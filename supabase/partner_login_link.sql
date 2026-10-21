-- ============================================================
-- One-click sign-in link. Spec §2.1.
--
-- WHY THESE COLUMNS AND NOT A NEW TABLE
--
-- A sign-in link and a 6-digit code are the same object: a one-time
-- credential issued to one partner, redeemable once, with an expiry.
-- partner_login_codes already carries the discipline that object needs
-- — consumed_at, attempts, request_ip, a partner FK that cascades — and
-- every one of those behaviours is already under test. A second table
-- would be a second place to forget `is null` on consumed_at.
--
-- So one row per issuance, with TWO ways to redeem it:
--
--   code_hash       + expires_at       -> the 6-digit code, 10 minutes
--   link_token_hash + link_expires_at  -> the emailed link, 7 days
--
-- ONE consumed_at covers both, and that is the point rather than an
-- accident: signing in by link must kill the code in the same email,
-- and vice versa. Two independent consumed flags would leave a
-- still-live credential sitting in a mailbox after its owner was
-- already signed in.
--
-- THE TTLs DIFFER ON PURPOSE. The code is typed by someone who has the
-- email open, so ten minutes is generous. The link is delivered when
-- staff create the partner row, and the partner may not read mail that
-- day — a ten-minute link would be dead before it was ever seen. Seven
-- days is the compromise: long enough to survive a weekend, short
-- enough that a forwarded or archived email stops being a key.
--
-- NOT NULLABLE-BY-ACCIDENT: both columns are nullable, because every
-- row written before this migration has no link, and a code-only row is
-- a legitimate thing to write (see the degradation note in
-- request-code). The route treats null as "this row has no link",
-- which is a refusal, not an error.
--
-- NOTHING IS STORED IN THE CLEAR. link_token_hash is SHA-256 of a
-- 32-byte base64url token, exactly as code_hash is SHA-256 of the six
-- digits. A leaked row cannot be replayed as a login.
--
-- Idempotent. Apply in the Supabase SQL editor after
-- supabase/partner_login.sql.
-- ============================================================

alter table partner_login_codes
  add column if not exists link_token_hash text,
  add column if not exists link_expires_at timestamptz;

-- The lookup the verify-link route makes: hash in, one row out.
--
-- UNIQUE, so two live links can never collide on one hash — a collision
-- would make "which partner does this token belong to" ambiguous, and
-- the route resolves the partner FROM the row. Partial, because the
-- column is null on every pre-existing row and on every code-only row,
-- and a plain unique index would treat those nulls as distinct anyway
-- while still carrying them in the index.
create unique index if not exists partner_login_codes_link_token_uniq
  on partner_login_codes (link_token_hash)
  where link_token_hash is not null;

-- ---- what this does NOT do --------------------------------
--
-- It does not revive referral_partners.portal_token. That was a BEARER
-- link: a URL that was itself the credential, never expired, never
-- single-use, and logged you in on GET. partner_login.sql retired it
-- and cleared every issued value. This migration is not that mechanism
-- returning under a new name — the difference is that a GET on the new
-- link renders a button and signs nobody in, which is what makes it
-- survive the email scanners that would silently burn a bearer link
-- before the partner ever clicked it.
