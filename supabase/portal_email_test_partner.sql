-- ============================================================
-- A THROWAWAY partner row, to prove the portal and the mail path.
--
-- Run in the Supabase SQL editor:
--   https://supabase.com/dashboard/project/fdqyzekseetvzkmuihbg/sql/new
--
-- EDIT ONE VALUE (test_email) AND NOTHING ELSE.
--
-- !! THIS ROW MUST BE DELETED WHEN YOU ARE DONE. The UNDO is at the
-- !! bottom of this file and is two statements. An active, signed
-- !! partner row left behind can request a login code forever, and it
-- !! is the one row in the table that nobody is accountable for.
--
-- WHY THIS IS NOT first_real_partner.sql
-- --------------------------------------
-- That file creates a partner AND links a client, which writes a real
-- commission obligation -- 5% of that client's net profit for 12 months
-- plus a $300 bonus -- and it says so: "this is not a test row and there
-- is no demo mode that would make it one." Correct, for what it does.
--
-- This file links NO CLIENT. That is the entire difference and it is
-- what makes the row safe: with no client attributed, partner_client_
-- monthly has nothing to report for them, computeOwed() has no revenue
-- to take a percentage of, and the Referrals screen cannot offer a
-- payout against them. The row can sign in and see an empty statement.
-- Nothing about money is touched.
--
-- WHY agreement_status IS SET BY HAND HERE
-- ----------------------------------------
-- Normally that would be the wrong thing to do, and first_real_partner
-- .sql deliberately refuses to: Shipo's rule is the agreement is signed
-- BEFORE access, and partner-access.ts enforces it so the ordering does
-- not depend on whoever is clicking. The reason the rule exists is that
-- a partner reaching their statement unsigned would be reading
-- commission figures under terms they have not agreed to, and those
-- figures are confidential under Section 6 of the agreement.
--
-- This row has no figures. It represents no human, refers no client,
-- and signs nothing, so there is no confidence to breach and no terms to
-- be unagreed to. Setting it 'signed' is a statement about a fixture,
-- not a claim that anybody signed anything -- which is exactly why the
-- row has to be deleted rather than kept around as "the test partner".
--
-- WHAT IT ACTUALLY PROVES
-- -----------------------
-- /api/partner/request-code answers with the same uniform OK for an
-- unknown address, for a blocked partner, and for a partner who really
-- was mailed a code -- by design, so it cannot be used as a directory
-- of who Shipo's partners are. With referral_partners empty, EVERY
-- request gets that OK, so the endpoint reports "a code is on its way"
-- with no provider configured at all.
--
-- Once this row exists and passes the access gate, that stops being
-- true: request-code reaches sendEmail, and a mail failure returns a
-- real 502 with a real message. The response finally carries
-- information. Either a code lands in the inbox, or the portal says so.
-- ============================================================

-- ------------------------------------------------------------
-- 1. The column that is breaking /referrals.
--
-- src/app/referrals/page.tsx selects w9_received_at and the column was
-- never added, so the staff Referrals screen 500s -- the screen you
-- would otherwise use to see this partner. Same single line as
-- supabase/partner_w9.sql, repeated so one paste leaves a working
-- screen. Idempotent, and harmless if it already ran.
--
-- ✅ DONE on fdqyzekseetvzkmuihbg, 2026-10-13. Confirmed from outside
-- the editor by `npx tsx --env-file=.env.local scripts/verify-w9-column.mjs`
-- (HTTP 200 where it had answered SQLSTATE 42703 for three rounds).
-- Idempotent, so re-running costs nothing.
--
-- !! RUN THIS ON ITS OWN, as its own submission, BEFORE part 2 -- and
-- !! SELECT NOTHING before pressing Run.
--
-- Two separate editor behaviours bit here, and only the second was the
-- real one:
--
-- 1. A submission is ONE TRANSACTION. With this line above the do-block
--    in a single paste, a failure in the block would roll the column
--    back too, breaking /referrals for a reason unrelated to /referrals
--    and reporting one error for two unrelated things.
--
-- 2. THE EDITOR RUNS ONLY THE SELECTED TEXT when anything is
--    highlighted, and reports success for whatever subset it ran. This
--    is what actually happened: three pastes of this line were reported
--    as run and none of them executed. The session was `postgres`,
--    owned the table, sat in no read-only transaction, and was in the
--    right database -- it could write, it was never asked to. It landed
--    the instant the statement was submitted together with a catalog
--    read-back, with nothing selected.
-- ------------------------------------------------------------
alter table referral_partners add column if not exists w9_received_at timestamptz;

