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
--
-- This block is scoped by SKU, not by month: pick_days groups on
-- (client_id, pick_date, sku), and 'SKU-PD' is written nowhere else. That is why
-- it can share September 2026 with VERIFY-CONF without either disturbing the
-- other. Any new assertion here must stay SKU-scoped or take its own month.
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
--
-- Scoped by SKU ('SKU-CONF'), same as VERIFY-PD above -- and it has to be, since
-- `select confidence into c` would take an arbitrary row if the predicate
-- matched more than one. Both lines share one pick_date so the view yields
-- exactly one row.
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
  if c is distinct from 2 then
    raise exception 'FAIL: confidence is %, expected 2 (weakest line wins)', c;
  end if;
  raise notice 'PASS: confidence takes the weakest line';
end $$;

-- A charge with an UNKNOWN cost must not be reported as a negative-margin leak.
--
-- This block owns SEPTEMBER 2026 for order_charges, and that is what makes an
-- expected count of ZERO meaningful: a zero-assertion is only as good as the
-- guarantee that no other block could have put a row in the same bucket. It was
-- not true when this comment was first written -- VERIFY-PNLC also wrote a
-- September charge for this same client, and the assertion survived only because
-- that charge's cost happened to be null, i.e. by the very property under test
-- rather than by isolation. VERIFY-PNLC now owns November 2026. Keep it that
-- way: no other block may write an order_charges row dated September 2026.
--
-- VERIFY-PD and VERIFY-CONF do write September 2026 ORDER_ITEMS for this client,
-- which is fine and must stay fine -- those feed leak 2 (picked_never_billed),
-- and this assertion names leak 4 explicitly.
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
-- cost (calculate-charges.ts:239).
--
-- This block owns OCTOBER 2026, so it and the one above are order-independent:
-- a positive count here can only come from this block's own insert, and the
-- zero count above cannot be broken by this one. `records = 1` depends on that
-- ownership too -- a second negative-margin charge for this client in October
-- would make it 2 and fail.
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
  -- `is distinct from`, not `<>`: if recs were NULL (max() over zero rows), `<>`
  -- would evaluate to NULL, take no branch, and silently print PASS. NULL here
  -- would mean the `n = 0` guard above failed to raise, which is impossible today
  -- but is exactly the kind of ordering dependency that bites later. Use
  -- `is distinct from` throughout assertions where either side could be NULL.
  if recs is distinct from 1 then
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
--
-- This block owns NOVEMBER 2026. It used to write September and so sat inside
-- VERIFY-LEAK's month, silently weakening that block's zero-assertion; giving
-- it its own month is the property worth having, not the corrected comment.
-- Note that a future edit giving this fixture a cost BELOW its amount is now
-- harmless -- that was the trap.
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
            '2026-11-05', 'verify');

  select revenue, cost_known, cost_unknown_charges
    into rev, ck, unknown_costs
  from pnl_client_monthly
  where client_id = cid and charge_type = 'verify_pnl'
    and period_month = '2026-11-01';

  if rev is null then
    raise exception 'FAIL: pnl_client_monthly reported no row for the fixture charge';
  end if;
  if rev is distinct from 7.50 then
    raise exception 'FAIL: pnl_client_monthly revenue is %, expected 7.50', rev;
  end if;
  -- `is distinct from` for the same reason as the `recs` check above: `<>` is
  -- NULL-blind and would print PASS if unknown_costs were NULL.
  if unknown_costs is distinct from 1 then
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
-- view. A sentinel month puts the overhead side of the full outer join entirely
-- under this block's control: it starts empty by construction, and only this
-- block ever fills it. It owns 2099-01 for both order_charges and
-- operating_costs.
--
-- It runs TWO phases, because the no-operating-costs case is not the case the
-- *_rows counts were added for:
--
--   Phase 1, no operating_costs rows at all -- all three allocation sums NULL
--            because the full outer join has no right-hand row, so net_profit
--            is NULL and the *_rows columns are NULL too.
--   Phase 2, operating_costs rows for TWO of the three allocations -- the
--            partial-category state a real business actually sits in. Here
--            direct_storage_rows is 0 rather than NULL (the month HAS a book,
--            and there is genuinely no direct_storage line in it), and
--            net_profit is still NULL because o.direct_storage is NULL and one
--            NULL poisons the subtraction. That combination is the whole reason
--            the three counts exist -- it is what lets Task 16 say "net profit
--            unavailable: no direct_storage cost recorded" instead of rendering
--            an empty cell -- and until now nothing exercised it.
--
-- Phase 2's BOTH rows are dated mid-month on purpose. operating_costs
-- imposes no first-of-month constraint (ledger_02_cost.sql:90), so if the
-- overhead CTE ever loses its date_trunc, neither row joins to 2099-01-01 and
-- both overhead_rows and direct_labor_rows come back NULL -- which the
-- assertions below name. If only direct_labor were mid-month, the overhead row
-- would still land on 2099-01-01 and overhead_rows would return 1, so the
-- date_trunc regression would produce `direct_labor_rows = NULL` while
-- `oh_rows = 1` appeared fine; dating both mid-month makes the detector fire
-- on overhead_rows first and removes that false-partial-pass.
do $$
declare cid uuid; oid uuid; np numeric; gm numeric;
        rev numeric; dc numeric;
        oh numeric; dl numeric; ds numeric;
        oh_rows bigint; dl_rows bigint; ds_rows bigint;
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

  -- Phase 2: two of the three allocations entered, direct_storage missing.
  -- period_month, category and amount are the NOT NULL columns without a
  -- default (ledger_02_cost.sql:88-97); vendor and note are nullable, and
  -- allocation has a default we override explicitly.
  insert into operating_costs (period_month, category, amount, allocation)
    values ('2099-01-10', 'VERIFY-rent',  1000.00, 'overhead'),
           ('2099-01-20', 'VERIFY-wages', 2000.00, 'direct_labor');

  select net_profit, gross_margin,
         overhead_rows, direct_labor_rows, direct_storage_rows
    into np, gm, oh_rows, dl_rows, ds_rows
  from pnl_monthly where period_month = '2099-01-01';

  -- `is distinct from` throughout, not `<>`: NULL <> 1 is NULL, not true, so a
  -- plain `<>` would take no branch and print PASS for the exact case these
  -- assertions exist to catch -- a NULL where a count was expected.
  if oh_rows is distinct from 1 then
    raise exception 'FAIL: overhead_rows is %, expected 1. A NULL here means the '
                    'mid-month operating_costs row did not join to the 1st, i.e. '
                    'the overhead CTE has lost its date_trunc', oh_rows;
  end if;
  if dl_rows is distinct from 1 then
    raise exception 'FAIL: direct_labor_rows is %, expected 1. A NULL here means '
                    'the mid-month operating_costs row did not join to the 1st, '
                    'i.e. the overhead CTE has lost its date_trunc', dl_rows;
  end if;
  if ds_rows is distinct from 0 then
    raise exception 'FAIL: direct_storage_rows is %, expected 0. It must be 0 and '
                    'not NULL: the month HAS operating_costs rows, and this '
                    'category is genuinely absent from them', ds_rows;
  end if;
  if gm is null then
    raise exception 'FAIL: gross margin went null once operating costs existed';
  end if;
  if np is not null then
    raise exception 'FAIL: net profit is % with direct_storage missing; a missing '
                    'allocation category is being coalesced to zero', np;
  end if;
  raise notice 'PASS: a missing allocation category nulls net_profit and is '
               'named by direct_storage_rows = 0';

  -- Phase 3: all three allocations present, and the NUMBER is asserted.
  --
  -- Until this phase existed, every assertion about net_profit in this file
  -- checked that it was NULL. Nothing anywhere entered all three allocation
  -- categories, so the arithmetic and the SIGNS of the five terms were
  -- untested -- in the one figure a human reads before repricing a client.
  -- `revenue - direct_cost + overhead - labour - storage`, or `+ direct_cost`,
  -- or the three terms coalesced to 0, would have passed this whole file.
  --
  -- WHY EACH TERM IS ASSERTED SEPARATELY AND NOT JUST THE TOTAL. Subtraction
  -- is commutative in its operands, so `- overhead - direct_labor` and
  -- `- direct_labor - overhead` give the same total: a net_profit assertion
  -- alone cannot see the three allocation filters being transposed, which is a
  -- live risk because they are three near-identical `sum(...) filter (...)`
  -- lines. Transposed filters would misreport the composition of cost while
  -- the headline stayed right, and labour_variance_inputs reads direct_labor
  -- specifically. Asserting the terms also localises a failure: without it, a
  -- wrong total tells the operator the expression is broken but not which
  -- limb of it.
  --
  -- WHAT PHASE 3 CANNOT SEE, so phases 1 and 2 are not superseded by it: with
  -- all three categories present, `coalesce(o.overhead, 0)` is
  -- indistinguishable from `o.overhead`. Only the null-propagation phases
  -- above catch an unknown cost being claimed as zero. The three phases test
  -- different properties and all three are load-bearing.
  insert into operating_costs (period_month, category, amount, allocation)
    values ('2099-01-05', 'VERIFY-space', 500.00, 'direct_storage');

  select revenue, direct_cost, gross_margin, net_profit,
         overhead, direct_labor, direct_storage, direct_storage_rows
    into rev, dc, gm, np, oh, dl, ds, ds_rows
  from pnl_monthly where period_month = '2099-01-01';

  -- The two revenue-side inputs. 10.00 and 4.00 are the single charge inserted
  -- at the top of this block; if either is wrong the revenue CTE is summing the
  -- wrong column, and every figure below it is wrong for that reason rather
  -- than for an arithmetic one.
  if rev is distinct from 10.00 then
    raise exception 'FAIL: revenue is %, expected 10.00. The revenue CTE is not '
                    'summing order_charges.amount for the fixture month', rev;
  end if;
  if dc is distinct from 4.00 then
    raise exception 'FAIL: direct_cost is %, expected 4.00. The revenue CTE is '
                    'not summing order_charges.cost', dc;
  end if;

  -- The three allocation sums, each distinct, so a transposition shows up here
  -- as two simultaneous failures rather than as a correct total.
  if oh is distinct from 1000.00 then
    raise exception 'FAIL: overhead is %, expected 1000.00. Either the '
                    'allocation filter is wrong or the mid-month row did not '
                    'truncate to the 1st', oh;
  end if;
  if dl is distinct from 2000.00 then
    raise exception 'FAIL: direct_labor is %, expected 2000.00. If this holds '
                    '1000.00 or 500.00 the three allocation filters have been '
                    'transposed, which net_profit alone cannot detect', dl;
  end if;
  if ds is distinct from 500.00 then
    raise exception 'FAIL: direct_storage is %, expected 500.00', ds;
  end if;
  if ds_rows is distinct from 1 then
    raise exception 'FAIL: direct_storage_rows is %, expected 1 now that the '
                    'category has been entered', ds_rows;
  end if;

  -- gross_margin, also never asserted numerically before this. It is the figure
  -- rendered next to net_profit, and it reads HIGH by any unknown cost -- so a
  -- sign error here is in the flattering direction.
  if gm is distinct from 6.00 then
    raise exception 'FAIL: gross_margin is %, expected 6.00 (revenue 10.00 less '
                    'direct_cost 4.00). A plus sign here would read 14.00', gm;
  end if;

  -- The headline. Negative on purpose: a positive expected value can be hit by
  -- several wrong expressions, whereas -3494.00 is reachable only by
  -- subtracting all four cost terms from revenue. 10 - 4 - 1000 - 2000 - 500.
  -- For the record, what the near misses look like: +direct_cost gives
  -- -3486.00, +overhead gives -1494.00, +direct_labor gives 506.00, and
  -- +direct_storage gives -2494.00 -- all four distinguishable from each other
  -- and from the truth, which is why the four amounts are different magnitudes.
  if np is distinct from -3494.00 then
    raise exception 'FAIL: net_profit is %, expected -3494.00 for revenue 10.00, '
                    'direct_cost 4.00, overhead 1000.00, direct_labor 2000.00, '
                    'direct_storage 500.00. A sign is wrong in '
                    'ledger_04_views.sql pnl_monthly.net_profit. Compare: '
                    '-3486.00 means direct_cost is added, -1494.00 means '
                    'overhead is added, 506.00 means direct_labor is added, '
                    '-2494.00 means direct_storage is added', np;
  end if;
  raise notice 'PASS: net_profit is -3494.00 and gross_margin is 6.00 -- all '
               'five terms carry the right sign and the right allocation';
