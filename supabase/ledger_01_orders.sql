-- Complete the ledger, migration 1 of 4: the order side.
-- Spec: docs/superpowers/specs/2026-09-29-complete-the-ledger-design.md §5.2
-- Apply order: ledger_01_orders -> ledger_02_cost -> ledger_03_charges
--              -> ledger_04_views
-- Safe to run more than once.

-- One ShipStation store belongs to exactly one client. The unique index is on
-- store_id alone, not (client_id, store_id): the whole point is that a store
-- cannot map two ways.
create table if not exists client_store_ids (
  id         uuid primary key default uuid_generate_v4(),
  client_id  uuid not null references clients(id),
  store_id   text not null,
  store_name text,
  created_at timestamptz default now()
);
create unique index if not exists client_store_ids_store_id_key
  on client_store_ids (store_id);

-- An order exists whether or not it ever becomes a shipment. This is the
-- anchor the whole ledger hangs from.
create table if not exists orders (
  id             uuid primary key default uuid_generate_v4(),
  client_id      uuid references clients(id),
  order_key      text not null,
  order_number   text not null,
  source         text not null,
  order_date     date,
  cancelled      boolean default false,
  cancelled_date date,
  created_at     timestamptz default now()
);

-- Two partial indexes, not one. `unique (client_id, order_key)` does not
-- constrain rows where client_id is null, because NULLs are distinct in SQL,
-- so unattributed orders would duplicate silently on every run.
create unique index if not exists orders_client_order_key
  on orders (client_id, order_key) where client_id is not null;
create unique index if not exists orders_source_order_key
  on orders (source, order_key) where client_id is null;
create index if not exists orders_order_date_idx on orders (order_date);

-- One row per line. line_ordinal exists because the sync deletes and reinserts
-- lines, which destroys the UUID a watermark is stored against; and SKU alone
-- is not a key, because kits repeat the same SKU on several lines.
create table if not exists order_items (
  id                    uuid primary key default uuid_generate_v4(),
  order_id              uuid references orders(id) on delete cascade,
  source                text not null,
  line_ordinal          int  not null,
  sku                   text,
  description           text,
  quantity_ordered      numeric(10,2),
  quantity_picked       numeric(10,2),
  is_component          boolean,
  classification_source text,
  pick_date             date,
  pick_date_source      text,
  is_estimate           boolean default false,
  unique (order_id, source, line_ordinal)
);
create index if not exists order_items_pick_date_idx
  on order_items (pick_date) where pick_date is not null;
create index if not exists order_items_sku_idx on order_items (sku);

-- Records each run so that a missed day is detectable rather than silently
-- becoming a gap in the pick history. client_id is per-row because Zenventory
-- syncs per client and a 401 on one client must be recordable without marking
-- the whole run failed.
create table if not exists sync_runs (
  id               uuid primary key default uuid_generate_v4(),
  source           text not null,
  client_id        uuid references clients(id),
  mode             text not null,
  window_start     date,
  window_end       date,
  started_at       timestamptz not null default now(),
  finished_at      timestamptz,
  status           text not null,
  rows_seen        int default 0,
  rows_written     int default 0,
  unpriced_before  int,
  unpriced_after   int,
  errors           jsonb default '[]'::jsonb,
  created_at       timestamptz default now()
);
create index if not exists sync_runs_source_started_idx
  on sync_runs (source, started_at desc);
