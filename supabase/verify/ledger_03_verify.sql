-- Verifies ledger_03_charges.sql. Run AFTER applying it. Rolls itself back.
begin;

-- The client-keyed index is the one that protects storage and unattributed
-- spend. If it is missing, three crons a day triple those charges.
do $$
declare cid uuid;
begin
  select id into cid from clients limit 1;
  insert into order_charges
    (order_id, client_id, charge_key, charge_type, label, amount, charge_date, source)
    values (null, cid, 'storage:2026-09-01', 'storage', 'Storage', 100, '2026-09-01', 'verify');
  begin
    insert into order_charges
      (order_id, client_id, charge_key, charge_type, label, amount, charge_date, source)
      values (null, cid, 'storage:2026-09-01', 'storage', 'Storage', 100, '2026-09-01', 'verify');
    raise exception 'FAIL: a duplicate order-less charge was accepted';
  exception when unique_violation then
    raise notice 'PASS: order-less charges are constrained by (client_id, charge_key)';
  end;
end $$;

-- And the order-keyed one.
do $$
declare oid uuid; cid uuid;
begin
  select id into cid from clients limit 1;
  insert into orders (client_id, order_key, order_number, source)
    values (cid, 'VERIFY-3', 'VERIFY-3', 'zenventory') returning id into oid;
  insert into order_charges
    (order_id, client_id, charge_key, charge_type, label, amount, charge_date, source)
    values (oid, cid, 'shipment:999', 'shipping', 'Shipping', 8.20, '2026-09-01', 'verify');
  begin
    insert into order_charges
      (order_id, client_id, charge_key, charge_type, label, amount, charge_date, source)
      values (oid, cid, 'shipment:999', 'shipping', 'Shipping', 8.20, '2026-09-01', 'verify');
    raise exception 'FAIL: a duplicate order charge was accepted';
  exception when unique_violation then
    raise notice 'PASS: order charges are constrained by (order_id, charge_key)';
  end;
end $$;

-- order_charges_order_key must NOT be partial. The charge calculator upserts
-- with supabase-js `{ onConflict: 'order_id,charge_key' }`, and PostgREST emits
-- only a column list -- never an index predicate. Postgres cannot infer a
-- partial index from a bare `on conflict (cols)` and raises 42P10 on EVERY
-- batch, so a predicate here writes zero charges rather than degrading the
-- result. This check exists because the predicate looks harmless and reads as
-- more correct; it is the same trap ledger_01_verify.sql guards for
-- orders_client_order_key.
do $$
declare pred text; found_idx boolean;
begin
  select pg_get_expr(i.indpred, i.indrelid), true
    into pred, found_idx
  from   pg_index i
  join   pg_class c on c.oid = i.indexrelid
  where  c.relname = 'order_charges_order_key';

  if found_idx is not true then
    raise exception 'FAIL: index order_charges_order_key does not exist';
  end if;

  if pred is not null then
    raise exception 'FAIL: order_charges_order_key is partial (%) -- '
                    'on conflict (order_id, charge_key) cannot infer it and the '
                    'charge calculator will fail 42P10 on every batch', pred;
  end if;
  raise notice 'PASS: order_charges_order_key is non-partial, so ON CONFLICT can infer it';
end $$;

