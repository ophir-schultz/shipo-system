-- ============================================================
-- Partner portal login — email + 6-digit code
--
-- Partners are NOT Supabase Auth users, deliberately. The staff
-- proxy authorises on "is there a Supabase session", so giving a
-- partner a Supabase user would hand them /dashboard, /clients and
-- /billing. Partner sessions are a separate mechanism that can
-- never satisfy that check.
--
-- Nothing here stores a code or a session token in the clear —
-- only SHA-256 hashes. A leaked database row cannot be replayed
-- as a login.
--
-- Idempotent. Apply in the Supabase SQL editor after
-- partner_portal.sql.
-- ============================================================

create extension if not exists "uuid-ossp";

-- ---- one-time login codes ----------------------------------
create table if not exists partner_login_codes (
  id uuid primary key default uuid_generate_v4(),
  referral_partner_id uuid references referral_partners(id) on delete cascade,
  email text not null,
  code_hash text not null,          -- SHA-256 of the 6-digit code
  expires_at timestamptz not null,
  consumed_at timestamptz,
  attempts integer default 0,       -- wrong guesses against this code
  request_ip text,
  created_at timestamptz default now()
);

create index if not exists partner_login_codes_partner_idx
  on partner_login_codes (referral_partner_id, created_at desc);
create index if not exists partner_login_codes_email_idx
  on partner_login_codes (lower(email), created_at desc);

-- ---- portal sessions ---------------------------------------
create table if not exists partner_sessions (
  id uuid primary key default uuid_generate_v4(),
  referral_partner_id uuid references referral_partners(id) on delete cascade,
  token_hash text not null,         -- SHA-256 of the cookie value
  expires_at timestamptz not null,
  revoked_at timestamptz,
  user_agent text,
  created_at timestamptz default now(),
  last_seen_at timestamptz default now()
);

create unique index if not exists partner_sessions_token_uniq
  on partner_sessions (token_hash);
create index if not exists partner_sessions_partner_idx
  on partner_sessions (referral_partner_id);

-- A partner needs an email to log in at all. Enforced in the app
-- rather than the schema so an existing partner row without one
-- does not break the Referrals screen.

alter table partner_login_codes enable row level security;
alter table partner_sessions enable row level security;

-- ---- retire the bearer-link columns ------------------------
-- Superseded by real logins. Left in place (not dropped) so no
-- data is destroyed, but the app no longer reads them and any
-- link previously issued is cleared here so it stops working.
update referral_partners
   set portal_token = null,
       portal_token_created_at = null
 where portal_token is not null;
