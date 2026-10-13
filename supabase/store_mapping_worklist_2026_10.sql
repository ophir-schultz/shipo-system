-- BUILDING THE STORE -> CLIENT MAPPING FROM EVIDENCE. Read-only except PART 5,
-- which is inert until PART 3 comes back clean.
--
-- THE DEFECT THIS SERVES. 599 of 890 shipments carry no client_id at all --
-- $8,980.99 of carrier spend, 94% of everything unbilled, from 2026-07-07 to
-- 2026-10-03. The cause was in src/lib/sync/shipstation.ts: the `shipmentData`
-- object it upserts ran from shipstation_shipment_id to raw_data and had NO
-- client_id KEY. So an unattributed shipment was not an edge case, it was the
-- DEFAULT, and the 291 attributed rows are hand-fixed exceptions. The comment
-- in scripts/probe-store-client-gap.mjs:5 names the original intent -- "for now
-- match by order source" -- and the matching was never built then.
--
-- IT IS BUILT NOW, and the 599 are the history it was built too late for. The
-- sync reads this mapping table on every pass, so the table being empty is what
-- leaves today's labels unattributed -- not missing code. PART 6 has the
-- specifics and PART 4 counts the rows.
--
-- A shipment with no client_id reaches no client's rate card, so none of the
-- rate-card work in rate_card_rescope_2026_10.sql touches these 599.
--
-- WHY NOT MATCH ON NAME. scripts/probe-store-client-gap.mjs:63 pairs a store to
-- a client with
--
--     nm.toLowerCase().includes(c.toLowerCase()) || c.toLowerCase().includes(nm)
--
-- which is a substring guess on a display name. For a diagnostic that is fine.
-- For writing client_id onto 599 shipments that become invoices it is not: the
-- failure mode is billing one client for another client's parcels, and it would
-- look completely normal on the invoice.
--
-- WHAT THIS USES INSTEAD. Two facts already in the database:
--
--   1. The sync stores the whole ShipStation payload as `raw_data: s`, so
--      advancedOptions.storeId is on all 890 rows, all-time -- no API call, no
--      30-day window.
--   2. THE 291 ATTRIBUTED SHIPMENTS ARE A TRAINING SET. Somebody set those
--      client_ids by hand. Any store_id that appears among them against ONE
--      consistent client is a mapping that was already verified by a human; it
--      is being read back out, not invented.
--
-- Store IDs that appear ONLY among the 599 have no such evidence and need a
-- human answer. PART 2 is the list to answer, with sample order numbers so the
-- question is answerable by someone who knows the business rather than the
-- store IDs.
--
-- THE INVARIANT THAT MAKES PART 3 MANDATORY. ledger_01_orders.sql:8 says it:
--
--     One ShipStation store belongs to exactly one client. The unique index is
--     on store_id alone, not (client_id, store_id): the whole point is that a
--     store cannot map two ways.
--
-- So if any store_id points at two clients in the attributed history, that
-- invariant is ALREADY violated in the data, and the correct response is to
-- stop and find out why -- not to pick the more common one.
--
-- THE STORE ID IS READ THE SAME WAY IN THREE PLACES, and it has to stay that
-- way. storeIdOf() in src/lib/sync/store-attribution.ts is the live rule: it
-- prefers advancedOptions.storeId, falls back to a top-level storeId, TRIMS,
-- and answers null for the empty string. backfill_store_attribution_2026_10.sql
-- matches it with nullif(trim(coalesce(...)), ''). This file did NOT -- every
-- extraction here was a bare coalesce, with no trim and no ''-to-null.
--
-- That is not cosmetic, because PART 5 WRITES. A bare coalesce would have
-- inserted a client_store_ids row keyed on ' 900 ' or on '', and storeIdOf
-- trims and nullifs before it looks the store up, so neither key can ever
-- match: the '' row is unreachable because storeIdOf returns null and the map
-- is never consulted at all, and the ' 900 ' row is missed because the live
-- lookup asks for '900'. Either way the mapping reads as done and attributes
-- nothing, for ever, with no error anywhere -- the sync would go on counting
-- those shipments as unmapped-store while the table says they are handled.
--
-- The read-only parts had a quieter version of the same fault: ' 900 ' and
-- '900' group as two different stores, which splits one store's hand-attributed
-- evidence across two rows and can turn a confident mapping into two thin ones.
--
-- All seven extractions below are now nullif(trim(coalesce(...)), ''). If you
-- change one, change storeIdOf and the backfill in the same pass.
--
-- NO DDL. PART 1-4 are select-only. PART 5 inserts into client_store_ids only
-- and is commented out.
--
-- RUN ONE PART AT A TIME. The Supabase SQL editor returns the result of the
-- LAST statement in a batch, so pasting several parts together shows the final
-- grid and silently discards the rest. PART 2 is the one that matters and it is
-- a single statement.


