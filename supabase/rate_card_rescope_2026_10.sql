-- RESCOPING THE DEAD RATE CARDS (Option B). Read PART 1 before running PART 2.
--
-- THE DEFECT. Two clients have a zone rate card scoped to a carrier string no
-- shipment carries, so the card matches nothing and every shipment goes
-- unbilled while looking, from the clients page, fully priced:
--
--   Orcam        carrier='UPS', service='Ground'  -- 800 rate rows
--                25 shipments, $238.59 carrier cost, $0.00 billed
--   Crisp Power  carrier='UPS'                    -- 216 rate rows
--                 1 shipment,    $36.64 carrier cost, $0.00 billed
--
-- The shipments carry ShipStation's own codes -- STAMPS_COM, UPS_WALLETED,
-- ups_ground_saver, usps_parcel_select -- because src/lib/ledger/carrier.ts
-- records the BILLING ACCOUNT, not the carrier in commercial terms:
--
--   `ups_walleted` is ShipStation's own UPS account, not a direct UPS account.
--   It reconciles against the ShipStation invoice, so it gets its own source
--   rather than a generic 'ups'.
--
-- Whoever loaded these cards wrote what a human calls the carrier. Nothing
-- validated the two against each other, so the card was accepted and billed
-- nothing for months. Same failure shape as shipments.client_id being
-- nullable: THE DEGRADED STATE WAS INDISTINGUISHABLE FROM THE HEALTHY ONE.
--
-- WHY EXACT STRINGS MATTER. src/lib/billing/zones.ts:211-220 matches with
-- `.eq('carrier', ...)` and `.eq('service', ...)` -- exact equality, no
-- normalisation, no ILIKE -- and src/lib/billing/recalculate.ts:166 passes
-- `s.carrier ?? ''` and `s.service ?? ''`, i.e. the raw shipments values. So
-- the only correct target is the literal string the shipment rows hold, which
-- is what PART 1 reads out of the database rather than taking on trust.
--
-- WHY NOT THE BLANKET CARD (Option A). zones.ts:206-209 tries
-- {carrier, service} and then {carrier:'', service:''}, so setting both to ''
-- would price everything off one matrix. Rejected: Orcam ships roughly 44% UPS
-- and 56% USPS, and one matrix for both bills a UPS rate for a USPS parcel.
-- That is the wrong price rather than no price -- the exact outcome this
-- codebase has spent several fixes removing.
--
-- NOTHING HERE IS DDL. No create, no alter, no drop. PART 1 and PART 3 are
-- read-only. PART 2 is one guarded UPDATE. PART 4 is inert until a price is
-- supplied. PART 5 is the inverse of PART 2.


-- ===========================================================================
-- PART 0 -- EVERY PRECONDITION IN ONE QUERY, ONE RESULT, FOUR COLUMNS.
-- ===========================================================================
-- Read-only. Run this ONE statement and send back the whole grid.
--
-- WHY THIS EXISTS, given PART 1 already asks the same questions: the Supabase
-- SQL editor returns the result of the LAST statement in a batch. PART 1 is
-- five statements, so pasting it whole shows 1E and silently discards the four
-- that matter -- and "silently discards" is the failure this entire file is
-- about. PART 1 is still correct, but it has to be run one statement at a
-- time. This part does not.
--
-- Everything is cast to text and labelled, so the output is narrow enough to
-- paste back as plain text rather than as an image.
--
-- IT ALSO ANSWERS 1C WITHOUT A SEPARATE QUERY: section B lists every scope the
-- two clients' cards currently occupy, so a card already sitting at
-- UPS_WALLETED would simply appear there. A collision cannot hide.
with cli as (
  select id, name, origin_zip
    from clients
   where name ilike 'orcam%' or name ilike 'crisp%'
),
card as (
  select z.client_id, z.carrier, z.service, count(*) as n,
         min(z.weight_lb) as wmin, max(z.weight_lb) as wmax,
         min(z.zone) as zmin, max(z.zone) as zmax,
         count(*) filter (where z.weight_lb > 20) as unreachable
    from client_zone_rates z
   where z.client_id in (select id from cli)
   group by 1, 2, 3
),
shp as (
  select s.client_id, s.carrier, s.service, count(*) as n,
         sum(s.actual_cost) as cost, count(s.client_rate) as billed
    from shipments s
   where s.client_id in (select id from cli)
   group by 1, 2, 3
)
select 'A-client' as section,
       c.name     as item,
       (select count(*) from cli)::text as n,
       c.id::text as detail
  from cli c
