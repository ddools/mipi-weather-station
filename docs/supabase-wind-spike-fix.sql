-- One-off correction for the 2026-09-01 wind spike, plus a re-runnable guard.
-- Run in the Supabase SQL editor. Safe to re-run (idempotent).
--
-- What happened
-- -------------
-- At 2026-09-01T12:29:10Z the station published a 70.6 m/s gust (254 km/h). The
-- next highest gust in the same 24 h was 16.28 m/s, and Ireland's record gust is
-- about 51 m/s, so the value is a fault rather than weather.
--
-- The collector's sampling loop divided each pulse count by the *nominal* sample
-- window instead of the time that actually elapsed. Uploads used to run inline at
-- the end of an archive cycle, so a stalled POST blocked the loop while the
-- anemometer's interrupt handler kept counting. That record was preceded by a
-- 185.4 s gap against a 66.2 s median -- the only gap over 90 s in 1,299 rows --
-- and the ~125 s of pulses it collected were divided by 5 s, reading 25x high.
-- Its own average corroborates this: at 7.97 m/s with one sample of 70.6, the
-- other eleven must have averaged 2.28 m/s, matching the neighbouring records.
--
-- Fixed in the collector by measuring real elapsed time, moving uploads onto a
-- background thread, and dropping samples above MAX_PLAUSIBLE_WIND_MS (55 m/s).
-- This file repairs the rows that were already stored and shipped.

-- ---------------------------------------------------------------------------
-- 1. Preview what will change — run this first
-- ---------------------------------------------------------------------------
select id, recorded_at, wind_speed_ms, wind_gust_ms
from readings
where wind_gust_ms > 55
order by recorded_at;

-- Expected: exactly one row, id 3507 at 2026-09-01T12:29:10.429159+00:00,
-- wind_gust_ms 70.6, wind_speed_ms 7.97.

-- ---------------------------------------------------------------------------
-- 2. Null the affected wind fields
-- ---------------------------------------------------------------------------
-- Both columns go to null rather than to a reconstructed figure. The gust is
-- unrecoverable (we know only that the eleven clean samples averaged 2.28 m/s,
-- not what their maximum was), and a null renders as "N/A" for that one minute,
-- which is honest. Temperature, pressure, humidity and rain on the row are
-- unaffected by this fault and are deliberately left alone.
update readings
set wind_gust_ms = null,
    wind_speed_ms = null
where wind_gust_ms > 55;

-- ---------------------------------------------------------------------------
-- 3. Same treatment for the hourly rollup, if it has been populated
-- ---------------------------------------------------------------------------
-- readings_hourly (see supabase-retention.sql) takes max(wind_gust_ms) per hour,
-- so the spike would be preserved there even after step 2. Recompute the one
-- affected bucket from the corrected raw rows rather than nulling the hour.
-- Guarded: readings_hourly only exists if supabase-retention.sql has been run.
do $$
begin
    if to_regclass('public.readings_hourly') is null then
        raise notice 'readings_hourly does not exist — skipping rollup repair';
        return;
    end if;

    update readings_hourly h
    set wind_gust_ms = src.gust,
        wind_speed_ms = src.mean
    from (
        select date_trunc('hour', recorded_at) as bucket,
               max(wind_gust_ms) as gust,
               avg(wind_speed_ms) as mean
        from readings
        where recorded_at >= '2026-09-01T12:00:00Z'
          and recorded_at < '2026-09-01T13:00:00Z'
        group by 1
    ) src
    where h.bucket = src.bucket;
end $$;

-- ---------------------------------------------------------------------------
-- 4. Verify
-- ---------------------------------------------------------------------------
select max(wind_gust_ms) as max_gust_ms,
       round((max(wind_gust_ms) * 3.6)::numeric, 1) as max_gust_kmh
from readings
where recorded_at >= '2026-09-01T00:00:00Z'
  and recorded_at < '2026-09-02T00:00:00Z';

-- Expected after the fix: 16.28 m/s (58.6 km/h), the day's real maximum.
--
-- Note: the eight records preceded by a 71-90 s gap that day are mildly inflated
-- by the same mechanism (mean gust 10.31 m/s against 5.13 for normal gaps),
-- including the 16.28 m/s figure above. They are within plausible weather and are
-- left as recorded -- there is no principled way to separate the inflation from
-- a real gust after the fact. The collector fix prevents new ones.
