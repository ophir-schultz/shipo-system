-- WHAT SECTION A WOULD BILL -- simulation only, nothing is written.
--
-- WHY SIMULATE RATHER THAN JUST RUN IT.
--
-- Section A of scripts/proposed-zone-chart-198.sql adds 14 zone_chart rows and
-- would price 17 shipments worth $277.21 of carrier cost that are unpriced
-- today. It is purely additive and ON CONFLICT DO NOTHING, so it cannot change
-- a price already billed. That makes it safe in the sense of "cannot corrupt
-- existing data". It is not automatically safe in the sense that matters here.
--
-- The zones come from the USPS DomesticZoneChart (origin 198, effective
-- 2026-09-01). zone_chart holds a UPS ground chart and has no carrier column.
-- The file's justification for mixing them is a single claim:
--
--   "those 14 prefixes are territories and offshore states absent from the
--    table entirely, and UPS and USPS agree on them"
--
-- That claim cannot be checked from inside this system. There is no UPS chart
-- in the repository, and there is no already-priced Hawaii/Alaska/Puerto Rico
-- shipment to calibrate against -- precisely BECAUSE those prefixes are
-- missing. So the one premise the write rests on is unverified here.
--
-- The cost of being wrong is asymmetric, and in the bad direction. These 17
-- shipments are currently UNPRICED, which is a loud failure that shows up in
-- the monitor and in the gap query. After Section A they are PRICED. If the
-- zone is wrong they become a plausible figure on the wrong lane -- a real
-- agreed rate, formatted to two decimals, indistinguishable from a correct
-- one. That is the same shape as the 20 LB cap, the `|| 0` weight floor and
-- the foreign-postcode collision, all three of which this codebase removed.
--
-- This query is the check that CAN be made from here: price every one of the
-- 17 at the zone Section A proposes, and compare against what the carrier
-- actually billed us. A client rate below our own cost on an offshore lane is
-- the signal that the zone is too low -- i.e. that UPS and USPS do NOT agree.
--
-- HOW TO READ IT.
--
--   rate_at_proposed is null        -> the matrix has no cell for that weight
--                                      and zone, so Section A alone will not
--                                      price the shipment anyway. It would
--                                      fall through to the legacy card and
--                                      stay unpriced. Not a risk, but not a
--                                      fix either.
--   margin_at_proposed < 0          -> we would bill the client LESS than the
--                                      carrier charged us. On an offshore lane
--                                      that is the expected symptom of a zone
--                                      that is too low. Investigate before
--                                      writing.
--   rate_at_zone_8 much higher      -> the answer is sensitive to the zone, so
--                                      getting it right matters. If zone 7 and
--                                      zone 8 are close, the risk is small
--                                      whichever is correct.
--
-- Zones proposed by Section A: 006-009 -> 7, 340 -> 6, 876 -> 8, 967-969 -> 8,
-- 995-999 -> 8. Only 007, 967, 968, 995 and 996 actually occur in the data.
--
-- Carrier/service matching is cardRowCovers (shipment-rate.ts:61), the same
-- bidirectional lowercased substring test the pricing code uses. weight_lb is
-- weightToLb (zones.ts:85): ounces / 16, rounded UP.
--
-- Grouped by client so the result fits on one screen without scrolling.
--
-- Safe to run repeatedly: SELECT only, no writes.

select
  c.name                                                   as client,
  count(*)                                                 as shipments,

  -- What the carrier billed us. Known for all of these -- the first gap query
  -- reported cost_also_unknown = 0 on every lane.
  round(sum(coalesce(s.actual_cost, 0))::numeric, 2)       as our_carrier_cost,

  -- What the client would be billed if Section A's zone is correct.
  round(sum(coalesce((
    select z.rate from client_zone_rates z
    where z.client_id = s.client_id
      and z.weight_lb = ceil(s.billed_weight / 16.0)
      and z.zone = case
        when left(regexp_replace(coalesce(s.recipient_zip, ''), '[^0-9]', '', 'g'), 3)
             in ('006','007','008','009') then 7
        when left(regexp_replace(coalesce(s.recipient_zip, ''), '[^0-9]', '', 'g'), 3)
             = '340' then 6
        else 8
      end
      and (position(lower(z.carrier) in lower(coalesce(s.carrier, ''))) > 0
        or position(lower(coalesce(s.carrier, '')) in lower(z.carrier)) > 0)
      and (position(lower(z.service) in lower(coalesce(s.service, ''))) > 0
        or position(lower(coalesce(s.service, '')) in lower(z.service)) > 0)
    limit 1
  ), 0))::numeric, 2)                                      as would_bill_at_proposed,

  -- Shipments the matrix cannot price even with the zone supplied. These stay
  -- unpriced after Section A; the fix for them is a matrix cell, not a chart row.
  count(*) filter (where not exists (
    select 1 from client_zone_rates z
    where z.client_id = s.client_id
      and z.weight_lb = ceil(s.billed_weight / 16.0)
      and z.zone = case
        when left(regexp_replace(coalesce(s.recipient_zip, ''), '[^0-9]', '', 'g'), 3)
             in ('006','007','008','009') then 7
        when left(regexp_replace(coalesce(s.recipient_zip, ''), '[^0-9]', '', 'g'), 3)
             = '340' then 6
        else 8
      end
      and (position(lower(z.carrier) in lower(coalesce(s.carrier, ''))) > 0
        or position(lower(coalesce(s.carrier, '')) in lower(z.carrier)) > 0)
      and (position(lower(z.service) in lower(coalesce(s.service, ''))) > 0
        or position(lower(coalesce(s.service, '')) in lower(z.service)) > 0)
  ))                                                       as still_no_matrix_cell,

  -- THE RED FLAG. A client rate below our own carrier cost on an offshore lane
  -- is what a too-low zone looks like.
  count(*) filter (where coalesce((
    select z.rate from client_zone_rates z
    where z.client_id = s.client_id
      and z.weight_lb = ceil(s.billed_weight / 16.0)
      and z.zone = case
        when left(regexp_replace(coalesce(s.recipient_zip, ''), '[^0-9]', '', 'g'), 3)
             in ('006','007','008','009') then 7
        when left(regexp_replace(coalesce(s.recipient_zip, ''), '[^0-9]', '', 'g'), 3)
             = '340' then 6
        else 8
      end
      and (position(lower(z.carrier) in lower(coalesce(s.carrier, ''))) > 0
        or position(lower(coalesce(s.carrier, '')) in lower(z.carrier)) > 0)
      and (position(lower(z.service) in lower(coalesce(s.service, ''))) > 0
        or position(lower(coalesce(s.service, '')) in lower(z.service)) > 0)
    limit 1
  ), 0) < coalesce(s.actual_cost, 0))                      as would_bill_below_our_cost,

  string_agg(distinct left(regexp_replace(coalesce(s.recipient_zip, ''),
                                          '[^0-9]', '', 'g'), 3), ', ') as prefixes,
  min(s.order_number)                                      as example_order

from shipments s
join clients c on c.id = s.client_id
where s.client_rate is null
  and s.client_id is not null
  and s.zone is null
  and coalesce(s.raw_data->'shipTo'->>'country', s.raw_data->>'country', 'US')
      in ('US', 'USA')
  and left(regexp_replace(coalesce(s.recipient_zip, ''), '[^0-9]', '', 'g'), 3)
      in ('006','007','008','009','340','876','967','968','969','995','996','997','998','999')
group by c.name
order by our_carrier_cost desc;