union all
-- The brackets are the point. A trailing or non-breaking space in 'UPS ' is
-- invisible in any grid, and would make PART 2's exact-equality UPDATE miss
-- while looking like it should have matched. `len` is the column a stray
-- character cannot hide from.
select 'B-card',
       cl.name || '  [' || card.carrier || '] / [' || card.service || ']',
       card.n::text,
       'len ' || length(card.carrier) || '/' || length(card.service)
         || '  lb ' || card.wmin || '-' || card.wmax
         || '  zone ' || card.zmin || '-' || card.zmax
         || '  unreachable ' || card.unreachable
  from card join cli cl on cl.id = card.client_id
union all
select 'C-ship',
       cl.name || '  [' || coalesce(shp.carrier, '<null>') || '] / ['
              || coalesce(shp.service, '<null>') || ']',
       shp.n::text,
       'len ' || coalesce(length(shp.carrier), -1) || '/'
              || coalesce(length(shp.service), -1)
         || '  cost ' || coalesce(shp.cost, 0)
         || '  billed ' || shp.billed
  from shp join cli cl on cl.id = shp.client_id
union all
-- Without this section the rest is moot: calculator.ts:99 never consults a
-- rate card for a shipment whose zone did not resolve, so if these three
-- sources name no zone, rescoping the card changes nothing and the fix is the
-- zone chart instead.
select 'D-zone',
       cl.name,
       count(*)::text,
       'zone_col ' || count(s.zone)
         || '  raw ' || count(*) filter (
              where (s.raw_data -> 'zone') is not null
                 or (s.raw_data -> 'shipTo' -> 'zone') is not null)
         || '  chart ' || count(*) filter (where zc.zone is not null)
         || '  origin_zip ' || coalesce(cl.origin_zip, '<null>')
  from shipments s
  join cli cl on cl.id = s.client_id
  left join zone_chart zc
    on zc.origin_prefix = left(regexp_replace(coalesce(cl.origin_zip, ''), '\D', '', 'g'), 3)
   and zc.dest_prefix   = left(regexp_replace(coalesce(s.recipient_zip, ''), '\D', '', 'g'), 3)
 group by cl.name, cl.origin_zip
order by 1, 2;

-- WHAT TO LOOK FOR, in the order it decides things:
--   A  must be exactly two rows, n = 2. More means a name pattern matches
--      several clients and PART 2 would rescope the wrong card.
--   B  vs C: is there a B row whose two bracketed strings EXACTLY match a C
--      row's? Today, no -- that is the defect. PART 2's literals must come
--      from C, not from my reading of carrier.ts.
--   D  zone_col + raw + chart near zero -> stop, fix zoning first.


-- ===========================================================================
-- PART 1 -- THE SAME PRECONDITIONS, SEPARATELY. One statement at a time.
-- ===========================================================================
-- Kept because each query here is readable on its own and PART 0 is not. If
-- PART 0 ran, these are redundant. RUN THEM ONE AT A TIME: pasted as a batch,
-- the editor shows only 1E.

-- 1A. The two client rows resolve to exactly one client each.
--
-- Checked because every statement below keys off a name match, and a name that
-- matched two clients would rescope the wrong card. Expect one row per client
-- and matches = 1 on both.
select
  pattern,
  (select count(*) from clients where name ilike pattern)       as matches,
  (select string_agg(name, ' | ') from clients where name ilike pattern) as names,
  (select string_agg(id::text, ' | ') from clients where name ilike pattern) as ids
from (values ('orcam%'), ('crisp%')) as v(pattern);

-- 1B. The exact carrier/service strings, both sides, with the bounds made
-- visible.
--
-- Wrapped in brackets on purpose: a trailing space or a non-breaking space in
-- 'UPS ' is invisible in a result grid and would make the UPDATE below miss
-- while looking like it should have matched. length() is there for the same
-- reason -- it is the one column a stray character cannot hide from.
select
  'rate_card' as side, c.name as client,
  '[' || z.carrier || ']' as carrier, length(z.carrier) as carrier_len,
  '[' || z.service || ']' as service, length(z.service) as service_len,
  count(*) as rows_, min(z.weight_lb) as min_lb, max(z.weight_lb) as max_lb,
  min(z.zone) as min_zone, max(z.zone) as max_zone
