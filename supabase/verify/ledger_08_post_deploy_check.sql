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
-- Paste PART A, PART A2, PART A3 and PART B as FOUR SEPARATE pastes, in that
-- order. Do not combine them.
--
-- Postgres parses a whole statement before executing any of it, so when a table
-- is missing, a script that references it fails to parse and returns NOTHING --
-- including the catalog checks that would have told you which table is missing.
-- PART A reads only pg_class, so it cannot fail that way and always answers Q1.
-- The later parts read the tables themselves and WILL error with
-- "relation does not exist" when PART A reported anything MISSING. That error is
-- itself the answer; fix the migration before bothering with the rest.
--
-- Each part is a single statement returning a single result set, because the
-- Supabase SQL editor shows the result of the last statement only.
--
-- WHAT EACH PART ANSWERS
--   PART A  -- 6 of the 8 ledger files, by relation existence. Cannot fail.
--   PART A2 -- ledger_06_seed_cost_rates.sql, by comparing seeded VALUES.
--   PART A3 -- ledger_03b_rate_adjustments_cleanup.sql, by its backfill effect.
--   PART B  -- Q2, the scheduler count, plus ledger health.
--
-- A2 and A3 exist because an existence check is blind to a migration that
-- creates no relation. Those two files only `update` and `insert`, so PART A
-- coming back all PRESENT says nothing whatsoever about either of them.
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
-- Expect 15 rows, every verdict PRESENT. A MISSING row names the .sql file
-- that did not go in.
--
-- WHAT THIS PART CANNOT SEE -- read this before calling Q1 answered.
-- An existence check can only find migrations that CREATE A RELATION. Two of
-- the eight ledger files create nothing:
--
--   ledger_03b_rate_adjustments_cleanup.sql -- one `update` backfill
--   ledger_06_seed_cost_rates.sql           -- six `insert` rows
--
-- All PRESENT here therefore means "6 of 8 applied", not "all 8 applied".
-- PART A2 and PART A3 cover the other two by their EFFECTS instead. Do not
-- read an all-PRESENT PART A as a clean bill for the whole migration set.
--
-- The last two rows are not ledger files at all. shipments and
-- rate_adjustments predate this work and PART A3 reads both, so a missing one
-- would make PART A3 fail to parse. Listing them here means that failure is
-- diagnosed in advance rather than hit as a bare "relation does not exist".
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
    ('VIEW',  'labour_variance_inputs', 'ledger_04_views.sql'),
    -- Prerequisites, not ledger output. PART A3 reads these two.
    ('TABLE', 'shipments',        'schema.sql (PREREQUISITE, not a ledger file)'),
    ('TABLE', 'rate_adjustments', 'schema.sql (PREREQUISITE, not a ledger file)')
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
-- PART A2 -- did ledger_06_seed_cost_rates.sql apply? Six rows, by value.
-- Safe to run once PART A reports cost_rates PRESENT. Expect 6 rows, all OK.
--
-- WHY VALUES AND NOT JUST PRESENCE. ledger_06 ends in `on conflict do nothing`,
-- so A ROW THAT ALREADY EXISTED WINS -- including one edited by hand. Re-running
-- the file does not reassert the numbers, so git and the database can diverge
-- permanently and silently. ledger_06's own header says to compare against the
-- literals rather than assume a re-run restored them; that comparison is what
-- this part is. The expected values below are copied from ledger_06 lines 42-80.
--
-- HOW TO READ THE VERDICTS
--   MISSING -- the row is absent, so ledger_06 did not apply (or not fully).
--   DEFECT  -- basis is not 'estimated'. This is the dangerous one: basis drives
--              is_estimate (calculate-charges.ts:144), so 'measured' or
--              'derived' on one of these placeholders makes a screen present a
--              guess as a measured cost, which ledger_06's header forbids.
--   DRIFT   -- the row exists with a different rate, so this file did NOT write
--              it. Note the direction. A hand-edited rate LOWER than git
--              understates cost and flatters margin, which is the direction that
--              does not announce itself.
--
-- `unit` is shown side by side rather than scored. Nothing reads cost_rates.unit
-- -- costOf is rate * quantity unconditionally (cost-rate.ts:71) -- so a unit
-- mismatch is cosmetic today and a trap tomorrow. See ledger_06's pack comment.
-- ###########################################################################

