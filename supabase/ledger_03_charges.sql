-- Complete the ledger, migration 3 of 4: the charge record.
-- Spec: docs/superpowers/specs/2026-09-29-complete-the-ledger-design.md §5.2, §6
-- Requires ledger_01_orders.sql and ledger_02_cost.sql to have been applied.
-- Safe to run more than once.

-- ---------------------------------------------------------------------------
-- A stable identity for shipments.
-- order_number is not unique: multi-package orders, reships and return labels
-- all repeat it. ShipStation's shipmentId is the only stable key available.
-- ---------------------------------------------------------------------------
alter table shipments add column if not exists shipstation_shipment_id bigint;

-- Backfill from the payload we already store. No API call needed.
update shipments
set shipstation_shipment_id = (raw_data->>'shipmentId')::bigint
where shipstation_shipment_id is null
  and raw_data ? 'shipmentId'
  and raw_data->>'shipmentId' ~ '^[0-9]+$';

-- Partial, so rows with no shipmentId do not block the index. If this fails
-- with a unique violation, the database already holds duplicate shipment rows
-- from the insert-path defect (spec §3.2) and they must be reconciled before
-- this migration can complete. Stop and report rather than dropping the index.
create unique index if not exists shipments_shipstation_id_key
  on shipments (shipstation_shipment_id)
  where shipstation_shipment_id is not null;

-- ---------------------------------------------------------------------------
-- A normalised order number to join shipments to orders on.
-- ---------------------------------------------------------------------------
-- orders.order_key is upper-cased and trimmed at write time (sync/zenventory.ts)
-- while shipments.order_number is whatever the carrier sent. Task 14 therefore
-- has to match them case-insensitively -- but a case-insensitive match done only
-- in memory is a trap: the rows still have to be FETCHED first, and PostgREST's
-- `.in()` is a case-SENSITIVE SQL `IN`. A label whose order number arrives in a
-- third casing is never retrieved, so the in-memory normalisation never sees it
-- and the shipping revenue is lost silently rather than loudly.
--
-- A stored generated column makes the fetch and the join agree by construction,
-- and is indexable, which `upper(order_number)` in a predicate would not be
-- without a matching expression index anyway.
--
-- NOTE: adding a stored generated column rewrites the table. On a shipments
-- table of this size that is seconds, but it is not instantaneous -- do not run
-- it in the middle of a sync.
alter table shipments add column if not exists order_number_key text
  generated always as (upper(btrim(order_number))) stored;
create index if not exists shipments_order_number_key_idx
  on shipments (order_number_key);

-- ---------------------------------------------------------------------------
-- The margin record: the one table carrying both what we charged and what it
-- cost.
-- ---------------------------------------------------------------------------
create table if not exists order_charges (
  id                 uuid primary key default uuid_generate_v4(),
  order_id           uuid references orders(id) on delete cascade,
  client_id          uuid references clients(id),
  rate_id            uuid references client_warehouse_rates(id),
  cost_rate_id       uuid references cost_rates(id),
  charge_key         text not null,
  charge_type        text not null,
  label              text not null,
  quantity           numeric(10,2),
  unit_rate          numeric(10,4),
  -- NULLABLE, for the same reason `cost` is. An at-cost freight line is billed
  -- at whatever the carrier charged, so until the carrier reports we do not
  -- know the revenue either. Storing 0 there is a claim that the label was
  -- given away free, and it understates revenue in every view that sums this
  -- column -- the exact null-versus-zero confusion this project exists to stop.
  amount             numeric(10,2),
  cost               numeric(10,2),
  cost_basis         text,
  charge_date        date not null,
  charge_date_source text,
  source             text not null,
  is_estimate        boolean not null default false,
  calculated_at      timestamptz default now(),

  -- A cost figure with no basis is a number whose provenance nobody can state,
  -- and every screen downstream would render it as measured. Note the converse is
  -- deliberately allowed: cost null with cost_basis null is the honest
  -- representation of "we do not know what this cost", which is different from
  -- "it was free" (cost = 0).
  constraint order_charges_cost_has_basis
    check (cost is null or cost_basis is not null)
);

