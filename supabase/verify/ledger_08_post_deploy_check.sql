-- ledger_08_post_deploy_check.sql
--
-- READ-ONLY. Every statement is a SELECT. Nothing writes, locks or migrates,
-- so this is safe to run at any time, including mid-sync.
--
-- WHY THIS EXISTS
-- Two questions were open as of 2026-10-03 and neither can be answered from
-- outside the database:
--
--   Q1. Did the 8 ledger_*.sql migrations actually apply? The handover note
--       records them as REPORTED RUN on an operator report, which is weaker
--       evidence than a machine check. Vercel runtime logs return 403, so the
--       deploy-side log is unreadable.
--
--   Q2. How many schedulers are really firing /api/agent/monitor? Four Vercel
--       projects build this one repo, and vercel.json lives in the repo, so
--       each inherits all three cron entries -- up to 12 invocations a day,
--       not 3. Three of the four were paused on 2026-10-03, but all three then
--       accepted a new production deployment from the next push, so the pause
--       is NOT confirmed to be in effect.
--
-- Run PART B after a scheduled run has had time to land. Crons fire at 06:00,
-- 14:00 and 20:00 UTC.
--
--
-- PASTE CONTRACT -- READ THIS, THE SPLIT IS DELIBERATE
-- Paste PART A and PART B as TWO SEPARATE pastes. Do not combine them.
--
-- Postgres parses a whole statement before executing any of it, so if a table
-- is missing, a script that references it fails to parse and returns NOTHING --
-- including the catalog checks that would have told you which table is missing.
-- PART A reads only pg_class, so it cannot fail that way and always answers Q1.
-- PART B reads the ledger tables themselves and WILL error with
-- "relation does not exist" if PART A reported anything MISSING. That error is
-- itself the answer; fix the migration before bothering with PART B.
--
-- Each part is a single statement returning a single result set, because the
-- Supabase SQL editor shows the result of the last statement only.
--
-- WHY EACH PART IS WRAPPED IN begin; ... rollback; EVEN THOUGH IT ONLY SELECTS
-- The other scripts in this directory insert sentinel clients, orders and
-- charges, and their rollback is the only thing keeping fixture money out of
-- pnl_monthly. This script writes nothing, so its rollback is not load-bearing
-- the same way -- it is kept because it makes the read-only property
-- ENFORCED rather than merely claimed, so a future edit that adds a write
-- cannot persist it by accident. src/lib/ledger/migrations.test.ts asserts the
-- wrapper on every ledger_*.sql in this directory.


-- ###########################################################################
-- PART A -- Q1: did the migrations apply? Reads the catalog only, never fails.
-- Expect 13 rows, every verdict PRESENT. A MISSING row names the .sql file
-- that did not go in.
-- ###########################################################################

begin;

with expected(kind_label, relname, created_by) as (
  values
    -- tables, from `create table if not exists` in the 8 ledger files
    ('TABLE', 'orders',                'ledger_01_orders.sql'),
    ('TABLE', 'order_items',           'ledger_01_orders.sql'),
    ('TABLE', 'sync_runs',             'ledger_01_orders.sql'),
    ('TABLE', 'cost_rates',            'ledger_02_cost.sql'),
    ('TABLE', 'operating_costs',       'ledger_02_cost.sql'),
    ('TABLE', 'order_charges',         'ledger_03_charges.sql'),
    ('TABLE', 'client_store_ids',      'ledger_05_seed_nayax.sql'),
    ('TABLE', 'client_storage_months', 'ledger_07_storage.sql'),
    -- views, from `create or replace view` in ledger_04_views.sql
    ('VIEW',  'pnl_monthly',            'ledger_04_views.sql'),
    ('VIEW',  'pnl_client_monthly',     'ledger_04_views.sql'),
    ('VIEW',  'leaks_monthly',          'ledger_04_views.sql'),
    ('VIEW',  'pick_days',              'ledger_04_views.sql'),
    ('VIEW',  'labour_variance_inputs', 'ledger_04_views.sql')
)
select
  e.kind_label                                        as expected_kind,
  e.relname                                           as relation,
  case when c.oid is null then 'MISSING' else 'PRESENT' end as verdict,
  coalesce(c.relkind::text, '-')                      as actual_relkind,
  e.created_by                                        as created_by_file
