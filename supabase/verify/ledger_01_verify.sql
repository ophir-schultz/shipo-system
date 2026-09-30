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

-- orders_client_order_key must NOT be partial. The Zenventory sync upserts with
-- supabase-js `{ onConflict: 'client_id,order_key' }`, and PostgREST emits only
-- a column list -- never an index predicate. Postgres cannot infer a partial
-- index from a bare `on conflict (cols)` and raises 42P10 on EVERY row, so a
-- predicate here fails the whole sync outright rather than degrading it. This
-- check exists because the predicate looks harmless and reads as more correct.
do $$
declare pred text; found_idx boolean;
begin
  select pg_get_expr(i.indpred, i.indrelid), true
    into pred, found_idx
  from   pg_index i
  join   pg_class c on c.oid = i.indexrelid
  where  c.relname = 'orders_client_order_key';

  if found_idx is not true then
    raise exception 'FAIL: index orders_client_order_key does not exist';
  end if;

  if pred is not null then
    raise exception 'FAIL: orders_client_order_key is partial (%) -- '
                    'on conflict (client_id, order_key) cannot infer it and the '
                    'Zenventory sync will fail 42P10 on every row', pred;
  end if;
  raise notice 'PASS: orders_client_order_key is non-partial, so ON CONFLICT can infer it';
end $$;

-- The upsert path itself, end to end: the same (client_id, order_key) issued
-- twice through ON CONFLICT must update in place rather than duplicate or throw.
-- This is the statement the sync actually sends; the index check above proves
-- the index is inferable but not that the round trip works.
do $$
declare cid uuid; n int;
begin
  select id into cid from clients limit 1;
  insert into orders (client_id, order_key, order_number, source, order_date)
    values (cid, 'VERIFY-UPSERT', 'VERIFY-UPSERT', 'zenventory', '2026-09-01')
    on conflict (client_id, order_key) do update set order_date = excluded.order_date;
  insert into orders (client_id, order_key, order_number, source, order_date)
    values (cid, 'VERIFY-UPSERT', 'VERIFY-UPSERT', 'zenventory', '2026-09-02')
    on conflict (client_id, order_key) do update set order_date = excluded.order_date;

  select count(*) into n from orders
    where client_id = cid and order_key = 'VERIFY-UPSERT';
  if n <> 1 then
    raise exception 'FAIL: the upsert produced % rows, expected 1', n;
  end if;
  raise notice 'PASS: on conflict (client_id, order_key) upserts in place';
end $$;

rollback;
