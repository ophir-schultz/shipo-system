-- September 2026 operating costs: the remaining overhead from the bank statement.
--
-- Third and last of the September trio. Read operating_costs_2026_09.sql's
-- header first for the filename convention and the paste-each-part-separately
-- rule; both apply here unchanged.
--
--   operating_costs_2026_09.sql        rent, $11,500.00      overhead
--   operating_costs_2026_09_labor.sql  contractors, $1,807.80 direct_labor
--   THIS FILE                          software/telecom/fees  overhead
--
-- WHY THIS FILE EXISTS. The first two files recorded $13,307.80 of September
-- cost, but the Sept 2026 BoA statement (SHIPOLLC ...6109) shows $3,571.13 of
-- total outflow and only $1,807.80 of that was labour. The remaining $1,763.33
-- is real operating cost that no row in the ledger accounts for. Left out, the
-- first month whose net_profit renders a number would OVERSTATE profit by that
-- amount -- the same flattering-error class the labour file refused, arrived at
-- by omission instead of understatement.
--
-- THE STATEMENT RECONCILES EXACTLY, which is why these figures are measured
-- rather than estimated:
--
--   contract labour (already recorded, direct_labor)    1,807.80
--   software / SaaS                                       836.26
--   telecom                                               426.32
--   postage -- DELIBERATELY EXCLUDED, see below            370.75
--                                                       --------
--   total withdrawals and other debits                  3,441.13  <- stmt p.4
--   overdraft fees                                        130.00  <- stmt p.4
--                                                       --------
--   total outflow                                       3,571.13
--
-- Both subtotals are the bank's own printed figures, not sums of my
-- categorisation, so the agreement is a real check and not a tautology.
--
-- THIS FILE WRITES 836.26 + 426.32 + 130.00 = 1,392.58, NOT 1,763.33.
-- Postage is held back on purpose. pnl_monthly's direct_cost is
-- `sum(cost)` over order_charges (ledger_04_views.sql:326) -- per-shipment
-- carrier cost. Two separate problems with booking the $370.75 here:
--
--   1. DOUBLE COUNT. If any of those labels are already costed on their
--      order_charges row, the same dollars would land in direct_cost AND in
--      overhead, and net_profit would subtract them twice.
--   2. WRONG EVENT. $355.00 of it is "Stamps Add Funds" -- topping up a
--      prepaid postage wallet. That is cash moving into a balance, not an
--      expense incurred. The expense happens when a label is bought, which
--      may be in a different month entirely.
--
-- So the honest treatment of postage is to verify it against order_charges
-- first, and the honest treatment of a number I have not verified is to leave
-- it out rather than guess. Absent reads as unknown; present-and-wrong does
-- not. The query to settle it is at the bottom of this file.


-- ---------------------------------------------------------------------------
-- PART 1 -- preconditions. Reads only. Run this first.
-- ---------------------------------------------------------------------------
select
  (select count(*) from pg_constraint
    where conname = 'operating_costs_allocation_valid')     as allocation_check_present,
  (select string_agg(category || '=' || amount::text, ', ' order by category)
     from operating_costs where period_month = '2026-09-01') as sept_rows,
  (select sum(amount) from operating_costs
    where period_month = '2026-09-01')                       as sept_total_now,
  (select count(*) from operating_costs
    where period_month = '2026-09-01'
      and category in ('software', 'telecom', 'bank_fees'))  as already_present;

-- Expect: allocation_check_present = 1,
--         sept_rows = 'contract_labor=1807.80, rent=11500.00',
--         sept_total_now = 13307.80,
--         already_present = 0.
--
-- allocation_check_present = 0 -> the CHECK is gone and a typo in `allocation`
-- would be accepted, match no FILTER in pnl_monthly, and drop the cost out of
-- net_profit silently. Re-run ledger_02_cost.sql before PART 2.
--
-- already_present > 0 -> some or all of these three rows exist. PART 2 upserts,
-- so re-running is safe and idempotent for these exact categories; but check
-- sept_rows for a DIFFERENT category holding the same money (an 'saas' or
-- 'internet' row, say), because that would be added to rather than replaced.