-- `create table if not exists` does nothing to a table that already exists, and
-- an earlier draft of this file created `amount` as NOT NULL. Without this, a
-- database that has already had that draft applied rejects every at-cost
-- freight charge whose carrier cost has not been reported -- which is a whole
-- order's charges failing, not one row.
--
-- The handler asks the catalog what the column IS, rather than assuming what
-- the failure meant. It used to be `exception when others then raise notice
-- 'order_charges.amount was already nullable'`, and that message named the one
-- cause it could never see: `drop not null` on an already-nullable column does
-- not raise, it is a no-op. So every condition that handler actually caught was
-- a broken paste or a missing prerequisite -- 42703 if the column were renamed,
-- 42501 if the migration is run by a role that does not own the table -- and
-- each one printed a reassuring notice and let the file finish green. The 42501
-- case is the expensive one: the column stays NOT NULL, the migration reports
-- success, and the failure surfaces later and elsewhere as every at-cost
-- freight charge being rejected.
--
-- Checking the post-state rather than the exception also means this block does
-- not depend on `drop not null` being idempotent. If it ever raises on a column
-- that is already nullable, the catalog says nullable and the block passes.
do $$
begin
  alter table order_charges alter column amount drop not null;
exception when others then
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'order_charges'
       and column_name = 'amount' and is_nullable = 'YES'
  ) then
    raise notice 'order_charges.amount is already nullable; the alter raised '
      'SQLSTATE %: % but the column is in the state this file needs', sqlstate, sqlerrm;
  else
    raise exception 'order_charges.amount is still NOT NULL. SQLSTATE %: %. '
      'Until it is nullable, every at-cost freight charge whose carrier cost '
      'has not been reported yet is rejected -- and because the calculator '
      'writes an order''s charges as one batch, that is the whole order''s '
      'charges failing, not one row. Check the SQLSTATE: 42501 means this is '
      'running as a role that does not own order_charges.', sqlstate, sqlerrm;
  end if;
end $$;

-- order_charges_cost_has_basis is declared inside the `create table if not
-- exists` above, which means a database created before commit a97d44a (the one
-- that added it) does not have it, and no amount of re-applying this file ever
-- will: the create is skipped wholesale. The file's own "safe to run more than
-- once" header reads as "running it again brings the schema up to date", and
-- for this constraint it did not.
--
-- What is missing when it is missing: a cost figure with no cost_basis is a
-- number whose provenance nobody can state, and every screen downstream renders
-- it as measured. There is no second line of defence -- unlike cost null, which
-- pnl_client_monthly counts as cost_unknown_charges and announces.
--
-- Same re-apply-safe shape as order_charges_charge_type_valid above. The
-- duplicate_object arm is the ordinary case on an up-to-date database.
do $$
declare
  offending bigint;
begin
  alter table order_charges add constraint order_charges_cost_has_basis
    check (cost is null or cost_basis is not null);
  raise notice 'order_charges_cost_has_basis added (this database did not have it)';
exception
  when duplicate_object then
    raise notice 'order_charges_cost_has_basis already present';
  when check_violation then
    select count(*) into offending
      from order_charges where cost is not null and cost_basis is null;
    raise exception 'order_charges_cost_has_basis NOT added: % order_charges '
      'row(s) hold a cost with no cost_basis.', offending
      using hint = 'Every one of those is rendered as a measured cost on the '
        || 'ledger and client pages with nothing marking it as unprovenanced. '
        || 'List them with: select id, client_id, charge_key, charge_type, '
        || 'charge_date, cost from order_charges where cost is not null and '
        || 'cost_basis is null; set cost_basis to the truth for each -- '
        || 'measured, derived or estimated -- or set cost back to null if its '
        || 'provenance cannot be established, which is the honest value and is '
        || 'NOT the same as zero. Then re-run this file.';
end $$;

