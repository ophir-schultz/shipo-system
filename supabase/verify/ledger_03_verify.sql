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
