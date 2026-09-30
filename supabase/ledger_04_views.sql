-- Complete the ledger, migration 4 of 4: the rollup.
-- Spec: docs/superpowers/specs/2026-09-29-complete-the-ledger-design.md §5.8
-- Requires migrations 1-3. Safe to run more than once.

-- ---------------------------------------------------------------------------
-- pick_days: what was picked, per client per day per SKU.
-- A view, not a table, so it cannot drift from the lines it summarises.
-- ---------------------------------------------------------------------------
create or replace view pick_days as
with usable as (          -- only lines carrying real pick evidence
  select oi.*
  from order_items oi
  where oi.pick_date is not null
    and oi.quantity_picked > 0
),
preferred as (            -- one source per order: Zenventory wins
  select distinct on (u.order_id) u.order_id, u.source
  from usable u
  order by u.order_id, case u.source when 'zenventory' then 0 else 1 end
)
select o.client_id, u.pick_date, u.sku,
  max(u.description)      as description,
  bool_or(u.is_component) as is_component,
  count(distinct o.id)    as orders,
  sum(u.quantity_picked)  as units_picked,
  bool_or(u.is_estimate)  as has_estimates,
  min(case u.pick_date_source        -- 1 = least confident
        when 'pickprintdate' then 3
        when 'watermark'     then 2
        when 'modified_date' then 1
        else 0                       -- null/unknown: trust nothing
      end)                as confidence
from usable    u
join orders    o on o.id = u.order_id
join preferred p on p.order_id = u.order_id and p.source = u.source
where not o.cancelled
group by o.client_id, u.pick_date, u.sku;

-- ---------------------------------------------------------------------------
-- leaks_monthly: the six measured leaks. This is the direct answer to
-- "check where the leaks of money are", and it depends on no cost rate being
-- right. Deliberately NOT netted into pnl_monthly: see the migration header.
-- ---------------------------------------------------------------------------
create or replace view leaks_monthly as

-- 1. Label spend attributable to no order and no client.
select date_trunc('month', s.ship_date)::date as period_month,
       null::uuid                             as client_id,
       'unattributed_label_spend'             as leak,
       'Labels with no order number and no client' as detail,
       count(*)                               as records,
       coalesce(sum(s.actual_cost), 0)        as amount
from shipments s
where coalesce(nullif(trim(s.order_number), ''), null) is null
   or s.client_id is null
group by 1

union all

-- 2. Picked, not cancelled, and no charge was ever raised. This is an ABSENCE:
--    revenue that does not exist, not money that left. `amount` is null
--    because we cannot know what it would have been worth without a rate.
select date_trunc('month', oi.pick_date)::date, o.client_id,
       'picked_never_billed',
       'Orders picked and not cancelled with no pick charge',
       count(distinct o.id),
       null::numeric
from order_items oi
join orders o on o.id = oi.order_id
where oi.pick_date is not null
  and oi.quantity_picked > 0
  and not o.cancelled
  and not exists (
    select 1 from order_charges c
    where c.order_id = o.id and c.charge_type = 'pick')
group by 1, 2

union all

-- 3. Shipments with a cost but no charge: we paid and did not bill.
select date_trunc('month', s.ship_date)::date, s.client_id,
       'unpriced_shipments',
       'Shipments with a carrier cost and no shipping charge',
       count(*), coalesce(sum(s.actual_cost), 0)
from shipments s
where s.actual_cost is not null
  and not exists (
    select 1 from order_charges c
    where c.charge_key = 'shipment:' || s.shipstation_shipment_id::text)
group by 1, 2

union all

-- 4. Charges where what we billed is below what it cost us.
--    `c.cost is not null` is load-bearing: a null cost is UNKNOWN, and an
--    unknown cost is not evidence of a negative margin. Without this test
--    every un-costed charge would be reported as a leak.
select date_trunc('month', c.charge_date)::date, c.client_id,
       'negative_margin_lines',
       'Charges billed below cost',
       count(*), coalesce(sum(c.cost - c.amount), 0)
from order_charges c
where c.cost is not null and c.cost > c.amount
group by 1, 2

union all

-- 5. Carrier re-bills: the cost went up after the label was bought.
select date_trunc('month', a.adjustment_date)::date, a.client_id,
       'carrier_rebills',
       'Carrier raised the cost after purchase',
       count(*), coalesce(sum(a.adjustment_amount), 0)
from rate_adjustments a
where a.adjustment_amount > 0
group by 1, 2

union all

-- 6. Voided labels: bought then voided. Refund exposure until piece 2
--    reconciles against the actual statements. A negative adjustment_amount
--    is what a void or refund looks like, and it was structurally
--    unrecordable before Task 10 changed `diff > 0.01` to `abs(diff) > 0.01`.
select date_trunc('month', a.adjustment_date)::date, a.client_id,
       'voided_labels',
       'Labels purchased then voided or refunded',
       count(*), coalesce(sum(abs(a.adjustment_amount)), 0)
from rate_adjustments a
where a.adjustment_amount < 0
group by 1, 2;

-- ---------------------------------------------------------------------------
-- pnl_client_monthly: revenue and direct cost per client per month.
-- GROSS margin only. Overheads are not allocated across clients.
-- ---------------------------------------------------------------------------
create or replace view pnl_client_monthly as
select date_trunc('month', c.charge_date)::date as period_month,
       c.client_id,
       cl.name                                  as client_name,
       c.charge_type,
       count(*)                                 as charges,
       sum(c.amount)                            as revenue,
       -- sum() already skips nulls, so unknown costs do not become zeros.
       sum(c.cost)                              as cost_known,
       count(*) filter (where c.cost is null)   as cost_unknown_charges,
       sum(c.amount) - coalesce(sum(c.cost), 0) as gross_margin,
       bool_or(c.is_estimate)                   as has_estimates
from order_charges c
left join clients cl on cl.id = c.client_id
group by 1, 2, 3, 4;

-- ---------------------------------------------------------------------------
-- pnl_monthly: the business total, with overheads subtracted at the top.
-- ---------------------------------------------------------------------------
create or replace view pnl_monthly as
with revenue as (
  select date_trunc('month', charge_date)::date as period_month,
         sum(amount)                            as revenue,
         sum(cost)                              as direct_cost,
         count(*) filter (where cost is null)   as cost_unknown_charges,
         bool_or(is_estimate)                   as has_estimates
  from order_charges group by 1
),
overhead as (
  select period_month,
         sum(amount) filter (where allocation = 'overhead')       as overhead,
         sum(amount) filter (where allocation = 'direct_labor')   as direct_labor,
         sum(amount) filter (where allocation = 'direct_storage') as direct_storage
  from operating_costs group by 1
)
select coalesce(r.period_month, o.period_month) as period_month,
       r.revenue,
       r.direct_cost,
       r.cost_unknown_charges,
       r.revenue - coalesce(r.direct_cost, 0)   as gross_margin,
       o.overhead, o.direct_labor, o.direct_storage,
       -- Null propagates deliberately. Until operating_costs has a row for the
       -- month, net profit is UNKNOWN, and showing gross margin in its place
       -- would overstate profit by the entire overhead bill.
       r.revenue - coalesce(r.direct_cost, 0)
                 - o.overhead - o.direct_labor - o.direct_storage as net_profit,
       r.has_estimates
from revenue r
full outer join overhead o on o.period_month = r.period_month;
