-- Verifies ledger_04_views.sql. Run AFTER applying it. Rolls itself back.
begin;

-- ---------------------------------------------------------------------------
-- One throwaway client, used by every block below.
--
-- The earlier draft did `select id into cid from clients limit 1` and bound
-- every assertion to whichever real client the planner happened to emit first.
-- That is how a verify script produces both false failures and false passes at
-- once: the "unknown cost is not a negative-margin leak" block asserts a count
-- of ZERO for that client, which breaks the moment the client has a genuine
-- negative-margin charge in the fixture month -- precisely the condition this
-- ledger exists to detect, so failure was likely and would have pointed at the
-- view instead of at the data. Meanwhile the "a real negative margin IS
-- reported" block asserted a count above zero for the same client with no month
-- filter, so it could pass on a pre-existing row without its own insert being
-- exercised at all. And if `clients` were empty, `cid` was null, every
-- `client_id = cid` was null, and the whole file failed for a reason the
-- messages did not name.
--
-- A dedicated client fixes all three. The script is wrapped in begin/rollback,
-- so this row never persists. `into strict` below means "exactly one row" --
-- if a real client somehow carries this name, the block fails loudly rather
-- than quietly testing the wrong rows.
--
-- `name` is the only NOT NULL column on `clients` without a default, here and
-- across every `alter table clients add column` in supabase/ (origin_zip,
-- founding_bonus_seq, referral_*, acquisition_*, zenventory_secure_key are all
-- nullable).
-- ---------------------------------------------------------------------------
insert into clients (name) values ('VERIFY-ONLY ledger_04');

-- The pick_days ordering bug: an order with dateless Zenventory rows and good
-- ShipStation rows must still appear. If `usable` were applied after
-- `preferred`, this order would vanish entirely.
do $$
declare cid uuid; oid uuid; n int;
begin
  select id into strict cid from clients where name = 'VERIFY-ONLY ledger_04';
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

  select count(*) into n from pick_days
    where sku = 'SKU-PD' and client_id = cid;
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
  select id into strict cid from clients where name = 'VERIFY-ONLY ledger_04';
  insert into orders (client_id, order_key, order_number, source)
    values (cid, 'VERIFY-CONF', 'VERIFY-CONF', 'zenventory') returning id into oid;
  insert into order_items (order_id, source, line_ordinal, sku,
                           quantity_picked, pick_date, pick_date_source)
    values (oid, 'zenventory', 1, 'SKU-CONF', 1, '2026-09-01', 'pickprintdate'),
           (oid, 'zenventory', 2, 'SKU-CONF', 1, '2026-09-01', 'watermark');
  select confidence into c from pick_days
    where sku = 'SKU-CONF' and client_id = cid;
  if c is null then
    raise exception 'FAIL: pick_days reported no row for the confidence fixture';
  end if;
  if c <> 2 then
    raise exception 'FAIL: confidence is %, expected 2 (weakest line wins)', c;
  end if;
  raise notice 'PASS: confidence takes the weakest line';
end $$;

-- A charge with an UNKNOWN cost must not be reported as a negative-margin leak.
-- September 2026 is this block's own month and nothing else writes to it, so
-- the expected count of zero cannot be disturbed by another block's fixture.
do $$
declare cid uuid; oid uuid; n int;
begin
  select id into strict cid from clients where name = 'VERIFY-ONLY ledger_04';
  insert into orders (client_id, order_key, order_number, source)
    values (cid, 'VERIFY-LEAK', 'VERIFY-LEAK', 'zenventory') returning id into oid;
  -- cost is null, so cost_basis stays null: order_charges_cost_has_basis
  -- (ledger_03_charges.sql:85) allows that pair deliberately -- it is the
  -- honest representation of "we do not know what this cost".
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
--
-- Two fixes here. `cost_basis` is supplied because cost is not: the check
-- constraint order_charges_cost_has_basis (ledger_03_charges.sql:85-86) reads
-- `cost is null or cost_basis is not null`, so the previous version of this
-- INSERT raised 23514, aborted the block, and took the two assertions after it
-- with it -- including the net_profit check the brief calls the one worth
-- keeping. 'measured' is the basis the calculator itself writes for a carrier
-- cost (calculate-charges.ts:227).
--
-- And the month is OCTOBER, not September, so this block and the one above are
-- order-independent: a positive count here can only come from this block's own
-- insert, and the zero count above cannot be broken by this one.
do $$
declare cid uuid; oid uuid; n int; recs bigint;
begin
  select id into strict cid from clients where name = 'VERIFY-ONLY ledger_04';
  insert into orders (client_id, order_key, order_number, source)
    values (cid, 'VERIFY-LEAK2', 'VERIFY-LEAK2', 'zenventory') returning id into oid;
  insert into order_charges (order_id, client_id, charge_key, charge_type,
                             label, amount, cost, cost_basis, charge_date, source)
    values (oid, cid, 'item:y:pick', 'pick', 'Pick', 1.00, 4.00, 'measured',
            '2026-10-01', 'verify');
  select count(*), max(records) into n, recs from leaks_monthly
    where leak = 'negative_margin_lines' and client_id = cid
      and period_month = '2026-10-01';
  if n = 0 then raise exception 'FAIL: a real negative margin was not reported'; end if;
  if recs <> 1 then
    raise exception 'FAIL: negative-margin leak reports % records, expected exactly 1', recs;
  end if;
  raise notice 'PASS: a real negative margin is reported';