begin;

with expected(cost_type, variant, unit, rate) as (
  values
    ('pick',     'device',           'per_unit',          0.2300),
    ('pick',     'component',        'per_unit',          0.2000),
    ('pack',     null::text,         'per_order',         0.1500),
    ('material', 'box_small',        'per_order',         0.4500),
    ('material', 'box_medium',       'per_order',         0.7500),
    ('storage',  null::text,         'per_pallet_month', 12.0000)
)
select
  e.cost_type || ' / ' || coalesce(e.variant, '(null variant)') as seeded_row,
  case
    when c.id is null
      then 'MISSING <- ledger_06 did not apply'
    when c.basis is distinct from 'estimated'
      then 'DEFECT: basis=' || coalesce(c.basis, 'NULL')
           || ' <- placeholder would present as measured'
    when c.rate <> e.rate
      then 'DRIFT: db=' || c.rate::text || ' git=' || e.rate::text
           || case when c.rate < e.rate then ' (db LOWER: flatters margin)'
                   else ' (db higher)' end
    else 'OK: rate=' || c.rate::text || ' basis=estimated'
  end as verdict,
  coalesce(c.unit, '-')         as db_unit,
  e.unit                        as git_unit,
  coalesce(c.effective_to::text, 'open') as db_effective_to
from expected e
-- Joined on coalesce(variant,'') to match the unique index in ledger_02_cost.sql,
-- which is also how the two null-variant rows deduplicate correctly.
left join cost_rates c
       on c.cost_type            = e.cost_type
      and coalesce(c.variant, '') = coalesce(e.variant, '')
      and c.effective_from        = date '2026-01-01'
order by
  case when c.id is null then 0 else 1 end,
  e.cost_type,
  coalesce(e.variant, '');

rollback;


-- ###########################################################################
-- PART A3 -- did ledger_03b_rate_adjustments_cleanup.sql apply?
-- Safe to run once PART A reports shipments and rate_adjustments PRESENT.
-- Expect 4 rows. Only the first is a pass/fail; the rest are the context that
-- stops it being misread. Read the DENOMINATOR row before trusting an OK.
--
-- WHAT 03b DID. Task 10 moved the dedup key from (order_number,
-- adjustment_amount) to (shipment_id, adjustment_amount). Every pre-existing
-- row has a null shipment_id, so without the backfill each one fails the new
-- lookup and the next sync inserts a duplicate beside it -- with both counting
-- toward the client's ledger.
--
-- WHY THE count(*) = 1 QUALIFIER IS LOAD-BEARING. order_number is NOT unique in
-- shipments (multi-package orders, reships), so 03b deliberately backfills only
-- rows whose order_number resolves to exactly ONE shipment. A check without
-- that qualifier would count the deliberately-skipped rows as failures and
-- report a clean migration as broken.
--
-- THE LIMIT OF THIS CHECK. A nonzero first row means EITHER 03b never applied OR
-- something is still writing rate_adjustments with a null shipment_id. Both need
-- fixing, but they are different bugs, and this count cannot tell them apart.
-- Check the newest row's created_at against the migration date to separate them.
-- ###########################################################################

begin;