from client_zone_rates z
join clients c on c.id = z.client_id
where c.name ilike 'orcam%' or c.name ilike 'crisp%'
group by 1, 2, 3, 4, 5, 6
union all
select
  'shipment' as side, c.name as client,
  '[' || coalesce(s.carrier, '<null>') || ']', length(s.carrier),
  '[' || coalesce(s.service, '<null>') || ']', length(s.service),
  count(*), null, null, null, null
from shipments s
join clients c on c.id = s.client_id
where c.name ilike 'orcam%' or c.name ilike 'crisp%'
group by 1, 2, 3, 4, 5, 6
order by side, client, carrier, service;

-- THE TEST THIS QUERY APPLIES: for every 'shipment' row, is there a
-- 'rate_card' row with the SAME bracketed carrier and service? Today the
-- answer is no for all of them, which is the whole defect. After PART 2 it
-- must be yes for at least the UPS lane.

-- 1C. Will the UPDATE collide with the unique constraint?
--
-- client_zone_rates declares `unique (client_id, carrier, service, weight_lb,
-- zone)` (zone_rates.sql:15). If a card ALREADY exists at the target scope,
-- rescoping the old one onto it raises 23505 and the whole statement rolls
-- back -- loud, not silent, but worth knowing first. Expect 0.
select
  c.name as client, count(*) as rows_already_at_target_scope
from client_zone_rates z
join clients c on c.id = z.client_id
where (c.name ilike 'orcam%' and z.carrier = 'UPS_WALLETED')
   or (c.name ilike 'crisp%' and z.carrier = 'UPS_WALLETED')
group by 1;

-- 1D. CAN A ZONE EVEN BE RESOLVED? The precondition that makes the rest
-- matter.
--
-- src/lib/billing/calculator.ts:99 only consults the rate card when a zone was
-- resolved; zones.ts:102-173 resolves it from raw_data.zone / shipTo.zone, or
-- from zone_chart keyed on the client's origin_zip prefix. If neither can name
-- a zone, rescoping the card changes NOTHING and the shipments stay unbilled
-- for a second, unrelated reason.
--
-- has_zone_col = shipments.zone already filled in (the 0th source, zones.ts:107)
-- has_raw_zone = raw_data carries one
-- chart_hit    = zone_chart has a row for origin->dest prefix
-- zoneable     = any of the three. If zoneable is far below shipments, STOP:
--                the next fix is the zone chart, not the rate card.
select
  c.name                                                          as client,
  c.origin_zip,
  count(*)                                                        as shipments,
  count(s.zone)                                                   as has_zone_col,
  count(*) filter (
    where (s.raw_data -> 'zone') is not null
       or (s.raw_data -> 'shipTo' -> 'zone') is not null
  )                                                               as has_raw_zone,
  count(*) filter (where zc.zone is not null)                     as chart_hit,
  count(*) filter (
    where s.zone is not null
       or (s.raw_data -> 'zone') is not null
       or (s.raw_data -> 'shipTo' -> 'zone') is not null
       or zc.zone is not null
  )                                                               as zoneable
from shipments s
join clients c on c.id = s.client_id
left join zone_chart zc
  on zc.origin_prefix = left(regexp_replace(coalesce(c.origin_zip, ''), '\D', '', 'g'), 3)
 and zc.dest_prefix   = left(regexp_replace(coalesce(s.recipient_zip, ''), '\D', '', 'g'), 3)
where c.name ilike 'orcam%' or c.name ilike 'crisp%'
group by 1, 2;

-- 1E. Which weight rows are reachable at all.
--
-- zones.ts:39 is `const MAX_WEIGHT_LB = 20`, and weightToLb() CAPS anything
-- heavier to row 20 rather than missing -- so cells above weight_lb = 20 can
-- never be read by any code path, and zone_rates.sql:11 documents the column
-- as `1..20`. Orcam's 800 rows are 100 weights x 8 zones: 640 of those cells
-- are unreachable. They are harmless (their heaviest parcel is 14 LB) but the
-- row count has been giving false confidence, so it is measured, not assumed.
select
  c.name                                                  as client,
  count(*)                                                as rate_rows,
  count(*) filter (where z.weight_lb between 1 and 20)    as reachable,
  count(*) filter (where z.weight_lb > 20)                as unreachable,
  count(*) filter (where z.rate = 0)                      as zero_rates,
  (select max(ceil(s.weight / 16.0))
     from shipments s where s.client_id = c.id and s.weight > 0) as heaviest_lb
