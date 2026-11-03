-- Read-only cross-check for the dashboard tabs.
-- SELECT only. Nothing here inserts, updates, or deletes.
--
-- Dates are America/New_York calendar dates. Set the four variables
-- to the same window the screen is using before you compare.
-- ship_date is timestamptz, so the bounds are Eastern midnight in UTC.
-- log_date, charge_date, and adjustment_date are dates, compared as dates.
--
-- Shipping revenue on the dashboard counts a shipment only when BOTH
-- client_rate and actual_cost are present. Each is rounded to cents,
-- then summed. A null is left out, not treated as zero.
-- Warehouse and manual charges are added beside that, not inside the margin.

-- Edit these four lines to match the screen.
-- Example for 3 Nov 2026, week starting Sunday 1 Nov, month and year to date:
--   week_start  2026-11-01
--   month_start 2026-11-01
--   year_start  2026-01-01
--   today       2026-11-03

with bounds as (
  select
    date '2026-11-01' as week_start,
    date '2026-11-01' as month_start,
    date '2026-01-01' as year_start,
    date '2026-11-03' as today
)
select 'dashboard shipping, week' as figure,
  count(*) filter (where client_rate is not null and actual_cost is not null) as reconciled_rows,
  count(*) as rows_read,
  round(sum(round(client_rate * 100)) filter (where client_rate is not null and actual_cost is not null) / 100.0, 2) as revenue,
  round(sum(round(actual_cost * 100)) filter (where client_rate is not null and actual_cost is not null) / 100.0, 2) as cost
from shipments, bounds
where ship_date >= (bounds.week_start::timestamp at time zone 'America/New_York')

union all
select 'dashboard shipping, month',
  count(*) filter (where client_rate is not null and actual_cost is not null),
  count(*),
  round(sum(round(client_rate * 100)) filter (where client_rate is not null and actual_cost is not null) / 100.0, 2),
  round(sum(round(actual_cost * 100)) filter (where client_rate is not null and actual_cost is not null) / 100.0, 2)
from shipments, bounds
where ship_date >= (bounds.month_start::timestamp at time zone 'America/New_York')

union all
select 'dashboard shipping, year',
  count(*) filter (where client_rate is not null and actual_cost is not null),
  count(*),
  round(sum(round(client_rate * 100)) filter (where client_rate is not null and actual_cost is not null) / 100.0, 2),
  round(sum(round(actual_cost * 100)) filter (where client_rate is not null and actual_cost is not null) / 100.0, 2)
from shipments, bounds
where ship_date >= (bounds.year_start::timestamp at time zone 'America/New_York')

union all
select 'dashboard warehouse log, month',
  count(*) filter (where total is not null),
  count(*),
  round(sum(total) filter (where total is not null), 2),
  null
from warehouse_daily_log, bounds
where log_date >= bounds.month_start

union all
select 'dashboard manual charges, month, approved',
  count(*),
  count(*),
  round(sum(amount), 2),
  null
from manual_charges, bounds
where approved and charge_date >= bounds.month_start

union all
select 'dashboard pending adjustments',
  count(*),
  count(*),
  round(sum(adjustment_amount), 2),
  null
from rate_adjustments
where status = 'pending'

union all
select 'adjustments billed',
  count(*),
  count(*),
  round(sum(adjustment_amount), 2),
  null
from rate_adjustments
where status = 'billed'

union all
select 'adjustments waived',
  count(*),
  count(*),
  round(sum(adjustment_amount), 2),
  null
from rate_adjustments
where status = 'waived'

union all
select 'clients active',
  count(*),
  count(*),
  null,
  null
from clients
where active

union all
select 'warehouse log today',
  count(*) filter (where total is not null),
  count(*),
  round(sum(total) filter (where total is not null), 2),
  null
from warehouse_daily_log, bounds
where log_date = bounds.today

union all
select 'statements order_charges this month',
  count(*) filter (where amount is not null),
  count(*),
  round(sum(amount) filter (where amount is not null), 2),
  null
from order_charges, bounds
where charge_date >= bounds.month_start
  and charge_date <= bounds.today

union all
select 'bills latest 10 grand total',
  count(*),
  count(*),
  round(sum(grand_total), 2),
  null
from (
  select grand_total
  from bills
  order by week_start desc, id desc
  limit 10
) latest

union all
select 'quotes rate sheets',
  count(*),
  count(*),
  null,
  null
from rate_sheets;

-- Employees are auth.users, not a public table. Count them in the
-- Supabase Auth admin screen. This file does not read auth.users.
