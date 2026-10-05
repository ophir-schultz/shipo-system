-- BUILDING THE STORE -> CLIENT MAPPING FROM EVIDENCE. Read-only except PART 5,
-- which is inert until PART 3 comes back clean.
--
-- THE DEFECT THIS SERVES. 599 of 890 shipments carry no client_id at all --
-- $8,980.99 of carrier spend, 94% of everything unbilled, from 2026-07-07 to
-- 2026-10-03. The cause is in src/lib/sync/shipstation.ts: the `shipmentData`
-- object it upserts runs from shipstation_shipment_id to raw_data and has NO
-- client_id KEY. So an unattributed shipment is not an edge case, it is the
-- DEFAULT, and the 291 attributed rows are hand-fixed exceptions. The comment
-- in scripts/probe-store-client-gap.mjs:5 names the original intent -- "for now
-- match by order source" -- and the matching was never built.
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
         coalesce(sh.raw_data -> 'advancedOptions' ->> 'storeId',
                  sh.raw_data ->> 'storeId') as store_id
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
    coalesce(
      sh.raw_data -> 'advancedOptions' ->> 'storeId',
      sh.raw_data ->> 'storeId'
    ) as store_id
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
    coalesce(
      sh.raw_data -> 'advancedOptions' ->> 'storeId',
      sh.raw_data ->> 'storeId'
    ) as store_id
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
         coalesce(sh.raw_data -> 'advancedOptions' ->> 'storeId',
                  sh.raw_data ->> 'storeId') as store_id
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
-- Measured 2026-10-05: client_store_ids is empty for all 9 clients, and
-- nothing in src/ reads it -- the only references are ledger_01_orders.sql,
-- two verify scripts, and ledger_08's existence check. So it has never been
-- populated and would do nothing yet if it were. PART 6.
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
--       select coalesce(sh.raw_data -> 'advancedOptions' ->> 'storeId',
--                       sh.raw_data ->> 'storeId') as store_id,
--              sh.client_id,
--              count(*) as n
--         from shipments sh
--        where sh.client_id is not null
--          and coalesce(sh.raw_data -> 'advancedOptions' ->> 'storeId',
--                       sh.raw_data ->> 'storeId') is not null
--        group by 1, 2
--     ) t
--    where t.store_id not in (
--      -- the conflict exclusion, restated here so this statement is safe on
--      -- its own and does not depend on somebody having read PART 3
--      select coalesce(sh.raw_data -> 'advancedOptions' ->> 'storeId',
--                      sh.raw_data ->> 'storeId')
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
-- PART 6 -- WHAT SQL CANNOT FIX HERE
-- ===========================================================================
-- Populating client_store_ids changes NOTHING about tomorrow's sync. Nothing in
-- src/ reads the table, and `shipmentData` in src/lib/sync/shipstation.ts has no
-- client_id key, so every shipment synced after this script runs is still
-- unattributed. SQL can recover the history; only a code change stops the
-- bleeding.
--
-- That change has one requirement worth stating in advance, because it is the
-- whole reason this file refuses to guess: AN UNMATCHED store_id MUST ANNOUNCE
-- ITSELF. The failure that produced the 599 was not that matching was hard --
-- it was that no-match was indistinguishable from not-trying, and nothing on
-- any screen said 599 shipments had no owner for three months. A lookup that
-- silently leaves client_id null rebuilds exactly that.
--
-- Related, same root cause, and already visible in the file: shipstation.ts:198
-- gates rate-adjustment recording on
--
--     if (diff !== null && Math.abs(diff) > 0.01 && existingShipment.client_id)
--
-- so for all 599 of these, every carrier refund and void has been silently
-- discarded. Those are real money movements with no record. Attributing the
-- shipments does not retroactively create the adjustments -- that history is
-- gone, and only the ShipStation side still has it.
