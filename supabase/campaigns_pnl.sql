-- ============================================================
-- Campaigns + P&L migration
-- Adds marketing-channel ROI, referral tracking, and inbound
-- shipment logging on top of the existing schema.
-- Reviewable file — apply manually in Supabase SQL editor.
-- ============================================================

create extension if not exists "uuid-ossp";

-- CAMPAIGNS (marketing channels / outreach motions)
create table if not exists campaigns (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  channel text not null,        -- dtc_email, fba_linkedin, partner_linkedin, seo, backlinks, spn, other
  status text default 'active', -- active, paused, ended
  start_date date,
  end_date date,
  monthly_cost numeric(10,2) default 0,   -- recurring spend
  one_time_cost numeric(10,2) default 0,  -- setup / one-off spend
  notes text,
  created_at timestamptz default now()
);

alter table campaigns enable row level security;

-- REFERRAL PARTNERS (people/companies who refer clients)
create table if not exists referral_partners (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  company text,
  email text,
  phone text,
  commission_type text default 'flat', -- flat, percent
  commission_value numeric(10,2) default 0, -- $ if flat, % if percent
  status text default 'active',        -- active, inactive
  notes text,
  created_at timestamptz default now()
);

alter table referral_partners enable row level security;

-- REFERRAL PAYOUTS (each payout to a partner — approved by Ophir before sending)
create table if not exists referral_payouts (
  id uuid primary key default uuid_generate_v4(),
  referral_partner_id uuid references referral_partners(id) on delete cascade,
  client_id uuid references clients(id),
  amount numeric(10,2) not null,
  period text,                    -- e.g. '2026-08' or 'Q3 2026'
  status text default 'pending',  -- pending, approved, paid
  approved_by text,
  approved_at timestamptz,
  paid_at timestamptz,
  notes text,
  created_at timestamptz default now()
);

alter table referral_payouts enable row level security;

-- INBOUND SHIPMENTS (receiving log — the "packing list" feeding P&L)
create table if not exists inbound_shipments (
  id uuid primary key default uuid_generate_v4(),
  client_id uuid references clients(id),
  reference text,                 -- PO / container / tracking ref
  received_date date,
  units integer default 0,
  our_cost numeric(10,2) default 0,     -- what receiving/handling cost us
  billed_amount numeric(10,2) default 0, -- what we bill the client
  notes text,
  created_at timestamptz default now()
);

alter table inbound_shipments enable row level security;

-- CLIENTS: attribute acquisition to a campaign / referral partner
alter table clients add column if not exists acquisition_campaign_id uuid references campaigns(id);
alter table clients add column if not exists acquisition_date date;
alter table clients add column if not exists referral_partner_id uuid references referral_partners(id);

-- ============================================================
-- Seed the known campaigns at $0 spend (edit costs later via form)
-- ============================================================
insert into campaigns (name, channel, status, start_date, monthly_cost, one_time_cost, notes)
select * from (values
  ('Shipo — Partner Program LinkedIn 2026', 'partner_linkedin', 'active', date '2026-08-08', 0::numeric, 0::numeric, 'HeyReach partner-referral outreach, campaign id 543002'),
  ('Shipo — FBA Client LinkedIn 2026',      'fba_linkedin',     'active', date '2026-08-08', 0::numeric, 0::numeric, 'HeyReach direct FBA-seller outreach, 4 segments'),
  ('Shipo — DTC Apollo Email',              'dtc_email',        'paused', date '2026-06-26', 0::numeric, 0::numeric, 'Apollo cold email — staged, currently frozen'),
  ('Shipo — Backlink / PR',                 'backlinks',        'active', date '2026-08-01', 0::numeric, 0::numeric, '90-day autonomous backlink agent'),
  ('Shipo — AI Search Optimization',        'seo',              'active', date '2026-08-01', 0::numeric, 0::numeric, 'AI Overviews / ChatGPT / Perplexity citation push'),
  ('Shipo — Amazon SPN',                    'spn',              'paused', null,               0::numeric, 0::numeric, 'Service Provider Network listing — planned')
) as v(name, channel, status, start_date, monthly_cost, one_time_cost, notes)
where not exists (select 1 from campaigns);
