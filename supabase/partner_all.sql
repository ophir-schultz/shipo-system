-- ============================================================
-- Shipo partner portal + partner logins — combined migration
-- partner_portal.sql followed by partner_login.sql, in order.
-- Idempotent: safe to run more than once.
-- ============================================================

-- ============================================================
-- Partner Portal + revised referral economics
--
-- SUPERSEDES the economics described in referral_program.sql.
-- The live public page (shipousa.com/partner-program/) and the
-- signed Referral Partner Agreement both say:
--
--   • $300 one-time bonus, ADDITIVE, owed after the referred
--     client's first payment.
--   • 5% of NET PROFIT on the referred client's whole account,
--     paid monthly for 12 months from the client's FIRST PAID
--     INVOICE (not from signup date).
--   • "Net profit" = amount invoiced to the client for the month
--     LESS the direct costs of serving that account: freight and
--     carrier charges, packaging and prep materials, storage, and
--     payment-processing fees. Warehouse labor is NOT deducted.
--   • Pass-through items billed at cost (freight, duties, Amazon
--     fees) generate no profit and are excluded entirely.
--   • A balance under $50 rolls into the following month.
--
-- This file is idempotent — apply it in the Supabase SQL editor.
-- Safe to run after referral_program.sql.
-- ============================================================

-- ---- fba_invoices: units + the four deductible cost buckets ----
-- NOTE on `amount`: under the 8% deal this held the FBA-prep
-- invoice only. Under the 5%-of-net-profit deal it holds the TOTAL
-- invoiced to the client for the month, before deductions.
alter table fba_invoices add column if not exists units_shipped integer default 0;
alter table fba_invoices add column if not exists cost_freight     numeric(10,2) default 0;  -- freight & carrier charges
alter table fba_invoices add column if not exists cost_materials   numeric(10,2) default 0;  -- packaging & prep materials
alter table fba_invoices add column if not exists cost_storage     numeric(10,2) default 0;  -- storage
alter table fba_invoices add column if not exists cost_processing  numeric(10,2) default 0;  -- payment processing
alter table fba_invoices add column if not exists updated_at timestamptz default now();

-- ---- referral_partners: portal access ----------------------------
-- A partner signs in with a long random token in the URL. There is
-- no password auth for external users. The token is revocable and
-- rotatable from the staff Referrals screen.
alter table referral_partners add column if not exists portal_token text;
alter table referral_partners add column if not exists portal_token_created_at timestamptz;
alter table referral_partners add column if not exists portal_last_seen_at timestamptz;

create unique index if not exists referral_partners_portal_token_uniq
  on referral_partners (portal_token)
  where portal_token is not null;

-- RLS stays on. The portal reads through the service-role client on
-- the server only — the token is never used to authenticate against
-- Supabase directly, and the anon key can still read nothing here.
alter table referral_partners enable row level security;
alter table fba_invoices enable row level security;


-- ============================================================
-- Partner portal login — email + 6-digit code
--
-- Partners are NOT Supabase Auth users, deliberately. The staff
-- proxy authorises on "is there a Supabase session", so giving a
-- partner a Supabase user would hand them /dashboard, /clients and
-- /billing. Partner sessions are a separate mechanism that can
-- never satisfy that check.
--
-- Nothing here stores a code or a session token in the clear —
-- only SHA-256 hashes. A leaked database row cannot be replayed
-- as a login.
--
-- Idempotent. Apply in the Supabase SQL editor after
-- partner_portal.sql.
-- ============================================================

create extension if not exists "uuid-ossp";

-- ---- one-time login codes ----------------------------------
create table if not exists partner_login_codes (
  id uuid primary key default uuid_generate_v4(),
  referral_partner_id uuid references referral_partners(id) on delete cascade,
  email text not null,
  code_hash text not null,          -- SHA-256 of the 6-digit code
  expires_at timestamptz not null,
  consumed_at timestamptz,
  attempts integer default 0,       -- wrong guesses against this code
  request_ip text,
  created_at timestamptz default now()
);

create index if not exists partner_login_codes_partner_idx
  on partner_login_codes (referral_partner_id, created_at desc);
create index if not exists partner_login_codes_email_idx
  on partner_login_codes (lower(email), created_at desc);

-- ---- portal sessions ---------------------------------------
create table if not exists partner_sessions (
  id uuid primary key default uuid_generate_v4(),
  referral_partner_id uuid references referral_partners(id) on delete cascade,
  token_hash text not null,         -- SHA-256 of the cookie value
  expires_at timestamptz not null,
  revoked_at timestamptz,
  user_agent text,
  created_at timestamptz default now(),
  last_seen_at timestamptz default now()
);

create unique index if not exists partner_sessions_token_uniq
  on partner_sessions (token_hash);
create index if not exists partner_sessions_partner_idx
  on partner_sessions (referral_partner_id);

-- A partner needs an email to log in at all. Enforced in the app
-- rather than the schema so an existing partner row without one
-- does not break the Referrals screen.

alter table partner_login_codes enable row level security;
alter table partner_sessions enable row level security;

-- ---- retire the bearer-link columns ------------------------
-- Superseded by real logins. Left in place (not dropped) so no
-- data is destroyed, but the app no longer reads them and any
-- link previously issued is cleared here so it stops working.
update referral_partners
   set portal_token = null,
       portal_token_created_at = null
 where portal_token is not null;