-- ===========================================================================
-- PART 0 -- THE WORKLIST AND ITS PRECONDITION, ONE QUERY, FIVE COLUMNS.
-- ===========================================================================
-- Read-only. Run this ONE statement and send back the whole grid. It replaces
-- PART 1 and PART 2 for practical purposes; both are kept below because each
-- reads better alone, but the editor only shows the last statement of a batch.
--
-- IT ANSWERS PART 1 WITHOUT A SEPARATE QUERY: the row whose store reads
-- `<no store>` IS the coverage answer. Its `unattr` figure is the portion of
-- the $8,980.99 that has neither a client nor a store to derive one from --
-- shipments no SQL can attribute, which need a human reading tracking numbers
-- in ShipStation. If that row carries most of the money, this whole approach
-- has a low ceiling and it is better to know that before answering anything.
--
-- CONFLICT DETECTION IS INLINE, not deferred to PART 3: a store that points at
-- two clients is reported as `CONFLICT: A + B` in the derived column rather
-- than being collapsed to whichever appeared more often.
-- ledger_01_orders.sql:8 is explicit that a store cannot map two ways, so a
-- conflict means that invariant is ALREADY violated in the data. It is not a
-- tie to be broken.
with s as (
  select sh.client_id, sh.actual_cost, sh.client_rate, sh.ship_date,
         sh.order_number,
         nullif(trim(coalesce(sh.raw_data -> 'advancedOptions' ->> 'storeId',
                  sh.raw_data ->> 'storeId')), '') as store_id
    from shipments sh
),
-- The training set: store -> client, ONLY from rows a human already attributed
-- by hand. Nothing here is derived from a display name.
trained as (
  select store_id, client_id, count(*) as n
    from s
   where client_id is not null and store_id is not null
   group by 1, 2
),
ta as (
  select store_id, count(*) as dc, sum(n) as rows_
    from trained group by 1
)
select
  coalesce(s.store_id, '<no store>')                        as store,
  count(*)::text                                            as n,
  'unattr ' || count(*) filter (where s.client_id is null)
    || '  cost ' || coalesce(
         sum(s.actual_cost) filter (where s.client_id is null), 0)
    || '  billed ' || count(s.client_rate)
    || '  ' || min(s.ship_date)::date || '..' || max(s.ship_date)::date
                                                            as detail,
  case
    when ta.store_id is null then 'NEEDS A HUMAN ANSWER'
    when ta.dc > 1 then 'CONFLICT: ' || (
      select string_agg(c.name, ' + ')
        from trained t join clients c on c.id = t.client_id
       where t.store_id = s.store_id)
    else (
      select c.name from trained t join clients c on c.id = t.client_id
       where t.store_id = s.store_id limit 1)
      || ' (' || ta.rows_ || ' rows)'
  end                                                       as derived_client,
  -- Two real order numbers, because a bare 350349 is not a question anyone can
  -- answer from memory and a derived name still deserves a sanity check.
  (select string_agg(x.order_number, ', ')
     from (select distinct sh2.order_number
             from s sh2
            where sh2.store_id is not distinct from s.store_id
            order by 1 limit 2) x)                          as sample_orders
from s
left join ta on ta.store_id = s.store_id
group by s.store_id, ta.store_id, ta.dc, ta.rows_
order by sum(s.actual_cost) filter (where s.client_id is null) desc nulls last;

