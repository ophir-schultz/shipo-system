-- ============================================================
-- Partner portal terms of use — the acceptance record.
--
-- A ROW PER (PARTNER, VERSION), NOT TWO COLUMNS ON referral_partners.
-- This is the whole design decision, so it is stated first.
--
-- `accepted_terms_version` + `accepted_terms_at` on referral_partners
-- would be OVERWRITTEN the next time the wording changes. The only
-- thing this record exists to answer is "what text did this partner
-- agree to, and when" -- and an overwriting column destroys exactly
-- that, keeping only the most recent answer. Append-only rows answer
-- it forever, including for wording we have since replaced.
--
-- Bumping PARTNER_TERMS_VERSION in src/lib/partner-terms.ts re-prompts
-- every partner and writes a new row each. That is intended: silently
-- re-wording terms somebody already agreed to is the failure mode this
-- table guards against. Old rows are never updated and never deleted.
--
-- `ip` and `user_agent` ARE EVIDENCE, NOT TELEMETRY. They are recorded
-- exactly as read from the request -- ip from the first hop of
-- x-forwarded-for, user_agent truncated to 400 characters -- so that an
-- acceptance can be tied to a request if it is ever disputed. Nothing
-- reads them. In particular, NEVER infer a location, a region, or a
-- jurisdiction from the ip: it is a proxy address on Vercel's network
-- as often as it is the partner's, and this table is not an analytics
-- source. No feature may be built on these two columns.
--
-- Nothing in any money path reads this table. It gates a render
-- (src/app/partner/page.tsx) and is written by one route
-- (POST /api/partner/accept-terms). See spec section 2.2.
--
-- Idempotent. Apply in the Supabase SQL editor.
-- ============================================================

create extension if not exists "uuid-ossp";

create table if not exists public.partner_terms_acceptances (
  id            uuid primary key default uuid_generate_v4(),
  referral_partner_id uuid not null references public.referral_partners(id) on delete cascade,
  terms_version text not null,
  accepted_at   timestamptz not null default now(),
  ip            text,
  user_agent    text,
  created_at    timestamptz not null default now()
);

-- The gate's only query: "has THIS partner accepted THIS version?"
-- UNIQUE, and that is load-bearing, not tidiness. The route checks for an
-- existing acceptance before inserting, but that check does not serialize:
-- a double-clicked Accept button sends two concurrent POSTs, both read
-- "no acceptance yet", and both insert. Sequential idempotency is not
-- concurrent idempotency. Rather than lock, we make the duplicate
-- IMPOSSIBLE here and HARMLESS in the route, which treats a 23505 unique
-- violation as the success it actually is -- somebody else just recorded
-- the same partner accepting the same version.
-- If an earlier run of this file created the index NON-unique, drop it
-- first: `create unique index if not exists` on an existing name of the
-- same spelling is a silent no-op, so the uniqueness would never arrive
-- and the 23505 the route relies on would never fire.
do $$
begin
  if exists (
    select 1 from pg_class c
      join pg_index i on i.indexrelid = c.oid
     where c.relname = 'partner_terms_acceptances_partner_version_idx'
       and not i.indisunique
  ) then
    drop index public.partner_terms_acceptances_partner_version_idx;
  end if;
end $$;

create unique index if not exists partner_terms_acceptances_partner_version_idx
  on public.partner_terms_acceptances (referral_partner_id, terms_version);

alter table public.partner_terms_acceptances enable row level security;

-- No policies. Every read and write goes through supabaseAdmin (service
-- role), the same as partner_sessions and partner_login_codes. RLS on
-- with no policy means the anon key cannot reach it at all, which is
-- the intent -- a partner never queries his own acceptance record.

-- ============================================================
-- VERIFICATION -- must return present = true.
-- ============================================================
-- select
--   'public.partner_terms_acceptances' as object_name,
--   exists (
--     select 1 from information_schema.tables
--      where table_schema = 'public'
--        and table_name = 'partner_terms_acceptances'
--   )
--   and exists (
--     select 1 from information_schema.columns
--      where table_schema = 'public'
--        and table_name = 'partner_terms_acceptances'
--        and column_name = 'terms_version'
--   )
--   and exists (
--     select 1 from pg_indexes
--      where schemaname = 'public'
--        and indexname = 'partner_terms_acceptances_partner_version_idx'
--   ) as present;