-- The persist path's actual statement, end to end: the same
-- (order_id, charge_key) issued twice through ON CONFLICT must update in place
-- rather than duplicate or throw. The index check above proves the index is
-- inferable but not that the round trip works.
do $$
declare oid uuid; cid uuid; n int;
begin
  select id into cid from clients limit 1;
  insert into orders (client_id, order_key, order_number, source)
    values (cid, 'VERIFY-UPSERT-3', 'VERIFY-UPSERT-3', 'zenventory') returning id into oid;

  insert into order_charges
    (order_id, client_id, charge_key, charge_type, label, amount, charge_date, source)
    values (oid, cid, 'item:verify:pick', 'pick', 'Pick', 1.28, '2026-09-01', 'calculator')
    on conflict (order_id, charge_key) do update set amount = excluded.amount;
  insert into order_charges
    (order_id, client_id, charge_key, charge_type, label, amount, charge_date, source)
    values (oid, cid, 'item:verify:pick', 'pick', 'Pick', 1.60, '2026-09-01', 'calculator')
    on conflict (order_id, charge_key) do update set amount = excluded.amount;

  select count(*) into n from order_charges
    where order_id = oid and charge_key = 'item:verify:pick';
  if n <> 1 then
    raise exception 'FAIL: the upsert produced % rows, expected 1', n;
  end if;
  raise notice 'PASS: on conflict (order_id, charge_key) upserts in place';
end $$;

-- Order-less rows are NOT covered by order_charges_order_key -- NULLs are
-- distinct in SQL, so `unique (order_id, charge_key)` never constrained them,
-- partial predicate or not. order_charges_client_key is what holds them, and it
-- stays partial deliberately. This block exists so that making the first index
-- non-partial cannot be misread as having moved coverage around: the order-less
-- guarantee is unchanged and still enforced.
do $$
declare cid uuid;
begin
  select id into cid from clients limit 1;
  insert into order_charges
    (order_id, client_id, charge_key, charge_type, label, amount, charge_date, source)
    values (null, cid, 'storage:2026-10-01', 'storage', 'Storage', 100, '2026-10-01', 'verify');
  begin
    insert into order_charges
      (order_id, client_id, charge_key, charge_type, label, amount, charge_date, source)
      values (null, cid, 'storage:2026-10-01', 'storage', 'Storage', 100, '2026-10-01', 'verify');
    raise exception 'FAIL: a second order-less row with the same (client_id, charge_key) was accepted -- order_charges_client_key is missing or no longer covers it';
  exception when unique_violation then
    raise notice 'PASS: order_charges_client_key still constrains order-less rows';
  end;
end $$;

-- ...and the other direction, which is the load-bearing one. The file asserts
-- above that order_charges_order_key must NOT be partial; it must also assert
-- that order_charges_client_key MUST be, or a future reader "tidying" the two
-- indexes to match has nothing stopping them. Dropping this predicate is not
-- cosmetic: charge_key for a peak surcharge is the constant 'surcharge:peak'
-- (src/lib/ledger/calculate-charges.ts), so without `where order_id is null`
-- every order of a client after the first would be rejected on its surcharge
-- row and start failing. The TASK 18 WARNING in ledger_03_charges.sql states
-- this in prose; the block below makes it enforceable.
do $$
declare pred text; found_idx boolean;
begin
  select pg_get_expr(i.indpred, i.indrelid), true
    into pred, found_idx
  from   pg_index i
  join   pg_class c on c.oid = i.indexrelid
  where  c.relname = 'order_charges_client_key';

  if found_idx is not true then
    raise exception 'FAIL: index order_charges_client_key does not exist';
  end if;

  if pred is null then
    raise exception 'FAIL: order_charges_client_key is NOT partial -- it now '
                    'constrains order-level rows too, so the second peak surcharge '
                    'for any client will be rejected and that order will fail';
  end if;
  raise notice 'PASS: order_charges_client_key is partial (%)', pred;
end $$;

