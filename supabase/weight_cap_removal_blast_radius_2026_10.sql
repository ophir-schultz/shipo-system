-- What removing the 20 LB zone-matrix cap actually moves.
--
-- READ-ONLY. Every statement in this file is a SELECT. Nothing here writes,
-- and there is no commented-out UPDATE to uncomment.
--
-- THE SUPABASE EDITOR SHOWS ONLY THE LAST STATEMENT'S RESULT when you paste a
-- batch. Paste one PART at a time.
--
-- WHY THIS FILE EXISTS. `weightToLb` in src/lib/billing/zones.ts used to end
-- with `if (lb > 20) return MAX_WEIGHT_LB`, on the stated grounds that "matrix
-- tops out at 20 LB". It does not: client_zone_rates holds rows to 100 LB for
-- Orcam and to 27 LB for Crisp Power. So a 25 LB parcel was billed the 20 LB
-- cell while the 25 LB cell its contract names sat in the table unread.
--
-- The cap is now removed. That is a change to what an unattended cron writes
-- into shipments.client_rate three times a day, so the number of shipments it
-- moves, and in which direction, has to be known BEFORE it deploys rather than
-- discovered on an invoice. This file is that count.
--
-- WHAT IT REPLAYS, and where it is only an approximation:
--   * the weight rule: billedWeightOf then ceil(oz/16), so weight > 320 oz.
--   * the zone rule: shipments.zone if 1..8, then the four raw_data candidates
--     resolveZone tries in order, then the zone_chart ZIP-prefix lookup off
--     clients.origin_zip. Same precedence as resolveZone.
--   * the cell rule: client_zone_rates on (client_id, carrier, service,
--     weight_lb, zone), exact carrier/service FIRST and the blanket ('','')
--     card second -- the two attempts resolveZoneRate makes, in that order.
--   * NOT replayed: dimensional weight. calculator.ts passes `weight` through,
--     so this file does too, but if a dim-weight adjustment is ever applied
--     upstream of resolveZoneRate these counts move with it.
--   * NOT replayed: the legacy card. A shipment that loses its zone cell here
--     is handed to matchLegacyRate, which either finds a band or refuses with
--     the bands named. PART 2 counts those separately but cannot say which,
--     because the legacy bands live in a different table and the substring
--     carrier match is not expressible as a join.


-- ---------------------------------------------------------------------------
-- PART 0 -- is there anything here at all?
-- ---------------------------------------------------------------------------
-- One row. If `over_20lb` is 0, the cap never bound anything in this database
-- and the removal is a correctness fix with no blast radius -- stop here.
select
  count(*)                                                      as shipments,
  count(*) filter (where s.weight is null or s.weight <= 0)     as no_usable_weight,
  count(*) filter (where s.weight > 0 and s.weight <= 320)      as at_or_under_20lb,
  count(*) filter (where s.weight > 320)                        as over_20lb,
  sum(s.actual_cost) filter (where s.weight > 320)              as carrier_cost_over_20lb,
  max(ceil(s.weight / 16.0)) filter (where s.weight > 320)      as heaviest_row_wanted,
  count(s.client_rate) filter (where s.weight > 320)            as over_20lb_already_billed
from shipments s;


