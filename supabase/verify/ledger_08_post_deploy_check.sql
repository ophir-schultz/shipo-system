-- ledger_08_post_deploy_check.sql
--
-- READ-ONLY. Every statement is a SELECT. Nothing writes, locks or migrates,
-- so this is safe to run at any time, including mid-sync.
--
-- WHY THIS EXISTS
-- Two questions were open as of 2026-10-03 and neither can be answered from
-- outside the database:
--
--   Q1. Did the ledger_*.sql migrations actually apply? There are 10 of them
--       as of 2026-10-05 -- ledger_03c and ledger_03d arrived after the
--       handover note was written and are counted nowhere in it. The note
--       records the original eight as REPORTED RUN on an operator report,
--       which is weaker evidence than a machine check, and says nothing at all
--       about the other two. Vercel runtime logs return 403, so the
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
-- Paste PART A, PART A2, PART A3, PART A4, PART A5, PART A6 and PART B as SEVEN
-- SEPARATE pastes, in that order. Do not combine them.
--
-- Postgres parses a whole statement before executing any of it, so when a table
-- is missing, a script that references it fails to parse and returns NOTHING --
-- including the catalog checks that would have told you which table is missing.
-- PART A, PART A4 and PART A6 read the catalog only -- pg_class, pg_constraint,
-- pg_index -- so none of them can fail that way, and each answers whatever it
-- can even on a database with tables missing. PART A2, A3, A5 and B read the
-- tables themselves and WILL error with "relation does not exist" when PART A
-- reported anything MISSING. That error is itself the answer; fix the migration
-- before bothering with the rest.
--
-- A4 and A6 sit after the table checks rather than beside PART A only because a
-- missing TABLE is the more useful thing to learn first. Nothing stops either
-- being run at any point.
--
-- Each part is a single statement returning a single result set, because the
-- Supabase SQL editor shows the result of the last statement only.
--
-- WHAT EACH PART ANSWERS
--   PART A  -- 5 of the 10 ledger files, by relation existence. Cannot fail.
--   PART A2 -- ledger_06_seed_cost_rates.sql, by comparing seeded VALUES.
--   PART A3 -- ledger_03b_rate_adjustments_cleanup.sql, by its backfill effect.
--   PART A4 -- the 8 named constraints, by catalog presence AND definition.
--   PART A5 -- ledger_05_seed_nayax.sql, by counting the rate card it wrote.
--   PART A6 -- ledger_03c and ledger_03d, by their 5 named INDEXES: catalog
--              presence AND definition, predicate included. Cannot fail.
--   PART B  -- Q2, the scheduler count, plus ledger health.
--
-- A2, A3, A5 and A6 exist because an existence check is blind to a migration
-- that creates no relation PART A looks for. FIVE of the ten files are in that
-- position, not two, and each now has a part of its own:
--
--   ledger_03b_rate_adjustments_cleanup.sql -- one `update` backfill   -> A3
--   ledger_03c_rate_adjustments_uniq.sql    -- two indexes             -> A6
--   ledger_03d_sync_runs_mutex.sql          -- three indexes           -> A6
--   ledger_05_seed_nayax.sql                -- 18 rate-card rows       -> A5
--   ledger_06_seed_cost_rates.sql           -- six `insert` rows       -> A2
--
-- A4 covers no file on its own -- every constraint it reads belongs to a file
-- PART A already finds by its tables. It is here because finding the TABLE does
-- not find the constraints on it; see PART A4's own header.
--
-- THE HOLE THAT USED TO BE HERE, KEPT BECAUSE THE SHAPE OF IT RECURS.
-- Until PART A6 was written, ledger_03c and ledger_03d were covered by NOTHING
-- in this script, and the reason is worth remembering: both create nothing but
-- indexes, an index is a pg_class row of relkind 'i' which PART A's join
-- excludes, and an index made by `create unique index` has no pg_constraint row
-- so PART A4 could not see it either. Two checks that each looked thorough left
-- the two newest files -- the likeliest of the ten to be unapplied -- entirely
-- unexamined, and both are load-bearing:
-- rate_adjustments_shipment_amount_key is the uniqueness the whole 03b backfill
-- exists to make possible, and sync_runs_running_source_key IS the sync mutex.
--
-- WHAT IS STILL NOT COVERED, so that this stays honest rather than merely
-- shorter than it was:
--   * ledger_01, 02, 03, 04 and 07 are covered by PART A at the level of
--     relations and by PART A4 at the level of named constraints. Their column
--     types, defaults and nullability are read by nothing here, and `create
--     table if not exists` does nothing to an existing table -- the same gap
--     PART A4 exists to close for constraints, one level down.
--   * Every part here scores DDL and seeded VALUES, never behaviour. The
--     scripts beside this one in supabase/verify/ attempt writes that must be
--     refused, which is the only thing that proves a constraint or an index
--     bites. They write fixtures and stop at the first fault; this script reads
--     only, reports every row at once, and is safe to run mid-sync. The two are
--     not substitutes for each other in either direction.
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
-- Expect 17 rows, every verdict PRESENT. A MISSING row names the .sql file
-- that did not go in.
--
-- WHAT THIS PART CANNOT SEE -- read this before calling Q1 answered.
-- An existence check can only find migrations that CREATE A RELATION, and only
-- the kinds of relation it asks about: tables and views, never indexes. Five of
-- the ten ledger files create nothing it looks for. They are listed in this
-- file's header along with which later PART covers each; the two that create
-- nothing but indexes are PART A6's subject, and the relkind filter below is
-- exactly why they need a part of their own.
--
-- All PRESENT here therefore means "5 of 10 applied", not "all 10 applied".
-- Do not read an all-PRESENT PART A as a clean bill for the migration set. It
-- is also blind to the CONSTRAINTS on the tables it finds, which is PART A4's
-- subject and a sharper hole than it sounds: `create table if not exists` does
-- nothing whatsoever to a table that is already there.
--
-- The last four rows are not ledger files at all. These predate this work, and
-- a later PART reads each of them, so a missing one would make that PART fail
-- to parse. Listing them here means the failure is diagnosed in advance rather
-- than hit as a bare "relation does not exist".
-- ###########################################################################

