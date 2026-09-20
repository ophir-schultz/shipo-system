-- ============================================================
-- Founding Partner launch offer + the columns the intake webhook
-- and the net-profit math actually depend on.
--
-- Approved by Ophir 2026-09-20:
--   $500 signup bonus (instead of $300) for the first 10 partners,
--   qualifying when the referred client does, in a calendar month,
--   EITHER more than 1,500 FBA prep units OR more than 500 DTC orders.
--
--   (Revised the same day from an earlier "more than 2,000 units",
--   which was FBA-only and had no DTC route at all.)
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

-- THREE BARS, ANY ONE OF WHICH CLEARS IT
-- --------------------------------------
-- Shipo sells two things. FBA prep is billed per unit, so "1,500
-- units in a month" is a real, readable number on the invoice. DTC
-- fulfillment is not: a DTC brand can be one of the best accounts in
-- the building and never have a prep unit count at all.
--
-- So a units-only qualification is an FBA-only qualification. It
-- would silently pay nothing on every DTC referral — no error, no
-- warning, just a bonus that never becomes owed.
--
-- The fix is not a service-line flag on the client (one more field
-- for someone to forget). It is to let the client qualify on
-- WHICHEVER bar it actually clears in the same calendar month.
--
-- ⚠️ THESE THREE ARE READ ALL-OR-NOTHING, NOT COLUMN BY COLUMN.
-- If a partner row carries ANY of them, that row IS the whole offer
-- and the standing terms are not consulted for the ones left NULL.
-- A Founding Partner is admitted on units-or-orders with NO revenue
-- path; under per-column fallback their NULL revenue column would
-- have resolved to the standing $500 and paid out through a route
-- that was never approved. See qualifyBars() in src/lib/referrals.ts.

alter table referral_partners add column if not exists bonus_min_units integer;
  -- FBA path. The referred client must ship MORE THAN this many prep
  -- units in a calendar month. Founding Partners: 1500.

alter table referral_partners add column if not exists bonus_min_orders integer;
  -- DTC path. MORE THAN this many orders in a calendar month.
  -- Founding Partners: 500. Orders, not units and not dollars.

alter table referral_partners add column if not exists bonus_min_revenue numeric(10,2);
  -- Dollar path. AT OR ABOVE this amount billed in a calendar month —
  -- at-or-above, because the published standing wording is "$500 or
  -- more", while the two volume bars above are strictly "more than".
  --
  -- Founding Partners get NULL here, closing this path deliberately.
  -- All three NULL = the standing terms apply ($500 billed, no volume
  -- bar), as published on shipousa.com/partner-program/.

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
-- `units_shipped` / `orders_shipped` are what the volume
-- qualifications read.
alter table fba_invoices add column if not exists units_shipped    integer;                  -- FBA prep units
alter table fba_invoices add column if not exists orders_shipped   integer;                  -- DTC orders

-- ⚠️ NO DEFAULT ON THE TWO VOLUME COLUMNS, and the old `default 0` on
-- units_shipped is dropped below.
--
-- NULL means "nobody recorded this". 0 means "recorded, and it was
-- genuinely zero". A column defaulting to 0 cannot tell those apart,
-- and the difference decides whether real money is owed: a DTC
-- invoice would silently read as "0 units, does not qualify" forever,
-- which looks identical to a correct answer and is the exact failure
-- this whole change exists to kill. qualifiesInMonth() skips a NULL
-- rather than treating it as 0.
alter table fba_invoices alter column units_shipped  drop default;
alter table fba_invoices alter column orders_shipped drop default;

-- ⚠️ CAVEAT, read this. Dropping the default does not touch rows that
-- already exist — any invoice saved while the default was 0 still
-- holds a literal 0 in units_shipped, indistinguishable from a real
-- zero. Nothing can recover that after the fact. Check any pre-
-- existing invoice rows by hand before trusting a "does not qualify":
--   select id, client_id, period, amount, units_shipped
--     from fba_invoices where units_shipped = 0;

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
--   ('referral_partners','bonus_min_orders'),
--   ('referral_partners','bonus_min_revenue'),
--   ('referral_partners','founding_partner'),
--   ('referral_partners','applied_at'),
--   ('fba_invoices','units_shipped'),
--   ('fba_invoices','orders_shipped'),
--   ('fba_invoices','cost_freight'),
--   ('fba_invoices','cost_materials'),
--   ('fba_invoices','cost_storage'),
--   ('fba_invoices','cost_processing'),
--   ('referral_payouts','dedupe_key')
-- ) as c(tbl,col)
-- order by present, column_name;
