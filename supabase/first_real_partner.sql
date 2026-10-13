-- ============================================================
-- The first real referral partner, and the client they referred.
--
-- Run this in the Supabase SQL editor:
--   https://supabase.com/dashboard/project/fdqyzekseetvzkmuihbg/sql/new
--
-- EDIT THE FOUR VALUES IN THE `input` BLOCK BELOW AND NOTHING ELSE.
--
-- This writes a REAL COMMISSION OBLIGATION. Once the client is linked,
-- /pnl computes 5% of that client's net profit plus a $300 signup bonus
-- as money owed, and the Referrals screen will offer to approve a
-- payout against it. So the attribution has to be factually true --
-- this is not a test row and there is no "demo" mode that would make it
-- one.
--
-- WHAT IT DOES NOT DO: grant portal access. agreement_status is left at
-- its default ('not_sent'), because Shipo's rule is that the agreement
-- is signed first. See src/lib/partner-access.ts.
--
-- Everything is inside one DO block, so it runs in one transaction: any
-- refusal below rolls back the whole thing and leaves no half-made
-- partner behind.
--
-- Safe to run twice -- the second run refuses rather than making a
-- second partner for the same person.
-- ============================================================

-- ------------------------------------------------------------
-- 0. The missing column that is currently breaking /referrals.
--
-- src/app/referrals/page.tsx selects w9_received_at. The column was
-- never added, so that select fails and the whole staff Referrals
-- screen 500s -- which is the screen you would use to create a partner
-- by hand. Measured 2026-10-13:
--   column referral_partners.w9_received_at does not exist
--
-- This is the same one line as supabase/partner_w9.sql, repeated here
-- so one paste leaves you with a working screen. Idempotent either way.
-- ------------------------------------------------------------
alter table referral_partners add column if not exists w9_received_at timestamptz;

-- ------------------------------------------------------------
-- 1. The partner and the link.
-- ------------------------------------------------------------
do $$
declare
  -- ==========================================================
  -- EDIT THESE FOUR. Everything else is derived or checked.
  -- ==========================================================
  partner_name    text := 'FULL NAME HERE';
  partner_email   text := 'email@example.com';
  partner_company text := 'COMPANY HERE';     -- '' or null if an individual

  -- Which client did they actually refer? Must match an existing row in
  -- `clients` exactly (case and spacing are forgiven, nothing else is).
  -- The five clients that currently have any ledger activity at all:
  --   Suteka (161 charges), SitnStand (51), Orcam (36), Kivema (5),
  --   Time Systems (UK) Ltd (4)
  referred_client text := 'Suteka';

  -- The month the client's FIRST PAYMENT landed. This is the anchor for
  -- the 12-month commission window AND the release condition for the
  -- $300 signup bonus -- src/lib/referrals.ts computeOwed(). Leave it
  -- as the 1st of the month.
  --
  -- It must be ON OR BEFORE the earliest month you want commissioned.
  -- The ledger's earliest charges are 2026-09, so 2026-09-01 covers
  -- everything on the books. A LATER date silently drops the earlier
  -- months out of the window with the note "before the recorded first
  -- payment", and an EARLIER one is a claim about when money arrived
  -- that is not true.
  first_payment   date := '2026-09-01';
  -- ==========================================================

  v_partner   uuid;
  v_client    uuid;
  v_existing  text;
  v_matches   int;