from client_zone_rates z
join clients c on c.id = z.client_id
where c.name ilike 'orcam%' or c.name ilike 'crisp%'
group by 1, c.id;

-- NOTE ON UNITS, since the two columns do not agree and nothing in the schema
-- says so: shipments.weight is OUNCES (the sync writes weight_unit:'ounces'),
-- client_zone_rates.weight_lb is POUNDS. `ceil(weight / 16.0)` above mirrors
-- weightToLb() at zones.ts:63-69 rather than inventing a second conversion.


-- ===========================================================================
-- PART 2 -- THE RESCOPE. One UPDATE per client. WRITES.
-- ===========================================================================
-- Run only after PART 1 shows: exactly one client per pattern (1A), the target
-- strings present on real shipments (1B), no collision (1C), and zones
-- resolvable (1D).
--
-- This invents NO PRICE. It moves an already-agreed matrix onto the carrier
-- and service code the system actually records. The numbers in `rate` are
-- untouched -- `set` names only carrier and service.
--
-- THE `exists` CLAUSE IS THE GUARD AND IS LOAD-BEARING. Without it, a wrong
-- target string would rescope 800 rows from one card that matches nothing onto
-- another card that matches nothing, report "UPDATE 800", and look like a fix.
-- With it, a wrong target updates 0 rows and says so. The condition is
-- literally "some shipment of this client would match the new scope", which is
-- the only thing that makes the rescope worth doing.

-- 2A. Orcam: UPS/Ground -> the UPS_WALLETED ground lane.
--
-- `service = 'ups_ground'` and NOT 'ups_ground_saver'. Ground Saver is UPS's
-- cheapest surface tier and the client did not agree Ground's price for it;
-- billing one at the other's rate is the wrong price. Ground Saver gets its
-- own card in PART 4 or stays visibly unpriced. Unpriced is recoverable.
update client_zone_rates z
   set carrier = 'UPS_WALLETED',
       service = 'ups_ground'
 where z.client_id = (select id from clients where name ilike 'orcam%')
   and z.carrier = 'UPS'
   and z.service = 'Ground'
   and exists (
     select 1 from shipments s
      where s.client_id = z.client_id
        and s.carrier = 'UPS_WALLETED'
        and s.service = 'ups_ground'
   );

-- 2B. Crisp Power: UPS -> UPS_WALLETED, service left as it is.
--
-- Their card is carrier-scoped only, so `service` keeps whatever it holds --
-- '' there means "any service for this carrier", which zones.ts does NOT treat
-- as a wildcard (it is an exact match on the empty string, and only the
-- carrier=''/service='' pair is tried as a fallback). If 1B shows service='',
-- this rescope alone will still not match: a carrier-scoped-only card is
-- unreachable by design. 1B decides whether 2B is worth running at all.
update client_zone_rates z
   set carrier = 'UPS_WALLETED'
 where z.client_id = (select id from clients where name ilike 'crisp%')
   and z.carrier = 'UPS'
   and exists (
     select 1 from shipments s
      where s.client_id = z.client_id
        and s.carrier = 'UPS_WALLETED'
        and s.service = z.service
   );

-- A row count of 0 from either statement is a FINDING, not a no-op: it means
-- the target scope matches no shipment, and PART 1's 1B says which string to
-- use instead. Do not widen the guard to force the update through.


