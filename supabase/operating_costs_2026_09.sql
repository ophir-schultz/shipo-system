-- September 2026 operating costs: the warehouse lease.
--
-- Source: owner-stated, 2026-10-05 -- "Rent 11500$ per month". NOT taken from
-- the Bank of America statement for Sept 2026 (SHIPOLLC ...6109), because the
-- rent does not appear on it. That statement's entire outflow is $3,571.13
-- against $11,500 of rent, so it captures about 24% of the month's real
-- operating cost and cannot be used to derive this figure. Recording the
-- provenance because the amount is a round number from memory, not a measured
-- one, and the next person will want to know which it is.
--
-- WHY THIS FILE IS NOT NAMED ledger_*.sql. src/lib/ledger/migrations.test.ts
-- globs `^ledger_.*\.sql$` in supabase/ for the migration-structure tests, and
-- the same glob in supabase/verify/ for a test that REQUIRES begin;/rollback;.
-- This file writes a row that must persist, so verify/ would discard it, and it
-- is data entry rather than a migration, so the structure tests do not apply.
--
-- PASTE EACH PART SEPARATELY. Postgres parses an entire statement before
-- executing any of it, so if operating_costs does not exist, a single batch
-- returns nothing at all -- including the check that would have named the
-- missing table. PART 1 reads only the catalog and cannot fail that way.

-- ---------------------------------------------------------------------------
-- PART 1 -- does the target exist? Reads pg_class only. Run this first.
-- ---------------------------------------------------------------------------
select
  to_regclass('public.operating_costs')            as operating_costs_table,
  to_regclass('public.pnl_monthly')                as pnl_monthly_view,
  (select count(*) from pg_constraint
    where conname = 'operating_costs_allocation_valid') as allocation_check_present;

-- Expect: both regclass columns non-null and allocation_check_present = 1.
-- A null operating_costs_table means ledger_02_cost.sql was never applied --
-- stop here and apply it, do not run PART 2.
-- allocation_check_present = 0 means the CHECK is missing, so a typo in
-- `allocation` below would be ACCEPTED and the cost would then match no FILTER
-- in pnl_monthly and vanish from net_profit. Re-run ledger_02_cost.sql first.


-- ---------------------------------------------------------------------------
-- PART 2 -- the insert.
-- ---------------------------------------------------------------------------
-- period_month MUST be the first of the month. pnl_monthly truncates defensively
-- (ledger_04_views.sql:348), so a mid-month date would still JOIN correctly --
-- but the unique index is on the RAW column, so '2026-09-15' and '2026-09-01'
-- are two separate rows that would both be summed. That double-counts rent and
-- reads as a worse month, not a better one, so it would at least be noticed.
--
-- allocation = 'overhead' is the owner's decision of 2026-10-05: one row, the
-- whole lease at the top, nothing pushed down to individual clients. See the
-- caveat printed by PART 3 -- this choice leaves net_profit NULL.
--
-- vendor is left NULL on purpose: null is UNKNOWN, and the landlord is not
-- named anywhere in the source. Fill it in if you know it; do not put a
-- placeholder string there, because '' and 'unknown' both participate in the
-- unique index as if they were real values.
insert into operating_costs (period_month, category, vendor, amount, allocation, note)
values (
  '2026-09-01',
  'rent',
  null,
  11500.00,
  'overhead',
  'Warehouse lease. Owner-stated 2026-10-05; not present on the Sept 2026 BoA statement.'
)
on conflict (period_month, category, coalesce(vendor, ''))
do update set
  amount     = excluded.amount,
  allocation = excluded.allocation,
  note       = excluded.note
returning id, period_month, category, vendor, amount, allocation;

-- do update, not do nothing: re-running after a corrected amount should fix the
-- row rather than silently keep the wrong one. It overwrites, so if you change
-- the amount above, that IS the new truth for September.
--
-- UNVERIFIED (no database on this machine): the ON CONFLICT clause infers an
-- EXPRESSION index -- operating_costs_month_category_vendor is on
-- (period_month, category, coalesce(vendor, '')), and the inference clause has
-- to restate that expression exactly. I believe this is correct, but I could
-- not execute it. If it errors with
--   42P10: there is no unique or exclusion constraint matching the ON CONFLICT
--          specification
-- then the inference failed, nothing was written, and the equivalent without
-- any inference is the two statements below. They are safe to paste together.
--
--   update operating_costs
--      set amount = 11500.00, allocation = 'overhead',
--          note = 'Warehouse lease. Owner-stated 2026-10-05; not present on the Sept 2026 BoA statement.'
--    where period_month = '2026-09-01' and category = 'rent' and vendor is null;
--
--   insert into operating_costs (period_month, category, vendor, amount, allocation, note)
--   select '2026-09-01', 'rent', null, 11500.00, 'overhead',
--          'Warehouse lease. Owner-stated 2026-10-05; not present on the Sept 2026 BoA statement.'
--    where not exists (select 1 from operating_costs
--                       where period_month = '2026-09-01'
--                         and category = 'rent' and vendor is null);
--
-- `vendor is null`, not `vendor = null`, in both -- the latter is never true.


-- ---------------------------------------------------------------------------
-- PART 3 -- what the P&L now says. Run this after PART 2.
-- ---------------------------------------------------------------------------
-- This reads the view itself rather than reporting that the insert ran. A
-- literal like 'RENT INSERTED' would print whenever the select runs and is
-- caused by nothing -- the values below are DERIVED from the row.
select
  period_month,
  revenue,
  direct_cost,
  gross_margin,
  overhead,
  direct_labor,
  direct_storage,
  overhead_rows,
  direct_labor_rows,
  direct_storage_rows,
  net_profit,
  case
    when net_profit is not null then 'net_profit is a number'
    when direct_labor is null and direct_storage is null
      then 'net_profit NULL: no direct_labor and no direct_storage row for this month'
    when direct_labor is null
      then 'net_profit NULL: no direct_labor row for this month'
    when direct_storage is null
      then 'net_profit NULL: no direct_storage row for this month'
    when revenue is null
      then 'net_profit NULL: no order_charges revenue for this month'
    else 'net_profit NULL: see the null column above'
  end as why
from pnl_monthly
where period_month = '2026-09-01';

-- EXPECTED RESULT, and it is not a bug: overhead = 11500.00, overhead_rows = 1,
-- and net_profit = NULL with why = 'net_profit NULL: no direct_labor and no
-- direct_storage row for this month'.
--
-- net_profit is revenue - direct_cost - overhead - direct_labor -
-- direct_storage, and each of the last three is a `sum(...) filter (...)` that
-- returns NULL -- not 0 -- when no row matches it. One NULL poisons the whole
-- subtraction, so net_profit is a number ONLY in months where all three
-- allocation categories have at least one operating_costs row.
-- ledger_04_views.sql:388-404 argues this is the right answer: coalescing a
-- missing category to 0 would assert a cost we never recorded was zero.
--
-- So with rent as a single overhead row, the headline figure stays blank. To
-- make it render, September also needs a direct_labor row and a direct_storage
-- row. The Sept BoA statement shows $1,807.80 of contractor payments that are
-- direct_labor; direct_storage has no natural line while storage sits inside
-- this lease, which is exactly the case ledger_04_views.sql:394 anticipates.
-- Resolving that is a pricing decision, not a SQL one, and is deliberately not
-- made here.