-- ------------------------------------------------------------
-- 2. The throwaway partner. Run as a SEPARATE submission.
--
-- Every raise below is deliberately ONE single-quoted literal on ONE
-- line, however long that makes the line. The earlier version wrapped
-- each message across several adjacent literals for readability, which
-- relies on the lexer concatenating them into the single string constant
-- that RAISE wants -- and that was the leading suspect for why the first
-- run of this file wrote nothing. Readability is not worth a construct
-- I could not test: there is no local postgres here, so this file is
-- checked by being run against the real database and nothing else.
--
-- The whole file is also pure ASCII, and must stay that way. The fixture
-- name used to contain an em dash, and the UNDO at the bottom matches
-- rows BY THAT NAME. Any mangling of one non-ASCII character between
-- this file and the SQL editor -- clipboard, encoding, a copy through
-- something that normalises punctuation -- would insert under one name
-- and delete under another. The UNDO would then report "0 rows" and
-- read as a clean success while leaving behind the one thing this file
-- insists must not be left behind: an active, signed partner row that
-- can request login codes forever and that nobody is accountable for.
-- A hyphen cannot fail that way.
-- ------------------------------------------------------------
do $$
declare
  -- ==========================================================
  -- EDIT THIS. Use an address you can actually read, because the
  -- whole point is to see whether the email arrives.
  --
  -- A +suffix is good here: Google Workspace delivers
  -- ophir+portaltest@shipousa.com to ophir@shipousa.com, and it keeps
  -- the fixture visibly distinct from your real address in the table.
  -- Whatever you put here is what you must type at the login screen --
  -- the partner is looked up BY this address and nothing else.
  -- ==========================================================
  test_email text := 'ophir+portaltest@shipousa.com';
  -- ==========================================================

  v_partner  uuid;
  v_existing uuid;
begin
  test_email := lower(btrim(test_email));

  if test_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'test_email (%) does not look like an email address. The portal login IS the email address, so a typo means the code is mailed into the void and the test tells you nothing. Nothing was written.', test_email;
  end if;

  -- Case-insensitive, like every other lookup against this table.
  -- /api/referrals/intake deduped case-sensitively once and minted two
  -- partner rows for one human; a fixture should not reintroduce that.
  select id into v_existing
    from referral_partners
   where lower(btrim(email)) = test_email
   limit 1;

  if v_existing is not null then
    raise exception 'A partner with the email % already exists (%). Run the UNDO at the bottom of this file first. Making a second row would split one address across two partners and the login would match whichever the database returned first.', test_email, v_existing;
  end if;

  -- status 'active'    -> passes the `status = 'inactive'` check
  -- agreement_status   -> must equal 'signed' exactly; NULL and
  --                       'not_sent' both read as unsigned and are
  --                       silently refused a code
  -- NO client link, so no commission obligation exists.
  insert into referral_partners (name, company, email, status, source, notes)
  values (
    'ZZ PORTAL TEST - DELETE ME',
    null,
    test_email,
    'active',
    'manual',
    -- Explicit || at every join, and current_date cast to text rather than
    -- left to the anynonarray || text resolution. Same reason as the raises:
    -- no construct in this file should be one I cannot test.
    'Throwaway fixture created by supabase/portal_email_test_partner.sql on '
      || current_date::text
      || '. Proves the Resend mail path and the portal login. NOT a real partner. No client is attributed and no commission is owed. Delete with the UNDO block in that file.'
  )
  returning id into v_partner;

  -- Set separately rather than in the insert above, so this file does not
  -- depend on whether the column has a default or is even present yet --
  -- partner_onboarding.sql adds it with `add column if not exists`.
  update referral_partners
     set agreement_status = 'signed'
   where id = v_partner;

  raise notice 'Created throwaway partner % as %.', test_email, v_partner;
  raise notice 'Name is "ZZ PORTAL TEST - DELETE ME" so it sorts last and reads as a fixture.';
  raise notice 'No client attributed, so nothing is owed and /pnl is unaffected.';
  raise notice 'NEXT: request a code at /partner/login using %', test_email;
  raise notice 'THEN: run the UNDO block at the bottom of this file.';
