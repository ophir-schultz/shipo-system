-- WHY THE ZONE MATRIX DID NOT COVER THESE ROWS -- the follow-up to
-- supabase/rate_card_gaps_2026_10_22.sql.
--
-- WHY THIS EXISTS.
--
-- The first query came back with every single row in bucket B: "this client
-- has no legacy shipping rate card at all". That is literally true and almost
-- useless on its own, because six of these clients are not MEANT to be priced
-- off a legacy card. Orcam and Crisp Power are priced off client_zone_rates
-- (zones.ts names them: 1..100 LB for Orcam, 1..27 LB for Crisp Power), and
-- Nayax is priced off the ICL zone rates loaded in
-- supabase/nayax_icl_zone_rates_2026_10.sql.
--
-- So for those rows "no legacy card" is not the gap -- it is the second of two
-- misses, and the FIRST one is the one worth fixing. recalculate.ts tries the
-- matrix first (:164) and only falls through to the card when the matrix
-- answers "no cell". matchLegacyRate's own comment at :213 makes the point
-- that the legacy card "can only ever describe itself", which is why bucket B
-- cannot tell you whether the right fix is a card row or a matrix cell.
--
-- This query answers that. For each unpriced lane it reports what the client's
-- matrix actually holds, so each row resolves to exactly one of:
--
--   no matrix at all           -> a legacy card row IS the fix (bucket B is right)
--   matrix, but not this lane  -> add the carrier/service to the matrix
--   matrix covers the lane,
--     but the weight is past
--     the top row               -> extend the matrix upward (see need_lb_max)
--   matrix covers the lane,
--     weight is in range,
--     but no_zone_resolved > 0  -> not a rate gap. No zone could be named for
--                                  the parcel, so no COLUMN of the matrix can
--                                  be chosen. Usually a foreign destination
--                                  (zones.ts refuses non-US on purpose) or a
--                                  missing origin_zip on the client.
--
-- HOW IT MIRRORS THE CODE.
--
--   The lane test is cardRowCovers (shipment-rate.ts:61), translated the same
--   way as in the first query: bidirectional, lowercased, and an empty string
--   on either side matches everything, because position('' in x) is 1 in
--   Postgres exactly as ''.includes() is true in JS. client_zone_rates.carrier
--   and .service are `not null default ''`, so '' there means "blanket rate
--   card, any carrier" -- the same meaning the code gives it.
--
--   need_lb is weightToLb (zones.ts:85) -- billed weight in OUNCES, divided by
--   16, rounded UP to a whole pound. There is no cap; the 20 LB cap was removed
--   on 2026-10-05 after it was found billing a 25 LB parcel the 20 LB cell.
--
-- WHAT IT CANNOT SEE.
--
--   Whether the zone that WAS resolved is the right one. It reports which zone
--   columns these parcels landed in, not whether the chart named them
--   correctly.
--
-- Safe to run repeatedly: SELECT only, no writes.

select
  c.name                                      as client,
  coalesce(s.carrier, '(none)')               as carrier,
  coalesce(s.service, '(none)')               as service,
  count(*)                                    as shipments,

  -- Does this client have a matrix at all? 0 here means bucket B was the whole
  -- story and a legacy card row is the fix.
  (select count(*) from client_zone_rates z
    where z.client_id = s.client_id)          as matrix_cells_total,

  -- Cells that cover THIS carrier/service, by the code's own predicate.
  (select count(*) from client_zone_rates z
    where z.client_id = s.client_id
      and (position(lower(z.carrier) in lower(coalesce(s.carrier, ''))) > 0
        or position(lower(coalesce(s.carrier, '')) in lower(z.carrier)) > 0)
      and (position(lower(z.service) in lower(coalesce(s.service, ''))) > 0
        or position(lower(coalesce(s.service, '')) in lower(z.service)) > 0)
  )                                           as matrix_cells_this_lane,

  -- The heaviest row the matrix holds for this lane. Compare against
  -- need_lb_max: if it is smaller, the matrix simply does not go up this far.
  (select max(z.weight_lb) from client_zone_rates z
    where z.client_id = s.client_id
      and (position(lower(z.carrier) in lower(coalesce(s.carrier, ''))) > 0
        or position(lower(coalesce(s.carrier, '')) in lower(z.carrier)) > 0)
      and (position(lower(z.service) in lower(coalesce(s.service, ''))) > 0
        or position(lower(coalesce(s.service, '')) in lower(z.service)) > 0)
  )                                           as matrix_top_lb,

  -- Which matrix ROW each parcel needed. weightToLb: ounces / 16, rounded up.
  min(ceil(s.billed_weight / 16.0))           as need_lb_min,
  max(ceil(s.billed_weight / 16.0))           as need_lb_max,

  -- Which matrix COLUMN. A null zone means no column could be chosen at all,
  -- so the matrix was never going to answer however complete it is.
  count(*) filter (where s.zone is null)      as no_zone_resolved,
  min(s.zone)                                 as zone_min,
  max(s.zone)                                 as zone_max,

  -- The commonest reason a zone could not be named: the parcel is not domestic
  -- and zones.ts refuses to run a US ZIP-prefix chart on a foreign postcode.
  count(*) filter (
    where coalesce(s.raw_data->'shipTo'->>'country', s.raw_data->>'country')
          not in ('US', 'USA')
  )                                           as non_us_destination,

  -- The other reason: the client has no warehouse origin to measure from.
  c.origin_zip                                as client_origin_zip,

  round(sum(coalesce(s.actual_cost, 0))::numeric, 2) as carrier_cost_unbilled,
  min(s.order_number)                         as example_order

from shipments s
join clients c on c.id = s.client_id
where s.client_rate is null
  and s.client_id is not null
group by c.name, c.origin_zip, s.client_id, s.carrier, s.service
order by carrier_cost_unbilled desc;
