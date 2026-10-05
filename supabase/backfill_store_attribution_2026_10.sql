-- Attribute the 599 unattributed shipments from their ShipStation store.
--
-- READ THIS FIRST. Only PART 2 writes. Everything else is a select, and PART 2
-- is the only statement in this file that cannot be undone by re-running it.
--
-- THE SUPABASE EDITOR SHOWS ONLY THE LAST STATEMENT'S RESULT when you paste a
-- batch. Paste one PART at a time. Pasting the file whole would run the UPDATE
-- and show you PART 3, which is the one shape of mistake this file exists to
-- avoid.
--
-- PREREQUISITE: client_store_ids must be populated first. Run
-- supabase/store_mapping_worklist_2026_10.sql, answer its
-- 'NEEDS A HUMAN ANSWER' stores, and insert the mappings. With that table
-- empty this file is a no-op that correctly reports attributing nothing.
--
-- THE RULE, which is the same one src/lib/sync/store-attribution.ts applies to
-- live shipments, deliberately: a shipment that already has a client_id is
-- never touched. 291 of the 890 rows were attributed by hand, and overwriting
-- one would move a real invoice from one client to another with no record that
-- it moved. Where the store map disagrees with a stored attribution, PART 1
-- lists it and PART 2 skips it.
--
-- WHAT THIS DOES NOT DO, and it matters because $8,980.99 is the number
-- attached to this work: attributing a shipment does not bill it. It makes the
-- shipment addressable to a client, which is the precondition for everything
-- else -- a rate card lookup, a zone, a client_rate, an order_charges row. A
-- shipment attributed here with no rate card for its carrier/service is still
-- unbilled afterwards, and will show up in the unpriced reports instead of the
-- unattributed ones. That is progress, not revenue.
--
-- Nor does it recover the rate adjustments. src/lib/sync/shipstation.ts gates
-- the rate_adjustments write on `existingShipment.client_id`, so every refund
-- and void that landed on these 599 shipments was discarded at the time. That
-- history exists only on ShipStation's side; attribution does not recreate it.


-- ---------------------------------------------------------------------------
-- PART 0 -- what this file is about to do, before it does anything.
-- ---------------------------------------------------------------------------
-- Read-only. One row per client that would gain shipments, plus a row for
-- every bucket that would NOT be attributed, so the unattributable remainder
-- is visible in the same result rather than inferred from a subtraction.
with sh as (
  select
    s.id,
    s.client_id,
    s.actual_cost,
    s.client_rate,
    s.ship_date,
    nullif(trim(coalesce(
      s.raw_data -> 'advancedOptions' ->> 'storeId',
      s.raw_data ->> 'storeId'
    )), '') as store_id
  from shipments s
),
j as (
  select
    sh.*,
    csi.client_id as mapped_client_id
  from sh
  left join client_store_ids csi on csi.store_id = sh.store_id
)
select
  case
    when j.client_id is not null and j.mapped_client_id is null
      then 'already attributed, store unmapped'
    when j.client_id is not null and j.mapped_client_id::text = j.client_id::text
      then 'already attributed, store agrees'
    when j.client_id is not null
      then 'CONFLICT -- stored attribution differs from the store map'
    when j.store_id is null
      then 'unattributable here -- no store id on the label'
    when j.mapped_client_id is null
      then 'blocked -- store has no row in client_store_ids'
    else 'WOULD ATTRIBUTE'
  end                                                   as outcome,
  coalesce(c.name, '<unmapped>')                        as client,
  count(*)                                              as shipments,
  sum(j.actual_cost)                                    as carrier_cost,
  count(j.client_rate)                                  as already_billed,
  min(j.ship_date)::date                                as oldest,
  max(j.ship_date)::date                                as newest
from j
left join clients c
  on c.id = coalesce(j.client_id, j.mapped_client_id)
group by 1, 2
order by 1, sum(j.actual_cost) desc nulls last;

-- HOW TO READ IT.
--
-- 'WOULD ATTRIBUTE' with a client name and a carrier_cost: that is the work.
--   The carrier_cost column is the spend that becomes addressable, NOT the
--   invoice -- see the note at the top of the file.
-- 'blocked -- store has no row in client_store_ids': one INSERT per store
--   fixes every shipment from it. These are the highest-leverage rows and the
--   reason the worklist runs first.
-- 'unattributable here -- no store id on the label': the ceiling on this whole
--   method. No SQL can attribute these; someone has to identify them in
--   ShipStation. If most of the money sits in this bucket, the mapping table
--   is not the answer and it is better to find that out now.
-- 'CONFLICT': stop. The store map and a stored attribution name different
--   clients, and one of them is wrong. ledger_01_orders.sql:8 states the
--   invariant -- one store belongs to exactly one client -- so a conflict means
--   either the mapping row is wrong or the hand attribution was. PART 1 names
--   the rows. PART 2 leaves them alone either way.


