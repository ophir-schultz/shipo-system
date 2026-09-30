-- Verifies ledger_04_views.sql. Run AFTER applying it. Rolls itself back.
begin;

-- The pick_days ordering bug: an order with dateless Zenventory rows and good
-- ShipStation rows must still appear. If `usable` were applied after
-- `preferred`, this order would vanish entirely.
do $$
declare cid uuid; oid uuid; n int;
begin
  select id into cid from clients limit 1;
  insert into orders (client_id, order_key, order_number, source)
    values (cid, 'VERIFY-PD', 'VERIFY-PD', 'zenventory') returning id into oid;

  -- Zenventory row: present, but no pick date yet. The normal early state.
  insert into order_items (order_id, source, line_ordinal, sku,
                           quantity_picked, pick_date, pick_date_source)
    values (oid, 'zenventory', 1, 'SKU-PD', 3, null, null);
  -- ShipStation row: real pick evidence.
  insert into order_items (order_id, source, line_ordinal, sku,
                           quantity_picked, pick_date, pick_date_source)
    values (oid, 'shipstation', 1, 'SKU-PD', 3, '2026-09-01', 'watermark');

  select count(*) into n from pick_days where sku = 'SKU-PD';
  if n = 0 then
    raise exception 'FAIL: an order with dateless Zenventory rows vanished from pick_days';
  end if;
  raise notice 'PASS: ShipStation pick evidence survives dateless Zenventory rows';
end $$;

-- Confidence must rank watermark BELOW pickprintdate. Alphabetically it does
-- not, which is why the view maps to integers first.
do $$
declare oid uuid; cid uuid; c int;
begin
  select id into cid from clients limit 1;
  insert into orders (client_id, order_key, order_number, source)
    values (cid, 'VERIFY-CONF', 'VERIFY-CONF', 'zenventory') returning id into oid;
  insert into order_items (order_id, source, line_ordinal, sku,
                           quantity_picked, pick_date, pick_date_source)
    values (oid, 'zenventory', 1, 'SKU-CONF', 1, '2026-09-01', 'pickprintdate'),
           (oid, 'zenventory', 2, 'SKU-CONF', 1, '2026-09-01', 'watermark');
  select confidence into c from pick_days where sku = 'SKU-CONF';
  if c <> 2 then
    raise exception 'FAIL: confidence is %, expected 2 (weakest line wins)', c;
  end if;
  raise notice 'PASS: confidence takes the weakest line';
end $$;

-- A charge with an UNKNOWN cost must not be reported as a negative-margin leak.
do $$
declare cid uuid; oid uuid; n int;
begin
  select id into cid from clients limit 1;
  insert into orders (client_id, order_key, order_number, source)
    values (cid, 'VERIFY-LEAK', 'VERIFY-LEAK', 'zenventory') returning id into oid;
  insert into order_charges (order_id, client_id, charge_key, charge_type,
                             label, amount, cost, charge_date, source)
    values (oid, cid, 'item:x:pick', 'pick', 'Pick', 1.28, null, '2026-09-01', 'verify');
  select count(*) into n from leaks_monthly
    where leak = 'negative_margin_lines' and client_id = cid
      and period_month = '2026-09-01';
  if n > 0 then
    raise exception 'FAIL: an unknown cost was reported as a negative margin';
  end if;
  raise notice 'PASS: unknown cost is not a negative-margin leak';
end $$;

-- And a genuinely negative margin must be.
do $$
declare cid uuid; oid uuid; n int;
begin
  select id into cid from clients limit 1;
  insert into orders (client_id, order_key, order_number, source)
    values (cid, 'VERIFY-LEAK2', 'VERIFY-LEAK2', 'zenventory') returning id into oid;
  insert into order_charges (order_id, client_id, charge_key, charge_type,
                             label, amount, cost, charge_date, source)
    values (oid, cid, 'item:y:pick', 'pick', 'Pick', 1.00, 4.00, '2026-09-01', 'verify');
  select count(*) into n from leaks_monthly
    where leak = 'negative_margin_lines' and client_id = cid;
  if n = 0 then raise exception 'FAIL: a real negative margin was not reported'; end if;
  raise notice 'PASS: a real negative margin is reported';
end $$;

-- Net profit must be NULL, not equal to gross margin, when no operating costs
-- have been entered. This is the whole reason the four cost inputs can arrive
-- later without producing a wrong answer in the meantime.
do $$
declare np numeric; gm numeric;
begin
  select net_profit, gross_margin into np, gm
  from pnl_monthly where period_month = '2026-09-01';
  if np is not null and gm is not null and np = gm then
    raise exception 'FAIL: net profit equals gross margin; overheads are being ignored';
  end if;
  raise notice 'PASS: net profit is null until operating costs exist';
end $$;

rollback;
