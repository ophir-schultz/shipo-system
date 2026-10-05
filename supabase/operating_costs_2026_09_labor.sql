-- September 2026 operating costs: contractor labour.
--
-- Companion to operating_costs_2026_09.sql (the $11,500 warehouse lease). Read
-- that file's header first; the filename convention and the reason this is not
-- named ledger_*.sql are explained there and apply identically here.
--
-- Source: Bank of America statement for Sept 2026 (SHIPOLLC ...6109), four
-- "PMNT SENT / CASH APP" debits:
--
--   09/02  CASH APP*YOUSSEF AMER      451.50
--   09/02  CASH APP*YOUNES EL BOUA    447.32
--   09/25  CASH APP*YOUSSEF AMER      429.45
--   09/25  CASH APP*YOUNES EL BOUA    479.53
--                                   --------
--                                   1,807.80
--
-- PROVENANCE IS BETTER HERE THAN FOR THE RENT, and that asymmetry is worth
-- stating. The rent is a round number recalled by the owner and appears on no
-- statement. This figure is four dated debits that tie to the statement's own
-- subtotal, so it is measured rather than remembered.
--
-- WHAT WAS CHECKED BEFORE WRITING IT. $1,807.80 across two people is roughly
-- $904 each for a month, which is low enough for a 3PL warehouse that the
-- obvious reading is "some labour is paid from another account and this is only
-- a floor". Owner confirmed 2026-10-05 that this IS the complete month and no
-- contractor pay left CHK 7029 or changed hands in cash. Recorded because the
-- number invites exactly that suspicion, and the next person should know the
-- question was asked rather than overlooked.
--
-- Why that mattered enough to ask: a MISSING category leaves net_profit NULL --
-- visibly unknown. An UNDERSTATED direct_labor produces a number, and a number
-- that is too low reads as a better month than it was. Blank-and-unknown gets
-- revisited; plausible-and-wrong does not. See ledger_02_cost.sql:110 and
-- ledger_04_views.sql:398-400.
--
-- PASTE EACH PART SEPARATELY, same reason as the rent file: Postgres parses a
-- whole statement before executing any of it, so a guard batched with the
-- insert prints nothing at all when the precondition it was meant to report on
-- is the thing that is missing.


-- ---------------------------------------------------------------------------
-- PART 1 -- preconditions. Reads only. Run this first.
-- ---------------------------------------------------------------------------
select
  (select count(*) from pg_constraint
    where conname = 'operating_costs_allocation_valid')      as allocation_check_present,
  (select count(*) from operating_costs
    where period_month = '2026-09-01'
      and allocation = 'overhead')                           as sept_overhead_rows,
  (select count(*) from operating_costs
    where period_month = '2026-09-01'
      and allocation = 'direct_labor')                       as sept_direct_labor_rows,
  (select string_agg(category, ', ' order by category) from operating_costs
    where period_month = '2026-09-01')                       as sept_categories;

-- Expect: allocation_check_present = 1, sept_overhead_rows = 1 (the lease,
-- already entered), sept_direct_labor_rows = 0, sept_categories = 'rent'.
--
-- allocation_check_present = 0 -> the CHECK is gone, so a typo in `allocation`
-- below would be ACCEPTED, match no FILTER in pnl_monthly, and silently drop
-- this cost out of net_profit. Re-run ledger_02_cost.sql before PART 2.
--
-- sept_direct_labor_rows >= 1 -> labour for September is ALREADY recorded.
-- Stop and look at what is there (the categories column names it). PART 2
-- upserts on category 'contract_labor' only, so a pre-existing row under a
-- different category would NOT be replaced -- it would be ADDED TO, and
-- September's labour would be counted twice.


