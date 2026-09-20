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