-- charge_type is an enum that Postgres was never told about.
--
-- Three places select on exact literals of it: leaks_monthly's
-- picked_never_billed (ledger_04_views.sql:185) and shipped_never_billed
-- (:224), and labour_variance_inputs (:464). A row written 'Pick' is therefore
-- billed in full and counted in pnl_client_monthly -- which groups BY
-- charge_type, so it shows up as its own 'Pick' line and the revenue is not
-- lost -- while being invisible to all three of those. The order then reports
-- as picked and never billed when it was billed.
--
-- That is the conservative direction: it invents a leak rather than hiding
-- one. Which is worse than it sounds. The leak views are the only instrument
-- in this ledger that goes looking for work that was done and not charged for,
-- and an instrument that reports a leak you can go and disprove is one you
-- stop reading. The expensive failure is not the false row, it is the habit.
--
-- The eight values are the same set charge-key.ts declares as CHARGE_TYPES
-- (src/lib/ledger/charge-key.ts), which since this commit is a runtime array
-- rather than a bare type union specifically so that this list can be checked
-- against it: src/lib/ledger/charge-key.test.ts reads the literals back out of
-- THIS FILE and asserts set equality. SQL cannot import a TypeScript union, so
-- a second copy is unavoidable; a second copy that can drift is not. Add a
-- charge type to one language and not the other and that test fails.
--
-- Not an enum TYPE, deliberately. `create type ... as enum` cannot have a
-- value removed and, before PG12, could not have one added inside a
-- transaction -- so the next charge type would need its own migration dance.
-- A check constraint is dropped and re-added by this file on every apply.
do $$
declare
  offending text;
begin
  alter table order_charges add constraint order_charges_charge_type_valid
    check (charge_type in ('shipping','pick','pack','material',
                           'storage','receiving','surcharge','return'));
  raise notice 'order_charges_charge_type_valid added';
exception
  when duplicate_object then
    raise notice 'order_charges_charge_type_valid already present';
  when check_violation then
    -- The failed ALTER is rolled back to this block's savepoint, so the table
    -- is readable here. Name the bad values: "some row" does not tell the
    -- operator which charge to go and look at. Same shape as
    -- cost_rates_basis_valid (ledger_02_cost.sql:50-75), on purpose -- this is
    -- the second instance of the pattern and the next one should copy it too.
    select string_agg(quoted, ', ')
      into offending
      from (select distinct quote_literal(charge_type) as quoted
              from order_charges
             where charge_type not in ('shipping','pick','pack','material',
                                       'storage','receiving','surcharge','return')) bad;

    -- `offending` is NULL only if the ALTER raised check_violation while this
    -- query finds nothing to blame -- a DIFFERENT check constraint on
    -- order_charges failing. Saying that beats printing an empty value list and
    -- a hint whose query ends in `in ()`, which reads as "no rows are wrong"
    -- and sends the operator looking for a problem that is not there.
    if offending is null then
      raise exception 'order_charges_charge_type_valid NOT added: the ALTER '
        'raised check_violation, but no order_charges row holds an invalid '
        'charge_type. Some OTHER check constraint on order_charges is being '
        'violated. Run the ALTER by hand to see which one.';
    end if;

    -- The hint re-uses `offending` rather than re-listing the eight valid
    -- values, and that is the point: a third copy of the list would sit inside
    -- a doubled-quoted string that charge-key.test.ts cannot read, so it would
    -- be the copy that drifts, and the wrong-but-plausible query it produced
    -- would tell the operator a bad row is fine. Interpolating the values the
    -- block just found gives a query that is correct by construction and
    -- narrower than the negated form besides.
    raise exception
      'order_charges_charge_type_valid NOT added: order_charges already holds invalid charge_type value(s): %', offending
      using hint = 'Every one of those rows is billed but missing from '
        || 'leaks_monthly and labour_variance_inputs. Locate them with: '
        || 'select id, client_id, charge_key, charge_type, charge_date, amount '
        || 'from order_charges where charge_type in (' || offending || '); '
        || 'correct charge_type in place -- do NOT delete them, the revenue is '
        || 'real -- then re-run this file.';
end $$;