-- And the behaviour that predicate buys, stated as an outcome rather than as a
-- property of an index: two DIFFERENT orders of the SAME client, both carrying
-- charge_key 'surcharge:peak', must both be accepted. That is the exact shape
-- the calculator produces for every order it levies a peak surcharge on, so if
-- this block ever fails the ledger stops writing on the second such order
-- rather than degrading.
do $$
declare cid uuid; oid1 uuid; oid2 uuid;
begin
  select id into cid from clients limit 1;
  insert into orders (client_id, order_key, order_number, source)
    values (cid, 'VERIFY-PEAK-1', 'VERIFY-PEAK-1', 'zenventory') returning id into oid1;
  insert into orders (client_id, order_key, order_number, source)
    values (cid, 'VERIFY-PEAK-2', 'VERIFY-PEAK-2', 'zenventory') returning id into oid2;

  insert into order_charges
    (order_id, client_id, charge_key, charge_type, label, amount, charge_date, source)
    values (oid1, cid, 'surcharge:peak', 'surcharge', 'Peak surcharge (8%)',
            1.20, '2026-09-01', 'calculator');
  insert into order_charges
    (order_id, client_id, charge_key, charge_type, label, amount, charge_date, source)
    values (oid2, cid, 'surcharge:peak', 'surcharge', 'Peak surcharge (8%)',
            2.40, '2026-09-01', 'calculator');

  raise notice 'PASS: two orders of one client may each carry charge_key surcharge:peak';
exception when unique_violation then
  raise exception 'FAIL: a second order of the same client was rejected on '
                  'charge_key = ''surcharge:peak'' -- order_charges_client_key has lost '
                  'its `where order_id is null` predicate and is now constraining '
                  'order-level rows';
end $$;

-- amount must be NULLABLE, for the same reason cost is. An at-cost freight line
-- is billed at whatever the carrier charged, so until the carrier reports, the
-- revenue is unknown -- not zero. NOT NULL forces the calculator to write 0,
-- which claims the label was given away free and understates revenue in every
-- view that sums this column. `create table if not exists` will not repair a
-- database that already carries the old NOT NULL, which is why
-- ledger_03_charges.sql has a guarded alter and why this block exists.
do $$
declare oid uuid; cid uuid;
begin
  select id into cid from clients limit 1;
  insert into orders (client_id, order_key, order_number, source)
    values (cid, 'VERIFY-AMT-1', 'VERIFY-AMT-1', 'zenventory') returning id into oid;
  insert into order_charges
    (order_id, client_id, charge_key, charge_type, label, amount,
     cost, cost_basis, charge_date, source)
    values (oid, cid, 'shipment:amt1', 'shipping', 'Shipping', null,
            null, null, '2026-09-01', 'verify');
  raise notice 'PASS: order_charges.amount accepts null (unreported at-cost freight)';
exception when not_null_violation then
  raise exception 'FAIL: order_charges.amount is still NOT NULL, so an at-cost '
                  'freight line whose carrier cost has not been reported cannot be '
                  'written without claiming it was billed at zero';
end $$;

-- shipments.order_number_key is what makes the shipment-to-order join
-- case-insensitive at the FETCH, not only in memory. If it is missing or not
-- normalising, Task 14 silently loses every label whose order number arrived in
-- a casing the order did not use.
do $$
declare k text;
begin
  insert into shipments (order_number, source)
    values ('  verify-CaSe-1  ', 'verify');
  select order_number_key into k from shipments where order_number = '  verify-CaSe-1  ';
  if k is distinct from 'VERIFY-CASE-1' then
    raise exception 'FAIL: order_number_key is %, expected VERIFY-CASE-1', coalesce(k, 'null');
  end if;
  raise notice 'PASS: shipments.order_number_key upper-cases and trims';
end $$;

-- An at-cost rate line must be expressible with no rate at all.
do $$
declare cid uuid;
begin
  select id into cid from clients limit 1;
  insert into client_warehouse_rates (client_id, rate_type, label, rate)
    values (cid, 'at_cost', 'Carrier freight at cost', null);
  raise notice 'PASS: client_warehouse_rates.rate accepts null';
exception when not_null_violation then
  raise exception 'FAIL: rate is still NOT NULL; at-cost lines cannot be stored';
end $$;

