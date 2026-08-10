-- ============================================================
-- Referral Program payout tracking
-- Implements Shipo's real partner-referral economics on top of
-- the referral_partners / referral_payouts tables:
--   • $300 one-time bonus, ADDITIVE, owed after the referred
--     client's first payment.
--   • 8% commission on the FBA-prep invoice ONLY (not all
--     revenue), paid monthly for 12 months from client signup.
--
-- Reviewable, idempotent file — apply manually in the Supabase
-- SQL editor. Safe to run whether or not campaigns_pnl.sql has
-- already been applied.
-- ============================================================

create extension if not exists "uuid-ossp";

-- REFERRAL PARTNERS (people/companies who refer FBA sellers) ---
-- (create if campaigns_pnl.sql hasn't run yet; else no-op)
create table if not exists referral_partners (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  company text,
  email text,
  phone text,
  commission_type text default 'flat',
  commission_value numeric(10,2) default 0,
  status text default 'active',
  notes text,
  created_at timestamptz default now()
);

-- Extra columns to hold the Forminator sign-up payload + review state
alter table referral_partners add column if not exists partner_type text;      -- agency, consultant, other
alter table referral_partners add column if not exists refer_method text;       -- free-text "how will you refer"
alter table referral_partners add column if not exists source text default 'manual'; -- manual | website_form
alter table referral_partners add column if not exists updated_at timestamptz default now();
-- status may now be: pending (from website form, awaiting review), active, inactive

-- CLIENTS: referral attribution + the two payout clocks ---------
alter table clients add column if not exists referral_partner_id uuid references referral_partners(id);
alter table clients add column if not exists referral_signup_date date;          -- starts the 12-month 8% window
alter table clients add column if not exists referral_first_payment_date date;   -- triggers the $300 bonus

-- FBA PREP INVOICES (the base for the 8% — dedicated entry) -----
-- 8% is computed ONLY off these amounts, never off total client
-- revenue. One row per referred client per month.
create table if not exists fba_invoices (
  id uuid primary key default uuid_generate_v4(),
  client_id uuid references clients(id) on delete cascade,
  period date not null,               -- first day of the invoice month, e.g. 2026-08-01
  amount numeric(10,2) not null,      -- the FBA-prep invoice total for that month
  notes text,
  created_at timestamptz default now()
);
create unique index if not exists fba_invoices_client_period_uniq
  on fba_invoices (client_id, period);

alter table fba_invoices enable row level security;

-- REFERRAL PAYOUTS (the ledger — every row approved by Ophir) ---
create table if not exists referral_payouts (
  id uuid primary key default uuid_generate_v4(),
  referral_partner_id uuid references referral_partners(id) on delete cascade,
  client_id uuid references clients(id),
  amount numeric(10,2) not null,
  period text,
  status text default 'pending',      -- pending, approved, paid
  approved_by text,
  approved_at timestamptz,
  paid_at timestamptz,
  notes text,
  created_at timestamptz default now()
);

alter table referral_payouts add column if not exists kind text default 'commission'; -- signup_bonus | commission
alter table referral_payouts add column if not exists fba_invoice_id uuid references fba_invoices(id) on delete set null;
alter table referral_payouts add column if not exists updated_at timestamptz default now();
-- Natural key so payout generation is idempotent (one bonus + one
-- commission per client per month):
alter table referral_payouts add column if not exists dedupe_key text;
create unique index if not exists referral_payouts_dedupe_uniq
  on referral_payouts (dedupe_key);

alter table referral_partners enable row level security;
alter table referral_payouts enable row level security;
