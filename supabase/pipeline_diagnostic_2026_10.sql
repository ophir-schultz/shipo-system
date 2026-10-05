-- WHERE IS THE PROFIT AND LOSS DATA? A read-only pipeline diagnostic.
--
-- Nothing here writes. Every part is a select; paste them one at a time.
--
-- WHY THIS EXISTS. order_charges has ZERO rows for September 2026 (confirmed
-- 2026-10-05), so pnl_monthly and pnl_client_monthly have nothing to aggregate
-- and the ledger's P&L is empty on the revenue side. That is not a bug in the
-- views -- they are correctly reporting that nothing was billed into them.
--
-- But there are TWO profit-and-loss mechanisms in this database, built at
-- different times, and only one of them is empty:
--
--   A. THE LEDGER (new).  orders -> order_charges -> pnl_monthly,
--      pnl_client_monthly. Revenue is order_charges.amount, direct cost is
--      order_charges.cost. Surfaced at /ledger. CONFIRMED EMPTY for Sept 2026.
--
--   B. PER-SHIPMENT (older).  shipments.client_rate (what the client was
--      billed), shipments.actual_cost (what the carrier charged),
--      shipments.profit_loss and shipments.is_loss. Surfaced at /pnl,
--      /losses, /dashboard, /billing, /reports. POPULATION UNKNOWN -- that is
--      what PART 2 settles.
--
-- So "why is it not showing where we are losing and profiting" may have the
-- answer "you are looking at the ledger page, and the data is on the shipment
-- pages". PART 2 and PART 3 decide that. If B has rows, you can answer the
-- question today, with the caveats in PART 4 -- which are not small.


-- ---------------------------------------------------------------------------
-- PART 1 -- is there any data at all? One row, the whole pipeline.
-- ---------------------------------------------------------------------------
select
  (select count(*) from clients)        as clients,
  (select count(*) from shipments)      as shipments_all_time,
  (select count(*) from orders)         as orders_all_time,
  (select count(*) from order_charges)  as order_charges_all_time,
  (select count(*) from operating_costs) as operating_costs_all_time,
  (select count(*) from sync_runs)      as sync_runs_all_time;

-- This is the single most informative query in the file. Read it as a chain:
--
-- shipments_all_time = 0 -> there is no shipment history anywhere. Nothing can
--   report profit, because no work has been recorded. The problem is upstream
--   of every view.
-- shipments > 0 but orders_all_time = 0 -> the ledger's own ingest never ran.
--   orders is a LEDGER table (ledger_01_orders.sql:22); shipments predates it.
--   So history exists in the old shape and was never carried into the new one.
-- orders > 0 but order_charges_all_time = 0 -> orders were ingested but never
--   priced. The charge-calculation step is the broken link, not the sync.
-- order_charges > 0 all-time but 0 for September -> the pipeline works and
--   simply has not run for this month.
--
-- operating_costs should be 4 if the retraction ran (rent, software, telecom,
-- bank_fees) or 5 if the understated labour row is still there.


-- ---------------------------------------------------------------------------
-- PART 2 -- does the OLDER per-shipment P&L have data? By month.
-- ---------------------------------------------------------------------------
select
  date_trunc('month', ship_date)::date            as month,
  count(*)                                        as shipments,
  count(client_rate)                              as have_client_rate,
  count(actual_cost)                              as have_actual_cost,
  count(profit_loss)                              as have_profit_loss,
  count(*) filter (where client_rate is null)     as missing_client_rate,
  count(*) filter (where actual_cost is null)     as missing_actual_cost
from shipments
group by 1
order by 1 desc
limit 18;

-- `count(col)` counts NON-NULL values, so have_* vs shipments is the
-- populated-ness of each column. This is the point of the query: a month with
-- 500 shipments and have_actual_cost = 12 cannot tell you anything about
-- profit, no matter what profit_loss says for those 12.
--
-- Read missing_actual_cost especially. A shipment billed but with no carrier
-- cost recorded is a shipment whose profit is UNKNOWN -- and if anything
-- downstream treats that as zero cost, it reads as pure profit.


-- ---------------------------------------------------------------------------
-- PART 3 -- the actual answer, if PART 2 showed the columns are populated.
-- ---------------------------------------------------------------------------
select
  date_trunc('month', ship_date)::date  as month,
  count(*)                              as shipments,
  sum(client_rate)                      as billed,
  sum(actual_cost)                      as carrier_cost,
  sum(client_rate) - sum(actual_cost)   as margin,
  count(*) filter (where is_loss)       as losing_shipments,
  sum(profit_loss) filter (where is_loss) as total_on_losers,
  round(
    100.0 * count(*) filter (where is_loss) / nullif(count(*), 0), 1
  )                                     as pct_losing
from shipments
where client_rate is not null
  and actual_cost is not null
group by 1
order by 1 desc
limit 18;

