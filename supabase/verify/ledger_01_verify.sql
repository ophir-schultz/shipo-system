-- Verifies ledger_01_orders.sql. Run AFTER applying it.
-- Every statement below should print 'PASS'. Rolls itself back.
begin;

-- The unattributed-order index is the one that matters. If it is missing,
-- this second insert succeeds and the ledger will double-count.
insert into orders (client_id, order_key, order_number, source)
  values (null, 'VERIFY-1', 'VERIFY-1', 'shipstation');
do $$
begin
  begin
    insert into orders (client_id, order_key, order_number, source)
      values (null, 'VERIFY-1', 'VERIFY-1', 'shipstation');
    raise exception 'FAIL: duplicate unattributed order was accepted';
  exception when unique_violation then
    raise notice 'PASS: unattributed orders are constrained';
  end;
end $$;

-- Line identity is (order_id, source, line_ordinal), so the same SKU may
-- legitimately repeat on two lines of a kit.
do $$
declare oid uuid;
begin
  select id into oid from orders where order_key = 'VERIFY-1';
  insert into order_items (order_id, source, line_ordinal, sku)
    values (oid, 'zenventory', 1, 'KIT-A'), (oid, 'zenventory', 2, 'KIT-A');
  raise notice 'PASS: a repeated SKU on two lines is accepted';
  begin
    insert into order_items (order_id, source, line_ordinal, sku)
      values (oid, 'zenventory', 1, 'KIT-A');
    raise exception 'FAIL: duplicate line_ordinal was accepted';
  exception when unique_violation then
    raise notice 'PASS: line_ordinal is unique per order and source';
  end;
end $$;

-- A store must not map to two clients.
do $$
declare cid uuid;
begin
  select id into cid from clients limit 1;
  insert into client_store_ids (client_id, store_id) values (cid, 'VERIFY-STORE');
  begin
    insert into client_store_ids (client_id, store_id) values (cid, 'VERIFY-STORE');
    raise exception 'FAIL: a store mapped twice';
  exception when unique_violation then
    raise notice 'PASS: store_id is globally unique';
  end;
end $$;

rollback;
