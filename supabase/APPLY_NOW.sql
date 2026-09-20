-- ============================================================
-- APPLY THIS WHOLE FILE. One paste, one Run.
--
-- Regenerated 2026-09-20. It is partner_onboarding.sql followed by
-- referral_founding_partner.sql, in that order — the order matters,
-- because the second file drops a column default the first one may
-- have created, and running them the other way round would put the
-- `default 0` back on fba_invoices.units_shipped.
--
-- Every statement is idempotent: `add column if not exists`,
-- `create ... if not exists`, guarded updates. Running it twice
-- changes nothing the second time.
--
-- The last statement is a verification SELECT. Read its output —
-- every row must say present = true. Any false means the payout
-- engine will compute a WRONG NUMBER rather than fail loudly.
-- ============================================================

-- ============================================================
-- Automated partner onboarding: apply -> sign -> portal access
--
-- The flow this supports, end to end:
--   1. Partner submits the Forminator form on shipousa.com
--   2. /api/referrals/intake inserts them as `pending`
--   3. An agreement envelope goes out for signature
--   4. DocuSign Connect POSTs the completed envelope back
--   5. The partner flips to `active` and is emailed a portal link
--   6. They sign in with email + 6-digit code and read their statement
--
-- Steps 1, 2, 5 and 6 already have code. This file adds the state
-- that steps 3 and 4 need, plus the idempotency ledger without which
-- a retried webhook would re-activate and re-email a partner.
--
-- Idempotent. Apply in the Supabase SQL editor.
-- ============================================================

-- ---- referral_partners: the agreement state machine ---------------
-- agreement_status moves: not_sent -> sent -> signed
--                                          -> declined
--                                          -> voided
-- Nothing else may set it. A partner is never `active` on the basis
-- of an application alone — only a completed envelope promotes them.
alter table referral_partners add column if not exists agreement_status text default 'not_sent';
alter table referral_partners add column if not exists agreement_envelope_id text;
alter table referral_partners add column if not exists agreement_template_id text;
  -- WHICH document they signed. The offer changes (standing terms vs
  -- Founding Partner) and the contract text will change with it. A
  -- partner's obligations are whatever THEY signed, not whatever the
  -- current template says, so the version has to be recorded per row.
alter table referral_partners add column if not exists agreement_sent_at timestamptz;
alter table referral_partners add column if not exists agreement_signed_at timestamptz;
alter table referral_partners add column if not exists agreement_declined_reason text;
alter table referral_partners add column if not exists portal_invited_at timestamptz;

-- One envelope maps to one partner. Prevents a second envelope for the
-- same partner silently overwriting the first signed one.
create unique index if not exists referral_partners_envelope_uniq
  on referral_partners (agreement_envelope_id)
  where agreement_envelope_id is not null;

-- ---- webhook idempotency ledger ------------------------------------
-- DocuSign Connect retries on any non-2xx, and will happily deliver the
-- same event twice on a timeout it decided was a failure. Without a
-- unique key on (envelope, event) a retry re-runs activation and sends
-- the partner a second portal invite.
create table if not exists partner_agreement_events (
  id uuid primary key default uuid_generate_v4(),
  envelope_id text not null,
  event text not null,                 -- envelope-completed, envelope-declined, ...
  referral_partner_id uuid references referral_partners(id) on delete set null,
  payload jsonb,
  processed_at timestamptz default now(),
  created_at timestamptz default now()
);

create unique index if not exists partner_agreement_events_uniq
  on partner_agreement_events (envelope_id, event);

create index if not exists partner_agreement_events_partner_idx
  on partner_agreement_events (referral_partner_id);

alter table partner_agreement_events enable row level security;

-- ---- backfill -------------------------------------------------------
-- Every existing partner predates the agreement flow. They have signed
-- nothing, so they start at not_sent rather than inheriting a status
-- that would let them straight into the portal.
update referral_partners
   set agreement_status = 'not_sent'
 where agreement_status is null;