-- HOW TO READ IT:
--   derived_client = a name with a high row count -> safe to insert (PART 5);
--     the mapping is being read back off work a human already did.
--   derived_client = a name with (1 rows)        -> one hand-attributed
--     shipment is thin evidence for a whole store. Check sample_orders.
--   NEEDS A HUMAN ANSWER                         -> say which client, using
--     sample_orders to recognise it.
--   CONFLICT                                     -> stop. Do not pick one.
--   store = <no store>                           -> unreachable by this method.


-- ===========================================================================
-- PART 1 -- IS THE STORE ID EVEN THERE? The precondition for everything below.
-- ===========================================================================
-- Three candidate paths, because the field's location is being verified rather
-- than assumed: probe-store-client-gap.mjs:35 reads
-- `s.advancedOptions?.storeId`, which is the shape for the /shipments endpoint,
-- but raw_data is whatever the payload held and a top-level storeId is the
-- shape elsewhere in the API.
--
-- `->`/`->>` are used throughout this file and jsonb_object_keys() is not:
-- raw_data may be typed `json` rather than `jsonb` (an earlier lateral
-- jsonb_object_keys() against it errored), and the arrow operators work on
-- both.
--
-- If has_adv_store is far below shipments, STOP. Everything below is keyed on
-- that path and a low number means the mapping has to come from somewhere else
-- entirely.
select
  count(*)                                                        as shipments,
  count(*) filter (where s.raw_data is null)                      as no_raw_data,
  count(*) filter (
    where (s.raw_data -> 'advancedOptions' ->> 'storeId') is not null
  )                                                               as has_adv_store,
  count(*) filter (where (s.raw_data ->> 'storeId') is not null)   as has_top_store,
  count(*) filter (where (s.raw_data ->> 'orderSource') is not null) as has_order_source,
  count(*) filter (where s.client_id is null)                     as unattributed,
  count(*) filter (
    where s.client_id is null
      and (s.raw_data -> 'advancedOptions' ->> 'storeId') is null
  )                                                               as unattributed_AND_unmappable
from shipments s;

-- unattributed_AND_unmappable is the column that decides how much of the
-- $8,980.99 this approach can recover at all. Those rows have neither a client
-- nor a store to derive one from, and no amount of SQL will attribute them --
-- they need the ShipStation order looked up by tracking number, by a human.


-- ===========================================================================
-- PART 2 -- THE WORKLIST. One row per store, sorted by money at stake.
-- ===========================================================================
-- This is the list to answer. `derived_client` is filled in wherever the
-- training set can answer it; where it says NEEDS A HUMAN ANSWER, that store
-- appears only on unattributed shipments and nobody has ever told this database
-- who it belongs to.
--
-- sample_orders exists because a bare store ID like 350349 is not a question
-- anyone can answer from memory. Three real order numbers and a recipient
-- usually are.
with s as (
  select
    sh.*,
    nullif(trim(coalesce(
      sh.raw_data -> 'advancedOptions' ->> 'storeId',
      sh.raw_data ->> 'storeId'
    )), '') as store_id
  from shipments sh
),
-- The training set: store -> client, only from rows a human already attributed.
trained as (
  select store_id, client_id, count(*) as n
  from s
  where client_id is not null and store_id is not null
  group by 1, 2
),
-- Counted per store so a store with two clients can be reported as such
-- instead of being collapsed to whichever appeared more often.
trained_agg as (
  select store_id, count(*) as distinct_clients, sum(n) as attributed_rows
  from trained group by 1
)
select
  s.store_id,
  count(*)                                                  as shipments,
  count(s.client_id)                                        as attributed,
  count(*) filter (where s.client_id is null)               as unattributed,
  sum(s.actual_cost) filter (where s.client_id is null)     as cost_on_unattributed,
  count(s.client_rate)                                      as billed,
  min(s.ship_date)::date                                    as first_ship,
  max(s.ship_date)::date                                    as last_ship,
  case
    when ta.store_id is null       then 'NEEDS A HUMAN ANSWER'
    when ta.distinct_clients > 1   then 'CONFLICT -- see PART 3'
    else (select c.name from clients c
           join trained t on t.client_id = c.id
          where t.store_id = s.store_id limit 1)
  end                                                       as derived_client,
  coalesce(ta.attributed_rows, 0)                           as evidence_rows,
  (select string_agg(x.order_number, ', ')
     from (select distinct sh2.order_number
             from s sh2
            where sh2.store_id = s.store_id
            order by 1 limit 3) x)                          as sample_orders,
  (select sh3.recipient_name
     from s sh3
    where sh3.store_id = s.store_id and sh3.recipient_name is not null
    limit 1)                                                as a_recipient
