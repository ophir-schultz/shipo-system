-- ============================================================
-- A pasted list of companies, as an OBJECT. Spec 2026-10-20 §3.1.
--
-- WHY A TABLE AND NOT JUST N CLAIMS. A partner onboarding an existing
-- book submits one list. That list has a submission time, a count, a
-- partner and a staff decision history, and modelling it as 100
-- independent claims loses the grouping that makes 100 rows triageable
-- -- the staff queue would show a hundred unrelated rows filed in the
-- same second, and the only way back to "what did he actually send" is
-- to eyeball timestamps.
--
-- TWO COUNTS, AND THEY ARE NOT THE SAME NUMBER.
--
--   submitted_raw_count -- lines he pasted, before the fold.
--   row_count           -- claims actually created, after dedupe.
--
-- Keeping both is what lets the response say "203 pasted, 187 after
-- removing duplicates" and still be auditable a month later. One column
-- holding "the count" would make a deduped batch indistinguishable from
-- a short one, and the first question anybody asks about a disputed
-- commission is "how many did he send us".
--
-- THE CLAIMS THEMSELVES ARE UNCHANGED. Each row of the paste becomes an
-- ordinary public.partner_client_claims row with status 'submitted' and
-- NO client_id -- see that file's header. Approving a claim is still the
-- only write in the system that attributes money, it is still one
-- considered decision per client, and bulk approve is deliberately not
-- built (§3.5).
--
-- batch_id IS NULLABLE, and that is the compatibility hinge. Null means
-- "filed one at a time through the existing form". The existing route
-- and the existing single-claim form are untouched by this migration.
--
-- RLS enabled with no policies, denying anon and authenticated outright.
-- The partner route and the staff queue both go through supabaseAdmin
-- with the partner id taken from the session cookie, never the body.
--
-- Idempotent. Apply in the Supabase SQL editor.
--
-- APPLY THIS BEFORE THE BATCH ROUTE SHIPS. With the table missing, the
-- insert fails and the partner meets a 500 -- which is the honest answer
-- and is also a partner who pasted a hundred companies and got nothing.
-- ============================================================

create extension if not exists "uuid-ossp";

create table if not exists public.partner_claim_batches (
  id            uuid primary key default uuid_generate_v4(),
  referral_partner_id uuid not null references public.referral_partners(id) on delete cascade,

  -- Claims created under this batch, after in-batch and
  -- against-existing dedupe.
  row_count     int not null,

  -- Lines as pasted, before the fold. The honest count to echo back.
  submitted_raw_count int not null,

  submitted_ip  text,
  created_at    timestamptz not null default now()
);

-- Serves the rolling-24h batch count in the submission route, which runs
-- on every POST. BATCH_MAX_PER_DAY fails closed, so a slow or failing
-- count is a refused upload -- this index is on the money path.
create index if not exists partner_claim_batches_partner_created_idx
  on public.partner_claim_batches (referral_partner_id, created_at desc);

alter table public.partner_claim_batches enable row level security;

-- The link. Nullable: a null batch_id is a claim filed one at a time.
alter table public.partner_client_claims
  add column if not exists batch_id uuid references public.partner_claim_batches(id);

-- The staff queue groups the open list by batch (§3.5).
create index if not exists partner_client_claims_batch_idx
  on public.partner_client_claims (batch_id);

-- ============================================================
-- VERIFICATION — must return present = true.
-- ============================================================
-- select
--   'partner_claim_batches' as object,
--   (
--     select count(*) from information_schema.columns
--      where table_schema = 'public' and table_name = 'partner_claim_batches'
--        and column_name in (
--          'id','referral_partner_id','row_count','submitted_raw_count',
--          'submitted_ip','created_at'
--        )
--   ) = 6
--   and exists (
--     select 1 from information_schema.columns
--      where table_schema = 'public' and table_name = 'partner_client_claims'
--        and column_name = 'batch_id'
--   )
--   -- batch_id must be NULLABLE, or every claim the existing single form
--   -- files is rejected by the database.
--   and (
--     select is_nullable from information_schema.columns
--      where table_schema = 'public' and table_name = 'partner_client_claims'
--        and column_name = 'batch_id'
--   ) = 'YES'
--   and (
--     select count(*) from pg_indexes
--      where schemaname = 'public'
--        and indexname in (
--          'partner_claim_batches_partner_created_idx',
--          'partner_client_claims_batch_idx'
--        )
--   ) = 2
--   and (
--     select relrowsecurity from pg_class
--      where oid = 'public.partner_claim_batches'::regclass
--   ) as present;
