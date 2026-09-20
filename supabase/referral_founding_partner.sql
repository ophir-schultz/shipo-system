-- ============================================================
-- Founding Partner launch offer + the columns the intake webhook
-- and the net-profit math actually depend on.
--
-- Approved by Ophir 2026-09-20:
--   $500 signup bonus (instead of $300) for the first 10 partners,
--   qualifying when the referred client ships MORE THAN 2,000 UNITS
--   in a calendar month.
--
-- WHY THIS IS A PER-PARTNER COLUMN AND NOT AN EDITED CONSTANT
-- -----------------------------------------------------------
-- `REFERRAL_TERMS.SIGNUP_BONUS` is a flat constant in
-- src/lib/referrals.ts. Raising it to 500 would pay $500 to every
-- partner, forever, retroactively — including the ones admitted
-- under the $300 standing terms. The admitted terms have to be
-- frozen ON THE PARTNER ROW at the moment they are accepted, so
-- that changing the offer later can never rewrite what an existing
-- partner was promised.
--
-- Idempotent. Apply in the Supabase SQL editor. Safe to run after
-- referral_program.sql and after partner_portal.sql, in any order.
-- ============================================================

-- ---- referral_partners: the admitted offer, frozen per partner ----
-- Each partner carries the terms they were accepted under. Nothing
-- reads a global bonus constant for a partner that has a value here.
alter table referral_partners add column if not exists signup_bonus_amount numeric(10,2);
  -- NULL = admitted under the standing terms (whatever REFERRAL_TERMS
  -- says today). A number = this partner's frozen bonus, e.g. 500.

alter table referral_partners add column if not exists bonus_min_units integer;
  -- NULL = the standing qualification applies. A number = the referred
  -- client must ship MORE THAN this many units in a calendar month
  -- before the bonus is owed. Founding Partners: 2000.

alter table referral_partners add column if not exists founding_partner boolean default false;
  -- Drives the "listed by name on the partner page" part of the offer.

alter table referral_partners add column if not exists applied_at timestamptz default now();
  -- The application timestamp the deadline offer is enforced against.
  -- Until /api/referrals/intake actually deploys and returns 200, the
  -- ONLY proof of an application date is an email timestamp, which is
  -- not a record anyone can adjudicate a capped offer against.

-- Backfill applied_at for rows that predate this column so the
-- "first 10" ordering is total and has no NULLs to tie-break.
update referral_partners
   set applied_at = created_at
 where applied_at is null
   and created_at is not null;

-- ---- fba_invoices: units + the four deductible cost buckets -------
-- Duplicated deliberately from partner_portal.sql, which is UNTRACKED
-- and therefore may never have been applied to production. Without
-- these, netProfit() subtracts zeros and the payout engine pays 5% of
-- GROSS revenue instead of 5% of net — silently, with no error.
-- `units_shipped` is also what the 2,000-unit qualification reads.
alter table fba_invoices add column if not exists units_shipped    integer       default 0;
alter table fba_invoices add column if not exists cost_freight     numeric(10,2) default 0;  -- freight & carrier charges
alter table fba_invoices add column if not exists cost_materials   numeric(10,2) default 0;  -- packaging & prep materials
alter table fba_invoices add column if not exists cost_storage     numeric(10,2) default 0;  -- storage
alter table fba_invoices add column if not exists cost_processing  numeric(10,2) default 0;  -- payment processing
alter table fba_invoices add column if not exists updated_at       timestamptz   default now();

-- ---- the four columns /api/referrals/intake writes ----------------
-- Already declared in referral_program.sql lines 33-36. Repeated here
-- because that file's application status in production is UNVERIFIED,
-- and an intake INSERT naming a column that does not exist returns a
-- 500 and saves no row. Re-running these costs nothing.
alter table referral_partners add column if not exists partner_type text;
alter table referral_partners add column if not exists refer_method text;
alter table referral_partners add column if not exists source text default 'manual';
alter table referral_partners add column if not exists updated_at timestamptz default now();

alter table referral_partners enable row level security;
alter table fba_invoices enable row level security;

-- ============================================================
-- VERIFICATION — run this after applying, and read the output.
-- Every row below must come back present = true. Any false means
-- the payout engine will compute a wrong number rather than fail.
-- ============================================================
-- select
--   c.tbl || '.' || c.col as column_name,
--   exists (
--     select 1 from information_schema.columns i
--      where i.table_name = c.tbl and i.column_name = c.col
--   ) as present
-- from (values
--   ('referral_partners','partner_type'),
--   ('referral_partners','refer_method'),
--   ('referral_partners','source'),
--   ('referral_partners','updated_at'),
--   ('referral_partners','signup_bonus_amount'),
--   ('referral_partners','bonus_min_units'),
--   ('referral_partners','founding_partner'),
--   ('referral_partners','applied_at'),
--   ('fba_invoices','units_shipped'),
--   ('fba_invoices','cost_freight'),
--   ('fba_invoices','cost_materials'),
--   ('fba_invoices','cost_storage'),
--   ('fba_invoices','cost_processing'),
--   ('referral_payouts','dedupe_key')
-- ) as c(tbl,col)
-- order by present, column_name;