end $$;

-- ---------------------------------------------------------------------------
-- labour_variance_inputs. Until this block existed the view had NO automated
-- verification of any kind -- not one assertion anywhere in supabase/ read a
-- single column of it -- and it is the view that answers "are we paying more
-- per pick than we charge for one", i.e. the one that decides whether the pick
-- price is wrong. Every property its own header argues for at length was
-- unwitnessed.
--
-- IT OWNS 2098-01 AND 2098-02, for both order_charges and operating_costs.
-- Sentinel months for the same reason the pnl block uses 2099-01: the view is
-- business-wide, with no client_id to scope by, so any real month would make
-- these assertions depend on the state of the bookkeeping rather than on the
-- view. 2099 is already taken; a second block may not reuse 2098.
--
-- The fixture also defines its OWN variants and its OWN cost_rates rows rather
-- than leaning on ledger_06_seed_cost_rates.sql's ('pick','device') at 0.2300
-- and ('pick','component') at 0.2000. Three reasons: re-baselining those
-- placeholders is explicitly planned, and a verify script that fails when the
-- seed is corrected trains the operator to ignore it; 0.2300 and 0.2000 are
-- close enough that a units-weighted blend and a plain average differ in the
-- third decimal, which is too fine a margin to assert on; and seeding the rates
-- here means the assertions below state the arithmetic in full rather than
-- referring the reader to another file.
--
-- THE NUMBERS ARE CHOSEN SO THAT EACH WRONG FORMULA LANDS SOMEWHERE ELSE:
--
--   variant VERIFY-A: 1 charge,  1 unit,  cost rate 0.5000, basis estimated
--   variant VERIFY-B: 2 charges, 9 units, cost rate 0.1000, basis measured
--
--   units-weighted (correct)  (1*0.50 + 9*0.10) / 10 = 0.14
--   plain avg(rate)                 (0.50 + 0.10) / 2  = 0.30
--
-- The 1-against-9 split is the point. With equal units the two formulas agree
-- and the assertion proves nothing; this split makes avg(rate) overstate the
-- standard by more than double, which reads as a large FAVOURABLE variance --
-- the direction nobody files a bug about. (The view's own header warns about
-- the opposite degradation, a cross-variant `limit 1`, which here would give
-- either 0.50 or 0.10 -- both also excluded by asserting 0.14.)
--
-- The basis pair is deliberately mixed. estimated and measured both present
-- must yield 'estimated': the weakest, because the screen has to caveat the
-- figure. Were the case arms in `picked` reordered, this month would present a
-- placeholder rate as measured, and 'estimated' vs 'measured' is the only
-- assertion that can see it.
--
-- Every charge and both operating_costs rows are dated MID-month, so a lost
-- date_trunc in pick_charges or in payroll shows up as the fixture month not
-- existing at all rather than as a wrong figure.
--
-- SIX PHASES, because the properties are mutually exclusive in one fixture:
--
--   B  two priced variants   -> standard_rate 0.14, basis estimated,
--                               direct_labor NULL (not 0), implied NULL
--   C  payroll arrives       -> direct_labor 2.00, implied 0.20
--   D  a charge with rate_id NULL  -> unattributable_pick_charges 1,
--                               standard_rate NULL, units 16
--   D2 that charge deleted   -> everything RECOVERS: 0.14 and 0 again
--   E  a variant with NO cost rate -> standard_rate NULL again, but
--                               unattributable_pick_charges still 0, units 25
--   F  a payroll-only month  -> a row exists, units_picked 0
--
-- WHY D AND E ARE BOTH HERE. They are two different defects that both null the
-- standard rate, and the column that distinguishes them is
-- unattributable_pick_charges. D's charge has no recoverable variant at all;
-- E's is attributable (its rate card line names VERIFY-C) and merely unpriced.
-- If the view ever counted `filter (where rate is null)` instead of
-- `filter (where variant is null)`, E would report 1 and fail here -- and the
-- operator would be sent to look for a broken rate_id when the actual fix is to
-- add a cost rate. The pair also gives the counter a control in both
-- directions: D proves it can reach 1, so E's 0 is a working rule rather than a
-- dead code path.
--
-- WHY D2 EXISTS. Without it, phase E could not prove anything about
-- standard_rate: D has already nulled it, so a view that latched the null
-- forever -- or one that ignored E's row entirely -- would still read NULL and
-- pass. Deleting D's charge and asserting that 0.14 comes BACK establishes that
-- the null is caused by the offending row and is not sticky, which is what
-- makes E's null attributable to E. It also catches the opposite defect: a
-- standard rate that stays null after the data is fixed is an alert that cannot
-- be cleared, and an alert that cannot be cleared becomes furniture.
--
-- D AND E ALSO PIN units_picked MOVING, 10 -> 16 -> 10 -> 25. The view's header
-- states that an unattributable or unpriced pick charge must be COUNTED and
-- never dropped, because dropping it shrinks units, shrinks absorbed cost and
-- reports a fictitious unfavourable variance. An inner join in pick_charges, or
-- a `where rate is not null`, would leave units at 10 throughout and is caught
-- twice. And implied_actual_rate is asserted in D and E precisely BECAUSE
-- standard_rate is null there: the all-or-nothing nulling must not take the
-- actual rate down with it, or the screen loses both halves of the comparison
-- at once. Payroll is 2.00 and the three unit totals are 10, 16 and 25 so that
-- all three quotients -- 0.20, 0.125, 0.08 -- terminate exactly and can be
-- compared without a tolerance.
-- ---------------------------------------------------------------------------
do $$
declare cid uuid; oid uuid;
        ra uuid; rb uuid; rc uuid;
        units numeric; unattrib numeric; dl numeric;
        sr numeric; srb text; iar numeric;
        vb jsonb; rows_found bigint;
