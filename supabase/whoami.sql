-- ============================================================
-- WHICH DATABASE IS THIS, AND WHAT IS ACTUALLY IN IT?
--
-- Paste into the SQL editor you have been using. One submission, one
-- row, no writes, nothing to undo.
--
-- WHY THIS EXISTS
-- ---------------
-- 2026-10-13: the `alter table referral_partners add column if not
-- exists w9_received_at` was reported as run and working. Read back
-- through PostgREST against project fdqyzekseetvzkmuihbg, postgres
-- answered SQLSTATE 42703, "column referral_partners.w9_received_at
-- does not exist" -- and referral_partners was still 0 rows, which is
-- not a cached figure.
--
-- Two explanations survive that, and they call for opposite actions:
--
--   (a) the DDL did not commit in the database I am reading, so it
--       needs running again; or
--   (b) it committed in a DIFFERENT project from the one my
--       environment points at, in which case running it again changes
--       nothing and the real bug is that two databases are in play.
--
-- Guessing between those wastes a paste and, worse, a wrong guess in
-- direction (b) would have us "fixing" a database that was never
-- broken while the one the app reads stays broken.
--
-- WHY A FINGERPRINT RATHER THAN A PROJECT REF
-- -------------------------------------------
-- Nothing in SQL reports the Supabase project ref -- current_database()
-- is 'postgres' in every project, so it cannot tell two apart. Table
-- counts can: this database has clients = 9 and order_charges = 265,
-- measured today. If the numbers below match, your editor and my
-- environment are the same database and explanation (a) holds. If they
-- differ, that is explanation (b) and it is the finding.
--
-- information_schema.columns is the live catalog, so w9_exists is the
-- authoritative answer to the column question -- not a PostgREST view
-- of it, which is what every previous check of mine went through.
-- ============================================================

-- ============================================================
-- PART B -- WHY WILL IT NOT WRITE?
--
-- Answered part A on 2026-10-13: db=postgres clients=9
-- order_charges=265 w9_exists=false partners=0. The fingerprint
-- matches, and w9_exists came from information_schema inside the
-- editor's own session, so the editor IS pointed at the database the
-- app reads, and the `alter table` is simply not committing there.
--
-- The pattern to explain: every READ has worked in that session, and
-- every WRITE has left no trace. Only a few mechanisms do that, and
-- they are told apart by facts the session can report about itself.
--
--   txn_read_only = on
--       The session is inside a READ ONLY transaction, so postgres
--       refuses any DDL or DML with SQLSTATE 25006 while allowing
--       every select. This fits the observed pattern exactly.
--
--   default_read_only = on
--       Same, but set as the connection default rather than per
--       transaction -- worth separating, because the fix is in a
--       different place.
--
--   owns_table = false
--       current_user is not a member of the role owning
--       referral_partners, so ALTER TABLE is refused as "must be
--       owner of table" -- which also blocks DDL while leaving reads
--       working. The owner is printed so the two can be compared
--       rather than assumed.
--
-- This query is itself read-only, so it runs regardless of which of
-- those is true -- which is the point. A diagnostic that needed write
-- permission to diagnose a write problem would tell us nothing.
-- ============================================================
select current_user                                       as whoami,
       current_setting('transaction_read_only')            as txn_read_only,
       current_setting('default_transaction_read_only')    as default_read_only,
       (select tableowner from pg_tables
         where schemaname = 'public'
           and tablename  = 'referral_partners')           as table_owner,
       pg_has_role(current_user,
         (select tableowner from pg_tables
           where schemaname = 'public'
             and tablename  = 'referral_partners'),
         'member')                                         as owns_table;

-- ------------------------------------------------------------
-- PART A -- ONE CELL. The same facts collapsed into a single text
-- value, so the whole answer is one click and one paste.
--
-- !! RUN EXACTLY ONE OF THE TWO QUERIES IN THIS FILE, NOT BOTH.
-- !! The Supabase editor displays only the LAST statement's result, so
-- !! submitting the whole file shows the wide version and silently
-- !! discards this one. That is the same editor behaviour that hid the
-- !! notices in portal_email_test_partner.sql. Select the lines you
-- !! want and use Run selection, or delete the other query.
-- ------------------------------------------------------------
select 'db=' || current_database()
    || ' role=' || current_user
    || ' clients=' || (select count(*) from clients)
    || ' order_charges=' || (select count(*) from order_charges)
    || ' w9_exists=' || (
         select exists (
           select 1 from information_schema.columns
            where table_schema = 'public'
              and table_name   = 'referral_partners'
              and column_name  = 'w9_received_at')
       )::text
    || ' partners=' || (select count(*) from referral_partners)
    || ' schemas=' || coalesce((
         select string_agg(table_schema, '+' order by table_schema)
           from information_schema.tables
          where table_name = 'referral_partners'), 'NONE')
  as answer;

-- ------------------------------------------------------------
-- The same thing as columns, if you would rather read it as a table.
-- ------------------------------------------------------------
select
  current_database()                                        as db,
  current_user                                              as role,

  -- The fingerprint. Expected for fdqyzekseetvzkmuihbg as of
  -- 2026-10-13: clients = 9, order_charges = 265.
  (select count(*) from clients)                            as clients,
  (select count(*) from order_charges)                      as order_charges,

  -- The column in question, read from the live catalog.
  exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name   = 'referral_partners'
       and column_name  = 'w9_received_at'
  )                                                         as w9_exists,

  -- And whether the fixture row is here. Expected 0 before part 2 of
  -- portal_email_test_partner.sql, 1 after.
  (select count(*) from referral_partners)                  as partners,
  (select count(*) from referral_partners
    where name = 'ZZ PORTAL TEST - DELETE ME')              as fixture_rows,

  -- Which schemas hold a table of this name. More than one row's worth
  -- here would explain everything: the ALTER would have landed on
  -- whichever the search_path resolved, while PostgREST reads only
  -- 'public'. Reported as a list rather than a count so the answer
  -- names the culprit instead of merely asserting there is one.
  (select string_agg(table_schema, ', ' order by table_schema)
     from information_schema.tables
    where table_name = 'referral_partners')                 as schemas_with_table;
