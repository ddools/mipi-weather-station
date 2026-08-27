-- Run in the Supabase SQL editor.
create table if not exists readings (
    id bigserial primary key,
    recorded_at timestamptz not null,
    temp_c real,
    humidity real,
    pressure_hpa real,
    pressure_msl_hpa real,
    wind_speed_ms real,
    wind_gust_ms real,
    wind_dir_deg real,
    rain_mm real,
    dewpoint_c real,
    air_quality real   -- TGS2600 relative contaminants index, 0-100 (uncalibrated); null when the sensor isn't fitted
);

-- Add the column to a table created before air quality existed (no-op otherwise).
alter table readings add column if not exists air_quality real;
create index if not exists idx_readings_recorded_at on readings (recorded_at desc);
create unique index if not exists uq_readings_recorded_at on readings (recorded_at);

alter table readings enable row level security;

-- Public read-only (website uses the anon key)
create policy "public read" on readings for select using (true);
-- No insert/update/delete policies: the Pi uses the service-role key, which bypasses RLS.
