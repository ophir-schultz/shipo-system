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
