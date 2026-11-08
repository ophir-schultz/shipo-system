-- PROPOSAL. Do not run. This file does not insert, update, or delete.
--
-- Name: propose_nayax_oct6_zone_shipping_2026_11_08
-- This is not a charge backfill. The denied 701 backfill is not this file.
-- This is not supabase/propose_charge_date_repair_2026_11_08.sql.
-- This is not supabase/warehouse_freight_shipment.sql.
--
-- 23 Nayax orders placed 2026-10-06, each with one shipment whose
-- date-only ship day is 2026-10-07. None is cancelled. None is voided.
-- Each already has a zone price in shipments.client_rate. Those 23
-- rates sum to 539.58. None of the 23 has an order_charges row.
--
-- The charge run on 2026-11-06 loaded orders with order_date on or
-- after 2026-10-07 (UTC today minus 30 days). These orders are dated
-- 2026-10-06, so they were not loaded and their labels were not
-- charged. Pick charges are still dated by pick_date. This list does
-- not invent a pick and does not use carrier cost or manual freight.
--
-- A run on 2026-11-08 uses a window start of 2026-10-09, so these
-- October 7 labels are already outside that 30-day window. Changing
-- the loader does not bill them. Billing them needs a separate
-- approval in your own words. Do not run a recalc to apply this list.

-- Read only. Expect 23 rows, sum(client_rate) = 539.58, and zero charges.
select s.order_number,
       s.client_rate,
       s.raw_data->>'shipDate' as carrier_day,
       o.order_date,
       o.cancelled
from public.shipments s
join public.orders o
  on o.client_id = s.client_id
 and o.order_number = s.order_number
where s.order_number in (
  'SO601060842', 'SO601060976', 'SO601060977', 'SO601061006',
  'SO601061010', 'SO601061035', 'SO601061037', 'SO601061039',
  'SO601061040', 'SO601061041', 'SO601061042', 'SO601061043',
  'SO601061044', 'SO601061045', 'SO601061046', 'SO601061047',
  'SO601061048', 'SO601061049', 'SO601061050', 'SO601061051',
  'SO601061052', 'SO601061053', 'SO601061054'
)
order by s.order_number;