-- ---------------------------------------------------------------------------
-- PART 2 -- three rows.
-- ---------------------------------------------------------------------------
-- All three are allocation = 'overhead': none is attributable to a particular
-- client's shipments, which is what the direct_* buckets mean.
--
-- vendor stays NULL on every row even though the statement names the merchants,
-- because each row aggregates several merchants -- there is no single vendor to
-- name. The merchant-level detail is itemised in each note instead, so the row
-- can still be tied back to specific statement lines. Do not put a placeholder
-- string in vendor: '' and 'various' both participate in the unique index as if
-- they were real values.
insert into operating_costs (period_month, category, vendor, amount, allocation, note)
values
  (
    '2026-09-01', 'software', null, 836.26, 'overhead',
    'Sept 2026 BoA stmt (SHIPOLLC ...6109), 13 debits: Apollo.io 426.87; '
      || 'Google Workspace 132.00 + 4.40; Anthropic 100.00; Apple 14.99 + 14.99 '
      || '+ 29.99 + 14.99 + 34.98; AWS 21.25; Make.com 18.82; Microsoft 365 '
      || '12.99; Scribd 9.99.'
  ),
  (
    '2026-09-01', 'telecom', null, 426.32, 'overhead',
    'Sept 2026 BoA stmt (SHIPOLLC ...6109), 3 debits: Comcast/Xfinity 369.06; '
      || 'Comcast Business Mobile 47.26; Airalo 10.00.'
  ),
  (
    '2026-09-01', 'bank_fees', null, 130.00, 'overhead',
    'Sept 2026 BoA stmt (SHIPOLLC ...6109) service-fee summary: overdraft fees '
      || '130.00 for the period, 550.00 year-to-date, NSF 0.00. The statement '
      || 'does not itemise the individual fees, so no count is claimed here.'
  )
on conflict (period_month, category, coalesce(vendor, ''))
do update set
  amount     = excluded.amount,
  allocation = excluded.allocation,
  note       = excluded.note
returning id, period_month, category, amount, allocation;

-- Expect 3 rows back, totalling 1,392.58.
--
-- The ON CONFLICT clause restates the expression index
-- operating_costs_month_category_vendor (period_month, category,
-- coalesce(vendor,'')). This shape has now run successfully twice in the
-- Supabase editor -- the rent file and the labour file, both 2026-10-05 -- so
-- the inference is confirmed by execution, not assumed.
--
-- A multi-row VALUES list with ON CONFLICT ... DO UPDATE is fine here because
-- the three rows have distinct `category` values and therefore cannot conflict
-- with EACH OTHER. Postgres raises 21000 ("ON CONFLICT DO UPDATE command
-- cannot affect row a second time") only when one statement hits the same
-- target row twice, which needs two identical keys in the same VALUES list.


-- ---------------------------------------------------------------------------
-- PART 3 -- what the P&L now says. Run this after PART 2.
-- ---------------------------------------------------------------------------
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

-- EXPECTED: overhead = 12892.58, overhead_rows = 4, direct_labor = 1807.80,
-- direct_labor_rows = 1, direct_storage = NULL, net_profit = NULL,
-- why = 'net_profit NULL: no direct_storage row for this month'.
--
-- 12892.58 = 11500.00 rent + 836.26 software + 426.32 telecom + 130.00 fees.
-- overhead_rows = 4 is the load-bearing check: it counts rows, so it rises from
-- 1 to 4 only if all three landed. A total that moved but a count that did not
-- reach 4 means one row went in under an unexpected category.
--
-- September's recorded cost is now 14,700.38 against the 13,307.80 before this
-- file -- so the first two files, taken alone, understated the month by almost
-- 10%.


-- ---------------------------------------------------------------------------
-- PART 4 -- OPTIONAL. Settles the postage question. Reads only, changes nothing.
-- ---------------------------------------------------------------------------
-- Run this to decide whether the excluded $370.75 belongs anywhere. It asks
-- whether September's order_charges already carry carrier cost: if they do,
-- postage is in direct_cost and must NOT be added as overhead.
select
  count(*)                                     as sept_charges,
  count(cost)                                  as charges_with_cost,
  count(*) filter (where cost is null)         as charges_cost_unknown,
  sum(cost)                                    as sept_direct_cost
from order_charges
where date_trunc('month', charge_date)::date = '2026-09-01';

-- charges_with_cost > 0 and sept_direct_cost in the hundreds -> postage is
--   already being captured per shipment. Leave it out of operating_costs; it
--   is in direct_cost. Nothing more to do.
-- sept_charges = 0 -> there is no September revenue or cost in order_charges at
--   all, which is consistent with the statement showing no customer deposits.
--   Then net_profit's revenue term is also NULL and the postage question is
--   moot until orders are flowing.
-- charges_with_cost = 0 but sept_charges > 0 -> charges exist with NO cost
--   recorded. Postage is then captured NOWHERE, and the $355.00 of Stamps
--   top-ups plus 15.75 UPS is a genuine gap -- but fixing it belongs on the
--   order_charges side, per shipment, not as a lump of overhead that would
--   mis-time the expense into the month the wallet was funded.
