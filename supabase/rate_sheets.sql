-- ============================================================
-- RATE SHEETS — per-prospect, shareable fulfillment pricing
--
-- One row per prospect quote. A sheet is published at
--
--   /rate-sheets/<slug>/<public_id>/<token>
--
-- and is readable by anyone holding that URL. There is no login:
-- the token IS the credential, the same capability-URL model the
-- referral portal uses (see referral_partners.portal_token in
-- partner_portal.sql).
--
-- SCOPE: fulfillment fees only — receiving, storage, pick & pack,
-- FBA prep, and the monthly minimum. Parcel/postage rates are
-- deliberately NOT published here. They are carrier rates that
-- move, and a sheet is forwardable by whoever receives it.
--
-- This file is idempotent — apply it in the Supabase SQL editor.
-- ============================================================

-- Short, human-quotable sheet number for the URL and for support
-- ("I'm looking at sheet 1042"). A uuid in the path would be
-- unreadable over the phone, and the row's own uuid stays internal.
create sequence if not exists rate_sheet_public_id_seq start with 1000;

create table if not exists rate_sheets (
  id                uuid primary key default uuid_generate_v4(),
  public_id         bigint not null default nextval('rate_sheet_public_id_seq'),

  -- Readable URL segment, e.g. 'acme-supplements-2026-09-17'. Cosmetic
  -- only: lookup is by public_id + token, so a stale slug still resolves
  -- and a guessed one gets you nothing.
  slug              text not null,

  -- The capability. Stored in the clear on purpose, unlike the partner
  -- session tokens in partner-auth.ts, because staff must be able to
  -- re-copy a link weeks after sending it. A hash would force a rotation
  -- every time someone lost the email. The tradeoff is accepted because
  -- this row holds a price quote, not a credential to anything else.
  token             text not null,

  company_name      text not null,
  contact_name      text,
  contact_email     text,
  prepared_by       text,            -- staff email that created the sheet

  -- Prospect profile the sheet is written against: monthly_orders,
  -- items_per_order, pallets_stored, pallets_inbound, fba_units,
  -- channels[], notes. Free-form so a new question can be asked on the
  -- form without a migration.
  profile           jsonb not null default '{}'::jsonb,

  -- Snapshot of the priced lines AT THE TIME OF SENDING. Deliberately a
  -- copy, not a join to a live price table: a sheet a prospect opens in
  -- November must still show what it showed in September, and must not
  -- silently reprice itself mid-negotiation.
  rate_card         jsonb not null default '[]'::jsonb,

  -- Billed as the greater of actual monthly charges or this floor.
  monthly_minimum   numeric(10,2) not null default 395.00,

  intro             text,            -- optional personalised opening paragraph
  status            text not null default 'draft',   -- draft | sent | expired
  valid_until       date,

  view_count        integer not null default 0,
  first_viewed_at   timestamptz,
  last_viewed_at    timestamptz,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- Two sheets must never share a token, or one prospect could read
-- another's pricing by typing the wrong id.
create unique index if not exists rate_sheets_token_uniq on rate_sheets (token);
create unique index if not exists rate_sheets_public_id_uniq on rate_sheets (public_id);
create index if not exists rate_sheets_created_idx on rate_sheets (created_at desc);

-- RLS stays on and no policy is added. Every read and write goes
-- through the service-role client on the server, which bypasses RLS.
-- The anon key — the one shipped to the browser — can therefore read
-- nothing in this table even with a valid token, so a sheet can only
-- ever be assembled by our own server code.
alter table rate_sheets enable row level security;
