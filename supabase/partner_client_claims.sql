-- ============================================================
-- Partner-added clients, as CLAIMS. Spec §3.1-§3.3.
--
-- THIS IS THE ONLY NEW PATH TO MONEY IN THE PORTAL. The deal is $300
-- plus 5% of net profit for twelve months, so a form that let a partner
-- type a company name and have it attributed to him would be a form that
-- lets him claim clients he never referred -- including Shipo's existing
-- clients, and including clients another partner brought in.
--
-- So the partner submits a CLAIM and staff approve it. NOTHING IS
-- ATTRIBUTED BY THE ACT OF SUBMITTING. That is why `client_id` is
-- nullable and separate from the typed `company_name`: the typed name is
-- a request, and the foreign key is the decision. src/lib/partner-claims.ts
-- never emits `client_id` at all on insert -- not as null, not as
-- undefined -- so the shape of the inserted row is where this is
-- enforced rather than in a convention somebody has to remember.
--
-- `decision_note` IS STAFF-FACING AND MUST NEVER REACH THE PARTNER
-- SURFACE. "Already claimed by Partner B" is exactly the information
-- §3.2 refuses to leak: the submission endpoint answers the same
-- sentence every time, because any other answer turns the form into a
-- lookup against Shipo's client list and lets a partner enumerate the
-- customer base one guess at a time. Partner-side selects therefore name
-- their columns explicitly and NEVER `select('*')` -- a star here would
-- carry decision_note, decided_by and client_id onto his screen the day
-- somebody adds a convenience query.
--
-- RLS is enabled with no policies, which denies everything to the anon
-- and authenticated roles. Both the partner route and the staff queue go
-- through supabaseAdmin (service role, which bypasses RLS) with the
-- partner id taken from the session cookie, never from the request body.
--
-- Idempotent. Apply in the Supabase SQL editor.
-- ============================================================

-- Declared because the primary key below defaults with it, and uuid-ossp
-- is NOT installed by default on a fresh Postgres. Without this line the
-- file fails at the CREATE TABLE on any database where no earlier
-- migration happened to declare it, and then every partner's claim meets
-- the submission route's unreadable-count path.
create extension if not exists "uuid-ossp";

create table if not exists public.partner_client_claims (
  id            uuid primary key default uuid_generate_v4(),
  referral_partner_id uuid not null references public.referral_partners(id) on delete cascade,

  -- As typed by the partner. Never trusted, never matched automatically.
  company_name  text not null,
  website       text,
  contact_name  text,
  contact_email text,
  note          text,          -- "what did you do for this referral"

  status        text not null default 'submitted',
                -- submitted | approved | rejected | duplicate
  -- Set by staff on approval. The ONLY thing that attributes money.
  client_id     uuid references public.clients(id),
  decided_by    text,
  decided_at    timestamptz,
  decision_note text,          -- staff-facing; never rendered to the partner

  -- This claim did not arrive inside the partner's daily allowance.
  --
  -- STAFF-FACING, AND THE REASON THE ROW EXISTS AT ALL. The submission
  -- route used to throw away claims past CLAIM_DAILY_CAP while answering
  -- the same cheerful "Received." -- so a partner with six clients lost
  -- the sixth and was told by his own claims panel not to re-send it. The
  -- cap's concealment job is done by the identical response; dropping the
  -- row only ever served flood protection, which CLAIM_STORE_CEILING now
  -- does. So these are kept, marked, and shown to staff.
  --
  -- NEVER SELECTED ON A PARTNER PATH. "You went over your daily limit" is
  -- a sentence about our rate-limiting, and the §3.2 response exists
  -- precisely so no such sentence is ever sent.
  over_cap      boolean not null default false,

  submitted_ip  text,
  created_at    timestamptz not null default now()
);

-- For a database where the table above already exists. `create table if
-- not exists` is a no-op there, so without this the route's insert fails
-- on every flagged claim and the partner meets a 500 instead of a row.
alter table public.partner_client_claims
  add column if not exists over_cap boolean not null default false;

-- The staff queue reads by status, newest first (§3.4).
create index if not exists partner_client_claims_status_created_idx
  on public.partner_client_claims (status, created_at desc);

-- Two different reads, two indexes. This one serves BOTH the partner's
-- own list (§3.5) and the daily cap count in the submission route, which
-- counts this partner's rows in the last 24 hours on every POST. A cap
-- that fails closed on an error means a slow or failing count is a
-- refusal to accept a claim, so the index is on the money path.
create index if not exists partner_client_claims_partner_created_idx
  on public.partner_client_claims (referral_partner_id, created_at desc);

alter table public.partner_client_claims enable row level security;

-- ============================================================
-- VERIFICATION — must return present = true.
-- ============================================================
-- select
--   'partner_client_claims' as object,
--   exists (
--     select 1 from information_schema.tables
--      where table_schema = 'public' and table_name = 'partner_client_claims'
--   )
--   and (
--     select count(*) from information_schema.columns
--      where table_schema = 'public' and table_name = 'partner_client_claims'
--        and column_name in (
--          'id','referral_partner_id','company_name','website','contact_name',
--          'contact_email','note','status','client_id','decided_by','decided_at',
--          'decision_note','over_cap','submitted_ip','created_at'
--        )
--   ) = 15
--   and (
--     select count(*) from pg_indexes
--      where schemaname = 'public' and tablename = 'partner_client_claims'
--        and indexname in (
--          'partner_client_claims_status_created_idx',
--          'partner_client_claims_partner_created_idx'
--        )
--   ) = 2
--   and (
--     select relrowsecurity from pg_class
--      where oid = 'public.partner_client_claims'::regclass
--   ) as present;