begin
  select id into strict cid from clients where name = 'VERIFY-ONLY ledger_04';
  insert into orders (client_id, order_key, order_number, source)
    values (cid, 'VERIFY-LVI', 'VERIFY-LVI', 'zenventory') returning id into oid;

  -- The rate card lines. These carry the VARIANT, which is the only route from
  -- a pick charge to its cost rate (order_charges.rate_id -> variant). rate is
  -- nullable since ledger_03_charges.sql:460 but is supplied anyway: a rate
  -- card line with no price is a separate defect with its own detector, and
  -- mixing it in here would make a failure ambiguous.
  --
  -- `service_type` is deliberately NOT named, even though it is `not null` with
  -- no default in schema.sql:29. ledger_03_charges.sql:493 drops that not-null,
  -- and its handler accepts "nullable OR gone" as the pass condition -- a
  -- database where someone finished the job and dropped the superseded column
  -- is in a better state, not a worse one. Naming it here would make this block
  -- fail with 42703 on exactly that better database.
  insert into client_warehouse_rates (client_id, charge_type, variant, rate,
                                      effective_from, label)
    values (cid, 'pick', 'VERIFY-A', 1.00, '2098-01-01', 'Verify pick A')
    returning id into ra;
  insert into client_warehouse_rates (client_id, charge_type, variant, rate,
                                      effective_from, label)
    values (cid, 'pick', 'VERIFY-B', 1.00, '2098-01-01', 'Verify pick B')
    returning id into rb;
  -- VERIFY-C exists on the rate card and deliberately gets NO cost_rates row.
  insert into client_warehouse_rates (client_id, charge_type, variant, rate,
                                      effective_from, label)
    values (cid, 'pick', 'VERIFY-C', 1.00, '2098-01-01', 'Verify pick C')
    returning id into rc;

  -- What the picks cost US. effective_from is the 1st and effective_to is open,
  -- so `cr.effective_from <= v.period_month` holds with equality -- the same
  -- boundary the real seed relies on.
  --
  -- THE THIRD ROW IS A TRAP, not a fixture. The view's lateral matches
  -- `cr.variant = v.variant`, and the whole reason an unattributable pick
  -- charge nulls the month is that NULL = NULL is NULL, so a null variant
  -- matches NOTHING -- including a variant-null cost row sitting right there.
  -- That property cannot be observed against the real seed, because
  -- ledger_06_seed_cost_rates.sql has variant-null rows for 'pack' and
  -- 'storage' only and the lateral filters cost_type = 'pick' first. So the
  -- fixture supplies the row the defect would need. If the join is ever
  -- loosened to `is not distinct from`, or the variants coalesced to '', phase
  -- D's null-variant charge picks up 9.0000 and the month reports a standard
  -- rate of 3.4625 instead of the honest NULL. 9.0000 is absurd on purpose: it
  -- is 18x the highest real rate here, so the wrong answer is unmistakable in
  -- the failure message rather than plausible.
  insert into cost_rates (cost_type, variant, unit, rate, effective_from, basis)
    values ('pick', 'VERIFY-A', 'per_unit', 0.5000, '2098-01-01', 'estimated'),
           ('pick', 'VERIFY-B', 'per_unit', 0.1000, '2098-01-01', 'measured'),
           ('pick', null,       'per_unit', 9.0000, '2098-01-01', 'estimated');

  -- Phase B. Two charges on VERIFY-B, not one, so `charges` is a count and
  -- `units` a sum of quantity -- a view that confused the two would read 2
  -- units for B instead of 9 and blend to 0.3666..., not 0.14.
  -- cost/cost_basis are left null throughout: this view reads quantity and
  -- rate_id only, and a null cost is the pair order_charges_cost_has_basis
  -- permits.
  insert into order_charges (order_id, client_id, rate_id, charge_key,
                             charge_type, label, quantity, amount,
                             charge_date, source)
    values (oid, cid, ra, 'VERIFY-LVI:a1', 'pick', 'Pick A', 1, 1.00,
            '2098-01-15', 'verify'),
           (oid, cid, rb, 'VERIFY-LVI:b1', 'pick', 'Pick B', 4, 4.00,
            '2098-01-15', 'verify'),
           (oid, cid, rb, 'VERIFY-LVI:b2', 'pick', 'Pick B', 5, 5.00,
            '2098-01-15', 'verify');

  select units_picked, unattributable_pick_charges, direct_labor,
         standard_rate, standard_rate_basis, implied_actual_rate,
         variant_breakdown
    into units, unattrib, dl, sr, srb, iar, vb
  from labour_variance_inputs where period_month = '2098-01-01';

  -- `is distinct from` throughout, as everywhere else in this file: a NULL on
  -- the left of `<>` takes no branch and prints PASS. Here a NULL in `units`
  -- specifically means the view returned NO ROW for the fixture month, which is
  -- what a lost date_trunc in pick_charges looks like.
  if units is distinct from 10 then
    raise exception 'FAIL: units_picked is %, expected 10 (1 + 4 + 5). NULL '
                    'means labour_variance_inputs returned no row at all for '
                    '2098-01, i.e. the mid-month charge_date did not truncate '
                    'to the 1st. 2 would mean charges are being counted where '
                    'quantity should be summed.', units;
  end if;
  if sr is distinct from 0.14 then
    raise exception 'FAIL: standard_rate is %, expected 0.14 -- the '
                    'units-weighted blend (1*0.5000 + 9*0.1000) / 10. Compare: '
                    '0.30 is a plain avg(rate) over the two variants, which '
                    'overstates the standard and reports a large FAVOURABLE '
                    'variance that is not there; 0.50 or 0.10 is a '
                    'cross-variant rate lookup picking one variant''s rate and '
                    'applying it to both variants'' units.', sr;
  end if;
  if srb is distinct from 'estimated' then
    raise exception 'FAIL: standard_rate_basis is %, expected estimated. One '
                    'contributing rate is estimated and one is measured, and '
                    'the WEAKEST must win -- measured here would present a '
                    'placeholder cost rate to the operator as a measured one.',
                    srb;
  end if;
  if unattrib is distinct from 0 then
    raise exception 'FAIL: unattributable_pick_charges is %, expected 0. Every '
                    'charge in this phase carries a rate_id that resolves to a '
                    'variant.', unattrib;
  end if;
  -- The null-not-zero property, in the direction that flatters. A 0 here would
  -- report the whole standard cost as a favourable variance.
  if dl is not null then
    raise exception 'FAIL: direct_labor is % with no payroll entered for the '
                    'month; unknown payroll is being reported as zero, which '
                    'shows the entire absorbed cost as a saving', dl;
  end if;
  if iar is not null then
    raise exception 'FAIL: implied_actual_rate is % with no payroll entered; it '
                    'is unknown, not zero', iar;
  end if;

  -- variant_breakdown, the only other column of this view and previously the
  -- only one with no assertion at all. §5.3.2 asks for the components beside
  -- the blend "so the cause is visible rather than inferred from one number" --
  -- which means the breakdown is not decoration, it is the thing an operator
  -- reads to find out WHICH variant moved. A blend of 0.14 that cannot be
  -- explained is a number nobody can act on.
  if jsonb_array_length(vb) is distinct from 2 then
    raise exception 'FAIL: variant_breakdown holds % entries, expected 2 (one '
                    'per variant, not one per charge -- there are 3 charges)',
                    jsonb_array_length(vb);
  end if;
  -- First entry, because the agg is `order by variant nulls last` and
  -- VERIFY-A sorts before VERIFY-B. Asserting the ORDER matters: the null
  -- entry's position is what phase D checks, and an unordered jsonb_agg is
  -- non-deterministic rather than merely differently sorted.
  if vb->0->>'variant' is distinct from 'VERIFY-A' then
    raise exception 'FAIL: variant_breakdown[0].variant is %, expected '
                    'VERIFY-A; the agg has lost its ORDER BY and the array is '
                    'in whatever order the planner emitted', vb->0->>'variant';
  end if;
  if (vb->0->>'units')::numeric is distinct from 1
     or (vb->0->>'standard_rate')::numeric is distinct from 0.5000 then
    raise exception 'FAIL: variant_breakdown[0] is %, expected 1 unit at '
                    '0.5000. The breakdown must carry the PER-VARIANT rate, '
                    'not the blend repeated.', vb->0;
  end if;
  if (vb->1->>'units')::numeric is distinct from 9
     or (vb->1->>'standard_rate')::numeric is distinct from 0.1000 then
    raise exception 'FAIL: variant_breakdown[1] is %, expected 9 units at '
                    '0.1000', vb->1;
  end if;
  raise notice 'PASS: standard_rate is the units-weighted 0.14, basis is the '
               'weakest of the two, unentered payroll stays null, and the '
               'breakdown explains the blend';

  -- Phase C. Payroll arrives, mid-month again so the payroll CTE's own
  -- date_trunc is exercised independently of pick_charges'.
  insert into operating_costs (period_month, category, amount, allocation)
    values ('2098-01-20', 'VERIFY-pickers', 2.00, 'direct_labor');

  select units_picked, direct_labor, standard_rate, implied_actual_rate
    into units, dl, sr, iar
  from labour_variance_inputs where period_month = '2098-01-01';

  if dl is distinct from 2.00 then
    raise exception 'FAIL: direct_labor is %, expected 2.00. NULL means the '
                    'mid-month operating_costs row did not join to the 1st, '
                    'i.e. the payroll CTE has lost its date_trunc -- the month '
                    'would read "payroll not entered" with the payroll sitting '
                    'in the table. 1000.00, 2000.00 or 500.00 would mean the '
                    'allocation filter is matching the pnl block''s rows.', dl;
  end if;
  if iar is distinct from 0.20 then
    raise exception 'FAIL: implied_actual_rate is %, expected 0.20 (2.00 over '
                    '10 units). This is the figure compared against '
                    'standard_rate, so a wrong denominator here inverts the '
                    'sign of the variance.', iar;
  end if;
  -- Entering payroll must not disturb the pick side. The months CTE is a UNION
  -- and a mis-written join could duplicate the pick rows against the payroll
  -- row and double units.
  if units is distinct from 10 then
    raise exception 'FAIL: units_picked became % once payroll existed, expected '
                    '10. The payroll join is multiplying the pick side.', units;
  end if;
  if sr is distinct from 0.14 then
    raise exception 'FAIL: standard_rate became % once payroll existed, '
                    'expected 0.14', sr;
  end if;
  raise notice 'PASS: payroll joins by truncated month and implied_actual_rate '
               'is 0.20 against a standard of 0.14';

  -- Phase D. A pick charge with no rate_id at all, so no recoverable variant.
  -- A NULL variant matches no cost_rates row -- NULL = NULL is NULL -- which is
  -- what makes it null the month's rate rather than quietly borrowing the
  -- variant-null cost row that ledger_06_seed_cost_rates.sql deliberately
  -- leaves in the table.
  insert into order_charges (order_id, client_id, rate_id, charge_key,
                             charge_type, label, quantity, amount,
                             charge_date, source)
    values (oid, cid, null, 'VERIFY-LVI:x1', 'pick', 'Pick unattributed', 6,
            6.00, '2098-01-15', 'verify');

  select units_picked, unattributable_pick_charges, standard_rate,
         standard_rate_basis, implied_actual_rate, variant_breakdown
    into units, unattrib, sr, srb, iar, vb
  from labour_variance_inputs where period_month = '2098-01-01';

  if unattrib is distinct from 1 then
    raise exception 'FAIL: unattributable_pick_charges is %, expected 1. A '
                    'pick charge with a null or dangling rate_id has no '
                    'recoverable variant, and this column is the only place '
                    'that says so. 0 here means the row was dropped by the '
                    'join instead of counted.', unattrib;
  end if;
  if units is distinct from 16 then
    raise exception 'FAIL: units_picked is %, expected 16 (10 + 6). 10 means '
                    'the unattributable charge was DROPPED rather than '
                    'counted, which shrinks absorbed cost and reports a '
                    'fictitious unfavourable variance -- the pick_charges join '
                    'must stay a LEFT join.', units;
  end if;
  if sr is not null then
    raise exception 'FAIL: standard_rate is % with an unattributable charge '
                    'present; it must be NULL for the whole month. 0.14 means '
                    'the charge was excluded from the blend, and 0.0875 means '
                    'its units stayed in the denominator while its cost was '
                    'treated as zero. Both understate absorbed cost and report '
                    'an overspend that never happened. 3.4625 means the null '
                    'variant MATCHED the variant-null cost row this block '
                    'seeds as a trap, i.e. the lateral join is no longer an '
                    'exact equality.', sr;
  end if;
  if srb is not null then
    raise exception 'FAIL: standard_rate_basis is % while standard_rate is '
                    'null; a basis for a rate that does not exist will be '
                    'rendered as a caveat on a blank figure. estimated here '
                    'means the outer gate on any_rate_missing was dropped and '
                    'only the inner weakest-basis case survives.', srb;
  end if;
  if iar is distinct from 0.125 then
    raise exception 'FAIL: implied_actual_rate is %, expected 0.125 (2.00 over '
                    '16 units). It must survive standard_rate going null: '
                    'losing both halves at once leaves the screen with nothing '
                    'to show and no reason given.', iar;
  end if;

  -- The breakdown is the ONLY place that says which variant caused the null.
  -- standard_rate is blank and standard_rate_basis is blank, so without this
  -- array the month renders as "no standard rate" with no reason attached --
  -- and the operator's next move, add a cost rate for WHICH variant, is
  -- unanswerable. `nulls last` is therefore a contract and not a tidiness
  -- preference: the degraded entry sits at the end where the screen can
  -- render it as the exception.
  if jsonb_array_length(vb) is distinct from 3 then
    raise exception 'FAIL: variant_breakdown holds % entries, expected 3 -- the '
                    'unattributable charge must appear as its own entry, not '
                    'be folded into another variant or dropped',
                    jsonb_array_length(vb);
  end if;
  -- `->>` over a JSON null yields SQL NULL, which is what "no variant" has to
  -- look like here. A non-null value in the last slot means the agg ordered
  -- the null first, or named the variant something.
  if vb->2->>'variant' is not null then
    raise exception 'FAIL: variant_breakdown[2].variant is %, expected the '
                    'null-variant entry last (`order by variant nulls last`). '
                    'The degraded entry sorting first pushes a real variant '
                    'into the slot the screen flags as the exception.',
                    vb->2->>'variant';
  end if;
  if (vb->2->>'units')::numeric is distinct from 6 then
    raise exception 'FAIL: variant_breakdown[2].units is %, expected 6 -- the '
                    'units whose cost cannot be stated are the figure that '
                    'tells the operator how much of the month is affected',
                    vb->2->>'units';
  end if;
  if vb->2->>'standard_rate' is not null then
    raise exception 'FAIL: variant_breakdown[2].standard_rate is %, expected '
                    'null. A number here means the null-variant entry found a '
                    'cost rate, which is the same defect the 3.4625 case above '
                    'describes.', vb->2->>'standard_rate';
  end if;
  raise notice 'PASS: an unattributable pick charge is counted in units, nulls '
               'the month''s standard rate, is named by its own counter, and '
               'appears last in the breakdown with its units and a null rate';

  -- Phase D2. Delete the offending charge. Everything must come BACK.
  --
  -- This is the phase that makes phase E meaningful, and it is worth having on
  -- its own account: a standard rate that stays null after the data is fixed is
  -- an alert nobody can clear, and the operator learns to scroll past it. Same
  -- reasoning as the per-run delta in the Zenventory sync -- a detector that
  -- cannot return to the quiet state is not a detector.
  delete from order_charges where charge_key = 'VERIFY-LVI:x1' and order_id = oid;

  select units_picked, unattributable_pick_charges, standard_rate,
         standard_rate_basis, implied_actual_rate
    into units, unattrib, sr, srb, iar
  from labour_variance_inputs where period_month = '2098-01-01';

  if units is distinct from 10 then
    raise exception 'FAIL: units_picked is % after deleting the unattributable '
                    'charge, expected 10', units;
  end if;
  if unattrib is distinct from 0 then
    raise exception 'FAIL: unattributable_pick_charges is % after the offending '
                    'charge was deleted, expected 0', unattrib;
  end if;
  if sr is distinct from 0.14 then
    raise exception 'FAIL: standard_rate is % after the offending charge was '
                    'deleted, expected 0.14 again. A null here means the view '
                    'cannot return to the quiet state once a month has been '
                    'degraded -- an alert that cannot be cleared stops being '
                    'read.', sr;
  end if;
  if srb is distinct from 'estimated' then
    raise exception 'FAIL: standard_rate_basis is % after the offending charge '
                    'was deleted, expected estimated again', srb;
  end if;
  if iar is distinct from 0.20 then
    raise exception 'FAIL: implied_actual_rate is % after the offending charge '
                    'was deleted, expected 0.20 again', iar;
  end if;
  raise notice 'PASS: removing the offending charge restores 0.14 -- the null '
               'tracks the condition and is not latched';

  -- Phase E. A variant that IS attributable but has no cost rate. The standard
  -- rate must go null again, for a different reason, and the counter must NOT
  -- move. ALL-OR-NOTHING: blending over only the covered subset would
  -- understate absorbed cost and report a leak that is not there.
  insert into order_charges (order_id, client_id, rate_id, charge_key,
                             charge_type, label, quantity, amount,
                             charge_date, source)
    values (oid, cid, rc, 'VERIFY-LVI:c1', 'pick', 'Pick C', 15, 15.00,
            '2098-01-15', 'verify');

  select units_picked, unattributable_pick_charges, standard_rate,
         standard_rate_basis, implied_actual_rate
    into units, unattrib, sr, srb, iar
  from labour_variance_inputs where period_month = '2098-01-01';

  if unattrib is distinct from 0 then
    raise exception 'FAIL: unattributable_pick_charges is %, expected 0. This '
                    'charge IS attributable -- its rate card line names '
                    'VERIFY-C -- it simply has no cost rate. Counting it here '
                    'means the column is filtering on a null RATE rather than '
                    'a null VARIANT, and it would send the operator to look '
                    'for a broken rate_id when the fix is to add a cost rate.',
                    unattrib;
  end if;
  if units is distinct from 25 then
    raise exception 'FAIL: units_picked is %, expected 25 (10 + 15). 10 means '
                    'the unpriced variant''s units were dropped, which is the '
                    'same fictitious unfavourable variance as in phase D by a '
                    'different route -- a `where rate is not null` in priced '
                    'or per_variant.', units;
  end if;
  if sr is not null then
    raise exception 'FAIL: standard_rate is % with one variant''s cost rate '
                    'absent; it must be NULL for the whole month. 0.14 means '
                    'the uncovered variant was excluded from the blend, and '
                    '0.056 means its units were kept in the denominator while '
                    'its cost was treated as zero.', sr;
  end if;
  if srb is not null then
    raise exception 'FAIL: standard_rate_basis is % while standard_rate is '
                    'null', srb;
  end if;
  if iar is distinct from 0.08 then
    raise exception 'FAIL: implied_actual_rate is %, expected 0.08 (2.00 over '
                    '25 units)', iar;
  end if;
  raise notice 'PASS: an unpriced variant nulls the month''s standard rate '
               'without dropping its units and without being miscounted as '
               'unattributable';

  -- Phase F, in its own month. Payroll with no picks at all -- a shutdown
  -- month, or any month where payroll is entered before the charge calculator
  -- has run. This is 100%-unabsorbed labour, the largest unfavourable variance
  -- there is, and if `months` were the pick side left-joined to payroll instead
  -- of a UNION the month would produce NO ROW and be invisible.
  insert into operating_costs (period_month, category, amount, allocation)
    values ('2098-02-10', 'VERIFY-pickers-idle', 700.00, 'direct_labor');

  -- Counted first, and separately. units_picked is coalesced to 0 inside the
  -- view, so it can never be null in a row that exists -- which means "row
  -- missing" and "row present with no picks" are indistinguishable from the
  -- column alone, and the assertion below would report the missing-row case as
  -- a wrong number rather than as the structural failure it is.
  select count(*) into rows_found
  from labour_variance_inputs where period_month = '2098-02-01';

  if rows_found is distinct from 1 then
    raise exception 'FAIL: labour_variance_inputs returns % rows for a month '
                    'with payroll and no picks, expected 1. 0 means the months '
                    'CTE is no longer a UNION of both sides, so a fully '
                    'unabsorbed payroll month -- the largest unfavourable '
                    'variance there is -- reports nothing at all.', rows_found;
  end if;

  select units_picked, unattributable_pick_charges, direct_labor,
         standard_rate, implied_actual_rate
    into units, unattrib, dl, sr, iar
  from labour_variance_inputs where period_month = '2098-02-01';

  -- 0, not null, and the distinction is the whole null-versus-zero doctrine:
  -- order_charges holds no pick charge in this month, which is a MEASURED zero.
  if units is distinct from 0 then
    raise exception 'FAIL: units_picked is % for a month with no pick charges, '
                    'expected 0. NULL means the coalesce was dropped: nobody '
                    'picked anything is a measured zero, not an unknown.',
                    units;
  end if;
  if unattrib is distinct from 0 then
    raise exception 'FAIL: unattributable_pick_charges is %, expected 0', unattrib;
  end if;
  if dl is distinct from 700.00 then
    raise exception 'FAIL: direct_labor is %, expected 700.00 for the '
                    'payroll-only month', dl;
  end if;
  -- Both null because there is nothing to divide by. The guards are
  -- `units_picked > 0`, so losing them is a division by zero, not a wrong
  -- number -- it would abort the view for every caller.
  if sr is not null then
    raise exception 'FAIL: standard_rate is % with zero units picked', sr;
  end if;
  if iar is not null then
    raise exception 'FAIL: implied_actual_rate is % with zero units picked; '
                    'with no units there is no per-unit rate to state', iar;
  end if;
  raise notice 'PASS: a payroll-only month appears, with a measured zero units '
               'and no fabricated per-unit rates';
