-- Map store 326718 to Kivema. 535 orphans, $5,494.04 of already-paid carrier
-- cost that cannot appear on any statement until this runs.
--
-- This store was deliberately HELD BACK by store_mapping_2026_10_15.sql
-- because its attribution split Kivema 157 / Creative Pea 14. This file
-- records what resolved that, including the part that is an accepted risk
-- rather than a proof.
--
-- WHAT THE EVIDENCE SAYS
-- ---------------------
-- 1. The monthly shape says Kivema. Kivema runs continuously 2026-05..2026-10.
--    Creative Pea appears only in the week 2026-08-10..2026-08-17 and has its
--    own store (348161).
--
-- 2. The original suspicion was WRONG, and in Kivema's favour. 326718 shows 17
--    rows shaped '##-#', which is the form Creative Pea uses on its own store
--    (#1609-3, #1620-4). Those 17 rows are Kivema=12 / orphan=5 /
--    Creative Pea=0. The shape is Kivema's here.
--
-- 3. The 4-digit population is Kivema's counter. On THIS store the 4-digit
--    rows are Kivema=12 (1600..1643) and orphan=169 (1628..2115) -- the two
--    ranges OVERLAP inside one store, so attributed and unattributed rows
--    interleave in the same number band. That is one counter, not two.
--    Creative Pea has ZERO 4-digit rows on 326718; its 4-digit orders
--    (1588..1637) are all on 348161. So 169 orphans / $1,752.41 are Kivema's.
--
-- 4. The 4-digit series is NOT shared across stores. Suteka runs 6147..7396,
--    SitnStand 2475..2535 -- both cleanly disjoint. The "one ERP counter
--    spanning several stores" theory is dead.
--
-- WHAT IS NOT PROVED -- the accepted risk
-- ---------------------------------------
-- The 6-digit population cannot be separated. 361 orphans / $3,687.24, and
-- BOTH clients have 6-digit rows here (Kivema 145, Creative Pea 14). No shape,
-- band or carrier distinguishes them -- Creative Pea's values are a strict
-- SUBSET of Kivema's, so the discriminating test returned "indistinguishable",
-- which is not the same as "clean".
--
-- If the orphans split the way the attributed rows do (14/159 = 8.8%), then
-- roughly 32 shipments / ~$325 of Creative Pea freight will land on Kivema's
-- statement. It concentrates in August: Creative Pea's window is 2026-08-10..
-- 08-17 and 161 of the orphans shipped that month.
--
-- This is mapped anyway because Ophir confirmed 2026-10-19 that the August
-- week was a ONE-OFF that will not recur. That is the fact the data could not
-- supply. Section 3 below lists the rows to eyeball if the ~$325 matters.
--
-- WHY THIS IS SAFE TO RUN
-- -----------------------
-- backfill_store_attribution_2026_10.sql:162 filters `where s.client_id is
-- null`. The backfill only claims orphans -- it can never move a shipment off
-- a statement it already appears on. So this cannot rewrite history, and the
-- 157 rows already attributed to Kivema and the 14 already attributed to
-- Creative Pea all stay exactly where they are. Creative Pea's August rows
-- that are ALREADY attributed are not at risk; only unattributed ones are.
--
-- client_store_ids has a UNIQUE index on store_id ALONE (ledger_01_orders.sql
-- :17), so this insert FAILS if 326718 is already mapped. Do NOT add an
-- ON CONFLICT -- a failure here is the correct outcome.

-- ===========================================================================
-- SECTION 0 -- DRY RUN. Run this FIRST and read it.
-- ===========================================================================
-- Expect ONE row: clients_matched = 1, of_which_active = 1, already_mapped = 0.
-- clients_matched = 0 means the name does not match and section 1 would insert
-- NOTHING, silently -- a trailing space in clients.name has caused exactly
-- that before. already_mapped = 1 means someone mapped it since this was
-- written, and section 1 will fail on the unique index, which is correct.
select
  '326718'                                                                as store_id,
  'Kivema'                                                                as client_match,
  (select count(*) from clients c where btrim(c.name) = 'Kivema')         as clients_matched,
  (select count(*) from clients c where btrim(c.name) = 'Kivema'
                                    and c.active)                         as of_which_active,
  (select count(*) from client_store_ids x where x.store_id = '326718')   as already_mapped;


-- ===========================================================================
-- SECTION 1 -- the mapping
-- ===========================================================================
insert into client_store_ids (client_id, store_id, store_name)
select c.id, '326718', 'Kivema'
from clients c
where btrim(c.name) = 'Kivema';


-- ===========================================================================
-- SECTION 2 -- VERIFY. "Success" means nothing. Read the row.
-- ===========================================================================
-- Expect ONE row naming Kivema, with orphans_it_will_claim near 535 and
-- cost_it_will_claim near 5494.04 (both drift upward as new orders sync).
-- Counted the same way the backfill counts, so this is a true preview.
select
  csi.store_id,
  csi.store_name,
  c.name                                                   as client,
  c.active,
  (select count(*) from shipments s
    where s.client_id is null
      and nullif(trim(coalesce(
            s.raw_data -> 'advancedOptions' ->> 'storeId',
            s.raw_data ->> 'storeId')), '') = csi.store_id) as orphans_it_will_claim,
  -- No coalesce: a null cost is UNKNOWN, not zero.
  (select round(sum(s.actual_cost), 2) from shipments s
    where s.client_id is null
      and nullif(trim(coalesce(
            s.raw_data -> 'advancedOptions' ->> 'storeId',
            s.raw_data ->> 'storeId')), '') = csi.store_id) as cost_it_will_claim
from client_store_ids csi
join clients c on c.id = csi.client_id
where csi.store_id = '326718';


-- ===========================================================================
-- SECTION 3 -- the accepted risk, made reviewable
-- ===========================================================================
-- Run this AFTER the backfill. These are the rows most likely to be Creative
-- Pea's: 6-digit order numbers on 326718, shipped inside Creative Pea's known
-- window, now sitting on Kivema. Roughly 32 rows / ~$325 is the modelled
-- exposure. If any of them are Creative Pea's, reassign the SHIPMENT -- do not
-- touch the store mapping, which is correct for the store as a whole.
--
-- Returns zero rows if the backfill has not run yet. That is expected.
select
  s.id,
  s.order_number,
  s.ship_date,
  s.carrier,
  s.actual_cost,
  c.name as currently_billed_to
from shipments s
join clients c on c.id = s.client_id
where nullif(trim(coalesce(
        s.raw_data -> 'advancedOptions' ->> 'storeId',
        s.raw_data ->> 'storeId')), '') = '326718'
  and btrim(c.name) = 'Kivema'
  and s.ship_date >= date '2026-08-10'
  and s.ship_date <= date '2026-08-17'
  -- 6-digit leading number: the population that cannot be separated. The
  -- 4-digit rows are Kivema's counter and are deliberately excluded.
  and length((regexp_match(s.order_number, '(\d+)'))[1]) = 6
order by s.ship_date, s.order_number;


-- ===========================================================================
-- SECTION 4 -- then run the backfill, then RECALCULATE
-- ===========================================================================
-- Nothing above touches shipments. Run
-- supabase/backfill_store_attribution_2026_10.sql to attach the rows already
-- in the table; new ones attribute themselves on sync.
--
-- Attribution is not pricing. These rows arrive with with_zone unset and will
-- show revenue 0 against real cost until a recalculation runs. A zero here
-- means "not priced yet", not "no margin".