begin
  partner_name    := btrim(partner_name);
  partner_email   := lower(btrim(partner_email));
  partner_company := nullif(btrim(coalesce(partner_company, '')), '');
  referred_client := btrim(referred_client);

  -- ---- refuse on the placeholders, loudly -------------------
  --
  -- Pasting this file unedited must not create a partner called
  -- "FULL NAME HERE" with a live commission obligation attached.
  if partner_name = '' or partner_name = 'FULL NAME HERE'
     or partner_email = '' or partner_email = 'email@example.com' then
    raise exception
      'Fill in partner_name and partner_email at the top of this block first. '
      'Nothing was written.';
  end if;

  if partner_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception
      'partner_email (%) does not look like an email address. The portal login IS '
      'the email address, so a typo here locks the partner out and there is no '
      'second identifier to recover them by.', partner_email;
  end if;

  -- ---- one partner per human --------------------------------
  --
  -- CASE-INSENSITIVE on purpose. /api/referrals/intake deduped
  -- case-sensitively once and minted two partner rows for the same
  -- person, which splits one partner's clients across two statements
  -- and pays neither correctly.
  select name into v_existing
    from referral_partners
   where lower(btrim(email)) = partner_email
   limit 1;

  if v_existing is not null then
    raise exception
      'A partner with the email % already exists (%). Link the client to that row '
      'instead of making a second one -- two rows for one human splits their '
      'clients across two statements.', partner_email, v_existing;
  end if;

  -- ---- the client has to exist, and exactly one of it -------
  select count(*) into v_matches
    from clients
   where lower(btrim(name)) = lower(referred_client);

  if v_matches = 0 then
    raise exception
      'No client named %. Check the spelling against the clients table -- a partner '
      'created here with nothing linked would sit on the Referrals screen looking '
      'like a partner who has referred nobody.', referred_client;
  elsif v_matches > 1 then
    raise exception
      '% clients are named %. Linking the wrong one attributes another client''s '
      'revenue to this partner. Resolve the duplicate first.', v_matches, referred_client;
  end if;

  select id into v_client
    from clients
   where lower(btrim(name)) = lower(referred_client);

  -- ---- a client belongs to at most one partner --------------
  --
  -- Overwriting an existing attribution moves a live commission
  -- obligation from one person to another, silently.
  select p.name into v_existing
    from clients c
    join referral_partners p on p.id = c.referral_partner_id
   where c.id = v_client;

  if v_existing is not null then
    raise exception
      '% is already attributed to %. Clear that first if the attribution is wrong -- '
      'reassigning it here would move a live commission from one person to another '
      'with no record of the change.', referred_client, v_existing;
  end if;

  -- ---- write ------------------------------------------------
  --
  -- commission_type / commission_value are left at their table defaults
  -- ('flat', 0) deliberately. NOTHING reads them: the deal lives in
  -- REFERRAL_TERMS (5% for 12 months, $300 bonus) in src/lib/referrals.ts.
  -- Typing 5 into commission_value would read like a second, conflicting
  -- source of truth for the rate.
  --
  -- signup_bonus_amount is left NULL so the standing $300 applies.
  -- A number there is a BESPOKE contracted bonus for one signed partner
  -- and overrides the programme.
  --
  -- agreement_status is left at its default. The partner cannot be
  -- invited to the portal until it reads 'signed', which the DocuSign
  -- webhook writes. That ordering is the point.
  insert into referral_partners (name, company, email, status, source, notes)
  values (
    partner_name,
    partner_company,
    partner_email,
    'active',
    'manual',
    'Created by hand in supabase/first_real_partner.sql on ' || current_date ||
      '. First partner on the standing programme: 5% of net profit for 12 months '
      'from first payment, plus a $300 signup bonus.'
  )
  returning id into v_partner;

  update clients
     set referral_partner_id        = v_partner,
         -- coalesce: never overwrite a date somebody already recorded.
         referral_signup_date        = coalesce(referral_signup_date, first_payment),
         referral_first_payment_date = coalesce(referral_first_payment_date, first_payment)
   where id = v_client;

  raise notice 'Partner % (%) created as %.', partner_name, partner_email, v_partner;
  raise notice 'Client % (%) attributed to them, first payment %.',
    referred_client, v_client, first_payment;
  raise notice 'Agreement is NOT signed, so the portal stays shut until DocuSign comes back.';
end $$;

-- ============================================================
-- VERIFICATION -- run this as a SEPARATE submission.
--
-- The Supabase SQL editor only shows the LAST statement's result, so a
-- select pasted above would hide the notices raised by the block.
--
-- EXPECT: one row per (client, month) with activity.
--
-- EXPECT revenue, net_profit_before_processing = NULL and payable =
-- false on every row, as of 2026-10-13. That is not a fault in this
-- file. Every one of the 257 order_charges rows is an at-cost shipping
-- line with a known `cost` and a NULL `amount` -- the ledger knows what
-- we PAID the carrier and not what we BILLED the client, because none
-- of the five clients with charges has a rate card (only Nayax does,
-- and Nayax has no charges). Until those amounts exist, the partner
-- statement correctly reports every month as provisional and owes
-- nothing.
-- ============================================================
-- select period_month, client_name, revenue, cost_freight, cost_materials,
--        cost_storage, cost_labour_not_deducted, net_profit_before_processing,
--        revenue_unknown_charges, cost_unknown_charges, payable
--   from partner_client_monthly
--  order by period_month desc, client_name;

-- ============================================================
-- UNDO, if the attribution turns out to be wrong. Replace the email.
-- Order matters: unlink before delete, or the FK on clients blocks it.
-- ============================================================
-- update clients
--    set referral_partner_id = null,
--        referral_signup_date = null,
--        referral_first_payment_date = null
--  where referral_partner_id = (
--    select id from referral_partners where lower(email) = lower('email@example.com')
--  );
--
-- delete from referral_partners where lower(email) = lower('email@example.com');