end $$;

-- ---------------------------------------------------------------------------
-- order_charges_unattributed_key: the unique index covering a charge with BOTH
-- order_id and client_id null. It had no test.
--
-- ledger_03_charges.sql:321-331 is explicit that no path in the plan produces
-- such a row, and that the index exists anyway because "unreachable" is a claim
-- about code not yet written while the cost of being wrong is asymmetric: with
-- no constraint, the thrice-daily cron inserts a fresh copy of the same charge
-- every run and the ledger inflates while still looking plausible. An index
-- nothing exercises is also an index nobody notices the loss of -- the two
-- partial indexes beside it were reworked once already (the order_key one was
-- converted from partial to non-partial in that same file), and a future edit
-- to this one would be silent.
--
-- The duplicate insert is wrapped in its own BEGIN/EXCEPTION, which opens a
-- savepoint: the failed statement rolls back to it and the outer transaction
-- survives, so the blocks after this one still run. Same shape as the
-- constraint-adding blocks in ledger_02 and ledger_03.
--
-- Its own month, 2097-01, on the same no-collision grounds as the two blocks
-- above. These rows have no client_id, so they are invisible to every
-- client-scoped assertion, but pnl_monthly is business-wide and sums
-- order_charges.amount for whatever month they land in.
-- ---------------------------------------------------------------------------
do $$
declare dup_rejected boolean := false; n bigint;
begin
  insert into order_charges (order_id, client_id, charge_key, charge_type,
                             label, amount, charge_date, source)
    values (null, null, 'VERIFY-UNATTRIB-1', 'storage', 'Verify unattributed 1',
            1.00, '2097-01-01', 'verify');

  -- Positive control, and it has to come before the duplicate attempt. Without
  -- it, an index defined over the wrong column -- or a check constraint
  -- rejecting these rows outright -- would make the duplicate fail for the
  -- wrong reason and this block would report a pass. A second row with a
  -- DIFFERENT key must be accepted.
  insert into order_charges (order_id, client_id, charge_key, charge_type,
                             label, amount, charge_date, source)
    values (null, null, 'VERIFY-UNATTRIB-2', 'storage', 'Verify unattributed 2',
            1.00, '2097-01-01', 'verify');

  begin
    insert into order_charges (order_id, client_id, charge_key, charge_type,
                               label, amount, charge_date, source)
      values (null, null, 'VERIFY-UNATTRIB-1', 'storage',
              'Verify unattributed 1 again', 1.00, '2097-01-01', 'verify');
  exception when unique_violation then
    dup_rejected := true;
  end;

  -- `is not true`, and `dup_rejected` is initialised to false rather than left
  -- to default to NULL. Either alone would do; both are here because `if not
  -- dup_rejected` over a NULL takes no branch and prints PASS, which is the
  -- failure direction this block exists to rule out.
  if dup_rejected is not true then
    raise exception 'FAIL: a second order_charges row with the same charge_key '
                    'and both order_id and client_id null was ACCEPTED. '
                    'order_charges_unattributed_key is missing or no longer '
                    'covers these rows, so a repeated calculator run appends '
                    'a fresh copy of the same charge instead of colliding.';
  end if;

  select count(*) into n from order_charges
  where order_id is null and client_id is null
    and charge_key in ('VERIFY-UNATTRIB-1', 'VERIFY-UNATTRIB-2');

  if n is distinct from 2 then
    raise exception 'FAIL: % of the 2 distinct-key unattributed charges are '
                    'present, expected 2. Fewer means the index is rejecting '
                    'rows it should admit, so the duplicate above was refused '
                    'for the wrong reason and the assertion proved nothing.', n;
  end if;
  raise notice 'PASS: order_charges_unattributed_key admits distinct keys and '
               'rejects a repeat';