-- A row with cost set and cost_basis null must be rejected by
-- order_charges_cost_has_basis. A constraint that exists but does not bite is
-- worse than no constraint.
do $$
declare oid uuid; cid uuid;
begin
  select id into cid from clients limit 1;
  insert into orders (client_id, order_key, order_number, source)
    values (cid, 'VERIFY-CHK-1', 'VERIFY-CHK-1', 'zenventory') returning id into oid;
  begin
    insert into order_charges
      (order_id, client_id, charge_key, charge_type, label, amount,
       cost, cost_basis, charge_date, source)
      values (oid, cid, 'shipment:chk1', 'shipping', 'Shipping', 8.20,
              5.00, null, '2026-09-01', 'verify');
    raise exception 'FAIL: a charge with cost set and cost_basis null was accepted';
  exception when check_violation then
    raise notice 'PASS: order_charges_cost_has_basis rejects cost without basis';
  end;
end $$;

-- A row with both cost and cost_basis null must be ACCEPTED — this is the
-- honest "we do not know what this cost" state, distinct from cost = 0 (free).
-- A constraint accidentally written as check (cost_basis is not null) would
-- reject this row and go unnoticed if we only tested the rejection case.
do $$
declare oid uuid; cid uuid;
begin
  select id into cid from clients limit 1;
  insert into orders (client_id, order_key, order_number, source)
    values (cid, 'VERIFY-CHK-2', 'VERIFY-CHK-2', 'zenventory') returning id into oid;
  insert into order_charges
    (order_id, client_id, charge_key, charge_type, label, amount,
     cost, cost_basis, charge_date, source)
    values (oid, cid, 'shipment:chk2', 'shipping', 'Shipping', 8.20,
            null, null, '2026-09-01', 'verify');
  raise notice 'PASS: cost null + cost_basis null accepted (honest-unknown case)';
exception when check_violation then
  raise exception 'FAIL: order_charges_cost_has_basis incorrectly rejected cost=null cost_basis=null';
end $$;

-- ---------------------------------------------------------------------------
-- client_warehouse_rates_no_overlap, in both directions.
--
-- This constraint has to reject one specific thing and accept four that look
-- like it. An over-broad version would be worse than none: it would reject the
-- at-cost shipping line, or the deliberately-disabled peak surcharge, and the
-- seed file would stop applying — which is a loud failure, but a loud failure
-- that teaches whoever hits it to drop the constraint.
--
-- Every block below creates its own inactive client and deletes it afterwards,
-- rather than borrowing one with `select id into cid from clients limit 1` the
-- way the blocks above this point do. Two reasons, and the second is the one
-- that matters:
--
--   - These rows are BILLABLE in a way the earlier blocks' rows are not. A row
--     with charge_type set and a live date window is exactly what
--     load-charge-inputs.ts looks up and calculate-charges.ts bills from. The
--     first block alone would leave an armed 8% peak surcharge on whichever
--     client `limit 1` returned. A verification script must not be able to
--     change what a client is invoiced.
--
--   - `limit 1` with no order by returns an arbitrary row, so if it ever
--     returned Nayax the eighteen seeded rows would already be sitting there
--     and the SETUP insert of the last three blocks would collide with one of
--     them. The exception then fires before the assertion is reached, and the
--     handler prints a FAIL naming a cause that is not the cause — "adjacent
--     rate periods are treated as overlapping" when the constraint is fine and
--     the fixture is at fault. A check that reports a false FAIL on some runs
--     and passes on others is worse than no check: it spends its credibility
--     the first time it is wrong, and this file is the only thing that will
--     say whether the constraint works.
--
-- Cleanup is a single `delete from clients`, because client_warehouse_rates
-- is `on delete cascade` (schema.sql:29). It sits on the success path only:
-- an uncaught exception rolls the whole DO statement back, including the
-- fixture, so the failure path needs no cleanup and must not be given any —
-- a cleanup that ran before the FAIL raise would destroy the rows whose
-- presence is the evidence.
-- ---------------------------------------------------------------------------

