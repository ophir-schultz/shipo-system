-- Per-client price lists for the P&L pricing engine.
--
-- ADD ONLY. This file creates tables. It does not update or delete any
-- existing table, and it does not insert rows. Do not run it from the app.
-- The Nayax rates live in price-lists/nayax.json and are loaded by the
-- upload on the client page (POST /api/clients/[id]/price-lists), which
-- inserts a new row and leaves earlier uploads in place.
--
-- Safe to run more than once.

create table if not exists client_price_lists (
  id uuid primary key default uuid_generate_v4(),
  client_id uuid references clients(id),
  name text not null,
  document jsonb not null,
  source_filename text,
  uploaded_by text,
  created_at timestamptz default now()
);

create index if not exists client_price_lists_client_created_idx
  on client_price_lists (client_id, created_at desc);

alter table client_price_lists enable row level security;

-- One row of the client billing workbook (the columns on the Nayax sheet).
-- Prices may be blank when the row was imported before it was priced.
create table if not exists client_billing_lines (
  id uuid primary key default uuid_generate_v4(),
  client_id uuid references clients(id),
  order_number text not null,
  line_date date,
  recipient_name text,
  tracking_number text,
  sku text,
  qty text,
  qty_count numeric,
  serial_number text,
  pick_price numeric(12,2),
  box_price numeric(12,2),
  shipping_price numeric(12,2),
  total numeric(12,2),
  zone text,
  zipcode text,
  weight text,
  volume_weight text,
  source text default 'import',
  created_at timestamptz default now()
);

create index if not exists client_billing_lines_client_date_idx
  on client_billing_lines (client_id, line_date);

alter table client_billing_lines enable row level security;

-- Finance approves a client report for a date range inside the system.
-- Download reads this table. Nothing in the app emails the report.
create table if not exists client_report_approvals (
  id uuid primary key default uuid_generate_v4(),
  client_id uuid references clients(id),
  period_from date not null,
  period_to date not null,
  status text not null default 'approved',
  approved_by text,
  approved_at timestamptz default now(),
  created_at timestamptz default now()
);

create index if not exists client_report_approvals_period_idx
  on client_report_approvals (client_id, period_from, period_to);

alter table client_report_approvals enable row level security;
