-- Map ShipStation stores to clients, so 343 orphaned shipments carrying
-- $11,276.54 of already-paid carrier cost can appear on a statement.
--
-- WHAT THE EVIDENCE WAS, measured 2026-10-15
-- ------------------------------------------
-- client_store_ids was EMPTY. All 1639 shipments carrying a store id were
-- unmapped across 11 stores, not the 8 the monitor reports -- the monitor
-- scans a 30-day window and the backlog is older than that. 990 of those
-- shipments had no client at all: $17,957.80 of carrier spend, zero revenue,
-- nothing priced, no zone resolved.
--
-- Neither evidence source expected to name the owners worked. Recipient names
-- are individual consumers, and no unmapped store shared an order-number shape
-- with a known client. What named them is that 649 of the shipments ALREADY
-- carried a client_id, attributed by some path other than the store id -- and
-- per store that attribution is unanimous across multiple months.
--
-- WHY THIS IS SAFE
-- ----------------
-- backfill_store_attribution_2026_10.sql:162 filters `where s.client_id is
-- null`, and that is load-bearing: the backfill only claims orphans and can
-- never move a shipment off a statement it already appears on. So a mapping
-- below cannot rewrite history -- it can only fill in the blanks and attribute
-- future syncs.
--
-- client_store_ids has a UNIQUE index on store_id ALONE
-- (ledger_01_orders.sql:17), so a store belongs to exactly one client and a
-- second insert for the same store FAILS rather than creating an ambiguity.
-- That is the behaviour we want. Do NOT add an ON CONFLICT.

-- ===========================================================================
-- SECTION 0 -- DRY RUN. Run this FIRST and read it.
-- ===========================================================================
-- The insert in section 1 joins on btrim(clients.name). A name that does not
-- match inserts NOTHING for that store, silently -- and a trailing space in
-- clients.name has already caused exactly that failure in a rate-card script.
-- So the match is proved before anything is written.
--
-- Expect: 7 rows, every one with clients_matched = 1 and already_mapped = 0.
-- Any 0 in clients_matched is a name that needs fixing before section 1.
-- Any 1 in already_mapped means someone has mapped that store since this file
-- was written, and section 1 will FAIL on the unique index -- which is correct.
select
  v.store_id,
  v.client_match,
  (select count(*) from clients c where btrim(c.name) = v.client_match)      as clients_matched,
  (select count(*) from clients c where btrim(c.name) = v.client_match
                                    and c.active)                            as of_which_active,
  (select count(*) from client_store_ids x where x.store_id = v.store_id)    as already_mapped
from (values
  ('337203', 'Suteka'),
  ('343386', 'Orcam'),
  ('342775', 'SitnStand'),
  ('348161', 'Creative Pea'),
  ('349265', 'Time Systems (UK) Ltd'),
  ('344458', 'Crisp Power'),
  ('350349', 'Nayax')
) as v(store_id, client_match)
order by v.store_id;


-- ===========================================================================
-- SECTION 1 -- the mappings. One statement, so it is all-or-nothing.
-- ===========================================================================
-- Six of these are unanimous: 100% of the store's attributed shipments point
-- at one client, across 2 to 6 distinct months. The seventh is Nayax and is
-- argued separately below.
--
--   337203 -> Suteka                 232/232 attributed, 5 months, claims 11
--   343386 -> Orcam                  114/114 attributed, 6 months, claims 4
--   342775 -> SitnStand               81/81  attributed, 2 months, claims 3
--   348161 -> Creative Pea            28/28  attributed, 3 months, claims 13
--   349265 -> Time Systems (UK) Ltd   17/17  attributed, 3 months, claims 0
--   344458 -> Crisp Power              5/5   attributed, 2 months, claims 0
--
-- The last two claim nothing today. They are mapped anyway so that the next
-- sync attributes itself instead of adding to the orphan pile.
--
-- 350349 -> NAYAX. 313 shipments, ONE attributed. A single row is normally an
-- anecdote, not evidence, and this one carries $10,535.77 -- so it is argued
-- on the order numbers instead. 311 of the 313 orders are an `SO`-prefixed
-- 9-digit series (SO601058313, SO601061037) that appears NOWHERE ELSE in all
-- 1639 shipments. One uniform series across a whole store is one ERP, which is
-- one client; the single attributed row names which; and Nayax is an active
-- freight client currently holding exactly one shipment, which is the same
-- fact seen from the other side. Three independent readings, one answer.
--
-- This is also the mapping that makes this morning's work pay: the 800-cell
-- ICL zone card is loaded and verified, can_resolve_zone = YES, and it has
-- almost nothing to price until these 312 shipments reach Nayax.
insert into client_store_ids (client_id, store_id, store_name)
select c.id, v.store_id, v.store_name
from (values
  ('337203', 'Suteka',                'Suteka'),
  ('343386', 'Orcam',                 'Orcam'),
  ('342775', 'SitnStand',             'SitnStand'),
  ('348161', 'Creative Pea',          'Creative Pea'),
  ('349265', 'Time Systems (UK) Ltd', 'Time Systems (UK)'),
  ('344458', 'Crisp Power',           'Crisp Power'),
  ('350349', 'Nayax',                 'Nayax')
) as v(store_id, client_match, store_name)
join clients c on btrim(c.name) = v.client_match;