-- ---------------------------------------------------------------------------
-- PART 1 -- the outcome for each over-20 LB shipment, bucketed.
-- ---------------------------------------------------------------------------
-- The one query that answers "what does this change cost or recover".
with heavy as (
  select
    s.id, s.client_id, s.carrier, s.service, s.client_rate, s.actual_cost,
    s.ship_date, s.weight, s.zone as stored_zone, s.recipient_zip, s.raw_data,
    c.name as client, c.origin_zip,
    ceil(s.weight / 16.0)::int as real_row
  from shipments s
  join clients c on c.id = s.client_id
  where s.weight is not null
    and s.weight > 320            -- ceil(weight/16) > 20, i.e. the cap bound it
),
-- resolveZone's step 1: the four raw_data candidates, in its order. The cast
-- sits inside a CASE so a non-numeric value is never cast at all -- a bare
-- `v::int` with the regex in the WHERE would still be free to fail first.
raw_zone as (
  select
    h.id,
    (
      select q.n
      from (
        select
          case when t.v ~ '^\s*[0-9]+\s*$' then trim(t.v)::int end as n,
          t.ord
        from unnest(array[
          h.raw_data ->> 'zone',
          h.raw_data ->> 'shippingZone',
          h.raw_data -> 'advancedOptions' ->> 'zone',
          h.raw_data -> 'shipTo' ->> 'zone'
        ]) with ordinality as t(v, ord)
      ) q
      where q.n between 1 and 8
      order by q.ord
      limit 1
    ) as zone
  from heavy h
),
-- resolveZone's step 2: the ZIP-prefix chart.
chart_zone as (
  select
    h.id,
    (
      select zc.zone
      from zone_chart zc
      where zc.origin_prefix = left(regexp_replace(coalesce(h.origin_zip, ''), '\D', '', 'g'), 3)
        and zc.dest_prefix   = left(regexp_replace(coalesce(h.recipient_zip, ''), '\D', '', 'g'), 3)
        and length(regexp_replace(coalesce(h.origin_zip, ''), '\D', '', 'g')) >= 3
        and length(regexp_replace(coalesce(h.recipient_zip, ''), '\D', '', 'g')) >= 3
        and zc.zone between 1 and 8
      limit 1
    ) as zone
  from heavy h
),
z as (
  select
    h.*,
    coalesce(
      case when h.stored_zone between 1 and 8 then h.stored_zone end,
      rz.zone,
      cz.zone
    ) as zone
  from heavy h
  join raw_zone rz   on rz.id = h.id
  join chart_zone cz on cz.id = h.id
),
-- The two lookups, at the row the code now asks for and at the row the cap
-- used to force it to. Presence and rate are read separately on purpose: a
-- cell priced at 0 is a real agreed rate -- a lane somebody made free -- and
-- coalescing past it would file that cell as absent.
lk as (
  select
    z.*,
    (select r.rate from client_zone_rates r
      where r.client_id = z.client_id and r.zone = z.zone
        and r.weight_lb = z.real_row
        and r.carrier = z.carrier and r.service = z.service limit 1) as new_specific,
    (select r.rate from client_zone_rates r
      where r.client_id = z.client_id and r.zone = z.zone
        and r.weight_lb = z.real_row
        and r.carrier = '' and r.service = '' limit 1)               as new_blanket,
    (select r.rate from client_zone_rates r
      where r.client_id = z.client_id and r.zone = z.zone
        and r.weight_lb = 20
        and r.carrier = z.carrier and r.service = z.service limit 1) as old_specific,
    (select r.rate from client_zone_rates r
      where r.client_id = z.client_id and r.zone = z.zone
        and r.weight_lb = 20
        and r.carrier = '' and r.service = '' limit 1)               as old_blanket
  from z
),
d as (
  select
    lk.*,
    -- Exact carrier/service wins over the blanket card, which is the order
    -- resolveZoneRate tries them in and why this is not a `least`/`greatest`.
    case when lk.new_specific is not null then lk.new_specific else lk.new_blanket end as new_rate,
    case when lk.old_specific is not null then lk.old_specific else lk.old_blanket end as old_rate
  from lk
)
select
  case
    when d.zone is null
      then 'no zone -- the zone card was never consulted, so the cap did nothing here'
    when d.old_rate is null and d.new_rate is null
      then 'unpriced on the zone card before and after -- no change'
    when d.old_rate is not null and d.new_rate is null
      then 'LOSES its zone cell -- now falls to the legacy card (see PART 2)'
    when d.old_rate is null and d.new_rate is not null
      then 'GAINS a zone cell -- the cap was hiding a row that exists'
    when d.new_rate > d.old_rate
      then 'REPRICED UP -- was billed the 20 LB cell, now billed its own row'
    when d.new_rate < d.old_rate
      then 'REPRICED DOWN -- its own row is cheaper than the 20 LB cell'
    else 'same rate at both rows -- no money moves'
  end                                                   as outcome,
  d.client,
  count(*)                                              as shipments,
  min(d.real_row)                                       as lightest_row_wanted,
  max(d.real_row)                                       as heaviest_row_wanted,
  sum(d.old_rate)                                       as billed_at_the_cap,
  sum(d.new_rate)                                       as billed_at_the_real_row,
  sum(d.new_rate) - sum(d.old_rate)                     as difference,
  sum(d.actual_cost)                                    as carrier_cost,
  min(d.ship_date)::date                                as oldest,
  max(d.ship_date)::date                                as newest
from d
group by 1, 2
order by 1, abs(coalesce(sum(d.new_rate) - sum(d.old_rate), 0)) desc;

-- HOW TO READ IT.
--
-- 'REPRICED UP' with a positive `difference`: revenue the cap was giving away.
--   This is the case the removal exists for, and the figure is the recovery.
-- 'GAINS a zone cell': stronger version of the same -- these were unpriced or
--   priced off the legacy card and now have their contracted cell.
-- 'LOSES its zone cell': the one to check before deploying. These had a 20 LB
--   cell and have no cell at their real row, so they now go to the legacy
--   card. PART 2 is about them.
-- 'REPRICED DOWN': a client's card charges less for the heavier row than for
--   20 LB. That is odd and worth looking at the card, but it is still the
--   agreed cell for that weight and so still the right number.
-- 'no zone': unaffected. resolveZoneRate is never reached without a zone.
-- 'same rate at both rows': unaffected, and the honest shape of a card that
--   really is flat above 20.