-- ===========================================================================
-- PART 3 -- VERIFICATION. Read-only. Does a rate now REACH a shipment?
-- ===========================================================================
-- Deliberately NOT "did the update run" -- a row count proves a write
-- happened, not that it billed anything. This walks the same path the billing
-- code walks: resolve a zone, convert ounces to the matrix row, and join to
-- the cell on all four keys with exact equality, exactly as zones.ts does.
--
-- cell_found is the number that matters. Before this script it is 0 for
-- Orcam's 25 shipments. If it is still 0 after PART 2, the rescope did not
-- work and the reason is in one of the other columns.
with ship as (
  select
    c.name        as client,
    s.id,
    s.client_id,
    s.carrier,
    s.service,
    s.actual_cost,
    s.client_rate,
    -- NOT `least(ceil(weight/16.0), 20)`: least() IGNORES nulls in Postgres,
    -- so a null weight would resolve to 20 -- the most expensive row of the
    -- matrix -- and be counted as priceable. The case refuses it instead,
    -- matching billedWeightOf (shipment-rate.ts:105-110), which answers null
    -- for null, non-finite, and <= 0, and weightToLb (zones.ts:63-69), which
    -- caps a readable weight rather than missing on it.
    case when s.weight > 0
         then least(ceil(s.weight / 16.0), 20)::int
    end                                   as weight_lb,
    -- Every cast is regex-guarded. An unguarded `::int` on a raw_data value
    -- that is not a number raises 22P02 and loses the whole result set, so a
    -- single malformed payload would read as "the query is broken" rather than
    -- as one unzoneable shipment.
    coalesce(
      s.zone,
      case when (s.raw_data ->> 'zone') ~ '^[0-9]+$'
           then (s.raw_data ->> 'zone')::int end,
      case when (s.raw_data -> 'shipTo' ->> 'zone') ~ '^[0-9]+$'
           then (s.raw_data -> 'shipTo' ->> 'zone')::int end,
      zc.zone
    )                                     as zone
  from shipments s
  join clients c on c.id = s.client_id
  left join zone_chart zc
    on zc.origin_prefix = left(regexp_replace(coalesce(c.origin_zip, ''), '\D', '', 'g'), 3)
   and zc.dest_prefix   = left(regexp_replace(coalesce(s.recipient_zip, ''), '\D', '', 'g'), 3)
  where c.name ilike 'orcam%' or c.name ilike 'crisp%'
)
select
  sh.client,
  sh.carrier,
  sh.service,
  count(*)                                              as shipments,
  sum(sh.actual_cost)                                   as carrier_cost,
  count(sh.client_rate)                                 as currently_billed,
  count(*) filter (where sh.weight_lb is null)          as no_weight,
  count(*) filter (where sh.zone is null)               as no_zone,
  count(z.rate)                                         as cell_found,
  count(bz.rate)                                        as blanket_fallback,
  sum(z.rate)                                           as would_bill,
  -- Cost is filtered to the SAME rows the revenue came from. `sum(z.rate) -
  -- sum(sh.actual_cost)` would subtract the cost of every shipment in the
  -- group from the revenue of only the matched ones, so a partly-priceable
  -- lane would report a loss it does not have. The two sides of a margin have
  -- to be measured over one population.
  sum(z.rate) - sum(sh.actual_cost) filter (where z.rate is not null)
                                                        as would_be_margin,
  count(*) filter (where z.rate is null)                as still_unpriceable
from ship sh
left join client_zone_rates z
  on z.client_id = sh.client_id
 and z.carrier   = sh.carrier
 and z.service   = sh.service
 and z.weight_lb = sh.weight_lb
 and z.zone      = sh.zone
left join client_zone_rates bz
  on bz.client_id = sh.client_id
 and bz.carrier = '' and bz.service = ''
 and bz.weight_lb = sh.weight_lb
 and bz.zone      = sh.zone
group by 1, 2, 3
order by 1, carrier_cost desc;

-- HOW TO READ IT, in the order the billing code fails:
--   no_weight > 0   -> billedWeightOf() refuses it (zones.ts:203 returns a MISS,
--                      so the shipment is written UNPRICED with the weight named
--                      as the reason). A rate card cannot fix this.
--   no_zone > 0     -> no zone source named one, so the card is never consulted.
--                      Fix the zone chart, not the card.
--   cell_found = 0 with no_weight = 0 and no_zone = 0
--                   -> the scope strings still do not match. Back to 1B.
--   cell_found = shipments -> the lane is priceable. The shipments still need
--                      the recalculate run to actually write client_rate;
--                      this query only proves a rate is now REACHABLE.
--   would_be_margin negative -> the card prices this lane below cost. That is a
--                      real finding about the quote, not a bug, and it is better
--                      to see it here than after invoicing.