end $$;

-- pnl_client_monthly: a null cost must not become a zero cost.
--
-- This view had no test at all, and it is the one that will drive keep/drop
-- decisions per client. `charge_type = 'verify_pnl'` gives the block its own
-- group, since the view groups by (period_month, client_id, client_name,
-- charge_type) and two other blocks write 'pick' charges for this client.
-- charge_date is the 5th, so the row also proves period_month truncates.
do $$
declare cid uuid; oid uuid;
        rev numeric; ck numeric; unknown_costs bigint;
begin
  select id into strict cid from clients where name = 'VERIFY-ONLY ledger_04';
  insert into orders (client_id, order_key, order_number, source)
    values (cid, 'VERIFY-PNLC', 'VERIFY-PNLC', 'zenventory') returning id into oid;
  insert into order_charges (order_id, client_id, charge_key, charge_type,
                             label, amount, cost, charge_date, source)
    values (oid, cid, 'item:z:verify_pnl', 'verify_pnl', 'Verify', 7.50, null,
            '2026-09-05', 'verify');

  select revenue, cost_known, cost_unknown_charges
    into rev, ck, unknown_costs
  from pnl_client_monthly
  where client_id = cid and charge_type = 'verify_pnl'
    and period_month = '2026-09-01';

  if rev is null then
    raise exception 'FAIL: pnl_client_monthly reported no row for the fixture charge';
  end if;
  if rev <> 7.50 then
    raise exception 'FAIL: pnl_client_monthly revenue is %, expected 7.50', rev;
  end if;
  if unknown_costs <> 1 then
    raise exception 'FAIL: cost_unknown_charges is %, expected 1', unknown_costs;
  end if;
  if ck is not null then
    raise exception 'FAIL: an unknown cost became a cost_known of %; it must stay null', ck;
  end if;
  raise notice 'PASS: pnl_client_monthly keeps an unknown cost unknown';
end $$;

-- Net profit must be NULL, not equal to gross margin, when no operating costs
-- have been entered. This is the whole reason the four cost inputs can arrive
-- later without producing a wrong answer in the meantime.
--
-- The previous version selected from pnl_monthly for a month it had not
-- written to, and its guard was `if np is not null and gm is not null and
-- np = gm`. With no charges in that month both came back null, the guard was
-- false, and it printed PASS having tested nothing -- the one check the brief
-- singles out was the one check that could not fail. It now inserts its own
-- charge first and asserts the property positively: we HAVE a gross figure and
-- we honestly do NOT have a net one.
--
-- The fixture month is deliberately one no real data can occupy. pnl_monthly is
-- business-wide, so a real month would make `net_profit is null` depend on
-- whether operating_costs happens to hold all three allocation categories for
-- it -- an assertion about the state of the bookkeeping rather than about the
-- view. A sentinel month makes the overhead side of the full outer join empty
-- by construction.
do $$
declare cid uuid; oid uuid; np numeric; gm numeric;
begin
  select id into strict cid from clients where name = 'VERIFY-ONLY ledger_04';
  insert into orders (client_id, order_key, order_number, source)
    values (cid, 'VERIFY-PNLM', 'VERIFY-PNLM', 'zenventory') returning id into oid;
  insert into order_charges (order_id, client_id, charge_key, charge_type,
                             label, amount, cost, cost_basis, charge_date, source)
    values (oid, cid, 'item:m:pick', 'pick', 'Pick', 10.00, 4.00, 'measured',
            '2099-01-15', 'verify');

  select net_profit, gross_margin into np, gm
  from pnl_monthly where period_month = '2099-01-01';

  if gm is null then
    raise exception 'FAIL: pnl_monthly has no gross margin for the fixture month, '
                    'so this check would have passed without testing anything';
  end if;
  if np is not null then
    raise exception 'FAIL: net profit is % with no operating costs recorded; '
                    'overheads are being treated as zero', np;
  end if;
  raise notice 'PASS: gross margin is reported and net profit is honestly null';
end $$;

rollback;