-- ---------------------------------------------------------------------------
-- PART 2 -- the insert.
-- ---------------------------------------------------------------------------
-- category = 'contract_labor', not 'wages'. The 'VERIFY-wages' label in
-- supabase/verify/ledger_04_verify.sql:294 is a test fixture, not a production
-- taxonomy -- nothing in this database defines category values, and there is no
-- CHECK on the column, so it is a label for humans. These are Cash App payments
-- to individuals with no payroll run behind them, which is 1099 contractor pay
-- rather than W-2 wages, and the distinction is one an accountant will care
-- about later.
--
-- allocation = 'direct_labor': this is labour performed on client work, which
-- is what that bucket means (ledger_04_views.sql). It is the one of the three
-- allocations that needs no judgement call here.
--
-- ONE ROW, vendor NULL, rather than one row per contractor. The unique index
-- would happily hold two named rows, and per-vendor detail would be the better
-- audit trail -- but the statement truncates the second payee to
-- "YOUNES EL BOUA", and that is a truncation, not a name. Writing it into
-- `vendor` would assert a surname this file does not actually know, which is
-- worse than NULL because it looks authoritative. The four dated amounts live
-- in the note instead, which is enough to tie this row back to the statement
-- lines without inventing anything. Split it into named rows once the full
-- names are known -- and if you do, DELETE this row rather than leaving it
-- alongside them.
insert into operating_costs (period_month, category, vendor, amount, allocation, note)
values (
  '2026-09-01',
  'contract_labor',
  null,
  1807.80,
  'direct_labor',
  'Contractor pay via Cash App, 4 debits on Sept 2026 BoA stmt (SHIPOLLC ...6109): '
    || '09/02 451.50 + 447.32, 09/25 429.45 + 479.53. '
    || 'Owner confirmed 2026-10-05 this is the complete month for September.'
)
on conflict (period_month, category, coalesce(vendor, ''))
do update set
  amount     = excluded.amount,
  allocation = excluded.allocation,
  note       = excluded.note
returning id, period_month, category, vendor, amount, allocation;

-- The ON CONFLICT inference below restates the expression index
-- operating_costs_month_category_vendor, which is on
-- (period_month, category, coalesce(vendor, '')). Unlike the rent file -- where
-- this clause was marked UNVERIFIED because there is no database on the machine
-- that wrote it -- this shape has now actually run: operating_costs_2026_09.sql
-- PART 2 executed successfully in the Supabase SQL editor on 2026-10-05. So the
-- inference is confirmed, not believed.
--
-- do update, not do nothing: re-running after a corrected amount fixes the row
-- instead of keeping the wrong one. It overwrites -- if you edit the amount
-- above, that IS the new truth for September.


-- ---------------------------------------------------------------------------
-- PART 3 -- what the P&L now says. Run this after PART 2.
-- ---------------------------------------------------------------------------
-- Reads the view, so every value below is DERIVED from the row rather than
-- echoing the fact that an insert ran.
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

-- EXPECTED: overhead = 11500.00, overhead_rows = 1, direct_labor = 1807.80,
-- direct_labor_rows = 1, direct_storage = NULL, direct_storage_rows = 0,
-- net_profit = NULL, why = 'net_profit NULL: no direct_storage row for this
-- month'.
--
-- The `why` string is the instrument. Before this file it read "no direct_labor
-- AND no direct_storage"; it should now name direct_storage ALONE. That change
-- is what proves the labour row landed and is visible THROUGH THE VIEW, not
-- merely present in the table. If `why` still mentions direct_labor, the row
-- did not land or its allocation does not match the FILTER.
--
-- direct_labor_rows = 2 would mean September's labour is recorded twice -- see
-- the PART 1 guard. Find the other row before trusting any figure here.
--
-- net_profit stays NULL and that remains correct. Owner confirmed 2026-10-05
-- that $11,500 is the TOTAL rent and storage sits inside that lease, so there
-- is no separate storage line to record. The remaining options are:
--
--   (a) leave direct_storage absent -- net_profit stays blank, which is an
--       accurate report of "not known";
--   (b) split the lease between overhead and direct_storage on a defensible
--       basis (square footage, or racked vs. office area), which needs a
--       measurement nobody has taken yet.
--
-- What is NOT an option is a direct_storage row of 0.00. Storage is inside the
-- $11,500, so asserting it cost nothing is false -- and it is false in the
-- flattering direction, which is the precise error ledger_04_views.sql:398-400
-- refuses to make. A blank headline figure is the honest output until (b)
-- happens. This is a pricing decision and is deliberately not made here.