-- ===========================================================================
-- PART 4 -- THE REMAINING SERVICES. INERT. Needs a price per service.
-- ===========================================================================
-- PART 2 fixes one lane. It does not fix these, and they are the majority of
-- the volume:
--
--   Orcam        ~56% USPS, via carrier STAMPS_COM
--   system-wide  ups_ground_saver 88 shipments, 4 billed
--                usps_parcel_select 467 shipments, 152 billed
--                usps_ground_advantage 293 shipments, 39 billed
--
-- There is no card for them at any scope, and I will not derive one. Copying
-- Orcam's UPS matrix onto usps_parcel_select would produce 160 cells of
-- invoiceable numbers that no client agreed to -- which is worse than the
-- current state, because the current state is visibly unbilled and that would
-- be invisibly mispriced.
--
-- (`carrier = 'STAMPS_COM'` reads oddly for a USPS parcel. It is correct for
-- this schema: zones.ts matches shipments.carrier verbatim, and the sync writes
-- the Stamps.com ACCOUNT there, not the delivery carrier. Matching the code
-- rather than the commercial name is the entire point of this file.)
--
-- WHAT IS NEEDED: for each (client, service) below, the agreed rate per
-- weight_lb x zone cell. One number per cell, 20 weights x 8 zones = 160 cells
-- per service, or a formula to generate them from.
--
-- When those numbers exist, generate the inserts from the quote -- do not
-- hand-type 160 rows. The shape is:
--
--   insert into client_zone_rates (client_id, carrier, service, weight_lb, zone, rate)
--   select (select id from clients where name ilike 'orcam%'),
--          'STAMPS_COM', 'usps_parcel_select', w, z, <rate for (w, z)>
--     from generate_series(1, 20) w, generate_series(1, 8) z
--   on conflict (client_id, carrier, service, weight_lb, zone) do nothing;
--
-- The `on conflict do nothing` is there so a re-run cannot overwrite an agreed
-- price with a later guess. If a price genuinely changes, that is an UPDATE
-- somebody decided on, not a side effect of running a load script twice.
--
-- SEPARATELY, and not fixable by a weight x zone matrix at all: Suteka has 47
-- shipments, $352.47 of cost, NO card of any kind, and ships
-- usps_first_class_mail_international. A domestic weight x zone matrix has no
-- column for an international destination. That needs a pricing decision
-- before it needs any SQL.


-- ===========================================================================
-- PART 5 -- ROLLBACK. The exact inverse of PART 2.
-- ===========================================================================
-- Here because PART 2 is a relabel of real money data and the honest way to
-- make that safe is for the undo to exist before the do. No `exists` guard on
-- these: reverting to a scope that matches nothing is the POINT of a revert.
--
--   update client_zone_rates
--      set carrier = 'UPS', service = 'Ground'
--    where client_id = (select id from clients where name ilike 'orcam%')
--      and carrier = 'UPS_WALLETED' and service = 'ups_ground';
--
--   update client_zone_rates
--      set carrier = 'UPS'
--    where client_id = (select id from clients where name ilike 'crisp%')
--      and carrier = 'UPS_WALLETED';
--
-- Reverting Orcam's is only safe while no OTHER card has been loaded at
-- UPS/Ground in the meantime; 1C is the query that checks, with the two
-- carrier strings swapped.


-- ===========================================================================
-- WHAT THIS SCRIPT DOES NOT FIX
-- ===========================================================================
-- Rate-card scoping is the SECOND defect, and the smaller one. 599 of 890
-- shipments carry no client_id at all -- $8,980.99 of carrier spend, 94% of
-- the unbilled total, starting 2026-07-07 -- because `shipmentData` in
-- src/lib/sync/shipstation.ts has no client_id key, so every synced shipment
-- is unattributed by default and the 291 attributed ones are hand-fixed
-- exceptions. A shipment with no client_id reaches no client's rate card, so
-- every statement above is irrelevant to it.
--
-- Fixing that needs client_store_ids populated -- the table exists
-- (ledger_01_orders.sql:10), is empty for all 9 clients, and is read by
-- nothing in src/ -- plus a sync that uses it and ANNOUNCES an unmatched
-- store_id rather than guessing a client.
--
-- Third, and invisible to every query in this file because warehouse work
-- creates no shipment row: client_warehouse_rates holds 19 rows, all Nayax.
-- Eight active clients have no pick_pack, storage, receiving or special_task
-- price. Against $11,500/month of lease that may be the largest hole of the
-- three.
