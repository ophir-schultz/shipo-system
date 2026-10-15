-- Who owns the 8 unmapped stores? Evidence, so the answer is read rather than
-- guessed.
--
-- The monitor (2026-10-15 03:31 ET) reports 266 shipments from 8 store ids with
-- no row in client_store_ids: 202015, 326718, 337203, 342775, 343386, 348161,
-- 350349, 352718. Those shipments have NO CLIENT, so they cannot appear on any
-- statement and cannot be invoiced. One INSERT per store id fixes every
-- shipment that store has already sent and every one it will send.
--
-- This file does not write anything. It assembles, per store, the three things
-- that in practice name the client:
--
--   1. recipient names        -- a store shipping only to "SHIPO LLC - SUTEKA"
--                                is Suteka's, and the monitor's own blank-order
--                                -number examples are named exactly that way
--   2. order-number shape     -- RET-2026-### and #S#### are different systems;
--                                a shape that matches an EXISTING client's
--                                shape is strong evidence
--   3. carrier and money      -- which agreement it must be billed under, and
--                                how much is sitting unbilled
--
-- Read-only. Nothing here inserts, updates or deletes.

-- ---------------------------------------------------------------------------
-- 1. One row per unmapped store: size, money, dates, carriers.
-- ---------------------------------------------------------------------------
-- store_id is pulled out of raw_data exactly as backfill_store_attribution
-- does it (same coalesce, same trim, same nullif), so a store that shows here
-- is a store that file would also see. Writing a second, simpler extraction
-- would risk this report disagreeing with the thing that acts on it.
with sh as (
  select
    s.id,
    s.client_id,
    s.order_number,
    s.recipient_name,
    s.carrier,
    s.service,
    s.ship_date,
    s.actual_cost,
    s.client_rate,
    nullif(trim(coalesce(
      s.raw_data -> 'advancedOptions' ->> 'storeId',
      s.raw_data ->> 'storeId'
    )), '') as store_id
  from shipments s
),
unmapped as (
  select sh.*
  from sh
  left join client_store_ids csi on csi.store_id = sh.store_id
  where sh.store_id is not null
    and csi.client_id is null
)
select
  store_id,
  count(*)                                   as shipments,
  count(distinct recipient_name)             as distinct_recipients,
  min(ship_date)::date                       as first_shipped,
  max(ship_date)::date                       as last_shipped,
  -- Still arriving, or historical? A store that shipped last week needs a
  -- mapping urgently; one that stopped in March is cleanup.
  (max(ship_date)::date >= current_date - 14) as active_last_14d,
  -- What is unbilled. actual_cost is what we PAID, so this is real money out
  -- the door with no client to recover it from. Summed with no coalesce: a
  -- null cost is unknown, not zero, and count tells you how many are unknown.
  round(sum(actual_cost), 2)                 as cost_we_paid,
  count(actual_cost)                         as costs_known,
  round(sum(client_rate), 2)                 as rate_if_any,
  string_agg(distinct carrier, ', ')         as carriers
from unmapped
group by store_id
order by count(*) desc;

-- ---------------------------------------------------------------------------
-- 2. The naming evidence: top recipients per store.
-- ---------------------------------------------------------------------------
-- Three per store. ShipStation recipient names on these accounts are written
-- "SHIPO LLC - <CLIENT>", which is how the monitor's blank-order-number
-- examples identify SITNSTAND and SUTEKA -- so this column alone often ends
-- the question.
with sh as (
  select
    s.recipient_name,
    nullif(trim(coalesce(
      s.raw_data -> 'advancedOptions' ->> 'storeId',
      s.raw_data ->> 'storeId'
    )), '') as store_id
  from shipments s
),
unmapped as (
  select sh.store_id, sh.recipient_name
  from sh
  left join client_store_ids csi on csi.store_id = sh.store_id
  where sh.store_id is not null and csi.client_id is null
),
ranked as (
  select
    store_id,
    coalesce(recipient_name, '(no recipient name)') as recipient_name,
    count(*) as n,
    row_number() over (partition by store_id order by count(*) desc) as rn
  from unmapped
  group by store_id, coalesce(recipient_name, '(no recipient name)')
)
select store_id, rn as rank, recipient_name, n as shipments
from ranked
where rn <= 3
order by store_id, rn;