-- ---------------------------------------------------------------------------
-- PART 2 -- the shipments that LOSE their zone cell, named.
-- ---------------------------------------------------------------------------
-- Run this only if PART 1 shows a 'LOSES its zone cell' row. Per shipment,
-- because the decision is per cell: either the client's card gets a row at
-- that weight, or the shipment is correctly unpriced and somebody quotes it.
--
-- Note what losing the cell is NOT. It is not a $0 and not a wrong price: the
-- shipment falls to matchLegacyRate, which refuses a weight outside every band
-- and names the bands in the reason, so it lands in the unpriced reports with
-- an explanation. That is the designed failure, and it is strictly better than
-- the invoice it replaces -- the 20 LB rate on a heavier parcel, which no
-- report could ever flag because it is a real rate from a real row.
with heavy as (
  select
    s.id, s.client_id, s.carrier, s.service, s.client_rate, s.actual_cost,
    s.order_number, s.tracking_number, s.ship_date, s.weight,
    s.zone as stored_zone, s.recipient_zip, s.raw_data,
    c.name as client, c.origin_zip,
    ceil(s.weight / 16.0)::int as real_row
  from shipments s
  join clients c on c.id = s.client_id
  where s.weight is not null and s.weight > 320
),
z as (
  select
    h.*,
    coalesce(
      case when h.stored_zone between 1 and 8 then h.stored_zone end,
      (
        select q.n
        from (
          select case when t.v ~ '^\s*[0-9]+\s*$' then trim(t.v)::int end as n, t.ord
          from unnest(array[
            h.raw_data ->> 'zone',
            h.raw_data ->> 'shippingZone',
            h.raw_data -> 'advancedOptions' ->> 'zone',
            h.raw_data -> 'shipTo' ->> 'zone'
          ]) with ordinality as t(v, ord)
        ) q
        where q.n between 1 and 8
        order by q.ord
        limit 1
      ),
      (
        select zc.zone
        from zone_chart zc
        where zc.origin_prefix = left(regexp_replace(coalesce(h.origin_zip, ''), '\D', '', 'g'), 3)
          and zc.dest_prefix   = left(regexp_replace(coalesce(h.recipient_zip, ''), '\D', '', 'g'), 3)
          and length(regexp_replace(coalesce(h.origin_zip, ''), '\D', '', 'g')) >= 3
          and length(regexp_replace(coalesce(h.recipient_zip, ''), '\D', '', 'g')) >= 3
          and zc.zone between 1 and 8
        limit 1
      )
    ) as zone
  from heavy h
)
select
  z.client,
  z.order_number,
  z.tracking_number,
  z.ship_date::date                        as ship_date,
  concat_ws(' / ', z.carrier, z.service)   as service,
  z.weight                                 as weight_oz,
  z.real_row                               as row_it_needs,
  z.zone,
  z.client_rate                            as billed_today,
  z.actual_cost,
  -- The cell it is losing, so the size of the change is on the same line as
  -- the shipment losing it.
  coalesce(
    (select r.rate from client_zone_rates r
      where r.client_id = z.client_id and r.zone = z.zone and r.weight_lb = 20
        and r.carrier = z.carrier and r.service = z.service limit 1),
    (select r.rate from client_zone_rates r
      where r.client_id = z.client_id and r.zone = z.zone and r.weight_lb = 20
        and r.carrier = '' and r.service = '' limit 1)
  )                                        as rate_at_the_old_cap,
  -- And the heaviest row the client's card DOES carry for this lane, which is
  -- the number somebody needs in order to decide whether to extend the card or
  -- to quote the shipment by hand.
  (select max(r.weight_lb) from client_zone_rates r
    where r.client_id = z.client_id and r.zone = z.zone
      and ((r.carrier = z.carrier and r.service = z.service)
        or (r.carrier = '' and r.service = ''))) as heaviest_row_on_the_card
from z
where z.zone is not null
  and not exists (
    select 1 from client_zone_rates r
    where r.client_id = z.client_id and r.zone = z.zone and r.weight_lb = z.real_row
      and ((r.carrier = z.carrier and r.service = z.service)
        or (r.carrier = '' and r.service = ''))
  )
  and exists (
    select 1 from client_zone_rates r
    where r.client_id = z.client_id and r.zone = z.zone and r.weight_lb = 20
      and ((r.carrier = z.carrier and r.service = z.service)
        or (r.carrier = '' and r.service = ''))
  )
order by z.client, z.real_row desc, z.ship_date desc;


-- ---------------------------------------------------------------------------
-- PART 3 -- what the cards actually carry, which is the measurement the cap
--           contradicted.
-- ---------------------------------------------------------------------------
-- Read-only. One row per client/carrier/service, so "the matrix tops out at
-- 20 LB" can be checked rather than believed. Any `heaviest_row` above 20 is a
-- set of cells the capped code could not reach.
select
  c.name                                                  as client,
  nullif(r.carrier, '')                                   as carrier,
  nullif(r.service, '')                                   as service,
  min(r.weight_lb)                                        as lightest_row,
  max(r.weight_lb)                                        as heaviest_row,
  count(distinct r.weight_lb)                             as distinct_rows,
  count(distinct r.zone)                                  as distinct_zones,
  count(*)                                                as cells,
  count(*) filter (where r.weight_lb > 20)                as cells_the_cap_hid
from client_zone_rates r
join clients c on c.id = r.client_id
group by 1, 2, 3
order by max(r.weight_lb) desc, 1;
