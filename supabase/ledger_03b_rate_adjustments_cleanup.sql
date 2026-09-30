-- Complete the ledger, migration 3b: backfill rate_adjustments.shipment_id.
-- Spec: docs/superpowers/specs/2026-09-29-complete-the-ledger-design.md §3.2
-- Depends only on the base schema: rate_adjustments.shipment_id,
-- rate_adjustments.order_number, shipments.id and shipments.order_number all
-- exist in supabase/schema.sql. It does NOT need ledger_03_charges.sql — the
-- join below goes through order_number, not shipstation_shipment_id.
-- Safe to run more than once.

-- ---------------------------------------------------------------------------
-- Why this file exists.
--
-- Task 10 changed the dedup key used when matching an existing rate_adjustments
-- row. The old code matched on (order_number, adjustment_amount); the new code
-- matches on (shipment_id, adjustment_amount) where shipment_id is the UUID
-- primary key of the shipments table. Consequence: on the first run of the new
-- code, every pre-existing rate_adjustments row fails the lookup (the
-- shipment_id column was null because the old code never set it), so a
-- duplicate row is inserted alongside it. The original row then sits with
-- shipment_id = null forever, and both rows count toward the client's ledger.
--
-- This migration backfills shipment_id on existing rows so that the new
-- dedup logic finds them instead of inserting beside them.
--
-- Join path: rate_adjustments.order_number → shipments.order_number → shipments.id.
-- Ambiguity risk: order_number is NOT unique in shipments (multi-package orders
-- and reships repeat the same number). We backfill only when exactly one
-- shipments row carries that order_number. Rows with zero or multiple matches
-- are left alone with a comment below explaining why. A partial backfill is
-- safer than a wrong one: an unbackfilled row triggers one duplicate insert on
-- the next sync run, which is a bounded, visible problem; a wrong assignment
-- ties the adjustment to the wrong shipment, which corrupts the ledger silently.
-- ---------------------------------------------------------------------------

update rate_adjustments ra
set    shipment_id = s.id
from   shipments s
where  ra.shipment_id is null
  and  ra.order_number = s.order_number
  -- Only backfill when the order_number resolves to exactly one shipment.
  -- If multiple shipments share the order_number we cannot know which one
  -- triggered the adjustment, so we leave those rows alone.
  and  (
         select count(*)
         from   shipments s2
         where  s2.order_number = ra.order_number
       ) = 1;

-- Rows left with shipment_id null after the update are either:
--   a) orders with multiple shipments (ambiguous join — intentionally skipped)
--   b) orders whose shipments row was deleted (orphaned adjustment — unfixable)
-- Both categories are visible in ledger_03b_verify.sql query 1.