end $$;

-- ---------------------------------------------------------------------------
-- The security state of the five views. This is the only assertion in this file
-- that is not about a number being right, and it is here because until now
-- NOTHING downstream of ledger_04_views.sql confirmed it independently. That
-- file's own guards report on themselves; a guard that is the sole witness to
-- its own success is not a check. The `anon` key is a NEXT_PUBLIC_ string
-- inlined into the browser bundle (src/lib/supabase.ts:3-6), so a view created
-- but not revoked is every client's margin, published.
--
-- Two properties, both required, neither sufficient alone:
--   * security_invoker -- without it the views read the RLS-protected base
--     tables (clients, shipments, rate_adjustments, client_warehouse_rates) as
--     their OWNER, RLS bypassed.
--   * no SELECT for anon or authenticated -- what actually closes the ledger
--     tables from migrations 1-3, which carry no RLS of their own.
--
-- THE TWO NAMING CONVENTIONS ARE NOT INTERCHANGEABLE, and getting one wrong
-- produces an assertion that passes because it matched nothing -- strictly worse
-- than no assertion. `pg_class.relname` holds the BARE name, so the catalog
-- lookup uses bare names plus an explicit relnamespace; `has_table_privilege`
-- takes a regclass-resolvable identifier resolved against search_path, so it
-- gets the SCHEMA-QUALIFIED form. Both conventions already appear, each
-- correctly, in ledger_04_views.sql -- they are copied from there, not chosen.
--
-- Both checks fail SAFE if a name is wrong: the left join leaves an unmatched
-- view with NULL reloptions and reports it as missing, and has_table_privilege
-- raises 42P01 on a name that resolves to nothing. Neither can quietly match
-- zero rows and call that a pass.
-- ---------------------------------------------------------------------------
do $$
declare
  missing_invoker text;
  absent_roles    text;
  still_open      text;