-- Two unique indexes, for the same reason `orders` needed two. Not every charge
-- belongs to an order: storage is billed monthly against a client, and
-- unattributed label spend belongs to neither. A single
-- unique (order_id, charge_key) would not constrain those rows at all, so the
-- one category of charge that CANNOT be re-derived from an order document would
-- be the one silently duplicated three times a day.
--
-- The FIRST index is deliberately NOT partial, and must stay that way.
-- A `where order_id is not null` predicate on it would be semantically free --
-- it only excludes rows that NULL-distinctness leaves unconstrained anyway --
-- but it breaks the charge calculator outright. PostgREST's on_conflict
-- parameter emits only a column list, never an index predicate, so supabase-js
-- `.upsert(..., { onConflict: 'order_id,charge_key' })` produces
-- `on conflict (order_id, charge_key)` with no where clause. Postgres cannot
-- infer a PARTIAL index from that and raises 42P10, "no unique or exclusion
-- constraint matching the ON CONFLICT specification" -- on every single batch,
-- so ZERO charges are ever written. This is the identical trap that
-- ledger_01_orders.sql documents for orders_client_order_key. The drop below
-- exists because an earlier draft of this file created it partial; re-running
-- this migration converts it.
--
-- The drop and the create are one atomic step, and the drop is conditional.
-- Written as a bare `drop index` followed by `create unique index`, this file's
-- own "safe to run more than once" header was not quite true: between the two
-- statements there is NO unique index on (order_id, charge_key), and if the
-- create then fails -- it fails if the table already holds a duplicate pair --
-- that window never closes, leaving exactly the unconstrained table the
-- three-index design exists to prevent. A PL/pgSQL block WITH an exception
-- handler runs its body in a subtransaction, so a failed create rolls the drop
-- back with it: the index is either its old shape or its new one, never absent.
-- The `indpred is not null` test also makes a re-run a genuine no-op instead of
-- a needless drop and rebuild.
do $$
begin
  if exists (
    select 1
    from   pg_index i
    join   pg_class c on c.oid = i.indexrelid
    where  c.relname = 'order_charges_order_key'
      and  i.indpred is not null
  ) then
    raise notice 'order_charges_order_key is partial; converting it to non-partial';
    drop index order_charges_order_key;
  end if;

  create unique index if not exists order_charges_order_key
    on order_charges (order_id, charge_key);
exception when unique_violation then
  raise exception 'order_charges already holds duplicate (order_id, charge_key) rows, '
                  'so the unique index cannot be created (%). The previous index has been '
                  'restored, so nothing is left unconstrained. Reconcile the duplicates '
                  'and re-run this file.', sqlerrm;
end $$;

