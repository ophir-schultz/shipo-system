-- ============================================================
-- Are the five new warehouse actions actually PRICED, per client?
--
-- Run in the Supabase SQL editor with the "New query" button, so this is
-- the only statement in the tab. The editor shows only the LAST result.
--
-- WHY THIS EXISTS. "We added the rates" and "the log will bill them" are
-- two different claims. src/lib/billing/warehouse-log-rate.ts resolves a
-- daily-log line through FOUR conditions, and a rate card can satisfy
-- "rows exist" while failing any of them:
--
--   1. a row whose service_type EQUALS the action string exactly
--      -- structured card rows carry service_type NULL and charge_type
--         set, and a SQL equality never matches NULL, so a rate entered
--         as a charge_type/variant line prices NOTHING on this screen
--   2. in effect on the log date, half-open [effective_from, effective_to)
--      -- a card dated to start next month is not a card today
--   3. EXACTLY ONE such live row
--      -- client_warehouse_rates_no_overlap is keyed `charge_type with =`
--         and a NULL never conflicts in an exclusion constraint, so the
--         charge_type-NULL rows this screen reads are exactly the rows
--         that constraint does NOT protect. Two can be written.
--   4. a rate that parses to a finite number (NULL is UNKNOWN, not free)
--
-- Each failure sends you somewhere different, so each gets its own
-- verdict rather than one "no rate found".
--
-- PASS CONDITION: every row reads OK. Anything else is work the team can
-- log but the system will not bill -- it shows an em-dash, not $0.
-- Rows are ordered problems-first.
-- ============================================================

with svc(service_type) as (
  -- The five actions added in 22bb413. Deliberately literal: if someone
  -- renames a value in WAREHOUSE_SERVICE_TYPES without updating this list,
  -- the mismatch is the finding.
  values ('fba_prep'), ('receiving_pallet'), ('receiving_carton'),
         ('devan_20ft'), ('devan_40ft')
),
cl as (
  select id, name from clients where active is true
),
card as (
  -- Whole card per client, so "no card at all" and "card holds only
  -- structured lines" are distinguishable from "this one service is missing".
  select client_id,
         count(*)                                          as card_rows,
         count(*) filter (where charge_type is not null)    as structured_rows
  from client_warehouse_rates
  group by client_id
),
named as (
  -- Rows naming the service, REGARDLESS of date. Needed to tell
  -- "never agreed" from "agreed for a window that is not today".
  select client_id,
         service_type,
         count(*) as named_rows,
         string_agg(
           coalesce(effective_from::text, 'open') || '..' ||
           coalesce(effective_to::text,   'open'), ', '
           order by effective_from nulls first) as windows
  from client_warehouse_rates
  where service_type is not null
  group by client_id, service_type
),
live as (
  -- Half-open [from, to), matching both inEffect() and the daterange
  -- '[)' in client_warehouse_rates_no_overlap. Using a different
  -- convention here would let this query disagree with the running code.
  select client_id,
         service_type,
         count(*)                                   as live_rows,
         min(rate)                                  as the_rate,
         min(unit)                                  as the_unit,
         count(*) filter (where rate is null)       as null_rates,
         string_agg(id::text, ', ')                 as ids
  from client_warehouse_rates
  where service_type is not null
    and (effective_from is null or effective_from <= current_date)
    and (effective_to   is null or effective_to   >  current_date)
  group by client_id, service_type
)
select
  cl.name                      as client,
  s.service_type               as action,
  case
    when coalesce(cd.card_rows, 0) = 0
      then 'NO_CARD -- client has no warehouse rate card at all'
    when n.named_rows is null and coalesce(cd.structured_rows, 0) > 0
      then 'STRUCTURED_ONLY -- card has charge_type lines; this screen '
           || 'prices only service_type lines'
    when n.named_rows is null
      then 'NO_SERVICE_LINE -- nothing names this action'
    when coalesce(l.live_rows, 0) = 0
      then 'NOT_IN_EFFECT today -- windows: ' || n.windows
    when l.live_rows > 1
      then 'AMBIGUOUS -- ' || l.live_rows || ' live rows (' || l.ids
           || '); the screen refuses rather than pick one'
    when l.null_rates > 0
      then 'BAD_RATE -- rate is NULL (UNKNOWN, billed as nothing)'
    else 'OK  ' || l.the_rate::text || '  ' || coalesce(l.the_unit, '(no unit)')
  end                          as verdict
from cl
cross join svc s
left join card  cd on cd.client_id = cl.id
left join named n  on n.client_id  = cl.id and n.service_type = s.service_type
left join live  l  on l.client_id  = cl.id and l.service_type = s.service_type
order by
  (case when coalesce(l.live_rows,0) = 1
          and coalesce(l.null_rates,0) = 0 then 1 else 0 end),  -- problems first
  cl.name,
  s.service_type;