-- ============================================================
-- VERIFICATION — every row must return present = true.
-- ============================================================
-- select
--   c.tbl || '.' || c.col as column_name,
--   exists (
--     select 1 from information_schema.columns i
--      where i.table_name = c.tbl and i.column_name = c.col
--   ) as present
-- from (values
--   ('referral_partners','agreement_status'),
--   ('referral_partners','agreement_envelope_id'),
--   ('referral_partners','agreement_template_id'),
--   ('referral_partners','agreement_sent_at'),
--   ('referral_partners','agreement_signed_at'),
--   ('referral_partners','portal_invited_at'),
--   ('partner_agreement_events','envelope_id'),
--   ('partner_agreement_events','event')
-- ) as c(tbl,col)
-- order by present, column_name;
-- ============================================================
-- Launch offer + the columns the intake webhook and the net-profit
-- math actually depend on.
--
-- Approved by Ophir 2026-09-20:
--   $500 signup bonus (instead of $300) for the first 10 referred
--   CLIENTS, qualifying when the client does, in a calendar month,
--   EITHER more than 1,500 FBA prep units OR more than 500 DTC orders.
--
--   (Revised the same day from an earlier "more than 2,000 units",
--   which was FBA-only and had no DTC route at all.)
--
-- ⚠️ THE CAP COUNTS CLIENTS, NOT PARTNERS.
-- An earlier draft of this file capped 10 PARTNERS and claimed the
-- exposure was "10 × ($500 − $300) = $2,000". That is only true if
-- every partner brings exactly one client; 10 partners referring
-- unlimited clients at $500 each is unbounded. Counting clients makes
-- the sentence true. The place lives in clients.founding_bonus_seq,
-- added at the bottom of this file.
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

-- ---- clients: which of the 10 launch places this client holds ------
--
-- 1..10, or NULL for every client not on the launch offer.
--
-- WHY THIS IS STORED AND NOT DERIVED
-- ----------------------------------
-- The ordering ("earliest 10 clients to clear the bar") is perfectly
-- computable from the invoice table, and computeOwed() does compute it
-- on every page load. But a derived place can MOVE. Enter a backdated
-- invoice for some other client tomorrow and a client who was approved
-- — and possibly already paid — at $500 silently drops to 11th place
-- and restates to $300. The books would then disagree with the money
-- that actually left the building, and nothing would flag it.
--
-- So the place is written ONCE, at the moment the bonus is approved
-- (see the approve branch of /api/referrals/payouts), and is never
-- recomputed afterwards. Derived until it is decided; decided forever
-- after.
alter table clients add column if not exists founding_bonus_seq integer;

-- Two places numbered 3 is the same bug as no places at all — it pays
-- an eleventh $500. The DB refuses it rather than trusting the app to
-- have got the race right. Partial index so the NULLs (almost every
-- client) are not forced to be unique against each other.
create unique index if not exists clients_founding_bonus_seq_uniq
  on clients (founding_bonus_seq)
  where founding_bonus_seq is not null;

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
--   ('clients','founding_bonus_seq'),
--   ('referral_payouts','dedupe_key')
-- ) as c(tbl,col)
-- order by present, column_name;

-- ============================================================
-- VERIFICATION — this one runs. Read the output.
--
-- Every row must come back present = true. clients.founding_bonus_seq
-- is the newest and the one most likely to be missing: without it the
-- launch place can never be recorded, every place stays provisional
-- forever, and an approved $500 can silently restate to $300 the next
-- time an invoice is entered.
-- ============================================================
select
  c.tbl || '.' || c.col as column_name,
  exists (
    select 1 from information_schema.columns i
     where i.table_name = c.tbl and i.column_name = c.col
  ) as present
from (values
  ('referral_partners','partner_type'),
  ('referral_partners','refer_method'),
  ('referral_partners','source'),
  ('referral_partners','updated_at'),
  ('referral_partners','signup_bonus_amount'),
  ('referral_partners','bonus_min_units'),
  ('referral_partners','bonus_min_orders'),
  ('referral_partners','bonus_min_revenue'),
  ('referral_partners','founding_partner'),
  ('referral_partners','applied_at'),
  ('referral_partners','agreement_status'),
  ('clients','founding_bonus_seq'),
  ('fba_invoices','units_shipped'),
  ('fba_invoices','orders_shipped'),
  ('fba_invoices','cost_freight'),
  ('fba_invoices','cost_materials'),
  ('fba_invoices','cost_storage'),
  ('fba_invoices','cost_processing'),
  ('referral_payouts','dedupe_key')
) as c(tbl,col)
order by present, column_name;

-- The unique index that stops two clients holding launch place 3.
-- Must come back present = true as well.
select 'clients_founding_bonus_seq_uniq' as index_name,
       exists (select 1 from pg_indexes where indexname = 'clients_founding_bonus_seq_uniq') as present;