-- Named `unlinked`, not `nulls`: NULLS is a Postgres keyword (ORDER BY ... NULLS
-- FIRST). It is unreserved and would almost certainly parse as a CTE name, but
-- this script is handed to an operator to paste and there is no local database
-- to try it on, so a near-certainty is not worth a wasted round-trip.
with unlinked as (
  select
    ra.id,
    (select count(*)
     from   shipments s
     where  s.order_number = ra.order_number) as shipment_matches
  from rate_adjustments ra
  where ra.shipment_id is null
),
-- Each branch is a bare aggregate with no GROUP BY, so it returns exactly one
-- row even when the filter matches nothing. An empty result would otherwise be
-- indistinguishable from a read that never ran.
rows_out as (
  select
    0 as ord,
    'BACKFILL' as section,
    'resolvable rows still null (must be 0)' as item,
    case when count(*) = 0
         then 'OK: 0 <- ledger_03b applied'
         else 'FOUND: ' || count(*)::text
              || ' <- NOT backfilled; each duplicates on the next sync run'
    end as verdict
  from unlinked
  where shipment_matches = 1
  union all
  select
    1,
    'BY DESIGN',
    'orphaned: order_number matches 0 shipments',
    count(*)::text || ' rows <- skipped deliberately, not a failure'
  from unlinked
  where shipment_matches = 0
  union all
  select
    2,
    'BY DESIGN',
    'ambiguous: order_number matches 2+ shipments',
    count(*)::text || ' rows <- skipped deliberately, not a failure'
  from unlinked
  where shipment_matches > 1
  union all
  -- THE DENOMINATOR, and it is not decoration. Without it a count of 0 on the
  -- row above is ambiguous between "the backfill ran" and "the table is empty,
  -- so there was never anything to back fill" -- the second being a vacuous
  -- pass, which is the failure mode this directory's own comments warn about.
  -- Zero total rows means PART A3 proves NOTHING; it does not mean OK.
  select
    3,
    'DENOMINATOR',
    'rate_adjustments total / already linked',
    count(*)::text || ' total, '
      || count(shipment_id)::text || ' with a shipment_id'
      || case when count(*) = 0
              then ' <- TABLE EMPTY: the verdict above is vacuous, not a pass'
              else '' end
  from rate_adjustments
)
select section, item, verdict from rows_out order by ord;

rollback;


-- ###########################################################################
-- PART B -- Q2: how many schedulers fired, plus ledger health.
-- Run this only after PART A comes back all PRESENT.
--
-- HOW TO READ THE SCHEDULER ROWS -- this is the subtle part, and the strength
-- of an all-OK result DEPENDS ON THE source COLUMN. An earlier version of this
-- comment said all-OK proves nothing. That is true for one source out of three
-- and wrong for the other two, so it threw away good evidence. Corrected
-- 2026-10-05 after reading the three call sites.
--
-- Only THREE sources ever write a sync_runs row, and only ONE is gated:
--
--   'charges'    persist-charges.ts:210, GATED by canStart()
--   'shipstation' sync/shipstation.ts:19, NOT GATED
--   'zenventory'  sync/zenventory.ts:117, NOT GATED
--
-- For 'charges', a duplicate scheduler usually leaves NO TRACE. canStart() in
-- run-lock.ts is a pure function over rows the caller already read, and
-- persist-charges.ts does select (:172) -> decide (:192) -> insert (:210) with
-- no transaction and no database-level mutex. So a second scheduler yields
-- either a silent skip that writes no row, or a second row in the same minute
-- when it won the race. An OK on a 'charges' cluster is therefore WEAK.
--
-- For 'shipstation' and 'zenventory' there is NO LOCK TO LOSE. Both call
-- openSyncRun() unconditionally, near the top of the sync, so a second
-- scheduler that got as far as the sync WOULD have inserted a visible second
-- row. An OK on one of those clusters is therefore STRONG: it says no second
-- scheduler reached that code path at that boundary.
--
-- The one thing an OK on those two does not rule out is a duplicate scheduler
-- that never got past auth. requireStaffOrCron collapses to requireStaff() when
-- no secret is configured, so a project cloned without CRON_SECRET 401s before
-- reaching any sync and writes nothing. That world is BENIGN -- it is a noise
-- and billing question, not a ledger-correctness one -- but it is not the same
-- world as "only one scheduler exists", and the two are indistinguishable here.
--
-- Do NOT credit single-flight.ts with any of this. It is an in-process ref
-- guard for the browser AutoSync component; separate Vercel projects are
-- separate lambdas and it cannot see across them.
--
-- MULTIPLE on any source proves duplicate schedulers outright.
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