from s
left join trained_agg ta on ta.store_id = s.store_id
group by s.store_id, ta.store_id, ta.distinct_clients, ta.attributed_rows
order by cost_on_unattributed desc nulls last;

-- HOW TO USE IT:
--   derived_client = a name, evidence_rows high  -> safe to insert (PART 5).
--                    The mapping is being read back off work a human did.
--   derived_client = a name, evidence_rows = 1   -> ONE hand-attributed
--                    shipment is thin evidence for a whole store. Worth an
--                    eyeball at the sample orders before trusting it.
--   NEEDS A HUMAN ANSWER                         -> say which client, using
--                    sample_orders and a_recipient to recognise it.
--   store_id null (a row with no store at all)   -> PART 1's
--                    unattributed_AND_unmappable. Not solvable here.


-- ===========================================================================
-- PART 3 -- CONFLICTS. Must return ZERO ROWS before PART 5 may run.
-- ===========================================================================
-- A store pointing at two clients means either a hand-attribution was wrong, or
-- a store really does serve two clients -- in which case
-- client_store_ids_store_id_key (ledger_01_orders.sql:17) cannot represent it
-- and the schema's assumption is wrong, which is a design conversation and not
-- an insert.
--
-- Any row here invalidates the corresponding row of PART 2's derived_client.
-- Do not resolve it by majority.
with s as (
  select
    sh.client_id, sh.actual_cost, sh.ship_date, sh.order_number,
    nullif(trim(coalesce(
      sh.raw_data -> 'advancedOptions' ->> 'storeId',
      sh.raw_data ->> 'storeId'
    )), '') as store_id
  from shipments sh
)
select
  s.store_id,
  c.name                        as client,
  count(*)                      as attributed_shipments,
  sum(s.actual_cost)            as cost,
  min(s.ship_date)::date        as first_ship,
  max(s.ship_date)::date        as last_ship,
  string_agg(distinct s.order_number, ', ') as orders_
from s
join clients c on c.id = s.client_id
where s.store_id is not null
  and s.store_id in (
    select store_id from s
     where client_id is not null and store_id is not null
     group by store_id having count(distinct client_id) > 1
  )
group by 1, 2
order by 1, cost desc;

-- The reverse direction is worth a glance too, and is NOT a conflict: one
-- client legitimately owning several stores is normal and the unique index
-- permits it.
with s as (
  select sh.client_id,
         nullif(trim(coalesce(sh.raw_data -> 'advancedOptions' ->> 'storeId',
                  sh.raw_data ->> 'storeId')), '') as store_id
  from shipments sh
)
select c.name as client, count(distinct s.store_id) as stores,
       string_agg(distinct s.store_id, ', ') as store_ids
from s join clients c on c.id = s.client_id
where s.store_id is not null
group by 1 having count(distinct s.store_id) > 1
order by 2 desc;


-- ===========================================================================
-- PART 4 -- WHAT THE MAPPING TABLE HOLDS NOW. Expect zero rows.
-- ===========================================================================
-- Measured 2026-10-05: client_store_ids is empty for all 9 clients. The rest of
-- that note used to read "and nothing in src/ reads it", which is no longer
-- true and was the one clause that made an empty table look harmless:
-- loadStoreMap() in src/lib/sync/store-attribution.ts selects this table on
-- every sync pass, so empty is not merely unpopulated -- it is the reason the
-- labels pulled this morning have no client. PART 6.
--
-- Re-run the count rather than trusting the 2026-10-05 zero; mappings may have
-- been inserted since, and a non-zero mapping_rows changes what PART 2's
-- derived_client column is for.
select
  (select count(*) from client_store_ids)                      as mapping_rows,
  (select count(*) from clients)                               as clients,
  (select count(*) from client_store_ids where store_id = 'VERIFY-STORE')
                                                               as verify_fixture_left_behind;

