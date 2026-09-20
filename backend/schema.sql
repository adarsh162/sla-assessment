-- SLA Monitoring Dashboard — schema
-- Run this in the Supabase SQL editor (or any Postgres instance) before first use.

create table if not exists checks (
  id            bigserial primary key,
  service_id    text not null,
  service_name  text not null,
  ts            timestamptz not null,
  status_code   integer not null,
  latency_ms    numeric,              -- null when the source row had no usable latency
  agent         text not null,
  region        text not null,
  is_error      boolean not null,     -- derived: status_code >= 500, OR the 999 sentinel
  upload_batch  text not null,        -- groups rows from the same upload, for traceability
  inserted_at   timestamptz not null default now(),
  latency_ms_key numeric generated always as (coalesce(latency_ms, -1)) stored
);

-- The dashboard's two main query patterns: per-service aggregates over a window,
-- and a filtered/paginated log view over a date or date range.
create index if not exists idx_checks_service_ts on checks (service_id, ts);
create index if not exists idx_checks_ts on checks (ts);
create index if not exists idx_checks_batch on checks (upload_batch);

-- Prevents the same physical reading (service+agent+timestamp+status+latency) from being
-- inserted twice, whether from a true duplicate row in one file or from re-uploading the
-- same file. Two agents legitimately checking the same service at the same timestamp is
-- NOT a duplicate — hence agent is part of the key, not just service+ts.
create unique index if not exists uniq_checks_reading
  on checks (service_id, agent, ts, status_code, latency_ms_key);

-- Powers the dashboard's stats panel. Computed in the database rather than pulled
-- row-by-row to the browser, since a service with weeks of 15-minute checks could be
-- tens of thousands of rows — aggregating there is the only approach that stays fast
-- as the dataset grows. p95 uses percentile_cont, which needs a real DB, not PostgREST's
-- built-in aggregates alone.
create or replace function service_stats(from_ts timestamptz, to_ts timestamptz)
returns table (
  service_id text,
  service_name text,
  total_checks bigint,
  error_checks bigint,
  uptime_pct numeric,
  avg_latency_ms numeric,
  p95_latency_ms numeric
)
language sql
stable
as $$
  select
    c.service_id,
    max(c.service_name) as service_name,
    count(*) as total_checks,
    count(*) filter (where c.is_error) as error_checks,
    round(
      100.0 * (count(*) - count(*) filter (where c.is_error)) / nullif(count(*), 0),
      3
    ) as uptime_pct,
    round(avg(c.latency_ms) filter (where c.latency_ms is not null), 1) as avg_latency_ms,
    round(
      (percentile_cont(0.95) within group (order by c.latency_ms))::numeric,
      1
    ) as p95_latency_ms
  from checks c
  where c.ts >= from_ts and c.ts < to_ts
  group by c.service_id
  order by c.service_id;
$$;

-- RLS: the browser only ever needs to read. All writes happen through the Cloud
-- Function using the service-role key, which bypasses RLS entirely.
alter table checks enable row level security;

create policy "public read access" on checks
  for select
  using (true);
