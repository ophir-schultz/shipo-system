-- ============================================================
-- Is this partner a US person? Spec §2a.7.
--
-- Shipo's partners are US only for now. That was a sentence in a
-- conversation, and a sentence is not a guard: the W-9 builder would
-- have happily assembled an envelope for a partner in Tel Aviv or a
-- company in Cyprus, and a signed W-9 from a non-US person is not a
-- defective form, it is the WRONG form. The IRS wants a W-8BEN from a
-- foreign individual and a W-8BEN-E from a foreign entity, with treaty
-- claims and a different withholding regime behind each.
--
-- NEITHER W-8 IS BUILT, DELIBERATELY. This column exists so that the
-- absence is enforced rather than remembered. src/lib/partner-tax-status.ts
-- turns it into a refusal and src/lib/docusign-envelope.ts throws on it
-- before assembling any document, so the failure is "we cannot send you
-- this yet, email us" and never "here, sign the wrong form".
--
-- NO DEFAULT, AND THAT IS THE WHOLE POINT. Unset is its own state and
-- the builder refuses it. Defaulting to 'us_person' would be a default
-- that happens to be the safe answer for today's roster and silently
-- becomes the wrong answer the first time somebody abroad is added --
-- a guard whose correctness depends on nobody using the system is not a
-- guard. Staff set this in the partner editor on /referrals; the
-- partner is never asked, because the question is ours to answer from
-- the paperwork, not his to self-certify in a web form.
--
-- The CHECK constraint is what keeps the three values in the database
-- the same three the TypeScript union knows. Without it a typo in a
-- staff-side dropdown writes a value taxStatusOf() reads as null, which
-- reads downstream as "unset" -- a refusal rather than a wrong send, so
-- it fails in the safe direction, but it fails invisibly and a partner
-- waits on a screen nobody knows is blocked.
--
-- Idempotent. Apply in the Supabase SQL editor.
-- ============================================================

alter table referral_partners add column if not exists tax_status text;

-- Added separately from the column so this file stays re-runnable: the
-- `add column if not exists` above is a no-op on a second run, and a
-- bare `add constraint` would then fail on the name already existing.
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'referral_partners_tax_status_check'
  ) then
    alter table referral_partners
      add constraint referral_partners_tax_status_check
      check (tax_status is null or tax_status in ('us_person', 'foreign_individual', 'foreign_entity'));
  end if;
end $$;

-- Backfill is deliberately a no-op. NULL is the honest value for every
-- existing row: nobody has looked at their paperwork and recorded an
-- answer. Writing 'us_person' across the table to "clean it up" would
-- assert a fact about each partner's tax residency that no human has
-- checked -- and would hand the builder permission to send a W-9 on the
-- strength of a bulk UPDATE.

-- ============================================================
-- VERIFICATION — must return present = true.
-- ============================================================
-- select
--   'referral_partners.tax_status' as column_name,
--   exists (
--     select 1 from information_schema.columns
--      where table_name = 'referral_partners' and column_name = 'tax_status'
--   )
--   and exists (
--     select 1 from pg_constraint
--      where conname = 'referral_partners_tax_status_check'
--   ) as present;