-- The thing it exists to stop: two rates for the same service covering the
-- same day. This is the shape an activated peak surcharge used to take after
-- one re-run of ledger_05_seed_nayax.sql.
do $$
declare cid uuid;
begin
  insert into clients (name, active) values ('zzz-verify-no-overlap-reject', false)
    returning id into cid;
  insert into client_warehouse_rates
    (client_id, rate_type, label, rate, charge_type, variant, effective_from, effective_to)
    values (cid, 'percentage', 'Peak', 8.00, 'surcharge', 'peak', '2026-11-01', '2027-01-01');
  begin
    insert into client_warehouse_rates
      (client_id, rate_type, label, rate, charge_type, variant, effective_from, effective_to)
      values (cid, 'percentage', 'Peak', 8.00, 'surcharge', 'peak', '2026-12-01', '2027-02-01');
    raise exception 'FAIL: two overlapping surcharge/peak rates were accepted';
  exception when exclusion_violation then
    raise notice 'PASS: client_warehouse_rates_no_overlap rejects an overlapping rate';
  end;
  delete from clients where id = cid;
end $$;

-- Legacy rows must stay legal. Everything written by
-- POST /api/clients/[id]/warehouse-rates carries no charge_type, and there are
-- live rows of that shape in this table. If the constraint covered them, this
-- migration would fail to apply against production data rather than against a
-- test fixture — and nulls not conflicting is the mechanism, so it is worth a
-- check rather than a comment.
do $$
declare cid uuid;
begin
  insert into clients (name, active) values ('zzz-verify-no-overlap-legacy', false)
    returning id into cid;
  insert into client_warehouse_rates (client_id, service_type, rate, unit)
    values (cid, 'storage', 25.00, 'per_unit');
  insert into client_warehouse_rates (client_id, service_type, rate, unit)
    values (cid, 'storage', 30.00, 'per_unit');
  delete from clients where id = cid;
  raise notice 'PASS: two legacy rows with no charge_type still coexist';
exception when exclusion_violation then
  raise exception 'FAIL: the constraint covers legacy charge_type-null rows; '
                  'applying ledger_03 against real data will abort';
end $$;

-- The disabled peak line must stay duplicable, and that is not an oversight.
-- An EMPTY daterange overlaps nothing, including a copy of itself, so a
-- switched-off surcharge is outside the constraint entirely. It raises no
-- charges, so there is nothing to protect; the row becomes constrained the
-- moment it is given a real window, which is the only state that can bill.
--
-- Checked explicitly so that nobody later "tightens" the constraint into
-- something that rejects the off-switch this project depends on
-- (ledger_05_seed_nayax.sql's peak tuple, and the hasPeakLine fallback at
-- load-charge-inputs.ts:392 that makes deleting the row the wrong fix).
do $$
declare cid uuid;
begin
  insert into clients (name, active) values ('zzz-verify-no-overlap-empty', false)
    returning id into cid;
  insert into client_warehouse_rates
    (client_id, rate_type, label, rate, charge_type, variant, effective_from, effective_to)
    values (cid, 'percentage', 'Peak off', 8.00, 'surcharge', 'peak', '2026-01-01', '2026-01-01');
  insert into client_warehouse_rates
    (client_id, rate_type, label, rate, charge_type, variant, effective_from, effective_to)
    values (cid, 'percentage', 'Peak off', 8.00, 'surcharge', 'peak', '2026-01-01', '2026-01-01');
  delete from clients where id = cid;
  raise notice 'PASS: an empty-range (disabled) rate is outside the constraint';
exception when exclusion_violation then
  raise exception 'FAIL: the constraint rejects the empty-range off-switch, so '
                  'the peak line can no longer be seeded in its disabled state';
end $$;