-- ---------------------------------------------------------------------------
-- 3. Order-number shapes, unmapped stores beside the clients we already know.
-- ---------------------------------------------------------------------------
-- Digits are collapsed to '#', so 'RET-2026-158' and 'RET-2026-159' become one
-- shape 'RET-#-#'. A shape that appears under an unmapped store AND under an
-- existing client is the strongest evidence in this file: it means the same
-- order system produced both.
--
-- `owner` is the client name where one is known and the store id otherwise, so
-- matching shapes land on adjacent rows when sorted.
with sh as (
  select
    s.order_number,
    s.client_id,
    nullif(trim(coalesce(
      s.raw_data -> 'advancedOptions' ->> 'storeId',
      s.raw_data ->> 'storeId'
    )), '') as store_id
  from shipments s
  where nullif(btrim(coalesce(s.order_number, '')), '') is not null
),
tagged as (
  select
    sh.order_number,
    regexp_replace(sh.order_number, '[0-9]+', '#', 'g') as shape,
    case when csi.client_id is null and sh.store_id is not null
         then 'STORE ' || sh.store_id
         else coalesce(c.name, '(no client)')
    end as owner,
    (csi.client_id is null and sh.store_id is not null) as is_unmapped
  from sh
  left join client_store_ids csi on csi.store_id = sh.store_id
  left join clients c on c.id = sh.client_id
)
select
  shape,
  -- A shape used by exactly one owner says nothing. A shape shared between an
  -- unmapped store and a named client is the match.
  count(distinct owner)                                          as owners,
  bool_or(is_unmapped)                                           as seen_unmapped,
  bool_or(not is_unmapped)                                       as seen_mapped,
  string_agg(distinct owner, ' | ' order by owner)               as who_uses_it,
  count(*)                                                       as orders,
  min(order_number)                                              as example
from tagged
group by shape
-- Shared shapes first: those are the lines that answer the question.
having bool_or(is_unmapped)
order by (case when bool_or(not is_unmapped) then 0 else 1 end), count(*) desc;

-- ---------------------------------------------------------------------------
-- 4. The clients available to map them to.
-- ---------------------------------------------------------------------------
-- Including inactive ones, and with brackets around the name, because a
-- trailing space in clients.name has already caused one rate-card script to
-- match nothing. `stores_mapped` shows which clients already have a store id,
-- so a client showing 0 here is a candidate for one of the 8 above.
select
  '[' || c.name || ']'                                  as name_bracketed,
  length(c.name)                                        as name_len,
  c.active,
  (select count(*) from client_store_ids x where x.client_id = c.id) as stores_mapped,
  (select string_agg(x.store_id, ', ') from client_store_ids x where x.client_id = c.id)
                                                        as store_ids
from clients c
order by (select count(*) from client_store_ids x where x.client_id = c.id), c.name;

-- ---------------------------------------------------------------------------
-- WHEN YOU KNOW THE ANSWER
-- ---------------------------------------------------------------------------
-- One insert per store. client_store_ids has a UNIQUE index on store_id alone
-- (ledger_01_orders.sql:17), so a store can belong to exactly one client and a
-- second insert for the same store will FAIL rather than silently create an
-- ambiguity. That is the behaviour you want -- do not add an ON CONFLICT that
-- papers over it.
--
--   insert into client_store_ids (client_id, store_id, store_name)
--   select c.id, '350349', 'Nayax'
--   from clients c where btrim(c.name) = 'Nayax';
--
-- Then run supabase/backfill_store_attribution_2026_10.sql to attach the
-- shipments already in the table. New shipments attribute themselves on sync.
--
-- Store 326718 was previously reported as an ATTRIBUTION CONFLICT, not merely
-- unmapped -- its shipments already carry a client_id that disagrees with
-- where the store id would send them. Decide that one deliberately; mapping it
-- will move money between two clients' statements.