-- The WHERE clause is load-bearing and narrows the answer on purpose: this is
-- the margin over shipments where BOTH sides are known. Compare `shipments`
-- here against `shipments` in PART 2 for the same month -- the difference is
-- how much of the month this answer does not cover.
--
-- `nullif(count(*), 0)` guards the division; without it a month that somehow
-- grouped with zero rows would raise division_by_zero and lose every other row
-- in the result.
--
-- losing_shipments and pct_losing are the "where are we losing" answer at the
-- top level. PART 5 breaks it down.


-- ---------------------------------------------------------------------------
-- PART 4 -- CAVEAT CHECK. Can the numbers in PART 3 be trusted?
-- ---------------------------------------------------------------------------
-- Two of this project's own completed fixes were "stop the billing calculator
-- writing silent zeros" and "stop the live recalculate writing $0 and
-- wrong-band rates". Any profit_loss computed BEFORE those landed may have
-- been built on a zero that stood in for an unknown rate -- which inflates
-- margin. This looks for that signature.
select
  count(*) filter (where actual_cost = 0)                  as zero_actual_cost,
  count(*) filter (where client_rate = 0)                  as zero_client_rate,
  count(*) filter (where actual_cost = 0 and client_rate > 0) as free_to_ship,
  count(*) filter (where client_rate = 0 and actual_cost > 0) as billed_nothing,
  count(*) filter (where profit_loss = client_rate)        as profit_equals_revenue,
  min(ship_date)                                           as earliest,
  max(ship_date)                                           as latest
from shipments;

-- free_to_ship > 0 -> shipments billed to a client with a carrier cost of
--   exactly 0.00. A carrier does not move a parcel for nothing, so each of
--   these is almost certainly an unknown cost written as a zero, and each one
--   reads as 100% margin. This is the single most likely reason a P&L would
--   look better than reality.
-- profit_equals_revenue > 0 -> same thing seen from the other side: profit
--   equal to the full billed amount means cost contributed nothing.
-- billed_nothing > 0 -> work done and nothing charged. Real cost, no revenue.
--
-- A true zero is possible (a voided label, a credit) -- so these counts are a
-- prompt to look, not a verdict. But if free_to_ship is a large share of
-- shipments, PART 3's margin is an overstatement and should not be quoted.


-- ---------------------------------------------------------------------------
-- PART 5 -- WHERE, specifically. Worst clients, then worst services.
-- ---------------------------------------------------------------------------
select
  client_name,
  count(*)                                   as shipments,
  sum(client_rate)                           as billed,
  sum(actual_cost)                           as carrier_cost,
  sum(client_rate) - sum(actual_cost)        as margin,
  round(
    100.0 * (sum(client_rate) - sum(actual_cost)) / nullif(sum(client_rate), 0), 1
  )                                          as margin_pct,
  count(*) filter (where is_loss)            as losing_shipments
from shipments
where client_rate is not null
  and actual_cost is not null
  and ship_date >= date_trunc('month', current_date) - interval '3 months'
group by 1
order by margin asc
limit 25;

-- `order by margin asc` puts the biggest money-losers first, which is the
-- question being asked. margin_pct is there because a large client can show a
-- small positive margin that is worse per dollar than a small client's.
--
-- Then the same cut by carrier and service -- often the real cause, since a
-- client is only unprofitable because of the services they use:
--
--   select carrier, service, count(*) as shipments,
--          sum(client_rate) - sum(actual_cost) as margin,
--          count(*) filter (where is_loss)     as losing_shipments
--     from shipments
--    where client_rate is not null and actual_cost is not null
--      and ship_date >= date_trunc('month', current_date) - interval '3 months'
--    group by 1, 2
--    order by margin asc
--    limit 25;


-- ---------------------------------------------------------------------------
-- PART 6 -- why the LEDGER is empty. Did its pipeline ever run?
-- ---------------------------------------------------------------------------
select
  source,
  mode,
  status,
  count(*)              as runs,
  max(started_at)       as last_started,
  max(finished_at)      as last_finished,
  sum(rows_seen)        as rows_seen,
  sum(rows_written)     as rows_written
from sync_runs
group by 1, 2, 3
order by last_started desc nulls last
limit 25;

-- NO ROWS -> the ledger's sync has never run, which fully explains order_charges
--   being empty. The ledger is correct and starved, not broken.
-- rows_seen > 0 with rows_written = 0 -> it ran, saw work, and wrote nothing.
--   That is a real failure and the errors column will say why:
--     select source, mode, status, started_at, errors from sync_runs
--      where errors <> '[]'::jsonb order by started_at desc limit 20;
-- status stuck on an in-progress value with finished_at null -> a run died
--   mid-flight. "Close sync runs in a finally block" was fixed, so a stuck row
--   should predate that fix; a NEW one would mean it regressed.
--
-- THE POINT OF THIS PART: it separates "nobody pressed the button" from "the
-- button is broken". Those have completely different fixes, and guessing
-- between them is how weeks get spent on the wrong one.