-- coalesce(variant,'') must make the null-variant line singular. There is one
-- at-cost freight line per client, not one per carrier, so its variant is
-- null; a bare `variant with =` would let two of them coexist, and that row
-- carries more money than any other on the card.
do $$
declare cid uuid;
begin
  insert into clients (name, active) values ('zzz-verify-no-overlap-nullvariant', false)
    returning id into cid;
  insert into client_warehouse_rates
    (client_id, rate_type, label, rate, charge_type, variant, effective_from, effective_to)
    values (cid, 'at_cost', 'Carrier freight', null, 'shipping', null, '2026-01-01', null);
  begin
    insert into client_warehouse_rates
      (client_id, rate_type, label, rate, charge_type, variant, effective_from, effective_to)
      values (cid, 'at_cost', 'Carrier freight', null, 'shipping', null, '2026-06-01', null);
    raise exception 'FAIL: two open-ended shipping lines with null variant were accepted';
  exception when exclusion_violation then
    raise notice 'PASS: coalesce(variant,'''') makes the null-variant line singular';
  end;
  delete from clients where id = cid;
end $$;

-- ...and it must not be so broad that it collapses distinct services. pick and
-- pack both have a 'device' variant; receiving and storage both have 'pallet'.
-- A constraint keyed on variant alone, or on client_id alone, would reject the
-- seed file's own eighteen rows.
do $$
declare cid uuid;
begin
  insert into clients (name, active) values ('zzz-verify-no-overlap-distinct', false)
    returning id into cid;
  insert into client_warehouse_rates
    (client_id, rate_type, label, rate, charge_type, variant, effective_from, effective_to)
    values (cid, 'per_pallet', 'Pallet receiving', 20.00, 'receiving', 'pallet', '2026-01-01', null);
  insert into client_warehouse_rates
    (client_id, rate_type, label, rate, charge_type, variant, effective_from, effective_to)
    values (cid, 'per_pallet', 'Pallet position', 25.00, 'storage', 'pallet', '2026-01-01', null);
  insert into client_warehouse_rates
    (client_id, rate_type, label, rate, charge_type, variant, effective_from, effective_to)
    values (cid, 'per_unit', 'Device pick', 0.32, 'pick', 'device', '2026-01-01', null);
  delete from clients where id = cid;
  raise notice 'PASS: same variant under different charge_types still coexist';
exception when exclusion_violation then
  raise exception 'FAIL: the constraint is too broad — it rejects two of the '
                  'eighteen rows ledger_05_seed_nayax.sql inserts';
end $$;

-- Adjacent, not overlapping: one rate ending the day another begins must be
-- legal, or no rate can ever be superseded. daterange(,,'[)') is half-open
-- precisely so that [Jan,Jun) and [Jun,) do not collide — a '[]' bound here
-- would make every rate change a constraint violation.
do $$
declare cid uuid;
begin
  insert into clients (name, active) values ('zzz-verify-no-overlap-adjacent', false)
    returning id into cid;
  insert into client_warehouse_rates
    (client_id, rate_type, label, rate, charge_type, variant, effective_from, effective_to)
    values (cid, 'per_unit', 'Device pick (old)', 0.30, 'pick', 'device', '2026-01-01', '2026-06-01');
  insert into client_warehouse_rates
    (client_id, rate_type, label, rate, charge_type, variant, effective_from, effective_to)
    values (cid, 'per_unit', 'Device pick (new)', 0.32, 'pick', 'device', '2026-06-01', null);
  delete from clients where id = cid;
  raise notice 'PASS: a rate can be superseded on the day the previous one ends';
exception when exclusion_violation then
  raise exception 'FAIL: adjacent rate periods are treated as overlapping, so '
                  'no rate on this card can ever be changed';
end $$;

-- How much of the shipment backfill actually landed. Not an assertion — a
-- number to report back, because it sizes the duplicate-row problem.
select count(*)                                    as shipments_total,
       count(shipstation_shipment_id)              as with_shipment_id,
       count(*) - count(shipstation_shipment_id)   as missing_shipment_id
from shipments;

rollback;
