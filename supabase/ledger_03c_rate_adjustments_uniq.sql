-- Complete the ledger, migration 3c: constrain rate_adjustments.
-- Depends on ledger_03b_rate_adjustments_cleanup.sql having run (it is the
-- backfill that makes shipment_id non-null on the pre-existing rows, and this
-- index cannot be created while the duplicates it left behind are still there).
-- Safe to run more than once.

-- ---------------------------------------------------------------------------
-- Why this file exists.
--
-- src/lib/sync/shipstation.ts deduplicates rate adjustments in application
-- code: it selects (shipment_id, adjustment_amount) and inserts only when that
-- select comes back empty. Nothing in the schema backed that up -- before this
-- file rate_adjustments carried no index at all beyond its primary key -- so
-- the dedup was a check-then-act with no constraint underneath it.
--
-- That is a race, and the window is the few milliseconds between the sync
-- reading shipments.actual_cost and writing the updated cost back. Two
-- overlapping syncs both read the OLD cost, both compute the same diff, both
-- find no existing adjustment, and both insert. /api/agent/monitor declares
-- maxDuration = 300 and is polled every five minutes from every open browser
-- tab, so overlap is reachable rather than theoretical; the single-flight guard
-- in src/lib/monitor/single-flight.ts is a React ref and therefore dedupes
-- within ONE TAB only, not across tabs and not against the cron.
--
-- The duplicate does not heal. Once actual_cost has been updated the diff is 0
-- on every later run and the branch is never re-entered, so the pair sits there
-- for ever. It is money: src/lib/billing/calculator.ts sums
-- adjustment_amount where status = 'approved' into the client's weekly bill, so
-- an approved duplicate DOUBLE-BILLS the client, and ledger_04_views.sql's
-- carrier_rebills and voided_labels leaks sum it regardless of status.
--
-- THE INVARIANT IS NOT NEW. supabase/verify/ledger_03b_verify.sql query 2
-- already asserts that no (shipment_id, adjustment_amount) pair appears more
-- than once among rows where shipment_id is non-null, and raises an exception
-- when one does. So the uniqueness rule was declared in a verify script and
-- enforced racily in application code while the schema stayed silent about it.
-- This file moves it to the one place that cannot be raced.
-- ---------------------------------------------------------------------------

-- DELIBERATELY NOT PARTIAL, and it must stay that way. This is the third time
-- this trap appears on this branch -- see ledger_01_orders.sql:36-50 for
-- orders_client_order_key and ledger_03_charges.sql:257-270 for
-- order_charges_order_key -- so the reasoning is only summarised here.
--
-- A `where shipment_id is not null` predicate would be semantically FREE: NULLs
-- are distinct in SQL, so a shipment_id-null row is unconstrained by
-- unique (shipment_id, adjustment_amount) whether the predicate is written or
-- not. But PostgREST's on_conflict parameter emits a bare column list and never
-- an index predicate, so supabase-js
-- `.upsert(..., { onConflict: 'shipment_id,adjustment_amount' })` produces
-- `on conflict (shipment_id, adjustment_amount)` with no where clause, Postgres
-- cannot infer a partial index from that, and it raises 42P10 -- on every
-- adjustment, so ZERO adjustments would ever be written. A free predicate that
-- breaks the only writer is not free.
--
-- Which rows that leaves unconstrained: those with shipment_id null. The sync
-- cannot produce one -- the adjustment branch is inside `if (existingShipment)`
-- and reads existingShipment.id -- and ledger_03b's informational query reports
-- the remaining historical ones (ambiguous multi-shipment order numbers, and
-- orphans whose shipments row is gone). Those predate this constraint and are
-- not written by any live code path, so there is nothing to serialise for them.
--
-- The DO block, rather than a bare `create unique index if not exists`, is for
-- the failure case: the create fails if the table already holds a duplicate
-- pair, and a bare statement would fail with Postgres's own terse message and
-- no indication of what to do about it. The handler keeps the real sqlerrm and
-- adds the reconciliation query, because the person running this file is the
-- person who has to decide which of the two rows is the real adjustment.
--
-- Nothing is dropped here, so unlike the two files cited above this block needs
-- no subtransaction to protect a window -- there is no window. A failed create
-- leaves the table exactly as it was: unconstrained, as it has been all along.
do $$
begin
  create unique index if not exists rate_adjustments_shipment_amount_key
    on rate_adjustments (shipment_id, adjustment_amount);
exception when unique_violation then
  raise exception 'rate_adjustments already holds duplicate (shipment_id, '
                  'adjustment_amount) rows, so the unique index cannot be created (%). '
                  'Nothing has changed. Find them with: select shipment_id, '
                  'adjustment_amount, count(*), array_agg(id), array_agg(status) from '
                  'rate_adjustments where shipment_id is not null group by 1, 2 having '
                  'count(*) > 1; then delete the surplus row in each group -- keeping '
                  'any row whose status is ''approved'' or ''billed'' in preference to a '
                  '''pending'' one, since that is the row a bill may already have been '
                  'written from -- and re-run this file.', sqlerrm;
end $$;

-- Supporting index for the per-client reads. calculator.ts filters
-- rate_adjustments by (client_id, status, adjustment_date) when it builds a
-- weekly bill, and dashboard/page.tsx by (status). Neither is served by the
-- unique index above, whose leading column is shipment_id.
create index if not exists rate_adjustments_client_status_date_idx
  on rate_adjustments (client_id, status, adjustment_date);
