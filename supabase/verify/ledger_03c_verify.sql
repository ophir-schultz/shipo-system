-- Verifies ledger_03c_rate_adjustments_uniq.sql. Run AFTER applying it. Rolls itself back.
begin;

-- 1. The index exists, is UNIQUE, and is NOT partial.
--
-- All three clauses are load-bearing and the third is the one most likely to
-- regress. A partial index satisfies "the index exists" and "no duplicates can
-- be written" perfectly well, and then breaks the only writer: PostgREST emits
-- a bare column list for on_conflict, Postgres cannot infer a partial index
-- from it, and supabase-js's upsert raises 42P10 on every adjustment. The
-- table stays clean because NOTHING IS EVER WRITTEN TO IT, which is the
-- failure this assertion exists to catch -- it looks identical to success from
-- the table's point of view. Same trap as orders_client_order_key and
-- order_charges_order_key; see the note in the migration.
do $$
declare
  is_unique  boolean;
  is_partial boolean;
begin
  select i.indisunique, i.indpred is not null
    into is_unique, is_partial
  from   pg_index i
  join   pg_class c on c.oid = i.indexrelid
  where  c.relname = 'rate_adjustments_shipment_amount_key';

  if is_unique is null then
    raise exception 'FAIL: rate_adjustments_shipment_amount_key does not exist. '
                    'ledger_03c_rate_adjustments_uniq.sql has not been applied.';
  end if;
  if not is_unique then
    raise exception 'FAIL: rate_adjustments_shipment_amount_key exists but is not UNIQUE, '
                    'so it constrains nothing.';
  end if;
  if is_partial then
    raise exception 'FAIL: rate_adjustments_shipment_amount_key is PARTIAL. It will still '
                    'reject duplicates, but supabase-js .upsert(onConflict: '
                    '''shipment_id,adjustment_amount'') now raises 42P10 on every '
                    'adjustment, so NO adjustment is ever recorded. Recreate it without '
                    'the predicate.';
  end if;
  raise notice 'PASS: rate_adjustments_shipment_amount_key is unique and non-partial';
end $$;

-- 2. Positive control: the constraint actually bites.
--
-- Query 1 inspects the catalogue, which proves the index is SHAPED right and
-- nothing about whether Postgres enforces it on these columns. So a real
-- duplicate is attempted here and the absence of an exception is the failure.
-- Without this block the file would pass against an index on the wrong columns.
--
-- A sibling row with a DIFFERENT amount is inserted first, because the
-- interesting way to get this wrong is an index that over-constrains to
-- (shipment_id) alone -- a shipment legitimately has several adjustments over
-- its life, and that index would reject the second one. Both directions are
-- therefore asserted: same amount rejected, different amount accepted.
do $$
declare
  sid uuid;
  cid uuid;
  blocked boolean := false;
begin
  select s.id, s.client_id into sid, cid
  from   shipments s
  where  s.client_id is not null
  limit  1;

  if sid is null then
    -- Not a pass. An empty fixture would silently skip the only block that
    -- tests the live behaviour, so say so loudly rather than printing PASS.
    raise exception 'INCONCLUSIVE: no attributed shipment exists to hang a test '
                    'adjustment from, so the constraint could not be exercised.';
  end if;

  insert into rate_adjustments (shipment_id, client_id, order_number, adjustment_amount, reason)
    values (sid, cid, 'verify-03c', 1.50, 'verify fixture');

  -- Different amount, same shipment: must be ACCEPTED.
  insert into rate_adjustments (shipment_id, client_id, order_number, adjustment_amount, reason)
    values (sid, cid, 'verify-03c', 2.50, 'verify fixture');

  -- Same amount, same shipment: must be REJECTED. This is the duplicate two
  -- overlapping syncs produce.
  begin
    insert into rate_adjustments (shipment_id, client_id, order_number, adjustment_amount, reason)
      values (sid, cid, 'verify-03c', 1.50, 'verify fixture');
  exception when unique_violation then
    blocked := true;
  end;

  if not blocked then
    raise exception 'FAIL: a second (shipment_id, adjustment_amount) row was accepted. '
                    'The index is not enforcing on these columns, and two overlapping '
                    'syncs can still double-bill a client.';
  end if;
  raise notice 'PASS: duplicate (shipment_id, adjustment_amount) rejected, second amount accepted';
end $$;

-- 3. The live table is clean.
--
-- Same assertion as ledger_03b_verify.sql query 2, repeated here because it
-- means something different now: there it reported on the backfill, here it is
-- the precondition for the index existing at all. If query 1 passed, this
-- cannot fail -- which is the point. It is the statement of what the index
-- guarantees from here on, and it is what to run if the migration ever has to
-- be dropped and rebuilt.
do $$
declare n int;
begin
  select count(*) into n
  from (
    select shipment_id, adjustment_amount
    from   rate_adjustments
    where  shipment_id is not null
    group  by shipment_id, adjustment_amount
    having count(*) > 1
  ) dups;
  if n > 0 then
    raise exception 'FAIL: % duplicate (shipment_id, adjustment_amount) pair(s) survive '
                    'in rate_adjustments despite the unique index', n;
  end if;
  raise notice 'PASS: no duplicate (shipment_id, adjustment_amount) pairs';
end $$;

rollback;
