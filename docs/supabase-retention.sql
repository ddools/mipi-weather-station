-- Retention + downsampling for the `readings` table.
-- Run once in the Supabase SQL editor. Safe to re-run (idempotent).
--
-- Goal: keep the project inside the 500 MB free tier indefinitely.
--   * raw 1-minute rows: kept ~90 days
--   * hourly averages: kept forever (tiny — ~24 rows/day, ~9k rows/year)
--
-- At a 60 s archive interval one raw row is ~120 B on disk with the index, so
-- 90 days ≈ 130k rows ≈ ~30 MB. The hourly rollup after years is still < 5 MB.
-- The website's 7d/30d history reads `readings_hourly` and its "All time" range
-- reads the `readings_daily` view over it (section 5) — the rollup is what lets
-- the charts reach back past the 90-day raw window to the station's first day.

-- ---------------------------------------------------------------------------
-- 1. Hourly rollup table
-- ---------------------------------------------------------------------------
create table if not exists readings_hourly (
    bucket           timestamptz primary key,  -- start of the hour, UTC
    sample_count     integer not null,
    temp_c           real,
    humidity         real,
    pressure_hpa     real,
    pressure_msl_hpa real,
    wind_speed_ms    real,   -- mean
    wind_gust_ms     real,   -- max gust in the hour
    wind_dir_deg     real,   -- vector-averaged (see function below)
    rain_mm          real,   -- summed, not averaged
    dewpoint_c       real,
    air_quality      real    -- mean of the TGS2600 relative index (uncalibrated)
);

alter table readings_hourly enable row level security;
alter table readings_hourly add column if not exists air_quality real;

do $$
begin
    if not exists (
        select 1 from pg_policies
        where tablename = 'readings_hourly' and policyname = 'public read'
    ) then
        create policy "public read" on readings_hourly for select using (true);
    end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Roll up completed hours
-- ---------------------------------------------------------------------------
-- Aggregates every whole hour that has raw rows but isn't in readings_hourly
-- yet (skips the current, still-filling hour). Wind direction is averaged as a
-- unit vector so 350° and 10° average to 0°, not 180°.
create or replace function roll_up_readings_hourly()
returns integer
language plpgsql
as $$
declare
    rows_written integer;
begin
    with rolled as (
        insert into readings_hourly (
            bucket, sample_count, temp_c, humidity, pressure_hpa, pressure_msl_hpa,
            wind_speed_ms, wind_gust_ms, wind_dir_deg, rain_mm, dewpoint_c, air_quality
        )
        select
            date_trunc('hour', recorded_at)                                   as bucket,
            count(*)                                                          as sample_count,
            avg(temp_c)                                                       as temp_c,
            avg(humidity)                                                     as humidity,
            avg(pressure_hpa)                                                 as pressure_hpa,
            avg(pressure_msl_hpa)                                             as pressure_msl_hpa,
            avg(wind_speed_ms)                                                as wind_speed_ms,
            max(wind_gust_ms)                                                 as wind_gust_ms,
            mod(
                degrees(
                    atan2(
                        avg(sin(radians(wind_dir_deg))),
                        avg(cos(radians(wind_dir_deg)))
                    )
                )::numeric + 360,
                360
            )::real                                                          as wind_dir_deg,
            sum(rain_mm)                                                      as rain_mm,
            avg(dewpoint_c)                                                   as dewpoint_c,
            avg(air_quality)                                                  as air_quality
        from readings
        where recorded_at < date_trunc('hour', now())
          and date_trunc('hour', recorded_at) not in (select bucket from readings_hourly)
        group by 1
        on conflict (bucket) do nothing
        returning 1
    )
    select count(*) into rows_written from rolled;
    return rows_written;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Purge raw rows older than 90 days (only those already rolled up)
-- ---------------------------------------------------------------------------
create or replace function purge_old_readings()
returns integer
language plpgsql
as $$
declare
    rows_deleted integer;
begin
    delete from readings
    where recorded_at < now() - interval '90 days'
      and date_trunc('hour', recorded_at) in (select bucket from readings_hourly);
    get diagnostics rows_deleted = row_count;
    return rows_deleted;
end $$;

-- ---------------------------------------------------------------------------
-- 4. Schedule it (pg_cron)
-- ---------------------------------------------------------------------------
-- Supabase ships pg_cron; enable it under Database → Extensions if this errors.
create extension if not exists pg_cron;

-- Roll up hourly, five past the hour (previous hour is complete by then).
select cron.schedule(
    'readings-hourly-rollup',
    '5 * * * *',
    $$select roll_up_readings_hourly()$$
);

-- Purge once a day at 03:20 UTC (quiet hour).
select cron.schedule(
    'readings-purge-90d',
    '20 3 * * *',
    $$select purge_old_readings()$$
);

-- To back-fill history before the first cron run, and to verify:
--   select roll_up_readings_hourly();
--   select purge_old_readings();
--   select * from cron.job;

-- ---------------------------------------------------------------------------
-- 5. Daily view for the site's "All time" history range
-- ---------------------------------------------------------------------------
-- One row per Irish-local calendar day, built from readings_hourly so it covers
-- the station's whole life even after the raw rows are purged. Today is left
-- out (it is still filling); the site adds it from the hourly/raw tail.
-- Columns are named like `readings` so the site can treat rows as Readings.
-- security_invoker makes the view obey readings_hourly's RLS (public read)
-- instead of running as its owner.
create or replace view readings_daily
with (security_invoker = on) as
select
    (date_trunc('day', bucket at time zone 'Europe/Dublin')
        at time zone 'Europe/Dublin')                                 as recorded_at,
    sum(sample_count)::integer                                        as sample_count,
    avg(temp_c)::real                                                 as temp_c,
    avg(humidity)::real                                               as humidity,
    avg(pressure_hpa)::real                                           as pressure_hpa,
    avg(pressure_msl_hpa)::real                                       as pressure_msl_hpa,
    avg(wind_speed_ms)::real                                          as wind_speed_ms,
    max(wind_gust_ms)                                                 as wind_gust_ms,
    mod(
        degrees(
            atan2(
                avg(sin(radians(wind_dir_deg))),
                avg(cos(radians(wind_dir_deg)))
            )
        )::numeric + 360,
        360
    )::real                                                           as wind_dir_deg,
    sum(rain_mm)::real                                                as rain_mm,
    avg(dewpoint_c)::real                                             as dewpoint_c,
    avg(air_quality)::real                                            as air_quality
from readings_hourly
where bucket < (date_trunc('day', now() at time zone 'Europe/Dublin')
                    at time zone 'Europe/Dublin')
group by 1;

grant select on readings_daily to anon, authenticated;

-- The site reads 7d/30d from readings_hourly and "All time" from
-- readings_daily (web/src/lib/supabase.ts), topping each up from raw rows for
-- the hours the rollup hasn't reached yet. Until this file has been run both
-- ranges fall back to bucketing raw rows, which is capped at 20k (~14 days).
