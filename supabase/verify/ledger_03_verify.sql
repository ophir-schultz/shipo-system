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

-- How much of the shipment backfill actually landed. Not an assertion — a
-- number to report back, because it sizes the duplicate-row problem.
select count(*)                                    as shipments_total,
       count(shipstation_shipment_id)              as with_shipment_id,
       count(*) - count(shipstation_shipment_id)   as missing_shipment_id
from shipments;

rollback;
