-- Enable UUID extension
create extension if not exists "uuid-ossp";

-- CLIENTS
create table clients (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  email text,
  phone text,
  active boolean default true,
  created_at timestamptz default now()
);

-- CLIENT SHIPPING RATES (per carrier/service)
create table client_shipping_rates (
  id uuid primary key default uuid_generate_v4(),
  client_id uuid references clients(id) on delete cascade,
  carrier text not null, -- UPS, FedEx, USPS, Stamps
  service text not null, -- Ground, Express, Priority, etc.
  rate numeric(10,2) not null,
  weight_min numeric(6,2) default 0,
  weight_max numeric(6,2),
  created_at timestamptz default now()
);

-- CLIENT WAREHOUSE RATES (pick&pack, storage, receiving, etc.)
create table client_warehouse_rates (
  id uuid primary key default uuid_generate_v4(),
  client_id uuid references clients(id) on delete cascade,
  service_type text not null, -- pick_pack, storage, receiving, special_task
  rate numeric(10,2) not null,
  unit text default 'per_unit', -- per_unit, per_pallet, per_hour, flat
  created_at timestamptz default now()
);

-- SHIPMENTS (pulled from ShipStation + Stamps.com)
create table shipments (
  id uuid primary key default uuid_generate_v4(),
  client_id uuid references clients(id),
  order_number text not null,
  order_date timestamptz,
  ship_date timestamptz,
  carrier text,
  service text,
  tracking_number text,
  recipient_name text,
  recipient_city text,
  recipient_state text,
  recipient_zip text,
  weight numeric(8,2),
  actual_cost numeric(10,2),   -- what we paid the carrier
  client_rate numeric(10,2),   -- what we charge the client
  profit_loss numeric(10,2),   -- client_rate - actual_cost
  is_loss boolean default false,
  source text default 'shipstation', -- shipstation, stamps
  raw_data jsonb,
  created_at timestamptz default now()
);

-- RATE ADJUSTMENTS (post-shipment carrier adjustments)
create table rate_adjustments (
  id uuid primary key default uuid_generate_v4(),
  shipment_id uuid references shipments(id),
  client_id uuid references clients(id),
  order_number text not null,
  original_cost numeric(10,2),
  adjusted_cost numeric(10,2),
  adjustment_amount numeric(10,2),
  reason text,
  adjustment_date timestamptz,
  status text default 'pending', -- pending, approved, billed
  billed_to_client boolean default false,
  created_at timestamptz default now()
);

-- WAREHOUSE DAILY LOG (team fills this out daily)
create table warehouse_daily_log (
  id uuid primary key default uuid_generate_v4(),
  client_id uuid references clients(id),
  log_date date not null,
  service_type text not null,
  quantity numeric(10,2) default 1,
  rate numeric(10,2),
  total numeric(10,2),
  notes text,
  logged_by uuid,
  created_at timestamptz default now()
);

-- MANUAL CHARGES (special tasks, one-off fees)
create table manual_charges (
  id uuid primary key default uuid_generate_v4(),
  client_id uuid references clients(id),
  charge_date date not null,
  description text not null,
  amount numeric(10,2) not null,
  added_by uuid,
  approved boolean default false,
  created_at timestamptz default now()
);

-- WEEKLY BILLS
create table bills (
  id uuid primary key default uuid_generate_v4(),
  client_id uuid references clients(id),
  week_start date not null,
  week_end date not null,
  shipping_total numeric(10,2) default 0,
  warehouse_total numeric(10,2) default 0,
  adjustments_total numeric(10,2) default 0,
  manual_charges_total numeric(10,2) default 0,
  grand_total numeric(10,2) default 0,
  status text default 'draft', -- draft, sent, paid
  created_at timestamptz default now()
);

-- BILL LINE ITEMS
create table bill_line_items (
  id uuid primary key default uuid_generate_v4(),
  bill_id uuid references bills(id) on delete cascade,
  item_type text not null, -- shipment, adjustment, warehouse, manual
  reference_id uuid,
  description text,
  quantity numeric(10,2) default 1,
  unit_rate numeric(10,2),
  total numeric(10,2),
  created_at timestamptz default now()
);

-- USERS / TEAM
create table team_members (
  id uuid primary key default uuid_generate_v4(),
  email text unique not null,
  full_name text,
  role text default 'team_member', -- admin, manager, team_member
  active boolean default true,
  created_at timestamptz default now()
);

-- Enable RLS on all tables
alter table clients enable row level security;
alter table client_shipping_rates enable row level security;
alter table client_warehouse_rates enable row level security;
alter table shipments enable row level security;
alter table rate_adjustments enable row level security;
alter table warehouse_daily_log enable row level security;
alter table manual_charges enable row level security;
alter table bills enable row level security;
alter table bill_line_items enable row level security;
alter table team_members enable row level security;
