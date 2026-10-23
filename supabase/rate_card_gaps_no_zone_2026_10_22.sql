-- WHY NO ZONE COULD BE NAMED -- third and last query in the chain.
--
-- WHERE THIS CAME FROM.
--
--   rate_card_gaps_2026_10_22.sql          -> 14 lanes, 29 shipments, $784.01,
--                                             ALL of them bucket B ("no legacy
--                                             rate card"), which turned out to
--                                             be true and misleading.
--   rate_card_gaps_why_zone_missed_...sql  -> every one of those clients HAS a
--                                             zone matrix (40 to 1600 cells).
--                                             So the legacy card was never the
--                                             intended pricing path. The matrix
--                                             missed first, and on 17 of the 29
--                                             it missed for a reason that is not
--                                             about rates at all: no_zone_resolved
--                                             equals the shipment count, so no
--                                             COLUMN of the matrix was choosable.
--
-- This query says why the column could not be chosen, per lane.
--
-- WHAT A NULL shipments.zone PROVES.
--
--   recalculate.ts:242 writes `zone` back ONLY when resolveZone named one
--   (`...(resolvedZone != null ? { zone: resolvedZone } : {})`), and an unpriced
--   row does still get written -- it falls through to the update with
--   client_rate null. So for a row that the last run touched, a null `zone` is
--   not "never computed". It is "computed, and the answer was none".
--
-- THE FOUR WAYS resolveZone (zones.ts:146) ANSWERS NONE.
--
--   1. The destination is recorded and is not US/USA. zones.ts refuses to run a
--      US ZIP-prefix chart on a foreign postcode ON PURPOSE -- before that guard
--      (added 2026-10-13) 'B2Y 1M9' in Nova Scotia became prefix '219' and got
--      priced on the Maryland lane. Four live shipments. A wrong price, not a
--      missing one. `country` below names these.
--   2. There is no recipient zip, or fewer than 3 digits in it. `zip_digits`.
--   3. zone_chart has no row for 198 -> this prefix. `chart_has_this_lane`.
--   4. The carrier did not put a zone in the payload either, which is the only
--      source tried before the chart. `carrier_sent_a_zone`.
--
--   The prefix is derived here exactly as zones.ts:214 derives it: strip every
--   non-digit from recipient_zip, take the first three, and require all three.
--
-- WHAT IS ALREADY KNOWN ABOUT zone_chart, AND IT MATTERS FOR READING THIS.
--
--   scripts/proposed-zone-chart-198.sql, generated 2026-09-29 and NEVER RUN,
--   records two measured facts:
--     - zone_chart holds a UPS ground chart, and the table has no carrier
--       column, so it can only ever hold one carrier's. 71% of real traffic is
--       UPS, so that is the right choice; its Section B (83 USPS corrections)
--       is marked DO NOT RUN for exactly that reason.
--     - its Section A adds 14 prefixes the table is missing ENTIRELY -- Puerto
--       Rico 006-009, USVI 340, 876, Hawaii 967-969, Alaska 995-999. Purely
--       additive, cannot change any existing price, and was simulated at the
--       time to price 5 of the 33 then-unpriced shipments.
--
--   So if `chart_has_this_lane` is false and the prefix is one of those 14,
--   the fix is already written and waiting. If it is false for some OTHER
--   prefix, that is new and Section A will not cover it.
--
-- Safe to run repeatedly: SELECT only, no writes.

select
  c.name                                                        as client,

  coalesce(s.raw_data->'shipTo'->>'country',
           s.raw_data->>'country',
           '(not recorded)')                                    as country,

  coalesce(s.carrier, '(none)')                                 as carrier,

  -- zones.ts:214, translated: strip non-digits, take three.
  coalesce(nullif(left(regexp_replace(coalesce(s.recipient_zip, ''),
                                      '[^0-9]', '', 'g'), 3), ''),
           '(no zip)')                                          as dest_prefix,

  -- Must be >= 3 or the chart is never consulted at all.
  length(regexp_replace(coalesce(s.recipient_zip, ''),
                        '[^0-9]', '', 'g'))                     as zip_digits,

  -- The lookup resolveZone actually performs, for the Wilmington origin every
  -- client on this list is set to.
  exists (
    select 1 from zone_chart zc
    where zc.origin_prefix = '198'
      and zc.dest_prefix = left(regexp_replace(coalesce(s.recipient_zip, ''),
                                               '[^0-9]', '', 'g'), 3)
  )                                                             as chart_has_this_lane,

  -- The source tried BEFORE the chart: a zone the carrier itself returned.
  -- All four keys zones.ts looks at.
  (    (s.raw_data->>'zone')                      is not null
    or (s.raw_data->>'shippingZone')              is not null
    or (s.raw_data->'advancedOptions'->>'zone')   is not null
    or (s.raw_data->'shipTo'->>'zone')            is not null
  )                                                             as carrier_sent_a_zone,

  count(*)                                                      as shipments,
  round(sum(coalesce(s.actual_cost, 0))::numeric, 2)            as carrier_cost_unbilled,
  min(s.order_number)                                           as example_order

from shipments s
join clients c on c.id = s.client_id
where s.client_rate is null
  and s.client_id is not null
  and s.zone is null
group by 1, 2, 3, 4, 5, 6, 7
order by carrier_cost_unbilled desc;