-- This one stays partial, and it is exactly what still covers the rows the
-- index above stops constraining once its predicate is gone: order-less charges
-- (storage, billed monthly against a client). NULLs are distinct in SQL, so
-- `unique (order_id, charge_key)` never constrained an order_id-null row,
-- partial predicate or not -- dropping the predicate moves no coverage. Nothing
-- upserts these rows by ON CONFLICT inference, so the 42P10 problem above does
-- not apply to it. Same division of labour as
-- orders_client_order_key / orders_source_order_key.
--
-- TASK 18 WARNING: because this index IS partial, a storage charge written with
-- `.upsert(..., { onConflict: 'client_id,charge_key' })` will hit the same
-- 42P10. Storage must use a different write strategy (read-then-insert/update,
-- or a plain insert guarded by a prior delete of the period's rows).
create unique index if not exists order_charges_client_key
  on order_charges (client_id, charge_key) where order_id is null and client_id is not null;

-- Neither partial index above covers a row with BOTH order_id and client_id
-- null. No path in this plan produces one -- unattributed label spend is
-- reported by leaks_monthly.unattributed_label_spend rather than written as a
-- charge, and storage charges always carry a client_id. This index exists
-- because "unreachable" is a claim about code not yet written, and the cost of
-- being wrong is asymmetric: an absent constraint here means the thrice-daily
-- cron inserts a fresh copy of the same charge every run, and the ledger
-- triples while still looking plausible.
create unique index if not exists order_charges_unattributed_key
  on order_charges (charge_key)
  where order_id is null and client_id is null;

create index if not exists order_charges_order_idx on order_charges (order_id);
create index if not exists order_charges_client_date_idx
  on order_charges (client_id, charge_date);
create index if not exists order_charges_type_date_idx
  on order_charges (charge_type, charge_date);
-- The stale-delete in Task 14 scans by (order_id, calculated_at); the composite
-- index satisfies that filter+sort without a table scan.
create index if not exists order_charges_calculated_idx
  on order_charges (order_id, calculated_at);

-- ---------------------------------------------------------------------------
-- The client rate card gains structure and effective dates.
-- ---------------------------------------------------------------------------
alter table client_warehouse_rates add column if not exists category       text;
alter table client_warehouse_rates add column if not exists label          text;
alter table client_warehouse_rates add column if not exists rate_type      text;
alter table client_warehouse_rates add column if not exists description    text;
alter table client_warehouse_rates add column if not exists effective_from date;
alter table client_warehouse_rates add column if not exists effective_to   date;

-- `category` and `label` are the QUOTE's words, kept for display. `charge_type`
-- and `variant` are the CALCULATOR's words, used for lookup. They have to be
-- separate columns: Task 14 looks a rate up by (charge_type, variant), and
-- without these it would have to string-match on
-- 'Device pick + serial number scan' — which breaks the first time another
-- client's quote words the same service differently.
alter table client_warehouse_rates add column if not exists charge_type text;
alter table client_warehouse_rates add column if not exists variant     text;

create index if not exists client_warehouse_rates_lookup_idx
  on client_warehouse_rates (client_id, charge_type, variant, effective_from);

-- Two rates for the same thing must never cover the same day.
--
-- cost_rates has carried this constraint since ledger_02_cost.sql:28-38. This
-- table did not, and it is the BILLING side: the cost side was better defended
-- than the side that decides what the client is invoiced.
--
-- What it stops, concretely. ledger_05_seed_nayax.sql holds an off-by-design
-- peak surcharge line and tells you to activate it by editing that file's date
-- literals and re-running. Until this commit the re-run's delete was keyed on
-- `effective_from = '2026-01-01'` — the very literal the instructions ask you
-- to change — so an activated peak row at, say, '2026-11-01' escaped the delete
-- and the insert put a SECOND one beside it. Two rows, same client, same
-- (surcharge, peak), same window. calculate-charges.ts:91-98 calls that a data
-- error and resolves it by sort order, so nothing crashes; it quietly bills
-- from whichever row sorted first. The seed's row_count assertion counts 18
-- inserted rows either way and reports success.
--
-- The delete is fixed in that file too. This is here because a constraint
-- cannot be edited around: anything that would arm two overlapping rates now
-- fails at the statement, which is the only version of this guarantee that
-- survives the next edit to the seed.
--
-- Five things make it fit the data already in this table:
--   - `charge_type with =` exempts every legacy row. Rows written by
--     POST /api/clients/[id]/warehouse-rates carry only service_type, rate and
--     unit (src/components/billing/WarehouseRatesUpload.tsx:74-78), so their
--     charge_type is null, and a null never conflicts in an exclusion
--     constraint. Only the structured card the seed files own is covered.
--   - `coalesce(variant,'')` covers the one line that legitimately has no
--     variant: 'shipping'/at_cost, where there is one freight line rather than
--     one per carrier. A bare `variant with =` would let two of those coexist,
--     which is the same defect in the single highest-value row on the card.
--   - An EMPTY daterange overlaps nothing, including a copy of itself. The
--     deliberately-disabled peak line ('2026-01-01','2026-01-01') is therefore
--     unconstrained while it is switched off — correct, it raises no charges —
--     and becomes constrained the moment it is given a real window. The
--     constraint guards exactly the state that can bill.
--   - effective_to null means open-ended, and daterange(d, null) is [d,), so
--     the seventeen open rows DO constrain each other. A hand-edited duplicate
--     of any of them now fails too, which is the hazard this file's own header
--     could previously only warn about in prose.
--   - effective_from is nullable here, unlike cost_rates where it is declared
--     not null, because it was added by `alter table` above with no backfill.
--     daterange(null, x) is unbounded BELOW, so a structured row with no start
--     date conflicts with every other row for that service and cannot be
--     written while one exists. That is the right direction: an undated rate is
--     one whose lookup by charge_date cannot resolve. It rejects nothing today
--     — the seed files are the only writers of charge_type and always supply
--     the date — and a future undated insert fails loudly instead of becoming
--     a row that silently matches every month.
--
-- btree_gist is not created here: this file's header requires ledger_02_cost.sql
-- first, and that is where it is enabled (ledger_02_cost.sql:7).
do $$
begin
  alter table client_warehouse_rates add constraint client_warehouse_rates_no_overlap
    exclude using gist (
      client_id            with =,
      charge_type          with =,
      coalesce(variant,'') with =,
      daterange(effective_from, effective_to, '[)') with &&
    );
exception
  when duplicate_object then
    raise notice 'client_warehouse_rates_no_overlap already present';
  when exclusion_violation then
    -- The duplicate is ALREADY in the table, so adding the constraint cannot
    -- succeed. Say what to do about it, then let the original error through
    -- with its own detail line naming the two conflicting rows.
    --
    -- Deliberately not a notice-and-continue. A rate card that bills from
    -- whichever row sorts first is the precise thing this constraint exists to
    -- make impossible; swallowing the error would leave that card in place and
    -- report the migration as applied, which is worse than not adding the
    -- constraint at all because it also removes the reason to look.
    raise notice 'Two overlapping rates already exist, so the constraint cannot '
      'be added. List them with: select client_id, charge_type, variant, '
      'effective_from, effective_to from client_warehouse_rates where '
      'charge_type is not null order by client_id, charge_type, variant, '
      'effective_from; delete the duplicate, then re-apply this file. If the '
      'duplicate is a Nayax seed row, re-applying ledger_05_seed_nayax.sql '
      'afterwards rewrites the whole card from source.';
    raise;
end $$;

-- `at_cost` lines have no rate of their own: the amount is whatever the carrier
-- charged. Without dropping NOT NULL they cannot be expressed at all, and the
-- workaround — storing 0 — would read as "free", which is the exact
-- null-versus-zero confusion this project exists to stop.
--
-- Handler checks the catalog, not the exception, for the reason given at the
-- `order_charges.amount` block above: "was already nullable" is the one cause
-- `drop not null` cannot produce.
do $$
begin
  alter table client_warehouse_rates alter column rate drop not null;
exception when others then
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'client_warehouse_rates'
       and column_name = 'rate' and is_nullable = 'YES'
  ) then
    raise notice 'client_warehouse_rates.rate is already nullable; the alter '
      'raised SQLSTATE %: % but the column is in the state this file needs',
      sqlstate, sqlerrm;
  else
    raise exception 'client_warehouse_rates.rate is still NOT NULL. '
      'SQLSTATE %: %. Until it is nullable, an at-cost freight line cannot be '
      'expressed at all, and the only way to enter one is to store 0 -- which '
      'reads as "we shipped it free" everywhere downstream. Check the '
      'SQLSTATE: 42501 means this is running as a role that does not own '
      'client_warehouse_rates.', sqlstate, sqlerrm;
  end if;