-- ===========================================================================
-- SECTION 2 -- VERIFY. "Success" means nothing here; read the rows.
-- ===========================================================================
-- Expect 7 rows, each with a client name, and orphans_it_will_claim matching
-- the counts in section 1's comment. A missing store_id is a name that did not
-- match -- section 0 should have caught it, and this is the second net.
select
  csi.store_id,
  csi.store_name,
  c.name                                                   as client,
  c.active,
  -- What the backfill will claim when it runs. This is the number that turns
  -- into revenue, and it is counted the same way the backfill counts it.
  (select count(*) from shipments s
    where s.client_id is null
      and nullif(trim(coalesce(
            s.raw_data -> 'advancedOptions' ->> 'storeId',
            s.raw_data ->> 'storeId')), '') = csi.store_id) as orphans_it_will_claim,
  -- Summed with no coalesce: a null cost is UNKNOWN, not zero.
  (select round(sum(s.actual_cost), 2) from shipments s
    where s.client_id is null
      and nullif(trim(coalesce(
            s.raw_data -> 'advancedOptions' ->> 'storeId',
            s.raw_data ->> 'storeId')), '') = csi.store_id) as cost_it_will_claim
from client_store_ids csi
join clients c on c.id = csi.client_id
order by 5 desc nulls last;


-- ===========================================================================
-- SECTION 3 -- then run the backfill
-- ===========================================================================
-- Nothing above touches shipments. Run
-- supabase/backfill_store_attribution_2026_10.sql to attach the shipments
-- already in the table; new ones attribute themselves on sync.
--
-- After that, Nayax's 312 shipments still need a RECALCULATION before the zone
-- card prices them -- attribution and pricing are separate steps, and
-- with_zone = 0 on every one of these rows today.


-- ===========================================================================
-- DELIBERATELY NOT MAPPED -- four stores, and why each one is held back
-- ===========================================================================
--
-- 326718 -> Kivema?  705 shipments, 534 orphans, $5,475.91. THE BIGGEST
--   REMAINING ITEM. Attribution splits Kivema 157 / Creative Pea 14, and the
--   monthly shape says Kivema: Kivema runs continuously 2026-05..2026-10,
--   Creative Pea appears only in the week of 2026-08-10 and has its own store
--   (348161). But 326718 shows 17 rows shaped '##-#' and that is exactly the
--   form Creative Pea uses on its own store (#1609-3, #1620-4). 17 rows of a
--   shape, 14 Creative Pea rows. If those are the same rows, Creative Pea's
--   traffic here is fully attributed already and every orphan is Kivema's. If
--   they are not, order number does not separate the two clients and some of
--   the 534 may be Creative Pea's. scripts/probe-326718-split.mjs answers
--   exactly that. $5.4k is enough to check rather than assume.
--
--   When it comes back clean:
--     insert into client_store_ids (client_id, store_id, store_name)
--     select c.id, '326718', 'Kivema' from clients c
--      where btrim(c.name) = 'Kivema';
--
-- 202015 -> CANNOT BE MAPPED AT ALL. 21 shipments, $319.49, no order numbers,
--   and the recipient names self-identify TWO different clients:
--     SHIPO LLC - SUTEKA (#S7143)        SHIPO LLC - SITNSTAND (RET-2026-152)
--     SHIPO LLC - SUTEKA (Return #S7160) SHIPO LLC - SITNSTAND (RET-2026-144)
--   This is the RETURNS store, shared. One store id, several clients' returns.
--   The UNIQUE index on store_id means client_store_ids structurally cannot
--   express it, and mapping it to either client would put the other's returns
--   on the wrong statement. These need per-shipment attribution off the
--   recipient name, which is a different mechanism and a separate change.
--   Leaving it unmapped is the correct outcome, not an omission.
--
-- 166519 -> UNKNOWN. 91 shipments, $878.13, zero attributed, and an order
--   series (1364..1676, 4 digits) shared with nobody. One row reads
--   '##-# (Hexa)'. "Hexa" is the only lead in the data and it is not the name
--   of any client on file -- so this may be a client with no record at all.
--   Needs a human who knows the account; no query will name it.
--
-- 352718 -> UNKNOWN, and not worth the risk. 1 shipment, $7.73, order 103996.
--   That number sits inside a 103888..104646 band shared by Orcam, SitnStand,
--   Time Systems and Crisp Power, so the order number cannot discriminate. One
--   shipment is not worth a guess that a UNIQUE index makes permanent.