begin;

with expected(kind_label, relname, created_by) as (
  values
    -- Tables, from `create table if not exists`. The file named is the one that
    -- CREATES the table, which is the file to re-run when a row reads MISSING.
    -- client_store_ids was credited to ledger_05_seed_nayax.sql until
    -- 2026-10-05. It is created by ledger_01_orders.sql:10 and ledger_05 does
    -- not mention it -- re-running ledger_05 on that advice would have failed
    -- on its own first statement. The misattribution also hid something: with
    -- client_store_ids credited to it, ledger_05 appeared to be covered by an
    -- existence check, when in truth it creates no relation at all and needed
    -- the separate check that is now PART A5.
    ('TABLE', 'orders',                'ledger_01_orders.sql'),
    ('TABLE', 'order_items',           'ledger_01_orders.sql'),
    ('TABLE', 'sync_runs',             'ledger_01_orders.sql'),
    ('TABLE', 'client_store_ids',      'ledger_01_orders.sql'),
    ('TABLE', 'cost_rates',            'ledger_02_cost.sql'),
    ('TABLE', 'operating_costs',       'ledger_02_cost.sql'),
    ('TABLE', 'order_charges',         'ledger_03_charges.sql'),
    ('TABLE', 'client_storage_months', 'ledger_07_storage.sql'),
    -- views, from `create or replace view` in ledger_04_views.sql
    ('VIEW',  'pnl_monthly',            'ledger_04_views.sql'),
    ('VIEW',  'pnl_client_monthly',     'ledger_04_views.sql'),
    ('VIEW',  'leaks_monthly',          'ledger_04_views.sql'),
    ('VIEW',  'pick_days',              'ledger_04_views.sql'),
    ('VIEW',  'labour_variance_inputs', 'ledger_04_views.sql'),
    -- Prerequisites, not ledger output. PART A3 reads shipments and
    -- rate_adjustments; PART A5 reads clients and client_warehouse_rates,
    -- which ledger_03_charges.sql alters and ledger_05 seeds but neither
    -- creates.
    ('TABLE', 'shipments',              'schema.sql (PREREQUISITE, not a ledger file)'),
    ('TABLE', 'rate_adjustments',       'schema.sql (PREREQUISITE, not a ledger file)'),
    ('TABLE', 'clients',                'schema.sql (PREREQUISITE, not a ledger file)'),
    ('TABLE', 'client_warehouse_rates', 'schema.sql (PREREQUISITE, not a ledger file)')
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
-- PART A4 -- are the named CONSTRAINTS there, and do they still say what this
-- repository says they say? Reads pg_constraint and pg_class only, so like
-- PART A it cannot fail to parse and may be run even when PART A reported
-- something MISSING. Expect 8 rows, every verdict OK.
--
-- WHY THIS IS A SEPARATE QUESTION FROM PART A.
-- `create table if not exists` does NOTHING to a table that already exists --
-- not even add a constraint the current version of the file declares inline.
-- That is not hypothetical in this repository: order_charges_cost_has_basis was
-- added inline by a commit later than the one that created order_charges, so
-- every database that applied the earlier version has the table and not the
-- constraint. ledger_03_charges.sql:149 exists solely to repair that, and
-- src/lib/ledger/migrations.test.ts asserts such a repair block for every named
-- inline constraint. PART A reports that table PRESENT either way, because
-- constraints live in pg_constraint and PART A never reads it.
--
-- A half-applied paste opens the same hole. Several of the guarded blocks RAISE
-- when existing rows violate the constraint being added (ledger_02_cost.sql:70,
-- ledger_03_charges.sql:155). The raise aborts the remainder of that file, so
-- the tables already created stay and every constraint after the raise never
-- arrives -- which is exactly the state PART A cannot distinguish from clean.
--
-- WHY THE DEFINITION IS SCORED AND NOT MERELY THE NAME.
-- Six of these eight are added by `alter table ... add constraint` under
-- `exception when duplicate_object then raise notice '... already present'`. A
-- constraint of the same NAME whose definition differs is therefore KEPT, and
-- the file reports it present. Checking the name alone would call that clean.
--
--   EXTRA     -- the definition holds more literal values than this repository
--                lists. Checked before NARROWED because it is the silent
--                direction: a hand-added 'Estimated' still fails the exact
--                equality at calculate-charges.ts:144, so the placeholder it
--                lets in is presented as a measured cost. A narrowed
--                constraint, by contrast, rejects inserts loudly.
--   NARROWED  -- a value this repository requires is absent from the
--                definition, so every insert carrying it fails.
--
-- Neither test subsumes the other. A SUBSTITUTED value ('derived' edited to
-- 'Derived') leaves the count unchanged and is caught only by NARROWED; an
-- ADDED value leaves every required value present and is caught only by EXTRA.
--
-- HOW TO FIX AN EXTRA OR A NARROWED, because the obvious move does not work.
-- RE-RUNNING THE FILE WILL NOT REPLACE A WRONG DEFINITION. Those six blocks see
-- the name already taken, take the duplicate_object branch, and print "already
-- present". The constraint has to be dropped by hand first, and only then will
-- a re-run write the definition this repository declares. The two in
-- ledger_07_storage.sql are the exception: they `drop constraint if exists`
-- immediately before adding, so for those two a re-run genuinely does reassert
-- the definition -- which also means a mismatch there can ONLY mean the file
-- has not been run since the definition last changed.
--
-- The count is single quotes divided by two, not a parse. That is exact only
-- while no permitted value contains an apostrophe, which holds for all 14
-- listed below. `definition` is printed in full regardless, so the operator can
-- read the domain rather than trust the arithmetic.
--
-- NOT VALIDATED is scored because it is the natural workaround for the raise
-- described above: `add constraint ... not valid` gets past violating rows by
-- declining to look at them. New rows are checked, the rows that caused the
-- raise are still there, and every other verdict here reads OK.
--
-- WHAT THIS PART CANNOT SEE -- read this before calling the DDL verified.
--   * It scores TEXT, not behaviour. ledger_02_verify.sql and
--     ledger_03_verify.sql insert rows that must be rejected; that is the check
--     that proves a constraint bites. This one answers "did the DDL land".
--   * A unique index made by `create unique index` is not a constraint and has
--     no pg_constraint row, so none of the indexes in ledger_03c or ledger_03d
--     appear here -- including sync_runs_running_source_key, which is the whole
--     mutex. PART A6 is where those five are read. An all-OK PART A4 says
--     nothing whatsoever about either of those two files.
-- ###########################################################################

begin;

with expected(table_name, conname, kind_label, must_contain, declared_at) as (
  values
    ('cost_rates',             'cost_rates_no_overlap',
     'EXCLUDE', null::text[],
     'ledger_02_cost.sql:30'),
    ('cost_rates',             'cost_rates_basis_valid',
     'CHECK',   array['measured','derived','estimated'],
     'ledger_02_cost.sql:63'),
    ('operating_costs',        'operating_costs_allocation_valid',
     'CHECK',   array['overhead','direct_labor','direct_storage'],
     'ledger_02_cost.sql:120'),
    ('order_charges',          'order_charges_cost_has_basis',
     'CHECK',   null::text[],
     'ledger_03_charges.sql:149'),
    ('order_charges',          'order_charges_charge_type_valid',
     'CHECK',   array['shipping','pick','pack','material',
                      'storage','receiving','surcharge','return'],
     'ledger_03_charges.sql:202'),
    -- client_warehouse_rates predates the ledger and is NOT in PART A's list.
    -- A missing table shows up below as "table absent" rather than as a bare
    -- "relation does not exist", because this part reads the catalog only.
    ('client_warehouse_rates', 'client_warehouse_rates_no_overlap',
     'EXCLUDE', null::text[],
     'ledger_03_charges.sql:420'),
    ('client_storage_months',  'client_storage_months_is_month_start',
     'CHECK',   null::text[],
     'ledger_07_storage.sql:57'),
    ('client_storage_months',  'client_storage_months_non_negative',
     'CHECK',   null::text[],
     'ledger_07_storage.sql:73')
),
-- Two left joins, so a row survives whether the table is absent, the
-- constraint is absent, or both -- and the verdict can tell those apart, which
-- matters because they are fixed by different actions.
found as (
  select
    e.*,
    t.oid                       as table_oid,
    c.oid                       as con_oid,
    c.contype,
    c.convalidated,
    pg_get_constraintdef(c.oid) as condef
  from expected e
  left join pg_class t
         on t.relname      = e.table_name
        and t.relnamespace = 'public'::regnamespace
        and t.relkind      = any (array['r','p']::"char"[])
  left join pg_constraint c
         on c.conname  = e.conname
        and c.conrelid = t.oid
),
-- One row per (constraint, required value), reduced to the values this database
-- does NOT have. `unnest(f.must_contain)` refers to an earlier FROM item, which
-- a function-call FROM item is documented to be allowed to do without the
-- LATERAL keyword. Rows whose must_contain is null unnest to nothing and so are
-- absent from this CTE entirely -- hence the left join below.
--
-- position(), not LIKE: '_' is a LIKE single-character wildcard, so
-- '%direct_labor%' would also match a definition reading 'directXlabor', and
-- the instrument would pass the exact drift it exists to catch. quote_literal
-- puts the value in the quotes pg_get_constraintdef prints around it, so a
-- column or function of the same spelling cannot satisfy the test.
required as (
  select
    f.conname,
    count(*) filter (where position(quote_literal(v) in f.condef) = 0)
      as absent_count,
    string_agg(quote_literal(v), ', ')
      filter (where position(quote_literal(v) in f.condef) = 0)
      as absent_list
  from found f, unnest(f.must_contain) v
  group by f.conname
),
scored as (
  select
    f.*,
    r.absent_count,
    r.absent_list,
    (length(f.condef) - length(replace(f.condef, '''', ''))) / 2
      as literals_in_def
  from found f
  left join required r on r.conname = f.conname
)
select
  s.conname as constraint_name,
  case
    when s.table_oid is null
      then 'MISSING: table absent -- read PART A, this is not a DDL fault'
    when s.con_oid is null
      then 'MISSING <- the table exists WITHOUT it; re-run '
           || split_part(s.declared_at, ':', 1)
    when s.contype::text <> case s.kind_label when 'CHECK' then 'c' else 'x' end
      then 'WRONG KIND: expected ' || s.kind_label
           || ', found contype=' || s.contype::text
    when s.must_contain is not null
     and s.literals_in_def > array_length(s.must_contain, 1)
      then 'EXTRA: the definition holds ' || s.literals_in_def::text
           || ' values, this repository lists '
           || array_length(s.must_contain, 1)::text
           || ' <- a widened domain admits what the code rejects'
    when coalesce(s.absent_count, 0) > 0
      then 'NARROWED: ' || s.absent_list
           || ' absent from the definition <- every insert carrying one fails'
    when not s.convalidated
      then 'NOT VALIDATED <- added NOT VALID, so the rows written before it '
           || 'were never checked and are still there'
    else 'OK'
  end       as verdict,
  coalesce(s.condef, '-') as definition,
  s.declared_at           as declared_at
from scored s
order by
  case when s.con_oid is null then 0 else 1 end,  -- faults float to the top
  split_part(s.declared_at, ':', 1),              -- then grouped by file
  s.conname;

rollback;


-- ###########################################################################
-- PART A5 -- did ledger_05_seed_nayax.sql apply, and is its card still intact?
-- Expect 6 rows. Read the CLIENT row FIRST: every verdict under it is a count
-- over the set that row describes, so on NONE they are vacuous, not passes.
--
-- PRECONDITIONS, AND ONE OF THEM IS NOT A TABLE. Run this once PART A reports
-- clients and client_warehouse_rates PRESENT -- and also order_charges, because
-- charge_type, variant, effective_from, effective_to and rate_type are columns
-- ledger_03_charges.sql:346-360 ADDS to client_warehouse_rates. Without
-- ledger_03 this part fails with "column charge_type does not exist", which
-- names no file and reads like a bug in this script rather than a missing
-- migration. order_charges PRESENT in PART A is the proxy for ledger_03.
--
-- WHY THIS PART EXISTS AT ALL. ledger_05 creates no relation -- it deletes and
-- re-inserts 18 rows of client_warehouse_rates -- so PART A is blind to it. The
-- blindness was invisible until 2026-10-05 because PART A credited
-- client_store_ids to ledger_05, which made the file look covered. It was not.
--
-- WHY NOT TRUST ledger_05's OWN ASSERTIONS. ledger_05 ends with five checks
-- that raise on a wrong row count, and they are good ones. They run only at
-- paste time. They cannot say whether the file was ever pasted, and they cannot
-- see what happened afterwards -- which is the live risk here, not a bad paste:
-- POST /api/clients/[id]/warehouse-rates deletes ALL of a client's rates before
-- inserting, and the replacements carry no charge_type, so one use of the
-- rate-upload UI on Nayax removes all 18 rows and the loader silently stops
-- billing the client (ledger_05_seed_nayax.sql:29-33).
--
-- WHY `charge_type is not null` IS THE SCOPE. That predicate is what makes a
-- row one of ledger_05's; rows written by the upload endpoint carry no
-- charge_type. It is also the key ledger_05's own delete uses, so this part
-- counts exactly the set that file manages.
--
-- The four rate assertions are the three lines that are BILLABLE TODAY plus the
-- surcharge that multiplies them. The other fourteen lines are deliberately
-- unbillable (ledger_05's closing table says which and why), so a drift in one
-- of them moves no money today; the CARD row counts all eighteen, which is what
-- catches a dropped tuple among them.
-- ###########################################################################

begin;

with nayax as (
  -- The same predicate ledger_05 resolves the client with, deliberately. A
  -- stricter one here could report a clean card for a client that file never
  -- wrote to, or an empty one for the client it did.
  select id from clients where name ilike '%nayax%'
),
card as (
  select r.*
  from client_warehouse_rates r
  where r.client_id in (select id from nayax)
    and r.charge_type is not null
),
-- Every branch is a bare aggregate with no GROUP BY, so each returns exactly
-- one row even when its filter matches nothing. An empty result set would
-- otherwise be indistinguishable from a read that never ran.
rows_out as (
  select
    0 as ord,
    'CLIENT' as section,
    'clients matching ''%nayax%'' (must be exactly 1)' as item,
    case
      when count(*) = 1 then 'OK: 1'
      when count(*) = 0
        then 'NONE <- there is no Nayax client, so every count below is over an '
             || 'empty set and proves nothing. This is not a pass.'
      else count(*)::text || ' <- ledger_05 REFUSES to seed in this state '
           || '(ledger_05_seed_nayax.sql:55-60). The rows below span more than '
           || 'one client and no count among them is meaningful.'
    end as verdict
  from clients where name ilike '%nayax%'
  union all
  select
    1,
    'CARD',
    '18 structured rate lines (charge_type not null)',
    case
      when count(*) = 18 then 'OK: 18'
      when count(*) = 0
        then 'NONE <- ledger_05 never applied, or the rate-upload endpoint '
             || 'replaced the card and the client is no longer billed at all'
      when count(*) > 18
        then 'FOUND ' || count(*)::text || ' <- a row escaped the delete and is '
             || 'now duplicated; the duplicate is billed from as well'
      else 'FOUND ' || count(*)::text || ' <- something outside ledger_05 '
           || 'removed ' || (18 - count(*))::text || ' line(s)'
    end
  from card
  union all
  -- The peak surcharge, by name. It is the one line ledger_05 documents as
  -- MEANT to change, so a date-scoped check cannot protect it, and it is a
  -- percentage applied to every pick-and-pack total.
  select
    2,
    'SURCHARGE',
    'exactly one surcharge / peak line',
    case
      when count(*) = 0
        then 'NONE <- deleting this row removes hasPeakLine, and the undated 8% '
             || 'then re-enters through the fallback at '
             || 'load-charge-inputs.ts:392 on EVERY order'
      when count(*) > 1
        then count(*)::text || ' <- two of these bill the surcharge twice over, '
             || 'or once from whichever row sorts first'
      else 'OK: 1 line, window ' || min(effective_from)::text || ' -> '
           || coalesce(min(effective_to)::text, 'OPEN-ENDED')
           || case
                when min(effective_to) is null
                  then ' <- WARNING: open-ended, so 8% is added to every '
                       || 'pick-and-pack total all year. leaks_monthly has no '
                       || 'overbilling branch and will not report this.'
                when min(effective_to) = min(effective_from)
                  then ' (empty range: the deliberate off-switch, raises nothing)'
                else ' (ARMED: this window is billing 8%)'
              end
    end
  from card where charge_type = 'surcharge' and variant = 'peak'
  union all
  -- pick/device and pick/component are two of the three lines that bill today.
  -- The variant strings must read exactly as calculate-charges.ts:117 writes
  -- them; a drift there costs the rate silently, and the order surfaces in
  -- leaks_monthly.picked_never_billed instead of on an invoice.
  select
    3,
    'BILLABLE',
    'pick / device: one open-ended line at 0.32',
    case
      when count(*) = 0
        then 'MISSING <- every device pick loses its rate and the order lands '
             || 'in leaks_monthly.picked_never_billed'
      when count(*) > 1
        then 'DUPLICATE: ' || count(*)::text || ' lines <- '
             || 'calculate-charges.ts:91-98 calls this a data error and then '
             || 'resolves it by sort order rather than refusing'
      when count(*) filter (where effective_to is not null) > 0
        then 'DISABLED: effective_to = ' || max(effective_to)::text
             || ' <- the largest revenue line stops billing on that date'
      when max(rate) is distinct from 0.32
        then 'DRIFT: db=' || coalesce(max(rate)::text, 'NULL') || ' git=0.32'
      else 'OK: 0.32, open-ended'
    end
  from card where charge_type = 'pick' and variant = 'device'
  union all
  select
    4,
    'BILLABLE',
    'pick / component: one open-ended line at 0.20',
    case
      when count(*) = 0
        then 'MISSING <- every component pick loses its rate and the order '
             || 'lands in leaks_monthly.picked_never_billed'
      when count(*) > 1
        then 'DUPLICATE: ' || count(*)::text || ' lines <- resolved by sort '
             || 'order, not refused'
      when count(*) filter (where effective_to is not null) > 0
        then 'DISABLED: effective_to = ' || max(effective_to)::text
      when max(rate) is distinct from 0.20
        then 'DRIFT: db=' || coalesce(max(rate)::text, 'NULL') || ' git=0.20'
      else 'OK: 0.20, open-ended'
    end
  from card where charge_type = 'pick' and variant = 'component'
  union all
  -- The freight line. A null rate here is CORRECT and is not the same as zero:
  -- rate_type 'at_cost' means the client pays what the carrier charged, and the
  -- null reads as "the carrier bill has not arrived yet". A number in that
  -- column converts a pass-through into a fixed price nobody agreed.
  select
    5,
    'BILLABLE',
    'shipping: one at_cost line, rate null BY DESIGN',
    case
      when count(*) = 0
        then 'MISSING <- there is no freight line, so shipping is never billed'
      when count(*) > 1
        then 'DUPLICATE: ' || count(*)::text || ' freight lines'
      when bool_or(rate_type is distinct from 'at_cost')
        then 'DEFECT: rate_type=' || coalesce(max(rate_type), 'NULL')
             || ' <- must be at_cost'
      when bool_or(rate is not null)
        then 'DEFECT: rate=' || max(rate)::text || ' <- a fixed freight PRICE '
             || 'has replaced pass-through carrier cost'
      else 'OK: at_cost, rate null'
    end
  from card where charge_type = 'shipping'
)
select section, item, verdict from rows_out order by ord;

rollback;


-- ###########################################################################
-- PART A6 -- did ledger_03c and ledger_03d apply? Their 5 named INDEXES, by
-- catalog presence AND definition. Reads pg_class, pg_index and
-- pg_get_indexdef only, so like PART A and PART A4 it cannot fail to parse and
-- may be run even when PART A reported something MISSING. Expect 5 rows, every
-- verdict OK.
--
-- WHY THIS IS A SEPARATE QUESTION FROM PART A AND FROM PART A4.
-- Those two files create nothing BUT indexes. An index is a pg_class row of
-- relkind 'i', which PART A's relkind filter excludes, and one made by
-- `create unique index` has no pg_constraint row, so PART A4 cannot see it
-- either. Until this part existed nothing in this script said whether either
-- file had gone in -- and they are the two newest of the ten, which makes them
-- the likeliest of the ten to be unapplied.
--
-- WHY THE DEFINITION IS SCORED AND NOT MERELY THE NAME.
-- All five are created by `create index if not exists`, which does NOTHING to an
-- index of that name that already exists -- not even correct its columns. So an
-- index of the right name and the wrong shape is KEPT and the file reports
-- success. Same trap as PART A4's six guarded constraints, and the same repair:
-- it has to be dropped by hand before a re-run will write what git declares.
--
-- WHY THE PREDICATE IS SCORED IN BOTH DIRECTIONS. want_partial is per row,
-- because the right answer differs per row and the two mistakes are silent in
-- OPPOSITE ways:
--
--   PREDICATE ADDED on rate_adjustments_shipment_amount_key is a REGRESSION, and
--   it is the likeliest edit a reader would make in good faith: `where
--   shipment_id is not null` looks free, since NULLs are distinct in SQL and such
--   a row is unconstrained whether the predicate is written or not. It is not
--   free. PostgREST emits a bare column list for on_conflict -- shipstation.ts
--   sends the pair shipment_id,adjustment_amount and nothing else -- Postgres
--   cannot infer a partial index from that, and supabase-js .upsert() then raises
--   42P10 on EVERY adjustment. The table stays clean because NOTHING IS EVER
--   WRITTEN TO IT, which from the table's point of view looks exactly like
--   success. The full argument is ledger_03c_rate_adjustments_uniq.sql:40-54.
--
--   THE 42P10 ARGUMENT STOPS AT THAT ONE INDEX, and the verdict below says so
--   rather than reusing the sentence. on_conflict can only ever name a unique or
--   exclusion constraint, so rate_adjustments_client_status_date_idx -- declared
--   non-unique here -- cannot be an upsert target and cannot produce 42P10 no
--   matter what predicate it carries. A predicate there costs reach, not writes.
--   Printing the 42P10 consequence against it would be an alarm for something
--   that cannot happen, which teaches an operator to discount the next one.
--
--   PREDICATE MISSING on a sync_runs mutex index is the opposite failure. There
--   the predicate IS the unlock: a row occupies the index only while status =
--   'running', and close() moving it to ok/partial/failed is what releases the
--   lock, at no extra write (ledger_03d_sync_runs_mutex.sql:100-103). Without
--   the predicate the first run ever recorded holds its source for ever and
--   every later run is refused with 23505.
--
-- WHY THE HALVES OF THE MUTEX PREDICATE ARE SCORED AND NOT JUST ITS EXISTENCE.
-- The two mutex indexes are a PAIR split on client_id, and a single
-- `unique (source, client_id) where status = 'running'` would pass any
-- predicate-presence test while getting the design exactly backwards: NULLs are
-- distinct, so every client_id-null row would go unconstrained -- and charges
-- and shipstation, the two sources whose overlap actually destroys charge rows,
-- are the two that write client_id null (ledger_03d:81-86). So
-- `client_id IS NULL` and `client_id IS NOT NULL` are required fragments here.
-- supabase/verify/ledger_03d_verify.sql asserts that A predicate exists; it
-- does not read WHICH one, and this part does.
--
-- THE FRAGMENTS ARE WRITTEN AS pg_get_indexdef PRINTS THEM, not as the
-- migrations write them. Postgres normalises a predicate on the way in: it
-- prints IS NULL and DESC in upper case, casts text constants ('running'
-- becomes 'running'::text, which the fragment still matches as a prefix), and
-- may render `in ('ok','partial')` as `= ANY (ARRAY[...])` -- which is why no
-- fragment below spans more than one value.
--
-- THE COMPARISON IS CASE-SENSITIVE ON PURPOSE. Lowering both sides would
-- tolerate more rendering variation and would also hide the single worst drift
-- available here: a predicate hand-edited to status = 'Running' matches no row
-- ever written, so the mutex silently stops locking while every other verdict
-- in this part reads OK. A case-insensitive match would call that clean.
--
-- EXTRA counts quoted values rather than parsing, exactly as PART A4 does, and
-- the expected count is DERIVED from the fragments rather than written out
-- beside them, so the two cannot drift apart. It catches the direction NARROWED
-- cannot see: `status in ('ok','partial','failed')` on the watermark index
-- leaves every required fragment present. The arithmetic is single quotes over
-- two, so it is exact only while no required value contains an apostrophe,
-- which holds for the four here. The definition is printed in full regardless.
--
-- INVALID is scored because it is a false-clean nothing else in this script
-- would show. A CREATE INDEX CONCURRENTLY that fails leaves the index in place
-- -- named, listed by every tool, with indisunique still true and a definition
-- that reads perfectly -- AND NOT ENFORCING ANYTHING. Same shape as PART A4's
-- NOT VALIDATED, and the same reason for scoring it.
--
-- LOCALISING A HALF-APPLIED PASTE. These five indexes come from four separate
-- statements, so a split verdict says WHERE a paste stopped, not merely that it
-- did. ledger_03c creates its unique index inside a DO block and
-- rate_adjustments_client_status_date_idx in a bare statement after it, so both
-- MISSING is the signature of that DO block having raised on duplicate rows and
-- the editor having stopped there. The thing to fix then is the duplicate
-- (shipment_id, adjustment_amount) pairs, NOT the migration: ledger_03c raises
-- the reconciliation query in its own error message, and
-- supabase/verify/ledger_03b_verify.sql query 2 asserts the same invariant
-- independently. Both sync_runs mutex indexes live in ONE DO block, so they are
-- present together or absent together, and sync_runs_watermark_idx is a later
-- statement again.
--
-- WHAT THIS PART CANNOT SEE -- read this before calling 03c and 03d verified.
--   * It scores TEXT, not behaviour -- PART A4's limit exactly.
--     supabase/verify/ledger_03c_verify.sql and ledger_03d_verify.sql attempt
--     real duplicate rows and require the insert to be REJECTED, which is what
--     proves an index bites, and nothing here replaces that. Those two write
--     fixtures and stop at the first fault, which is why they are not what this
--     script is: a read-only pass, safe mid-sync, that reports all five at once.
--   * A non-default opclass or a COLLATE clause is printed inside the column
--     list and would read here as NARROWED. The definition column is the answer
--     to that, so read it before believing a fault.
--   * Nothing here says whether ledger_03d PART 1 reaped the abandoned runs.
--     PART B's ORPHANED LOCK row is that check.
-- ###########################################################################

begin;

with expected(table_name, indexname, want_unique, want_partial, must_contain,
              at_stake, declared_at) as (
  values
    ('rate_adjustments', 'rate_adjustments_shipment_amount_key',
     true, false,
     array['(shipment_id, adjustment_amount)'],
     'this is the uniqueness the whole ledger_03b backfill exists to make '
       || 'possible; without it the dedup in sync/shipstation.ts is a '
       || 'check-then-act over two overlapping syncs, and the duplicate it '
       || 'admits never heals and double-bills the client once approved',
     'ledger_03c_rate_adjustments_uniq.sql:75'),
    ('rate_adjustments', 'rate_adjustments_client_status_date_idx',
     false, false,
     array['(client_id, status, adjustment_date)'],
     'the per-client read behind every weekly bill (calculator.ts) and the '
       || 'dashboard status filter; absence costs speed, never correctness',
     'ledger_03c_rate_adjustments_uniq.sql:93'),
    ('sync_runs', 'sync_runs_running_source_key',
     true, true,
     array['(source)', 'status = ''running''', 'client_id IS NULL'],
     'THIS IS THE SYNC MUTEX for the two sources that write client_id null -- '
       || 'charges and shipstation -- and a second overlapping charge run '
       || 'deletes the fresh rows the first one has just written',
     'ledger_03d_sync_runs_mutex.sql:106'),
    ('sync_runs', 'sync_runs_running_source_client_key',
     true, true,
     array['(source, client_id)', 'status = ''running''',
           'client_id IS NOT NULL'],
     'the per-client half of the same mutex, which is the half zenventory runs '
       || 'under because it opens one row per client',
     'ledger_03d_sync_runs_mutex.sql:110'),
    ('sync_runs', 'sync_runs_watermark_idx',
     false, true,
     array['(source, client_id, finished_at DESC)', '''ok''', '''partial'''],
     'the zenventory watermark read, run once per client per sync against a '
       || 'table that is append-only and never pruned; absence costs speed, '
       || 'never correctness',
     'ledger_03d_sync_runs_mutex.sql:137')
),
-- Three left joins, so a row survives whether the table is absent, the index is
-- absent, or both -- and the verdict tells those apart, because they are fixed
-- by different actions. The pg_index join is on indexrelid ALONE, deliberately:
-- joining it on indrelid too would make an index that exists on the WRONG table
-- indistinguishable from one that does not exist, and those are different
-- faults. on_table_oid is compared against table_oid below instead.
found as (
  select
    e.*,
    t.oid                   as table_oid,
    ic.oid                  as index_oid,
    i.indrelid              as on_table_oid,
    i.indisunique,
    i.indisvalid,
    i.indisready,
    -- Null, not false, when there is no pg_index row at all. `indpred is not
    -- null` on a missing row would read as a confident "not partial" for an
    -- index this database does not have, and a false UNKNOWN is the one shape
    -- this directory refuses to write.
    case when i.indexrelid is null
         then null
         else i.indpred is not null
    end                     as is_partial,
    pg_get_indexdef(ic.oid) as indexdef
  from expected e
  left join pg_class t
         on t.relname      = e.table_name
        and t.relnamespace = 'public'::regnamespace
        and t.relkind      = any (array['r','p']::"char"[])
  left join pg_class ic
         on ic.relname      = e.indexname
        and ic.relnamespace = 'public'::regnamespace
        and ic.relkind      = any (array['i','I']::"char"[])  -- index, partitioned
  left join pg_index i
         on i.indexrelid = ic.oid
),
-- One row per (index, required fragment), reduced to the fragments this database
-- does NOT have. `unnest(f.must_contain)` refers to an earlier FROM item, which
-- a function-call FROM item may do without the LATERAL keyword.
--
-- position(), not LIKE: '_' is a LIKE single-character wildcard, and every
-- fragment below contains one, so '%client_id IS NULL%' would also match
-- 'clientXid IS NULL' and the instrument would pass the drift it exists to
-- catch. A missing index makes indexdef null, so position() returns null, the
-- filter counts nothing and absent_count is 0 -- which is why MISSING is
-- scored before this is read.
required as (
  select
    f.indexname,
    count(*) filter (where position(v in f.indexdef) = 0) as absent_count,
    string_agg(v, ' | ' order by v)
      filter (where position(v in f.indexdef) = 0)        as absent_list
  from found f, unnest(f.must_contain) v
  group by f.indexname
),
scored as (
  select
    f.*,
    r.absent_count,
    r.absent_list,
    (length(f.indexdef) - length(replace(f.indexdef, '''', ''))) / 2
      as literals_in_def,
    -- Derived from the fragments rather than stated beside them, so a fragment
    -- added later cannot leave a stale expected count behind it.
    (length(array_to_string(f.must_contain, ''))
      - length(replace(array_to_string(f.must_contain, ''), '''', ''))) / 2
      as want_literals
  from found f
  left join required r on r.indexname = f.indexname
)
select
  s.indexname as index_name,
  case
    when s.table_oid is null
      then 'MISSING: table absent -- read PART A, this is not a DDL fault'
    when s.index_oid is null
      then 'MISSING <- re-run ' || split_part(s.declared_at, ':', 1)
           || ' (and read the half-applied note in this part''s header before '
           || 'assuming it was never pasted). AT STAKE: ' || s.at_stake
    when s.on_table_oid is distinct from s.table_oid
      then 'WRONG TABLE: this index is on '
           || coalesce(s.on_table_oid::regclass::text, 'something else')
           || ', not ' || s.table_name || ' <- it constrains the wrong rows'
    when s.indisvalid is distinct from true
      or s.indisready is distinct from true
      then 'INVALID <- present and enforcing NOTHING; a CREATE INDEX '
           || 'CONCURRENTLY that failed leaves exactly this. Drop it and re-run '
           || split_part(s.declared_at, ':', 1)
    when s.indisunique is distinct from s.want_unique
      then case
             when s.want_unique
               then 'NOT UNIQUE <- it constrains nothing, and the name alone '
                    || 'reads as protection. AT STAKE: ' || s.at_stake
             else 'UNEXPECTEDLY UNIQUE <- this repository declares a plain '
                  || 'index here, so a unique one refuses legitimate writes'
           end
    when s.is_partial is distinct from s.want_partial
      then case
             -- Split on want_unique, not on want_partial alone. The 42P10 trap
             -- needs an on_conflict target and only a unique index can be one,
             -- so the sentence below is true of exactly one of these five rows.
             when not s.want_partial and s.want_unique
               then 'PREDICATE ADDED <- Postgres cannot infer a partial index '
                    || 'from the bare column list PostgREST emits for '
                    || 'on_conflict, so supabase-js .upsert() raises 42P10 on '
                    || 'every write and the table stays clean by never being '
                    || 'written to at all'
             when not s.want_partial
               then 'PREDICATE ADDED <- NOT the 42P10 trap: a non-unique index '
                    || 'cannot be an on_conflict target, so no write fails. The '
                    || 'cost is reach -- the rows outside the predicate have '
                    || 'left the index, and the read it exists for scans for '
                    || 'them instead'
             when s.want_unique
               then 'PREDICATE MISSING <- the predicate IS the unlock, so the '
                    || 'first run ever recorded holds its source for ever and '
                    || 'every later run is refused with 23505'
             else 'PREDICATE MISSING <- the index now covers the rows the read '
                  || 'it exists for excludes, so it is bigger and less selective'
           end
    when s.literals_in_def > s.want_literals
      then 'EXTRA: the definition holds ' || s.literals_in_def::text
           || ' quoted value(s), this repository requires '
           || s.want_literals::text
           || ' <- a widened predicate indexes rows the repository excludes'
    when coalesce(s.absent_count, 0) > 0
      then 'NARROWED or MOVED: ' || s.absent_list
           || ' absent from the definition <- the columns or the predicate are '
           || 'not what this repository declares; read the definition column'
    else 'OK'
  end         as verdict,
  coalesce(s.indexdef, '-') as definition,
  s.declared_at             as declared_at
from scored s
order by
  case when s.index_oid is null then 0 else 1 end,  -- faults float to the top
  split_part(s.declared_at, ':', 1),                -- then grouped by file
  s.indexname;

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
-- For 'shipstation' and 'zenventory' there USED TO BE no lock to lose. Both
-- called openSyncRun() unconditionally, near the top of the sync, so a second
-- scheduler that got as far as the sync WOULD have inserted a visible second
-- row, and an OK on one of those clusters was therefore STRONG.
--
-- ###########################################################################
-- THAT WAS BROKEN AND THEN REPAIRED, BOTH ON 2026-10-05. READ THIS FIRST.
--
-- BROKEN: ledger_03d_sync_runs_mutex.sql (applied 13:56 UTC) put a unique
-- partial index on the running rows. A second scheduler on ANY source was
-- refused by the index and wrote NOTHING -- exactly the property that makes
-- 'charges' weak above. All three clusters went WEAK, and an OK degraded from
-- "at most one scheduler fired" to "at most one WON". The root cause was that
-- a refusal left no durable trace: openSyncRun() threw, the callers counted it
-- in memory, the monitor printed a skip line into an HTTP response body, and
-- then it was gone.
--
-- REPAIRED: openSyncRun() now writes a sync_runs row for the refusal, with
-- status = 'skipped' (sync-run.ts, LOCK_REFUSED_STATUS). The loser is visible
-- again, so a contended hour shows one winner plus one row per refusal instead
-- of a single row. That is why the query below splits winners from refusals
-- rather than counting rows -- see the comment on the clusters CTE.
--
-- WHAT THE REPAIR DOES AND DOES NOT RESTORE. It restores OBSERVABILITY of
-- contention, not the old STRONG reading, and the two are not the same claim.
-- A refusal row proves something asked for the lock while it was held; it does
-- not say what. AutoSync polls this route every five minutes from every open
-- browser tab, and a colliding tab leaves a refusal indistinguishable in shape
-- from a colliding scheduler. Hence the CONTENDED verdict rather than an
-- alarm. To turn CONTENDED into an answer, use distinct_minutes (a cron fires
-- on the hour; a tab does not) or the Vercel Cron Jobs tab per project.
--
-- MULTIPLE was unaffected throughout and still proves duplicate schedulers
-- outright: the index suppresses concurrent rows, never sequential ones.
--
-- BEFORE READING ANY RESULT, confirm the deploy carrying the refusal row is
-- live. Against an older build every refusal is still invisible and a
-- CONTENDED verdict simply cannot appear -- which reads identically to "no
-- contention", the same false-clean this block exists to warn about.
--
-- AND CONFIRM THE INDEX ITSELF, WITH PART A6. Every verdict below is read
-- against the assumption that the mutex is really there. With
-- sync_runs_running_source_key absent nothing is ever refused, so no refusal
-- row is ever written, CONTENDED cannot appear for that reason too, and
-- "OK: 1 run, nothing refused" degrades from "nothing contended" to "nothing
-- was stopping a second run". MULTIPLE still means exactly what it says.
-- ###########################################################################
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
    date_trunc('hour', started_at at time zone 'UTC')  as cron_hour_utc,
    count(*)                                           as rows_total,
    -- Winners and refusals must be counted SEPARATELY, and a bare count(*) is
    -- now actively misleading. Since openSyncRun started writing a 'skipped'
    -- row per refusal, ONE scheduler plus two browser tabs polling
    -- /api/agent/monitor leaves three rows in the hour -- which count(*) would
    -- report as "3 runs <- duplicate scheduler", a false positive on the exact
    -- question this section exists to answer.
    count(*) filter (where status <> 'skipped')        as winners,
    count(*) filter (where status =  'skipped')        as refusals,
    count(distinct date_trunc('minute', started_at))   as distinct_minutes,
    array_agg(distinct status)                         as statuses
  from sync_runs
  where started_at >= now() - interval '36 hours'
  group by 1, 2
),
scheduler_rows as (
  select
    1 as ord,
    'SCHEDULER' as section,
    source || ' @ ' || to_char(cron_hour_utc, 'YYYY-MM-DD HH24:00') || ' UTC' as item,
    -- Three verdicts, because there are now three distinguishable worlds, and
    -- the middle one could not be seen at all before refusals became durable.
    --
    --   winners > 1    Two runs both TOOK the lock in this hour. They cannot
    --                  have overlapped -- the index would have refused the
    --                  second -- so they ran SEQUENTIALLY, which is what a
    --                  duplicate scheduler firing minutes apart looks like.
    --                  Unchanged in meaning, and still proof.
    --
    --   refusals > 0   Something asked for the lock while it was held. That is
    --                  the mutex working, and NOT on its own a duplicate
    --                  scheduler: AutoSync polls this route every five minutes
    --                  from every open browser tab, so each colliding poll
    --                  leaves a refusal. Read it against distinct_minutes -- a
    --                  refusal in the same minute as the cron boundary is
    --                  suspicious; one at :23 is almost certainly a tab.
    --
    --   otherwise      One run took the lock and nothing contended for it.
    case when winners > 1
         then 'MULTIPLE: ' || winners::text || ' runs took the lock <- duplicate scheduler'
         when refusals > 0
         then 'CONTENDED: ' || winners::text || ' ran, ' || refusals::text
              || ' refused <- scheduler or browser tab, check the minutes'
         else 'OK: 1 run, nothing refused'
    end as verdict,
    'distinct_minutes=' || distinct_minutes::text
      || '  rows=' || rows_total::text
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