end $$;

-- `service_type` is `not null` in the original schema with no default, and its
-- four permitted values ('pick_pack', 'storage', 'receiving', 'special_task')
-- do not cover the eighteen quote lines. Left as it is, EVERY insert in Task 16
-- fails on a not-null violation. It is superseded by `charge_type` and kept
-- only so existing rows, and anything still reading it, are not broken.
--
-- The pass condition here is "nullable OR gone", unlike the two blocks above.
-- service_type is superseded, so a database where someone has finished the job
-- and dropped the column is in a BETTER state than one where it is merely
-- nullable -- and 42703 from a dropped column is the one `when others` cause
-- that genuinely is benign. Spelling that out is the point: it is benign
-- because the goal is "this column cannot block an insert", which a dropped
-- column satisfies, not because an exception was caught.
do $$
begin
  alter table client_warehouse_rates alter column service_type drop not null;
exception when others then
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'client_warehouse_rates'
       and column_name = 'service_type' and is_nullable = 'NO'
  ) then
    raise notice 'client_warehouse_rates.service_type is already nullable or '
      'no longer exists; the alter raised SQLSTATE %: % but the column cannot '
      'block an insert either way', sqlstate, sqlerrm;
  else
    raise exception 'client_warehouse_rates.service_type is still NOT NULL. '
      'SQLSTATE %: %. It has no default and its four permitted values do not '
      'cover the eighteen structured quote lines, so EVERY rate-card insert '
      'fails on a not-null violation while this stands -- including the whole '
      'of ledger_05_seed_nayax.sql. Check the SQLSTATE: 42501 means this is '
      'running as a role that does not own client_warehouse_rates.',
      sqlstate, sqlerrm;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- The zone chart holds a UPS chart. Now that UPS traffic is visible, a USPS
-- chart will need to sit BESIDE it, not replace it.
-- ---------------------------------------------------------------------------
alter table zone_chart add column if not exists carrier text;
update zone_chart set carrier = 'UPS' where carrier is null;