-- ---------------------------------------------------------------------------
-- PART 1 -- name the conflicts, if PART 0 showed any.
-- ---------------------------------------------------------------------------
-- Read-only. Skip this if PART 0 showed no CONFLICT row.
--
-- Per shipment, not per client: resolving a conflict means looking at an actual
-- order and deciding which client sent it, so the order number and tracking
-- number are the point of the query.
with sh as (
  select
    s.id, s.client_id, s.order_number, s.tracking_number, s.ship_date,
    s.actual_cost, s.carrier, s.service,
    nullif(trim(coalesce(
      s.raw_data -> 'advancedOptions' ->> 'storeId',
      s.raw_data ->> 'storeId'
    )), '') as store_id
  from shipments s
  where s.client_id is not null
)
select
  sh.store_id,
  stored.name                            as stored_client,
  mapped.name                            as store_map_says,
  sh.order_number,
  sh.tracking_number,
  sh.ship_date::date                     as ship_date,
  -- concat_ws, not ||: a null carrier or service would make the whole
  -- expression null and blank out the one column that says what was shipped.
  concat_ws(' / ', sh.carrier, sh.service) as service,
  sh.actual_cost
from sh
join client_store_ids csi on csi.store_id = sh.store_id
join clients stored on stored.id = sh.client_id
join clients mapped on mapped.id = csi.client_id
where csi.client_id::text <> sh.client_id::text
order by sh.store_id, sh.ship_date desc;


-- ---------------------------------------------------------------------------
-- PART 2 -- THE WRITE. The only statement in this file that changes a row.
-- ---------------------------------------------------------------------------
-- Run this only after PART 0's 'WOULD ATTRIBUTE' rows are the ones you expect
-- and PART 1 is empty or understood.
--
-- `where s.client_id is null` is load-bearing and is the whole safety property
-- of this statement. It is what makes the file re-runnable -- a second run
-- attributes nothing because there is nothing left unattributed -- and it is
-- what makes a wrong mapping row recoverable: a bad row attributes shipments
-- that were previously null, which PART 3 shows and which can be set back to
-- null. Without it, a bad mapping would overwrite 291 hand-attributed rows and
-- the previous values would be gone.
--
-- The join is an inner join on client_store_ids, so a store with no mapping
-- contributes no rows. That is the same refusal the application makes: an
-- unmapped store is UNKNOWN, and writing a guess would be worse than leaving
-- the shipment unattributed, because an unattributed shipment is visibly
-- missing and a wrongly attributed one is invisibly on someone's invoice.
--
-- update shipments s
--    set client_id = csi.client_id
--   from client_store_ids csi
--  where s.client_id is null
--    and csi.store_id = nullif(trim(coalesce(
--          s.raw_data -> 'advancedOptions' ->> 'storeId',
--          s.raw_data ->> 'storeId'
--        )), '');
--
-- Commented out on purpose. Uncomment the five lines, run them, and read the
-- row count against PART 0's 'WOULD ATTRIBUTE' total -- they must agree. If
-- the UPDATE touched MORE rows than PART 0 predicted, something changed
-- between the two runs and the right response is PART 3 before anything else.


-- ---------------------------------------------------------------------------
-- PART 3 -- what is left, after.
-- ---------------------------------------------------------------------------
-- Read-only, and worth running whether or not PART 2 ran: before, it is the
-- baseline; after, it is the result. The two differences that matter are
-- `unattributed` falling and `cost_on_unattributed` falling with it.
select
  count(*)                                                     as shipments,
  count(*) filter (where s.client_id is null)                  as unattributed,
  sum(s.actual_cost) filter (where s.client_id is null)         as cost_on_unattributed,
  count(*) filter (where s.client_id is not null
                     and s.client_rate is null)                as attributed_but_unpriced,
  sum(s.actual_cost) filter (where s.client_id is not null
                     and s.client_rate is null)                as cost_on_unpriced,
  count(*) filter (where s.client_id is null
                     and nullif(trim(coalesce(
                           s.raw_data -> 'advancedOptions' ->> 'storeId',
                           s.raw_data ->> 'storeId')), '') is null)
                                                               as still_no_store_id,
  count(s.client_rate)                                          as billed
from shipments s;

-- attributed_but_unpriced is the column to watch, and it should RISE when
-- PART 2 runs. That is not a regression -- it is the same shipments moving
-- from "nobody owns this" to "someone owns this and we have not priced it",
-- which is the next piece of work and a different one: a carrier/service with
-- no cell in client_zone_rates cannot produce a client_rate no matter who the
-- shipment belongs to. See supabase/rate_card_rescope_2026_10.sql.
--
-- still_no_store_id does NOT move. Nothing in this file can attribute a label
-- that carries no store key, and if that number is large it is the honest
-- answer to "why is the money still unbilled" rather than a gap in the method.