begin
  -- `coalesce(..., false) is not true`, not `<> true`: pg_options_to_table over a
  -- NULL reloptions yields no rows, so the scalar subquery is NULL, and
  -- `NULL <> true` is NULL -- which an `if` falls through, printing PASS for a
  -- view carrying no security_invoker option at all. Same NULL discipline as the
  -- `is distinct from` comparisons above, in the form the catalog needs.
  select string_agg(v.name || ' (reloptions=' ||
                    coalesce(c.reloptions::text, 'NULL') || ')',
                    ', ' order by v.name)
    into missing_invoker
  from unnest(array['pick_days', 'leaks_monthly',
                    'pnl_client_monthly', 'pnl_monthly',
                    'labour_variance_inputs']) as v(name)
  left join pg_class c on c.relname = v.name
                      and c.relnamespace = 'public'::regnamespace
  where coalesce((select o.option_value::boolean
                    from pg_options_to_table(c.reloptions) o
                   where o.option_name = 'security_invoker'), false) is not true;

  if missing_invoker is not null then
    raise exception 'FAIL: security_invoker is NOT set on: %. Those views run '
                    'with their OWNER''s privileges and read the RLS-protected '
                    'base tables with row level security bypassed. Re-apply '
                    'ledger_04_views.sql and read its notices. (reloptions=NULL '
                    'means the option is absent; a view missing from pg_class '
                    'entirely means the create never happened.)', missing_invoker;
  end if;
  raise notice 'PASS: security_invoker is set on all five views';

  -- Assert the roles EXIST before asking what they can read. has_table_privilege
  -- raises on an unknown role, and any formulation that swallowed that error
  -- would turn "the role is absent" into a silent pass -- the exact failure mode
  -- this block is written against. This is not an extra requirement:
  -- ledger_04_views.sql does `revoke ... from anon, authenticated`, which itself
  -- fails if either role is missing, so a database that applied that file has both.
  select string_agg(r.role, ', ' order by r.role) into absent_roles
  from unnest(array['anon', 'authenticated']) as r(role)
  where to_regrole(r.role) is null;

  if absent_roles is not null then
    raise exception 'FAIL: role(s) % do not exist, so the privilege assertion '
                    'below cannot be made and must not be reported as a pass. '
                    'ledger_04_views.sql revokes from both roles by name; if '
                    'this server has neither, that file was not applied here.',
                    absent_roles;
  end if;

  select string_agg(v.name || ' -> ' || r.role, ', ' order by v.name, r.role)
    into still_open
  from unnest(array['public.pick_days', 'public.leaks_monthly',
                    'public.pnl_client_monthly', 'public.pnl_monthly',
                    'public.labour_variance_inputs']) as v(name)
  cross join unnest(array['anon', 'authenticated']) as r(role)
  where has_table_privilege(r.role, v.name, 'SELECT');

  if still_open is not null then
    raise exception 'FAIL: SELECT is still granted: %. Every client''s margin is '
                    'readable with the public anon key. Re-apply the revoke block '
                    'in ledger_04_views.sql, and check whether `alter default '
                    'privileges` or an explicit grant elsewhere re-opened them.',
                    still_open;
  end if;
  raise notice 'PASS: neither anon nor authenticated can SELECT any of the five views';
end $$;

rollback;
