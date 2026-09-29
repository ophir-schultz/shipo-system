-- Complete the ledger, migration 3 of 4: the charge record.
-- Spec: docs/superpowers/specs/2026-09-29-complete-the-ledger-design.md §5.2, §6
-- Requires ledger_01_orders.sql and ledger_02_cost.sql to have been applied.
-- Safe to run more than once.

-- ---------------------------------------------------------------------------
-- A stable identity for shipments.
-- order_number is not unique: multi-package orders, reships and return labels
-- all repeat it. ShipStation's shipmentId is the only stable key available.
-- ---------------------------------------------------------------------------
alter table shipments add column if not exists shipstation_shipment_id bigint;

-- Backfill from the payload we already store. No API call needed.
update shipments
set shipstation_shipment_id = (raw_data->>'shipmentId')::bigint
where shipstation_shipment_id is null
  and raw_data ? 'shipmentId'
  and raw_data->>'shipmentId' ~ '^[0-9]+$';

-- Partial, so rows with no shipmentId do not block the index. If this fails
-- with a unique violation, the database already holds duplicate shipment rows
-- from the insert-path defect (spec §3.2) and they must be reconciled before
-- this migration can complete. Stop and report rather than dropping the index.
create unique index if not exists shipments_shipstation_id_key
  on shipments (shipstation_shipment_id)
  where shipstation_shipment_id is not null;

-- ---------------------------------------------------------------------------
-- The margin record: the one table carrying both what we charged and what it
-- cost.
-- ---------------------------------------------------------------------------
create table if not exists order_charges (
  id                 uuid primary key default uuid_generate_v4(),
  order_id           uuid references orders(id) on delete cascade,
  client_id          uuid references clients(id),
  rate_id            uuid references client_warehouse_rates(id),
  cost_rate_id       uuid references cost_rates(id),
  charge_key         text not null,
  charge_type        text not null,
  label              text not null,
  quantity           numeric(10,2),
  unit_rate          numeric(10,4),
  amount             numeric(10,2) not null,
  cost               numeric(10,2),
  cost_basis         text,
  charge_date        date not null,
  charge_date_source text,
  source             text not null,
  is_estimate        boolean default false,
  calculated_at      timestamptz default now()
);

-- Two partial unique indexes, for the same reason `orders` needed two. Not
-- every charge belongs to an order: storage is billed monthly against a client,
-- and unattributed label spend belongs to neither. A single
-- unique (order_id, charge_key) would not constrain those rows at all, so the
-- one category of charge that CANNOT be re-derived from an order document would
-- be the one silently duplicated three times a day.
create unique index if not exists order_charges_order_key
  on order_charges (order_id, charge_key) where order_id is not null;
create unique index if not exists order_charges_client_key
  on order_charges (client_id, charge_key) where order_id is null;

create index if not exists order_charges_order_idx on order_charges (order_id);
create index if not exists order_charges_client_date_idx
  on order_charges (client_id, charge_date);
create index if not exists order_charges_type_date_idx
  on order_charges (charge_type, charge_date);
-- The stale-delete in Task 14 scans by (order_id, calculated_at).
create index if not exists order_charges_calculated_idx
  on order_charges (calculated_at);

-- ---------------------------------------------------------------------------
-- The client rate card gains structure and effective dates.
-- ---------------------------------------------------------------------------
alter table client_warehouse_rates add column if not exists category       text;
alter table client_warehouse_rates add column if not exists label          text;
alter table client_warehouse_rates add column if not exists rate_type      text;
alter table client_warehouse_rates add column if not exists description    text;
alter table client_warehouse_rates add column if not exists effective_from date;
alter table client_warehouse_rates add column if not exists effective_to   date;

-- `category` and `label` are the QUOTE's words, kept for display. `charge_type`
-- and `variant` are the CALCULATOR's words, used for lookup. They have to be
-- separate columns: Task 14 looks a rate up by (charge_type, variant), and
-- without these it would have to string-match on
-- 'Device pick + serial number scan' — which breaks the first time another
-- client's quote words the same service differently.
alter table client_warehouse_rates add column if not exists charge_type text;
alter table client_warehouse_rates add column if not exists variant     text;

create index if not exists client_warehouse_rates_lookup_idx
  on client_warehouse_rates (client_id, charge_type, variant, effective_from);

-- `at_cost` lines have no rate of their own: the amount is whatever the carrier
-- charged. Without dropping NOT NULL they cannot be expressed at all, and the
-- workaround — storing 0 — would read as "free", which is the exact
-- null-versus-zero confusion this project exists to stop.
do $$
begin
  alter table client_warehouse_rates alter column rate drop not null;
exception when others then
  raise notice 'client_warehouse_rates.rate was already nullable';
end $$;

-- `service_type` is `not null` in the original schema with no default, and its
-- four permitted values ('pick_pack', 'storage', 'receiving', 'special_task')
-- do not cover the eighteen quote lines. Left as it is, EVERY insert in Task 16
-- fails on a not-null violation. It is superseded by `charge_type` and kept
-- only so existing rows, and anything still reading it, are not broken.
do $$
begin
  alter table client_warehouse_rates alter column service_type drop not null;
exception when others then
  raise notice 'client_warehouse_rates.service_type was already nullable';
end $$;

-- ---------------------------------------------------------------------------
-- The zone chart holds a UPS chart. Now that UPS traffic is visible, a USPS
-- chart will need to sit BESIDE it, not replace it.
-- ---------------------------------------------------------------------------
alter table zone_chart add column if not exists carrier text;
update zone_chart set carrier = 'UPS' where carrier is null;
