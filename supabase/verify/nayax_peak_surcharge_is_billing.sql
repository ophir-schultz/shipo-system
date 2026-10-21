-- Is the Nayax peak surcharge actually producing money, or just existing?
--
-- The rate row is confirmed live (effective_from 2026-10-15, effective_to
-- 2027-01-16, in_effect_today true, covers_oct_14 false). That proves the RATE
-- is right. It does not prove a single dollar has been billed: the surcharge is
-- only written when recalculateCharges runs AND the order has a pick or pack
-- line to charge 8% of.
--
-- calculate-charges.ts:403  basis  = sum of charge_type in ('pick','pack') only
-- calculate-charges.ts:404  if (basis > 0)   <- no picks, no surcharge, silently
-- calculate-charges.ts:429  charge_key = 'surcharge:peak', one per ORDER
-- calculate-charges.ts:433  amount = cents(basis * pct / 100)
--
-- So a 0 in `orders_with_peak` below does NOT mean the rate is broken. It means
-- either the cron has not run since 2026-10-15 09:xx (it fires at 0,4,8,12,16,20
-- UTC over a rolling 30-day window), or Nayax has no pick/pack lines in the
-- window at all -- which would be its own, larger problem.
--
-- Read-only. Nothing here writes.

-- ---------------------------------------------------------------------------
-- 1. Per-day: what the surcharge raised, and whether it reconciles to 8%.
-- ---------------------------------------------------------------------------
-- The expected figure is summed from PER-ORDER rounding, not computed by
-- rounding the daily total. cents() rounds each order's surcharge
-- independently, so rounding the sum would disagree by a few cents on a busy
-- day and read as a defect when it is just arithmetic.
with nayax as (
  select id from clients where name ilike '%nayax%'
),
per_order as (
  select
    oc.order_id,
    oc.charge_date,
    sum(case when oc.charge_type in ('pick','pack') then coalesce(oc.amount,0) end) as pick_pack,
    sum(case when oc.charge_key = 'surcharge:peak'  then oc.amount end)             as peak,
    max(case when oc.charge_key = 'surcharge:peak'  then oc.unit_rate end)          as peak_pct
  from order_charges oc
  join nayax n on n.id = oc.client_id
  where oc.charge_date >= date '2026-10-15'
  group by oc.order_id, oc.charge_date
)
select
  charge_date,
  count(*)                                              as orders,
  count(*) filter (where pick_pack > 0)                 as orders_with_pick_pack,
  count(peak)                                           as orders_with_peak,
  -- The gap that matters: an order that HAS a pick/pack basis and got no
  -- surcharge is 8% left on the table for that order.
  count(*) filter (where pick_pack > 0 and peak is null) as missing_surcharge,
  round(sum(pick_pack), 2)                              as pick_pack_total,
  round(sum(coalesce(peak,0)), 2)                       as peak_billed,
  round(sum(round(pick_pack * 8 / 100, 2))
          filter (where pick_pack > 0), 2)              as peak_expected_at_8pct,
  -- Any percentage other than 8.00 appearing here means a second peak row is
  -- live, or the seed file was re-run with a different figure.
  string_agg(distinct peak_pct::text, ', ')             as pct_actually_used
from per_order
group by charge_date
order by charge_date;

-- ---------------------------------------------------------------------------
-- 2. The one-line answer.
-- ---------------------------------------------------------------------------
-- `verdict` is derived from the counts, not asserted. 'NOT YET RECALCULATED' is
-- the expected reading on the day the window opens and is not a failure.
with nayax as (
  select id from clients where name ilike '%nayax%'
),
per_order as (
  select
    oc.order_id,
    sum(case when oc.charge_type in ('pick','pack') then coalesce(oc.amount,0) end) as pick_pack,
    sum(case when oc.charge_key = 'surcharge:peak'  then oc.amount end)             as peak
  from order_charges oc
  join nayax n on n.id = oc.client_id
  where oc.charge_date >= date '2026-10-15'
  group by oc.order_id
)
select
  count(*)                                               as nayax_orders_since_oct_15,
  count(*) filter (where pick_pack > 0)                  as eligible_orders,
  count(peak)                                            as surcharged_orders,
  round(coalesce(sum(peak), 0), 2)                       as peak_revenue_so_far,
  case
    when count(*) = 0
      then 'NO NAYAX CHARGES AT ALL SINCE OCT 15 -- check the ledger cron, not the rate'
    when count(*) filter (where pick_pack > 0) = 0
      then 'NAYAX HAS NO PICK/PACK LINES IN THE WINDOW -- the 8% has nothing to apply to'
    when count(peak) = 0
      then 'NOT YET RECALCULATED -- rate is live, no surcharge written yet'
    when count(*) filter (where pick_pack > 0 and peak is null) > 0
      then 'PARTIAL -- some eligible orders carry no surcharge'
    else 'BILLING -- every eligible order carries a peak surcharge'
  end                                                    as verdict
from per_order;
