-- THE VERDICT -- one row per fix, so nothing scrolls off the grid.
--
-- The previous query (rate_card_gaps_no_zone_2026_10_22.sql) returned 17 rows
-- and the Supabase grid shows 13 at a time, so four went unread. This one
-- collapses the same population to at most five rows, each naming the action.
--
-- WHAT THE 13 READABLE ROWS ALREADY ESTABLISHED.
--
-- 1. carrier_sent_a_zone was FALSE on every row -- UPS and Stamps.com alike.
--    So zone_chart is the only zone source in play for both carriers, not just
--    USPS. That is worth knowing before anyone decides which carrier's chart
--    the single carrier-less zone_chart table should hold.
--
-- 2. Every US prefix seen was one of Section A's fourteen: 967 and 968
--    (Hawaii), 995 and 996 (Alaska), 007 (Puerto Rico). Not one new prefix.
--    Section A of scripts/proposed-zone-chart-198.sql -- written 2026-09-29,
--    reviewed, never run -- adds exactly these.
--
-- 3. Three FOREIGN rows came back with chart_has_this_lane = TRUE: Canada 475,
--    Australia 229, Spain 151. The chart would have answered all three. That is
--    precisely the collision zones.ts:198 refuses on purpose, caught live --
--    foreign postcodes whose digits happen to name real US prefixes. The guard
--    is doing its job; those shipments are unpriced instead of wrongly priced.
--
-- The four unread rows are one above the fold (cost > $29.75) and three below
-- it (cost < $9.98). This query is how we see them without guessing.
--
-- WHY THE BUCKETS ARE IN THIS ORDER. Same reason matchLegacyRate's branches
-- are: each one is only reached when the ones above it did not apply, so a
-- shipment lands in exactly one and the counts add up to the population.
-- Foreign is first because zones.ts tests it first and refuses outright.
--
-- NOTE ON AN UNRECORDED COUNTRY. `NULL not in ('US','USA')` is NULL, not true,
-- so a shipment with no country recorded falls THROUGH the foreign branch and
-- is treated as domestic. That is deliberate and it matches zones.ts:139
-- exactly: almost every domestic row has no country in raw_data at all, so
-- reading absent as foreign would stop pricing the entire book.
--
-- Safe to run repeatedly: SELECT only, no writes.

select
  case
    when coalesce(s.raw_data->'shipTo'->>'country', s.raw_data->>'country')
         not in ('US', 'USA')
      then 'A. foreign destination -- needs a legacy card row; no matrix can reach it'

    when length(regexp_replace(coalesce(s.recipient_zip, ''), '[^0-9]', '', 'g')) < 3
      then 'B. unusable recipient zip -- fewer than 3 digits, chart never consulted'

    when left(regexp_replace(coalesce(s.recipient_zip, ''), '[^0-9]', '', 'g'), 3)
         in ('006','007','008','009','340','876','967','968','969','995','996','997','998','999')
      then 'C. SECTION A ALREADY COVERS THIS -- the fix is written and unrun'

    when not exists (
      select 1 from zone_chart zc
      where zc.origin_prefix = '198'
        and zc.dest_prefix = left(regexp_replace(coalesce(s.recipient_zip, ''),
                                                 '[^0-9]', '', 'g'), 3)
    )
      then 'D. NEW -- prefix absent from zone_chart and NOT in Section A'

    else 'E. chart has the lane -- the zone failed for some other reason'
  end                                                      as verdict,

  count(*)                                                 as shipments,
  count(distinct left(regexp_replace(coalesce(s.recipient_zip, ''),
                                     '[^0-9]', '', 'g'), 3)) as distinct_prefixes,
  string_agg(distinct left(regexp_replace(coalesce(s.recipient_zip, ''),
                                          '[^0-9]', '', 'g'), 3), ', ') as prefixes,
  string_agg(distinct coalesce(s.raw_data->'shipTo'->>'country',
                               s.raw_data->>'country', 'US/unrecorded'), ', ') as countries,
  round(sum(coalesce(s.actual_cost, 0))::numeric, 2)       as carrier_cost_unbilled,
  min(s.order_number)                                      as example_order

from shipments s
where s.client_rate is null
  and s.client_id is not null
  and s.zone is null
group by 1
order by carrier_cost_unbilled desc;
