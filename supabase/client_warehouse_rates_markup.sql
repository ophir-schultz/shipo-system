-- client_warehouse_rates.markup — the dollar markup on a cost_plus line.
--
-- Hand-applied in the Supabase SQL editor. There is no migration runner in
-- this project (docs/superpowers/global-constraints.md), so "the code is
-- deployed" and "the schema exists" are independent facts.
--
-- ---------------------------------------------------------------------------
-- WHY A SECOND COLUMN AND NOT JUST `rate`
-- ---------------------------------------------------------------------------
-- Freight is billed as carrier cost plus an agreed DOLLAR markup, a different
-- figure per client (Ophir 2026-10-15). Neither existing rate_type can say
-- that: `at_cost` makes revenue equal cost, so margin is zero by construction
-- and a referral partner's 5% of it is zero; `flat` ignores the carrier cost
-- entirely, pricing a 1 lb zone-2 parcel and a 40 lb zone-8 one the same.
--
-- The obvious thing is to write (rate_type 'cost_plus', rate 5.00) and teach
-- the calculator to read it. It type-checks, it reads naturally, and it is a
-- silent loss on every client you set it up for — because of code that is
-- already deployed.
--
-- `rate_type` is a bare `text` column with NO check constraint
-- (ledger_03_charges.sql:348), and the shipping branch of the charge
-- calculator used to END in a catch-all that priced any rate_type it did not
-- recognise as a flat per-shipment amount. So on the deploy that was live when
-- this column was written, a cost_plus row with rate 5.00 bills $5.00 FLAT per
-- shipment: the markup alone, carrier cost silently dropped. Across the 257
-- shipments already in order_charges that is roughly $1,285 billed against
-- $2,306.50 of freight actually paid — booked as real revenue, with nothing
-- anywhere flagging it.
--
-- Putting the markup in its own column removes the ordering problem instead of
-- documenting it. `rate` stays NULL on a cost_plus row, so code that predates
-- the type hits its own "line in effect with an empty rate cell" guard, warns,
-- and writes amount = null — unknown, flagged, and unpayable in
-- partner_client_monthly rather than confidently wrong. Rate card rows and the
-- code that prices them can now be applied in either order, which is the
-- whole point: a safety property that depends on a human remembering a deploy
-- sequence is not a safety property.
--
-- ---------------------------------------------------------------------------

alter table client_warehouse_rates add column if not exists markup numeric;

comment on column client_warehouse_rates.markup is
  'Dollar markup added to carrier cost on a cost_plus line. NULL on every '
  'other rate_type. Deliberately separate from `rate`: a cost_plus row keeps '
  '`rate` NULL so that code which does not understand the type leaves the '
  'amount unknown instead of billing the markup as a flat rate.';

-- No DEFAULT and no backfill, for the same reason partner_tax_status.sql has
-- neither. A default would write a number nobody agreed onto every one of the
-- rate card rows that already exist, and `0` in particular reads downstream as
-- "cost price, margin zero" — a term, stated confidently, that no client
-- signed. NULL is the honest value for "not set", and the calculator reports
-- it by name ('cost_plus line with no markup') rather than pricing it.
--
-- No check constraint tying markup to rate_type either, and that is a
-- deliberate limit on what SQL is asked to guarantee here. The invariant is
-- two-sided (markup set iff rate_type = 'cost_plus'), `rate_type` itself is
-- unconstrained text written by two different writers, and a table-level check
-- would reject the legacy writer's rows — which leave charge_type null and are
-- none of this column's business. The calculator enforces it where it can
-- report it usefully.

-- ---------------------------------------------------------------------------
-- VERIFY — run these three after the ALTER.
-- ---------------------------------------------------------------------------

-- 1. The column exists and is nullable numeric.
select column_name, data_type, is_nullable, column_default
  from information_schema.columns
 where table_name = 'client_warehouse_rates'
   and column_name = 'markup';
-- Expect exactly one row: markup | numeric | YES | (null)

-- 2. Nothing was backfilled. Every existing row still reads null.
select count(*) as total_rows,
       count(markup) as rows_with_a_markup
  from client_warehouse_rates;
-- Expect rows_with_a_markup = 0

-- 3. THE ROW SHAPE THAT WOULD STILL MIS-BILL, which no constraint here
--    prevents and which is therefore worth being able to ask about. A
--    cost_plus line with a populated `rate` is the hazardous shape described
--    at the top of this file; a cost_plus line with no markup is the
--    incomplete one. Both are refused by the calculator rather than priced,
--    and both should return zero rows on a correctly entered card.
select id, client_id, charge_type, variant, rate_type, rate, markup,
       case when rate is not null then 'cost_plus with a populated rate'
            when markup is null   then 'cost_plus with no markup'
       end as problem
  from client_warehouse_rates
 where rate_type = 'cost_plus'
   and (rate is not null or markup is null);
-- Expect 0 rows
