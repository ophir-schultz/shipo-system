-- What each active client can actually log on the warehouse daily log, and
-- why the rest of their card cannot be logged.
--
-- READ ONLY. No DDL, no writes. Safe to run on production.
--
-- This mirrors lib/billing/warehouse-log-rate.ts (priceServiceLine) and
-- lib/billing/warehouse-priced-services.ts (pricedServices) deliberately, so
-- the answer is the one the SCREEN will give, not a second opinion about the
-- card:
--
--   * a line is loggable only if service_type is a non-blank name AND rate is
--     not null AND it is in effect today;
--   * "in effect" is half-open [effective_from, effective_to) -- the same
--     convention as client_warehouse_rates_no_overlap, which is declared
--     daterange(effective_from, effective_to, '[)'). Using '<=' on the upper
--     bound here when the constraint uses '<' would report a line as live on
--     the day it expires;
--   * a null bound is open, not today;
--   * TWO live lines for one service_type is NOT priced -- the screen refuses
--     rather than picking one, because picking one silently invoices a rate
--     nobody chose;
--   * `no-card` is ZERO ROWS, not "no priced rows". pricedServices tests
--     `card.length === 0` against both partitions, so a client holding only
--     structured charge_type lines is `structured-only` -- a different finding
--     that sends you to the charge calculator instead of to the rate card.
--
-- The four states are kept apart because they send you to three different
-- places: add a card, use the charge calculator, or fix effective dates.

with card as (
  select
    c.id   as client_id,
    c.name as client_name,
    r.id is not null as has_row,
    -- Blank and whitespace-only names are dropped by pricedServices, because
    -- they would render as an unlabelled box and submit a service_type of ''.
    nullif(btrim(coalesce(r.service_type, '')), '') as service_type,
    r.rate,
    r.unit,
    r.charge_type,
    r.effective_from,
    r.effective_to,
    (
      coalesce(r.effective_from, date '-infinity') <= current_date
      and coalesce(r.effective_to, date 'infinity') >  current_date
    ) as live
  from clients c
  left join client_warehouse_rates r on r.client_id = c.id
  where c.active = true
),

-- One row per (client, service_type) that is named and in effect today, with
-- how many such lines there are. n > 1 is the duplicate case.
live_named as (
  select
    client_id, service_type,
    count(*)                                 as n,
    count(*) filter (where rate is not null)  as n_rated,
    min(rate)                                as rate,
    min(unit)                                as unit
  from card
  where service_type is not null and live
  group by client_id, service_type
),

loggable as (
  select client_id, service_type, rate, unit
  from live_named
  where n = 1 and n_rated = 1
),

blocked as (
  select client_id, service_type,
         case
           when n > 1 then 'DUPLICATE: ' || n || ' lines in effect today'
           else 'NO RATE: line exists, rate is null'
         end as why
  from live_named
  where n > 1 or n_rated = 0
),

-- Named lines that exist but are outside today's window. Different fix from
-- the above: extend an effective_to, do not add a second line.
expired as (
  select client_id, service_type,
         string_agg(
           coalesce(effective_from::text, 'open') || '..'
             || coalesce(effective_to::text, 'open'), ', '
           order by effective_from
         ) as windows
  from card
  where service_type is not null and not live
  group by client_id, service_type
)

select
  c.client_name,
  case
    when count(*) filter (where c.has_row) = 0  then 'no-card'
    when count(c.service_type) = 0              then 'structured-only'
    when (select count(*) from loggable l where l.client_id = c.client_id) = 0
                                                then 'none-priced'
    else 'priced'
  end                                                       as state,
  (select count(*) from loggable l where l.client_id = c.client_id)
                                                            as loggable_actions,
  (select string_agg(l.service_type || ' @' || l.rate
                     || coalesce(' ' || l.unit, ''), ', ' order by l.service_type)
     from loggable l where l.client_id = c.client_id)        as can_log_today,
  (select string_agg(b.service_type || ' (' || b.why || ')', '; '
                     order by b.service_type)
     from blocked b where b.client_id = c.client_id)         as blocked_lines,
  (select string_agg(e.service_type || ' [' || e.windows || ']', '; '
                     order by e.service_type)
     from expired e where e.client_id = c.client_id)         as out_of_window,
  count(c.charge_type)                                       as structured_lines,
  count(*) filter (where c.has_row)                          as rows_on_card
from card c
group by c.client_id, c.client_name
order by
  -- Worst first: the clients the team cannot log anything for tomorrow.
  (select count(*) from loggable l where l.client_id = c.client_id),
  c.client_name;


-- ---------------------------------------------------------------------------
-- Second query: which of the registry's actions are priced for ANYBODY.
--
-- devan_20ft and devan_40ft are offered by the screen and were asked for by
-- name, but a probe found them on no card anywhere. Run this to confirm before
-- adding them: a zero here means every devanning job done tomorrow is logged
-- and never invoiced.
--
-- pick_pack is deliberately NOT in this list. The ledger raises it per order,
-- so a per-action rate for it would double-charge.
-- ---------------------------------------------------------------------------
select
  s.service_type,
  count(r.id)                                   as lines_anywhere,
  count(r.id) filter (where r.rate is not null) as lines_with_a_rate,
  count(distinct r.client_id)                   as clients_with_it
from (values ('devan_20ft'), ('devan_40ft'), ('pallet_in'), ('pallet_out'),
             ('receiving'), ('receiving_pallet'), ('receiving_carton'),
             ('returns'), ('labeling'), ('kitting'), ('fba_prep'),
             ('storage'), ('labor_hours'), ('special_task')) as s(service_type)
left join client_warehouse_rates r
       on r.service_type = s.service_type
      and r.client_id in (select id from clients where active = true)
group by s.service_type
order by count(r.id), s.service_type;
