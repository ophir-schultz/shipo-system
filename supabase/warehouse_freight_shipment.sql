-- Manual freight lines. One row is one shipment, not one day.
-- The same client and date may have several rows. Two prices for one
-- shipment may not.
--
-- DO NOT RUN until Ophir approves. Preview and production share this
-- database. This file is additive. It does not update or delete rows.
--
-- Rollback, after approval to remove the columns:
--   drop index if exists warehouse_daily_log_shipment_ref_key;
--   alter table warehouse_daily_log drop column if exists freight_markup;
--   alter table warehouse_daily_log drop column if exists freight_cost;
--   alter table warehouse_daily_log drop column if exists shipment_ref;

alter table warehouse_daily_log add column if not exists shipment_ref text;
alter table warehouse_daily_log add column if not exists freight_cost numeric(10,2);
alter table warehouse_daily_log add column if not exists freight_markup numeric(10,2);

comment on column warehouse_daily_log.shipment_ref is
  'ShipStation shipment id for one manual freight line. Null on ordinary log rows.';
comment on column warehouse_daily_log.freight_cost is
  'Staff-only carrier cost for that shipment. Not a client charge by itself.';
comment on column warehouse_daily_log.freight_markup is
  'Staff-typed markup added to freight_cost. Not a rate-card rate. Null when this row is not freight.';

create unique index if not exists warehouse_daily_log_shipment_ref_key
  on warehouse_daily_log (shipment_ref)
  where shipment_ref is not null and btrim(shipment_ref) <> '';