-- verify_fixture_left_behind: ledger_01_verify.sql:43 inserts 'VERIFY-STORE'
-- to prove the unique index bites. It should roll back. If it is sitting there,
-- a verify run did not clean up and the row is test residue in a production
-- table -- worth deleting, and worth knowing about.


-- ===========================================================================
-- PART 5 -- POPULATE THE MAPPING. INERT. Uncomment only after PART 3 is empty.
-- ===========================================================================
-- Inserts ONLY the mappings the training set can prove, and only where no
-- conflict exists. It derives nothing from a name.
--
-- `on conflict (store_id) do nothing`, not `do update`: if a mapping is already
-- there, a human put it there deliberately, and a script re-run must not
-- repoint a store at a different client as a side effect.
--
--   insert into client_store_ids (client_id, store_id, store_name)
--   select t.client_id,
--          t.store_id,
--          'derived from ' || t.n || ' hand-attributed shipments 2026-10-05'
--     from (
--       select nullif(trim(coalesce(sh.raw_data -> 'advancedOptions' ->> 'storeId',
--                       sh.raw_data ->> 'storeId')), '') as store_id,
--              sh.client_id,
--              count(*) as n
--         from shipments sh
--        where sh.client_id is not null
--          and nullif(trim(coalesce(sh.raw_data -> 'advancedOptions' ->> 'storeId',
--                       sh.raw_data ->> 'storeId')), '') is not null
--        group by 1, 2
--     ) t
--    where t.store_id not in (
--      -- the conflict exclusion, restated here so this statement is safe on
--      -- its own and does not depend on somebody having read PART 3
--      select nullif(trim(coalesce(sh.raw_data -> 'advancedOptions' ->> 'storeId',
--                      sh.raw_data ->> 'storeId')), '')
--        from shipments sh
--       where sh.client_id is not null
--       group by 1
--      having count(distinct sh.client_id) > 1
--    )
--   on conflict (store_id) do nothing;
--
-- store_name records WHERE THE MAPPING CAME FROM rather than a display name,
-- because the next person to look at this table needs to know that these rows
-- were derived from historical attributions on a date, not entered from the
-- ShipStation console. The real store names are only available from the
-- /stores endpoint (probe-store-client-gap.mjs:22), not from raw_data.
--
-- THE BACKFILL IS DELIBERATELY NOT HERE. Writing client_id onto 599 shipments
-- is the step that turns carrier cost into an invoice, and it should not be a
-- paragraph at the bottom of the file that populates its own lookup table. It
-- goes in its own script, after this mapping has been read and approved, and it
-- must announce the rows it could not match instead of leaving them silently
-- untouched.


