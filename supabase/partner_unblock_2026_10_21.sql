-- ============================================================
-- THE FOUR PENDING PARTNER MIGRATIONS, IN ONE PLACE.
--
-- Run in the Supabase SQL editor:
--   https://supabase.com/dashboard/project/fdqyzekseetvzkmuihbg/sql/new
--
-- WHY THIS FILE EXISTS. Four migrations are written and committed and
-- none of them is known to be applied. One of them is confirmed
-- missing from the live /referrals screen ("Could not read the claims
-- queue"); the other three could not be checked at all. That is the
-- actual problem this file solves: not "apply these", but "stop not
-- knowing". PART D is a report, and it is the point of the file.
--
-- EVERY STATEMENT HERE IS IDEMPOTENT. create extension if not exists,
-- create table if not exists, add column if not exists, create index
-- if not exists, and for the one view, drop-then-create. Re-running a
-- part that already landed costs nothing and changes nothing. So you
-- do not need to know the state first — run A, B, C, then read D.
--
-- !! FOUR SEPARATE SUBMISSIONS, IN ORDER. SELECT NOTHING BEFORE Run.
-- !!
-- !! THE EDITOR RUNS ONLY THE SELECTED TEXT when anything is
-- !! highlighted, and reports success for whatever subset it ran. That
-- !! is how three pastes of a one-line `alter table` were reported as
-- !! run and executed nothing on 2026-10-13
-- !! (see supabase/portal_email_test_partner.sql). Click into the
-- !! editor, select nothing, Run.
-- !!
-- !! And a submission is ONE TRANSACTION, which is why these are four
-- !! and not one: a failure in PART C would otherwise roll back the
-- !! claims tables in PART A, breaking something unrelated to the
-- !! thing that failed and reporting one error for two problems.
--
--   PART A — partner_client_claims        (CONFIRMED MISSING)
--   PART B — partner_claim_batches        (unknown)
--   PART C — partner_order_units          (unknown; own submission)
--   PART D — the report                   (read this one)
--
-- WHAT EACH ONE COSTS IF IT IS STILL MISSING, which is the order they
-- bite in:
--
--   A. partner_client_claims — a partner files a claim and the insert
--      fails. He is told "Received." over a claim stored nowhere. The
--      daily cap REFUSES AND RECORDS by design; with no table there is
--      nothing to record into, so the refusal becomes a discard with a
--      friendly message. This one must land before the claims route is
--      reachable.
--
--   B. partner_claim_batches — the batch route 500s. A partner pasting
--      a list of companies meets an error page.
--
--   C. partner_order_units — the activity view and the CSV report 503
--      outright. Loud, and it is the view that carries NO MONEY by
--      construction, so it is also the one whose absence is safest.
--
--   D. partner_login_link (folded into PART A's submission, two lines)
--      — degrades QUIETLY, which makes it the worst of the four to
--      leave unknown. The sign-in email simply carries no one-click
--      link; the 6-digit code still works, nothing errors, and nobody
--      finds out. src/lib/partner-signin-email.ts catches PostgREST
--      42703 on purpose and sends a code-only email rather than
--      failing, precisely because this migration is applied by hand
--      and nothing sequences it against a deploy.
-- ============================================================


-- ============================================================
-- PART A — claims, plus the two sign-in-link columns.
-- Submission 1 of 4. Select nothing. Run.
--
-- Sources: supabase/partner_client_claims.sql
--          supabase/partner_login_link.sql
--
-- uuid-ossp is declared because it is NOT installed by default on a
-- fresh Supabase project and the primary key defaults with it.
--
-- RLS is enabled with NO POLICIES, which denies anon and authenticated
-- outright. Both routes read and write through supabaseAdmin, so the
-- service role is unaffected. A policy added here would be a way in.
-- ============================================================

create extension if not exists "uuid-ossp";

create table if not exists public.partner_client_claims (
  id            uuid primary key default uuid_generate_v4(),
  referral_partner_id uuid not null references public.referral_partners(id) on delete cascade,
  company_name  text not null,
  website       text,
  contact_name  text,
  contact_email text,
  note          text,
  status        text not null default 'submitted',
  client_id     uuid references public.clients(id),
  decided_by    text,
  decided_at    timestamptz,
  decision_note text,
  over_cap      boolean not null default false,
  submitted_ip  text,
  created_at    timestamptz not null default now()
);

-- For a database where the table predates over_cap. No-op otherwise.
alter table public.partner_client_claims
  add column if not exists over_cap boolean not null default false;

create index if not exists partner_client_claims_status_created_idx
  on public.partner_client_claims (status, created_at desc);

create index if not exists partner_client_claims_partner_created_idx
  on public.partner_client_claims (referral_partner_id, created_at desc);

alter table public.partner_client_claims enable row level security;

-- ---- the one-click sign-in link -----------------------------
--
-- Both columns nullable on purpose: a code-only row is legitimate, and
-- is what every row written before this migration looks like.
--
-- The partial unique index excludes nulls, so many code-only rows can
-- coexist while a link hash stays unique.
--
-- This is NOT a revival of referral_partners.portal_token, which was a
-- bearer link that never expired. One row carries both the code and
-- the link and shares ONE consumed_at, so redeeming either retires
-- both — a partner who clicks the link leaves no live code behind in
-- his mailbox.

alter table partner_login_codes
  add column if not exists link_token_hash text,
  add column if not exists link_expires_at timestamptz;

create unique index if not exists partner_login_codes_link_token_uniq
  on partner_login_codes (link_token_hash)
  where link_token_hash is not null;


-- ============================================================
-- PART B — claim batches. Submission 2 of 4.
-- Source: supabase/partner_claim_batches.sql
--
-- batch_id is NULLABLE and that is the compatibility hinge: null means
-- the claim was filed one at a time, which is every claim filed before
-- the batch route existed. A NOT NULL column here would make the
-- single-claim route unable to insert.
--
-- Two counts are kept deliberately. submitted_raw_count is what the
-- partner pasted; row_count is what was stored after dedupe. Keeping
-- only one makes a deduped batch indistinguishable from a short one,
-- and "I submitted nine and you show six" is then unanswerable.
-- ============================================================

create extension if not exists "uuid-ossp";

create table if not exists public.partner_claim_batches (
  id            uuid primary key default uuid_generate_v4(),
  referral_partner_id uuid not null references public.referral_partners(id) on delete cascade,
  row_count     int not null,
  submitted_raw_count int not null,
  submitted_ip  text,
  created_at    timestamptz not null default now()
);

create index if not exists partner_claim_batches_partner_created_idx
  on public.partner_claim_batches (referral_partner_id, created_at desc);

alter table public.partner_claim_batches enable row level security;

alter table public.partner_client_claims
  add column if not exists batch_id uuid references public.partner_claim_batches(id);

create index if not exists partner_client_claims_batch_idx
  on public.partner_client_claims (batch_id);


-- ============================================================
-- PART C — partner_order_units. Submission 3 of 4, ON ITS OWN.
--
-- Source: supabase/partner_order_units.sql — paste THAT FILE, not a
-- copy of it. It is the only one of the four that is not plain DDL: it
-- carries two `do $$` blocks, and dollar quoting is the thing most
-- likely to be mangled by being transcribed a second time.
--
-- It also needs to be its own submission for a reason the other parts
-- do not share. The editor shows only the LAST statement's result, and
-- that file's output IS `raise notice` text — one notice saying whether
-- security_invoker was set (it degrades to a notice, not an error, on
-- pre-Postgres-15), and a second block that re-reads
-- has_table_privilege and RAISES AN EXCEPTION if anon or authenticated
-- can still select from the view. Bury it under another statement and
-- you lose the only thing it tells you.
--
-- It is a VIEW, not a table, and it is dropped and recreated rather
-- than `create or replace` — replace raises 42P16 when a column is
-- inserted mid-list, which is exactly what editing this view does.
--
-- It carries NO MONEY COLUMN AT ALL, by construction, so no future
-- component can leak a figure that does not exist in it.
-- ============================================================

-- (nothing to paste here — see the note above)


-- ============================================================
-- PART D — THE REPORT. Submission 4 of 4. This is the one to read.
--
-- Run this LAST, select nothing, and paste the output back.
--
-- EXPECT ok = true on all 16 rows. Any false is a thing that did not
-- land, and `detail` says what was found instead.
--
-- Two rows are worth reading even when true:
--
--   claims_rls_no_policies — true means anon and authenticated are
--   denied outright. If a policy exists this reads false, and that is
--   a way into the claims table, not a tidiness complaint.
--
--   order_units_closed_to_anon — true means neither anon nor
--   authenticated can select the view. The view is the one object here
--   that joins orders to clients to partners, so an open grant on it
--   is cross-partner visibility.
-- ============================================================

with checks(sort_key, check_name, ok, detail) as (

  -- ---- PART A: partner_client_claims ----
  select 1, 'claims_table', (
    select count(*) = 1 from information_schema.tables
     where table_schema = 'public' and table_name = 'partner_client_claims'
  ), (
    select coalesce(string_agg(table_type, ','), 'ABSENT')
      from information_schema.tables
     where table_schema = 'public' and table_name = 'partner_client_claims'
  )

  union all
  select 2, 'claims_15_columns', (
    select count(*) = 15 from information_schema.columns
     where table_schema = 'public' and table_name = 'partner_client_claims'
  ), (
    select count(*)::text || ' columns' from information_schema.columns
     where table_schema = 'public' and table_name = 'partner_client_claims'
  )

  union all
  select 3, 'claims_over_cap', (
    select count(*) = 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'partner_client_claims'
       and column_name = 'over_cap'
  ), (
    select coalesce(string_agg(data_type || ' default ' || coalesce(column_default, 'NONE'), ','), 'ABSENT')
      from information_schema.columns
     where table_schema = 'public' and table_name = 'partner_client_claims'
       and column_name = 'over_cap'
  )

  -- client_id must be NULLABLE: the typed company name is a request,
  -- the foreign key is the decision, and a claim exists before anyone
  -- has decided.
  union all
  select 4, 'claims_client_id_nullable', (
    select count(*) = 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'partner_client_claims'
       and column_name = 'client_id' and is_nullable = 'YES'
  ), (
    select coalesce(string_agg('is_nullable=' || is_nullable, ','), 'ABSENT')
      from information_schema.columns
     where table_schema = 'public' and table_name = 'partner_client_claims'
       and column_name = 'client_id'
  )

  union all
  select 5, 'claims_two_indexes', (
    select count(*) = 2 from pg_indexes
     where schemaname = 'public'
       and indexname in ('partner_client_claims_status_created_idx',
                         'partner_client_claims_partner_created_idx')
  ), (
    select coalesce(string_agg(indexname, ','), 'NONE')
      from pg_indexes
     where schemaname = 'public'
       and indexname in ('partner_client_claims_status_created_idx',
                         'partner_client_claims_partner_created_idx')
  )

  union all
  select 6, 'claims_rls_enabled', (
    select coalesce(bool_or(relrowsecurity), false) from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = 'partner_client_claims'
  ), (
    select coalesce(string_agg(relrowsecurity::text, ','), 'ABSENT') from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = 'partner_client_claims'
  )

  union all
  select 7, 'claims_rls_no_policies', (
    select count(*) = 0 from pg_policies
     where schemaname = 'public' and tablename = 'partner_client_claims'
  ), (
    select coalesce(string_agg(policyname, ','), 'none (correct)')
      from pg_policies
     where schemaname = 'public' and tablename = 'partner_client_claims'
  )

  -- ---- PART B: partner_claim_batches ----
  union all
  select 8, 'batches_table', (
    select count(*) = 1 from information_schema.tables
     where table_schema = 'public' and table_name = 'partner_claim_batches'
  ), (
    select coalesce(string_agg(table_type, ','), 'ABSENT')
      from information_schema.tables
     where table_schema = 'public' and table_name = 'partner_claim_batches'
  )

  union all
  select 9, 'batches_6_columns', (
    select count(*) = 6 from information_schema.columns
     where table_schema = 'public' and table_name = 'partner_claim_batches'
  ), (
    select count(*)::text || ' columns' from information_schema.columns
     where table_schema = 'public' and table_name = 'partner_claim_batches'
  )

  union all
  select 10, 'batches_index', (
    select count(*) = 1 from pg_indexes
     where schemaname = 'public'
       and indexname = 'partner_claim_batches_partner_created_idx'
  ), (
    select coalesce(string_agg(indexname, ','), 'ABSENT') from pg_indexes
     where schemaname = 'public'
       and indexname = 'partner_claim_batches_partner_created_idx'
  )

  union all
  select 11, 'batches_rls_enabled', (
    select coalesce(bool_or(relrowsecurity), false) from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = 'partner_claim_batches'
  ), (
    select coalesce(string_agg(relrowsecurity::text, ','), 'ABSENT') from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = 'partner_claim_batches'
  )

  -- The hinge. Present AND nullable, or the single-claim route cannot
  -- insert at all.
  union all
  select 12, 'claims_batch_id_nullable', (
    select count(*) = 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'partner_client_claims'
       and column_name = 'batch_id' and is_nullable = 'YES'
  ), (
    select coalesce(string_agg('is_nullable=' || is_nullable, ','), 'ABSENT')
      from information_schema.columns
     where table_schema = 'public' and table_name = 'partner_client_claims'
       and column_name = 'batch_id'
  )

  -- ---- PART C: partner_order_units ----
  union all
  select 13, 'order_units_view', (
    select count(*) = 1 from information_schema.views
     where table_schema = 'public' and table_name = 'partner_order_units'
  ), (
    select coalesce(string_agg(table_type, ','), 'ABSENT')
      from information_schema.tables
     where table_schema = 'public' and table_name = 'partner_order_units'
  )

  union all
  select 14, 'order_units_closed_to_anon', (
    select not (
      coalesce(has_table_privilege('anon', 'public.partner_order_units', 'select'), false)
      or coalesce(has_table_privilege('authenticated', 'public.partner_order_units', 'select'), false)
    )
    where exists (
      select 1 from information_schema.views
       where table_schema = 'public' and table_name = 'partner_order_units'
    )
  ), (
    -- Spelled out because false here has TWO meanings and they are not
    -- the same problem: either the view is missing (row 13 already
    -- said so, and nothing is exposed), or it exists and is readable
    -- by anon/authenticated, which is cross-partner visibility.
    select case when not exists (
             select 1 from information_schema.views
              where table_schema = 'public' and table_name = 'partner_order_units')
           then 'view absent — nothing to grant; see row 13'
           else 'anon=' ||
                coalesce(has_table_privilege('anon', 'public.partner_order_units', 'select'), false)::text ||
                ' authenticated=' ||
                coalesce(has_table_privilege('authenticated', 'public.partner_order_units', 'select'), false)::text
           end
  )

  -- ---- PART A (second half): the sign-in link columns ----
  union all
  select 15, 'login_link_columns', (
    select count(*) = 2 from information_schema.columns
     where table_schema = 'public' and table_name = 'partner_login_codes'
       and column_name in ('link_token_hash', 'link_expires_at')
  ), (
    select coalesce(string_agg(column_name, ','), 'NONE')
      from information_schema.columns
     where table_schema = 'public' and table_name = 'partner_login_codes'
       and column_name in ('link_token_hash', 'link_expires_at')
  )

  union all
  select 16, 'login_link_unique_index', (
    select count(*) = 1 from pg_indexes
     where schemaname = 'public'
       and indexname = 'partner_login_codes_link_token_uniq'
  ), (
    select coalesce(string_agg(indexname, ','), 'ABSENT') from pg_indexes
     where schemaname = 'public'
       and indexname = 'partner_login_codes_link_token_uniq'
  )
)
select check_name,
       coalesce(ok, false) as ok,
       detail
  from checks
 order by sort_key;
