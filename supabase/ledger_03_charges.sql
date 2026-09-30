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
-- A normalised order number to join shipments to orders on.
-- ---------------------------------------------------------------------------
-- orders.order_key is upper-cased and trimmed at write time (sync/zenventory.ts)
-- while shipments.order_number is whatever the carrier sent. Task 14 therefore
-- has to match them case-insensitively -- but a case-insensitive match done only
-- in memory is a trap: the rows still have to be FETCHED first, and PostgREST's
-- `.in()` is a case-SENSITIVE SQL `IN`. A label whose order number arrives in a
-- third casing is never retrieved, so the in-memory normalisation never sees it
-- and the shipping revenue is lost silently rather than loudly.
--
-- A stored generated column makes the fetch and the join agree by construction,
-- and is indexable, which `upper(order_number)` in a predicate would not be
-- without a matching expression index anyway.
--
-- NOTE: adding a stored generated column rewrites the table. On a shipments
-- table of this size that is seconds, but it is not instantaneous -- do not run
-- it in the middle of a sync.
alter table shipments add column if not exists order_number_key text
  generated always as (upper(btrim(order_number))) stored;
create index if not exists shipments_order_number_key_idx
  on shipments (order_number_key);

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
  -- NULLABLE, for the same reason `cost` is. An at-cost freight line is billed
  -- at whatever the carrier charged, so until the carrier reports we do not
  -- know the revenue either. Storing 0 there is a claim that the label was
  -- given away free, and it understates revenue in every view that sums this
  -- column -- the exact null-versus-zero confusion this project exists to stop.
  amount             numeric(10,2),
  cost               numeric(10,2),
  cost_basis         text,
  charge_date        date not null,
  charge_date_source text,
  source             text not null,
  is_estimate        boolean not null default false,
  calculated_at      timestamptz default now(),

  -- A cost figure with no basis is a number whose provenance nobody can state,
  -- and every screen downstream would render it as measured. Note the converse is
  -- deliberately allowed: cost null with cost_basis null is the honest
  -- representation of "we do not know what this cost", which is different from
  -- "it was free" (cost = 0).
  constraint order_charges_cost_has_basis
    check (cost is null or cost_basis is not null)
);

-- `create table if not exists` does nothing to a table that already exists, and
-- an earlier draft of this file created `amount` as NOT NULL. Without this, a
-- database that has already had that draft applied rejects every at-cost
-- freight charge whose carrier cost has not been reported -- which is a whole
-- order's charges failing, not one row. Guarded and idempotent, in the same
-- shape as the two `client_warehouse_rates` alters further down.
do $$
begin
  alter table order_charges alter column amount drop not null;
exception when others then
  raise notice 'order_charges.amount was already nullable';
end $$;

-- Two unique indexes, for the same reason `orders` needed two. Not every charge
-- belongs to an order: storage is billed monthly against a client, and
-- unattributed label spend belongs to neither. A single
-- unique (order_id, charge_key) would not constrain those rows at all, so the
-- one category of charge that CANNOT be re-derived from an order document would
-- be the one silently duplicated three times a day.
--
-- The FIRST index is deliberately NOT partial, and must stay that way.
-- A `where order_id is not null` predicate on it would be semantically free --
-- it only excludes rows that NULL-distinctness leaves unconstrained anyway --
-- but it breaks the charge calculator outright. PostgREST's on_conflict
-- parameter emits only a column list, never an index predicate, so supabase-js
-- `.upsert(..., { onConflict: 'order_id,charge_key' })` produces
-- `on conflict (order_id, charge_key)` with no where clause. Postgres cannot
-- infer a PARTIAL index from that and raises 42P10, "no unique or exclusion
-- constraint matching the ON CONFLICT specification" -- on every single batch,
-- so ZERO charges are ever written. This is the identical trap that
-- ledger_01_orders.sql documents for orders_client_order_key. The drop below
-- exists because an earlier draft of this file created it partial; re-running
-- this migration converts it.
--
-- The drop and the create are one atomic step, and the drop is conditional.
-- Written as a bare `drop index` followed by `create unique index`, this file's
-- own "safe to run more than once" header was not quite true: between the two
-- statements there is NO unique index on (order_id, charge_key), and if the
-- create then fails -- it fails if the table already holds a duplicate pair --
-- that window never closes, leaving exactly the unconstrained table the
-- three-index design exists to prevent. A PL/pgSQL block WITH an exception
-- handler runs its body in a subtransaction, so a failed create rolls the drop
-- back with it: the index is either its old shape or its new one, never absent.
-- The `indpred is not null` test also makes a re-run a genuine no-op instead of
-- a needless drop and rebuild.
do $$
begin
  if exists (
    select 1
    from   pg_index i
    join   pg_class c on c.oid = i.indexrelid
    where  c.relname = 'order_charges_order_key'
      and  i.indpred is not null
  ) then
    raise notice 'order_charges_order_key is partial; converting it to non-partial';
    drop index order_charges_order_key;
  end if;

  create unique index if not exists order_charges_order_key
    on order_charges (order_id, charge_key);
exception when unique_violation then
  raise exception 'order_charges already holds duplicate (order_id, charge_key) rows, '
                  'so the unique index cannot be created (%). The previous index has been '
                  'restored, so nothing is left unconstrained. Reconcile the duplicates '
                  'and re-run this file.', sqlerrm;
end $$;

-- This one stays partial, and it is exactly what still covers the rows the
-- index above stops constraining once its predicate is gone: order-less charges
-- (storage, billed monthly against a client). NULLs are distinct in SQL, so
-- `unique (order_id, charge_key)` never constrained an order_id-null row,
-- partial predicate or not -- dropping the predicate moves no coverage. Nothing
-- upserts these rows by ON CONFLICT inference, so the 42P10 problem above does
-- not apply to it. Same division of labour as
-- orders_client_order_key / orders_source_order_key.
--
-- TASK 18 WARNING: because this index IS partial, a storage charge written with
-- `.upsert(..., { onConflict: 'client_id,charge_key' })` will hit the same
-- 42P10. Storage must use a different write strategy (read-then-insert/update,
-- or a plain insert guarded by a prior delete of the period's rows).
create unique index if not exists order_charges_client_key
  on order_charges (client_id, charge_key) where order_id is null and client_id is not null;

-- Neither partial index above covers a row with BOTH order_id and client_id
-- null. No path in this plan produces one -- unattributed label spend is
-- reported by leaks_monthly.unattributed_label_spend rather than written as a
-- charge, and storage charges always carry a client_id. This index exists
-- because "unreachable" is a claim about code not yet written, and the cost of
-- being wrong is asymmetric: an absent constraint here means the thrice-daily
-- cron inserts a fresh copy of the same charge every run, and the ledger
-- triples while still looking plausible.
create unique index if not exists order_charges_unattributed_key
  on order_charges (charge_key)
  where order_id is null and client_id is null;

create index if not exists order_charges_order_idx on order_charges (order_id);
create index if not exists order_charges_client_date_idx
  on order_charges (client_id, charge_date);
create index if not exists order_charges_type_date_idx
  on order_charges (charge_type, charge_date);
-- The stale-delete in Task 14 scans by (order_id, calculated_at); the composite
-- index satisfies that filter+sort without a table scan.
create index if not exists order_charges_calculated_idx
  on order_charges (order_id, calculated_at);

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