end $$;

-- ============================================================
-- VERIFY -- NOT commented out, and NOT a separate submission. Paste it
-- together with the do-block above, select nothing, press Run.
--
-- This used to say "run as a SEPARATE submission", on the reasoning
-- that the editor shows only the last statement's result and a select
-- here would hide the raise notices. That reasoning was wrong, and it
-- cost three rounds on the `alter table` that this file also carries.
--
-- What happened: the statement was pasted, reported as run, and left no
-- trace -- three times. The session turned out to be `postgres`, owning
-- the table, in no read-only transaction, in the right database. It
-- could write. It simply was never asked to, because the editor runs
-- only the SELECTED text when anything is highlighted, and still
-- reports success for whatever subset it did run. The moment the write
-- and a catalog read-back went into ONE submission, it worked
-- immediately and was confirmed from outside.
--
-- So: the notices are worth less than proof the block executed. A
-- notice says what the code INTENDED to do and prints identically
-- whether or not the transaction survives; this select is the row
-- itself. Keep them together.
--
-- EXPECT exactly one row, status active, agreement signed, and
-- clients_attributed = 0. If clients_attributed is anything else, this
-- row is carrying a commission obligation and the UNDO must be run.
--
-- NO ROWS AT ALL is the result to care about: it means the do-block did
-- not run, not that it ran and did nothing -- an insert and this select
-- are in the same transaction, so it cannot miss its own work.
-- ============================================================
select p.id, p.name, p.email, p.status, p.agreement_status,
       (select count(*) from clients c where c.referral_partner_id = p.id)
         as clients_attributed
  from referral_partners p
 where p.name = 'ZZ PORTAL TEST - DELETE ME';

-- ============================================================
-- UNDO -- RUN THIS WHEN THE TEST IS DONE.
--
-- Matched on the fixture NAME, not the email, so it cleans up even if
-- you edited test_email above and no longer remember what you used.
--
-- TWO statements, in this order. The unlink is first and is NOT
-- optional in general: clients.referral_partner_id is declared
--   references referral_partners(id)
-- with no `on delete` clause (supabase/referral_program.sql:40), so it
-- defaults to NO ACTION and the delete would be REFUSED by the foreign
-- key while any client still points at the row. For this fixture it
-- should report 0 rows, because nothing was ever linked -- if it
-- reports more, something attributed a client to the test partner and
-- that wants looking at before you delete anything.
--
-- No cleanup is needed for partner_login_codes or partner_sessions:
-- both declare referral_partner_id ... on delete cascade
-- (supabase/partner_login.sql:23,41), so any codes issued during the
-- test and any session it opened go with the row. Deleting them by
-- hand would work but would imply the cascade is not there.
-- ============================================================
-- update clients
--    set referral_partner_id = null,
--        referral_signup_date = null,
--        referral_first_payment_date = null
--  where referral_partner_id in (
--    select id from referral_partners where name = 'ZZ PORTAL TEST - DELETE ME'
--  );
--
-- delete from referral_partners where name = 'ZZ PORTAL TEST - DELETE ME';
