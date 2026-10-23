-- WHICH RATES ARE MISSING -- reconstructed from the database.
--
-- WHY THIS EXISTS.
--
-- recalculateShipments() already answers this question. It returns `reasons`:
-- every reason it could not price a shipment, counted, with an example order
-- number. But that answer lives only in the HTTP response to a staff browser
-- session. Before 345a3d3 the dashboard rendered only the totals and dropped
-- `reasons` on the floor, and the other delivery path -- the monitor email --
-- has been dark since MONITOR_EMAIL was unset on 2026-10-15. So the list was
-- computed several times a day and never seen.
--
-- This query recovers it from the OUTCOME the run wrote, so it can be answered
-- today without a deploy and re-checked later without clicking anything.
--
-- HOW IT MIRRORS THE CODE. The buckets below are not invented categories; they
-- are the branches of matchLegacyRate() in src/lib/billing/shipment-rate.ts,
-- in the order that function tries them, with its two predicates translated
-- exactly rather than approximated:
--
--   cardRowCovers (:61) -- `!rowCarrier || carrier.includes(rowCarrier)
--     || rowCarrier.includes(carrier)`, lowercased. The Postgres equivalent is
--     the two position() tests below. The empty-string case needs no separate
--     arm: position('' in anything) is 1 in Postgres exactly as ''.includes()
--     is true in JS, so a card row with a blank carrier matches every carrier
--     in both languages, and a shipment with a NULL carrier matches every row.
--     That second one is a quirk of the bidirectional test, not a bug here --
--     it is what the pricing code does, so it is what this query must do.
--
--   bandCovers (:113) -- inclusive at both ends, with a NULL bound meaning
--     unbounded in that direction.
--
-- WHAT IT CANNOT SEE, AND WHY THAT MATTERS.
--
-- 1. SKIPPED ROWS ARE INVISIBLE. When a rate-card read or a zone read fails,
--    recalculate deliberately writes NOTHING (recalculate.ts:150, :178, :188)
--    so a failed read cannot destroy a good price from an earlier run. Those
--    rows therefore keep whatever rate they already had and do not appear
--    below. A clean result here does NOT mean the last run was clean -- it
--    means nothing was left unpriced. `skipped` is only observable in the run
--    output, which is what the dashboard panel now shows.
--
-- 2. THE ZONE MATRIX IS A SEPARATE PATH, tried first (recalculate.ts:164).
--    Every row below failed BOTH the matrix and the legacy card, so every row
--    is a genuine gap -- but for a client priced off an 800-cell matrix the
--    right fix may be a matrix cell, not a legacy card row. That is why bucket
--    B says "no LEGACY card"; matchLegacyRate's own comment at :213 makes the
--    same point, that the legacy card "can only ever describe itself".
--
-- 3. It reads the state as of the last run that touched each row, not a fresh
--    computation. Run the recalculation first, then this.
--
-- Safe to run repeatedly: SELECT only, no writes.

select
  c.name                                             as client,
  coalesce(s.carrier, '(none)')                      as carrier,
  coalesce(s.service, '(none)')                      as service,

  case
    -- Bucket A. matchLegacyRate refuses before looking at the card at all
    -- (shipment-rate.ts:150). billed_weight is NULL only when billedWeightOf()
    -- rejected the weight, so this is "nobody weighed it", not "it is light".
    -- Pricing it from `weight ?? 0` would pick the LIGHTEST band -- the
    -- cheapest answer, on no evidence -- which is why the rate is null instead.
    when s.billed_weight is null then
      'A. not weighed -- no billed weight, so no band can be chosen'

    -- Bucket B. The card is empty for this client (shipment-rate.ts:163).
    when not exists (
      select 1 from client_shipping_rates r where r.client_id = s.client_id
    ) then
      'B. this client has no legacy shipping rate card at all'

    -- Bucket C. The card exists but has no row for this carrier/service
    -- (shipment-rate.ts:177). A row for another carrier is deliberately NOT
    -- used as a fallback: that bills a real amount from the wrong agreement.
    when not exists (
      select 1 from client_shipping_rates r
      where r.client_id = s.client_id
        and (position(lower(coalesce(r.carrier, '')) in lower(coalesce(s.carrier, ''))) > 0
          or position(lower(coalesce(s.carrier, '')) in lower(coalesce(r.carrier, ''))) > 0)
        and (position(lower(coalesce(r.service, '')) in lower(coalesce(s.service, ''))) > 0
          or position(lower(coalesce(s.service, '')) in lower(coalesce(r.service, ''))) > 0)
    ) then
      'C. no card row covers this carrier/service'

    -- Bucket D. Rows cover the carrier/service, but none covers this weight
    -- (shipment-rate.ts:194). The heaviest band is NOT used as a fallback --
    -- for a parcel under the lightest band that overcharges by the full
    -- difference.
    when not exists (
      select 1 from client_shipping_rates r
      where r.client_id = s.client_id
        and (position(lower(coalesce(r.carrier, '')) in lower(coalesce(s.carrier, ''))) > 0
          or position(lower(coalesce(s.carrier, '')) in lower(coalesce(r.carrier, ''))) > 0)
        and (position(lower(coalesce(r.service, '')) in lower(coalesce(s.service, ''))) > 0
          or position(lower(coalesce(s.service, '')) in lower(coalesce(r.service, ''))) > 0)
        and (r.weight_min is null or s.billed_weight >= r.weight_min)
        and (r.weight_max is null or s.billed_weight <= r.weight_max)
    ) then
      'D. weight falls outside every band for this carrier/service'

    -- Bucket E. The card looks like it covers this row, so the null rate came
    -- from somewhere else: an ambiguous band (two rows, different prices, both
    -- covering), a non-numeric rate cell, or a row this run skipped and never
    -- rewrote. Not expected to be large; if it is, read the run output.
    else
      'E. card appears to cover this -- ambiguous band, bad rate cell, or stale'
  end                                                as gap,

  count(*)                                           as shipments,

  -- Ounces in the column, pounds for a human. recalculate compares
  -- billed_weight against weight_min/weight_max directly, both in OUNCES, so
  -- the band you add must be in ounces too -- 1 LB is 16.
  round(min(s.billed_weight) / 16.0, 2)              as min_lb,
  round(max(s.billed_weight) / 16.0, 2)              as max_lb,
  min(s.billed_weight)                               as min_oz,
  max(s.billed_weight)                               as max_oz,

  -- What this gap is costing. actual_cost is what the carrier billed US; with
  -- no client_rate there is nothing billed to the client against it, so this
  -- column is money out with no agreed money in. coalesce to 0 only for the
  -- sum, and count the unknowns separately so the total is never mistaken for
  -- complete -- a null actual_cost is an unknown cost, not a free shipment.
  round(sum(coalesce(s.actual_cost, 0))::numeric, 2) as carrier_cost_unbilled,
  count(*) filter (where s.actual_cost is null)      as cost_also_unknown,

  min(s.order_number)                                as example_order,
  min(s.ship_date)                                   as first_seen,
  max(s.ship_date)                                   as last_seen

from shipments s
join clients c on c.id = s.client_id
where s.client_rate is null
  and s.client_id is not null
group by 1, 2, 3, 4
order by count(*) desc, carrier_cost_unbilled desc;