from expected e
left join pg_class c
       on c.relname      = e.relname
      and c.relnamespace = 'public'::regnamespace
      and c.relkind      = any (
            case e.kind_label
              when 'TABLE' then array['r','p']::"char"[]   -- ordinary, partitioned
              else              array['v','m']::"char"[]   -- view, materialized view
            end)
order by
  case when c.oid is null then 0 else 1 end,  -- MISSING rows float to the top
  e.created_by,
  e.relname;

rollback;


-- ###########################################################################
-- PART B -- Q2: how many schedulers fired, plus ledger health.
-- Run this only after PART A comes back all PRESENT.
--
-- HOW TO READ THE SCHEDULER ROWS -- this is the subtle part.
-- Do not count successful runs. A duplicate scheduler usually does NOT show up
-- as a second successful run: the run-lock makes the loser SKIP. canStart() in
-- src/lib/ledger/run-lock.ts is a pure function over rows the caller already
-- read, and persist-charges.ts does select -> decide -> insert with no
-- database-level mutex, so a second scheduler yields either a skip that leaves
-- no row at all, or a second row in the same minute if it won the race.
--
-- So the signal for "more than one scheduler" is a SCHEDULER row whose verdict
-- is MULTIPLE -- two or more runs for one source clustered on a cron boundary.
-- One scheduler produces exactly one run per boundary. Note the asymmetry:
-- MULTIPLE proves duplicate schedulers, but all-OK does NOT prove there is
-- only one -- the others may simply be losing the race and skipping silently.
-- ###########################################################################

begin;

with clusters as (
  select
    source,
    date_trunc('hour', started_at at time zone 'UTC') as cron_hour_utc,
    count(*)                                          as runs,
    count(distinct date_trunc('minute', started_at))  as distinct_minutes,
    array_agg(distinct status)                        as statuses
  from sync_runs
  where started_at >= now() - interval '36 hours'
  group by 1, 2
),
scheduler_rows as (
  select
    1 as ord,
    'SCHEDULER' as section,
    source || ' @ ' || to_char(cron_hour_utc, 'YYYY-MM-DD HH24:00') || ' UTC' as item,
    case when runs = 1
         then 'OK: 1 run'
         else 'MULTIPLE: ' || runs::text || ' runs <- duplicate scheduler'
    end as verdict,
    'distinct_minutes=' || distinct_minutes::text
      || '  statuses=' || array_to_string(statuses, ',') as detail
  from clusters
),
-- Always returns exactly one row, so "no orphaned lock" is stated rather than
-- left as an empty result that could be mistaken for a failed read.
stale_lock as (
  select
    2 as ord,
    'ORPHANED LOCK' as section,
    'sync_runs still running >30min' as item,
    case when count(*) = 0
         then 'OK: none'
         else 'FOUND: ' || count(*)::text || ' <- holds the lock, later runs skip silently'
    end as verdict,
    coalesce(
      string_agg(source || ' ' || id::text || ' open ' || (now() - started_at)::text, '; '),
      'STALE_RUN_MINUTES=30 in run-lock.ts'
    ) as detail
  from sync_runs
  where finished_at is null
    and status = 'running'
    and started_at < now() - interval '30 minutes'
),
charges as (
  select
    3 as ord,
    'LEDGER CONTENT' as section,
    'order_charges' as item,
    count(*)::text || ' rows' as verdict,
    -- A NULL max() is UNKNOWN-shaped: it means "no rows", which could be an
    -- empty ledger OR a sync that has never once succeeded. Read it next to
    -- the SCHEDULER rows before concluding anything.
    'newest calculated_at=' || coalesce(max(calculated_at)::text, 'NULL (no rows: UNKNOWN, not zero)')
      || '  distinct_orders=' || count(distinct order_id)::text as detail
  from order_charges
),
clock as (
  select
    0 as ord,
    'CLOCK' as section,
    'now()' as item,
    to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS') || ' UTC' as verdict,
    'crons fire 06:00 / 14:00 / 20:00 UTC' as detail
)
select section, item, verdict, detail
from (
  select * from clock
  union all select * from scheduler_rows
  union all select * from stale_lock
  union all select * from charges
) all_rows
order by ord, item;

rollback;
