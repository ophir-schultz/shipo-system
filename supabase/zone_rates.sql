-- ============================================================
-- ZONE-BASED SHIPPING RATE MATRIX (Weight LB × Zone 1-8)
-- ============================================================

-- One row per (client, carrier, service, weight_lb, zone) cell of the matrix.
create table if not exists client_zone_rates (
  id          uuid primary key default uuid_generate_v4(),
  client_id   uuid references clients(id) on delete cascade,
  carrier     text not null default '',   -- '' = blanket rate card (any carrier)
  service     text not null default '',   -- '' = blanket rate card (any service)
  weight_lb   integer not null,           -- matrix row: 1..20 (whole pounds)
  zone        integer not null,           -- matrix column: 1..8
  rate        numeric(10,2) not null,
  created_at  timestamptz default now(),
  unique (client_id, carrier, service, weight_lb, zone)
);
create index if not exists idx_zone_rates_lookup
  on client_zone_rates (client_id, carrier, service, weight_lb, zone);

alter table client_zone_rates enable row level security;

-- Each shipment's resolved delivery zone (1..8), filled in during billing.
alter table shipments add column if not exists zone integer;

-- Warehouse origin ZIP per client, used to derive zone from recipient ZIP.
alter table clients add column if not exists origin_zip text;

-- Optional ZIP-prefix → zone chart (destination 3-digit ZIP prefix → zone),
-- scoped to an origin 3-digit prefix. Populate from your carrier's zone chart.
create table if not exists zone_chart (
  id            uuid primary key default uuid_generate_v4(),
  origin_prefix text not null,   -- first 3 digits of origin ZIP
  dest_prefix   text not null,   -- first 3 digits of destination ZIP
  zone          integer not null,
  unique (origin_prefix, dest_prefix)
);
create index if not exists idx_zone_chart_lookup on zone_chart (origin_prefix, dest_prefix);

alter table zone_chart enable row level security;