-- ===========================================================================
-- PART 6 -- WHAT THE MAPPING FIXES NOW, AND WHAT IT STILL DOES NOT
-- ===========================================================================
-- THIS SECTION SAID THE OPPOSITE UNTIL 2026-10-13, and the old text is quoted
-- because copies of it are presumably still being read and acting on it would
-- now be exactly backwards:
--
--     Populating client_store_ids changes NOTHING about tomorrow's sync.
--     Nothing in src/ reads the table [...] SQL can recover the history; only
--     a code change stops the bleeding.
--
-- True as measured on 2026-10-05. The code change has since landed and is
-- deployed, so THE LOOKUP IS LIVE and populating this table is what stops the
-- bleeding:
--
--   loadStoreMap() in src/lib/sync/store-attribution.ts selects
--   store_id, client_id from client_store_ids, once per run -- once, so that an
--   edit to this table while a pull is in flight cannot attribute one page to
--   one client and the next page to another.
--
--   decideAttribution() in the same module turns a hit on a blank row into
--   { action: 'attribute' }, and src/lib/sync/shipstation.ts spreads
--   { client_id: attribution.clientId } into `shipmentData` on that action
--   ALONE. A row that already holds a client_id keeps it: the key is simply
--   absent from the update, so the 291 hand-attributed rows cannot be moved by
--   a sync running three times a day.
--
-- So one row inserted by PART 5 attributes every shipment that store sends from
-- the next pass onward -- and, because the sync re-upserts its whole window
-- through the same `shipmentData`, every shipment of that store's still inside
-- it. The window is 30 days (syncShipments(daysBack = 30)). That makes PART 2 a
-- billing worklist rather than a diagnostic: answering a NEEDS A HUMAN ANSWER
-- row and inserting the mapping is the whole forward fix, with nothing to
-- deploy.
--
-- AN UNMATCHED store_id ANNOUNCES ITSELF, which is the requirement this file
-- stated in advance and the reason it still refuses to guess. decideAttribution
-- returns { action: 'unmapped-store', storeId }; shipstation.ts counts it into
-- `unmappedStore`, collects the ids into a sorted, deduplicated
-- `unmappedStoreIds` and warns once per run ('stores with no client_store_ids
-- row'); src/app/api/agent/monitor/route.ts puts that into the alert's errors[]
-- WITH THE STORE IDS IN THE MESSAGE, because the ids are the action. It recurs
-- every eight hours until somebody inserts the row, and the recurrence is
-- deliberate -- that is unbilled revenue accruing, not a transient. The failure
-- that produced the 599 was never that matching was hard; it was that no-match
-- was indistinguishable from not-trying for three months.
--
-- A FAILED READ OF THIS TABLE IS KEPT DISTINCT FROM AN EMPTY ONE, which is what
-- makes a count of zero readable. loadStoreMap answers { map: null } on error
-- rather than an empty Map, decideAttribution reads that null as
-- 'map-unavailable' and attributes nothing, and the monitor raises its own
-- errors[] line for `storeMapUnavailable`. Without that split, a dropped grant
-- or a renamed column would present as "attributed 0" next to three healthy
-- numbers -- identical to a quiet day with no new stores.
--
-- WHAT IS LEFT IS THE HISTORY AND THE STORELESS LABELS.
--
--   1. Shipments whose ship_date has fallen out of the 30-day window are never
--      re-upserted, so the live path will not attribute them however complete
--      this mapping becomes. They are the backfill, and it already has its own
--      file -- supabase/backfill_store_attribution_2026_10.sql, which applies
--      this same rule from the same module and is a no-op that correctly
--      reports attributing nothing while client_store_ids is empty. It stays a
--      separate file for the reason PART 5 gives: writing client_id onto 599
--      shipments is the step that turns carrier cost into an invoice.
--
--   2. Labels carrying no store key at all -- PART 1's
--      unattributed_AND_unmappable, PART 0's `<no store>` row, the sync's
--      `noStoreId` counter. No row in this table can reach them. The monitor
--      logs that count instead of alerting on it, because there is no insert to
--      offer: they need the ShipStation order read by a person.
--
-- NO DDL STILL HOLDS AND PART 5 STAYS COMMENTED OUT. A live lookup raises the
-- stakes on a wrong insert rather than lowering them: a mapping guessed from a
-- display name now bills the wrong client three times a day going forward, not
-- only across the history. PART 3 must return zero rows first.
--
-- THE RATE ADJUSTMENTS, same root cause, and the forward half of that is fixed
-- too. The rate_adjustments gate in shipstation.ts now reads
-- `attributedClientId` -- the client as of THIS pass -- and no longer
-- `existingShipment.client_id`, the value from before attribution. Under the
-- old gate, a refund or void arriving on the same pass that attributed its
-- shipment was computed, found no client, and was dropped; no later run
-- recovered it either, because once actual_cost holds the new value the diff is
-- 0 for ever and the branch is never re-entered.
--
-- What no code change recovers is the adjustments already lost. Every carrier
-- refund and void that landed on the 599 while that gate was blank-by-default
-- was discarded at the time. Those are real money movements with no record;
-- attributing the shipments does not recreate them, and only the ShipStation
-- side still has them.
