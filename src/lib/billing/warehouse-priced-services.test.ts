import { describe, it, expect } from 'vitest'
import { pricedServices } from './warehouse-priced-services'
import type { WarehouseRateRow } from './warehouse-log-rate'

// ============================================================
// Why this function exists, and why it delegates.
//
// The warehouse daily log used to render one fixed list of actions for every
// client, from WAREHOUSE_SERVICE_TYPES. A probe against production showed that
// list matches almost nothing: of 9 active clients x 5 new actions, ZERO were
// priced. Not because the work was unpriced -- the cards carry
// `inbound_pallet_handling`, `loose_case`, `special_tasks_(...)` -- but because
// the names on the cards are the price list's names, not the constant's. The
// cards do not even agree with each other: `package_received` exists on one
// client only, `inbound_pallet_handling` is 7/pallet on two clients and 20 on a
// third, and the shrink-wrap line is spelled two different ways.
//
// So the fixed list cannot be made correct by renaming it. Any constant is
// right for some clients and silently NO LINE for the rest -- and a NO LINE is
// work that gets logged and never billed, which is the failure this whole area
// has been closing all week.
//
// The fix is to stop guessing: derive each client's actions from that client's
// own card.
//
// DELEGATION IS THE POINT. This function does not re-decide what "priced"
// means -- it calls priceServiceLine, the same function POST /api/warehouse/log
// prices with. If it re-implemented the conditions, the screen could offer an
// action that the save then refuses, or hide one the save would have accepted.
// Those two disagreeing is worse than either being wrong alone, because the
// operator would be looking at a menu that lies about what is billable.
// ============================================================

const DATE = '2026-10-14'

const row = (o: Partial<WarehouseRateRow>): WarehouseRateRow => ({
  id: 'r1', service_type: 'storage', rate: 10, ...o,
})

describe('pricedServices', () => {
  describe('card states', () => {
    it('reports no-card for a client with nothing at all', () => {
      // Four of the nine active clients are in exactly this state. Every
      // warehouse service for them is unbillable, not just the new ones, and
      // the old screen rendered them a full menu of actions anyway.
      // structuredCount 0 because there are no rows -- not because the count
      // was skipped on this path. The early return reports it too.
      expect(pricedServices([], DATE))
        .toEqual({ state: 'no-card', services: [], structuredCount: 0 })
    })

    it('reports structured-only when the card holds charge_type lines it cannot price from', () => {
      /**
       * Nayax: 18 structured lines and one legacy row. A price WAS agreed --
       * in a shape this screen does not read. That is a different finding from
       * "no price agreed" and sends someone somewhere different, so it must
       * not collapse into no-card.
       */
      const card = [
        row({ id: 'a', service_type: null, charge_type: 'receiving' }),
        row({ id: 'b', service_type: null, charge_type: 'storage' }),
      ]
      expect(pricedServices(card, DATE))
        .toEqual({ state: 'structured-only', services: [], structuredCount: 2 })
    })

    it('reports none-priced when legacy lines exist but none can be priced', () => {
      /**
       * Distinct from structured-only: there ARE service_type lines, they just
       * cannot be used -- expired, duplicated, or carrying no rate. Telling the
       * operator "no rate card" here would be false and would send them to add
       * a card that already exists.
       */
      const card = [row({ id: 'a', service_type: 'storage', effective_to: '2026-01-01' })]
      expect(pricedServices(card, DATE))
        .toEqual({ state: 'none-priced', services: [], structuredCount: 0 })
    })
  })

  describe('what gets offered', () => {
    it('offers each priced service with its agreed rate and unit', () => {
      const card = [
        row({ id: 'a', service_type: 'inbound_pallet_handling', rate: 7, unit: 'per_pallet' }),
        row({ id: 'b', service_type: 'loose_case', rate: '0.30', unit: 'per_unit' }),
      ]
      expect(pricedServices(card, DATE)).toEqual({
        state: 'priced',
        services: [
          { service_type: 'inbound_pallet_handling', rate: 7, unit: 'per_pallet' },
          { service_type: 'loose_case', rate: 0.3, unit: 'per_unit' },
        ],
        // A card with no structured partition has nothing extra to say, and
        // the screen shows no note. Creative Pea and SitnStand are this shape.
        structuredCount: 0,
      })
    })

    it('carries the SAME rate the save will use, not a re-read of the row', () => {
      /**
       * `'0.30'` above arrives as a string from numeric(10,2) and is offered as
       * the number 0.3, because that is what priceServiceLine returns and what
       * the log will bill. If this function showed the raw cell while the save
       * used the parsed value, the screen and the invoice could differ by a
       * coercion -- which is precisely the class of bug that put a `?? 0` on
       * this path in the first place.
       */
      const [only] = pricedServices(
        [row({ service_type: 'storage', rate: '25.00' })], DATE).services
      expect(only.rate).toBe(25)
      expect(typeof only.rate).toBe('number')
    })

    it('offers a deliberate 0 but never a null', () => {
      /**
       * 0 is a decision -- this service is free -- and it must survive to the
       * screen as an offer. null is UNKNOWN and must not be offered at all.
       * Both halves asserted here because the obvious implementation
       * (`if (!rate) continue`) drops the first along with the second.
       */
      const card = [
        row({ id: 'a', service_type: 'free_thing', rate: 0, unit: 'per_unit' }),
        row({ id: 'b', service_type: 'unknown_thing', rate: null }),
      ]
      const { services } = pricedServices(card, DATE)
      expect(services).toEqual([
        { service_type: 'free_thing', rate: 0, unit: 'per_unit' },
      ])
    })

    it('withholds a service whose live rows are ambiguous', () => {
      /**
       * Two live rows for one service: priceServiceLine refuses rather than
       * picking by sort order, and so must this. Offering the action would
       * invite work that the save then rejects.
       *
       * Reachable, not hypothetical: the no-overlap constraint is keyed
       * `charge_type with =`, and NULL never conflicts in an exclusion
       * constraint -- so the legacy rows this screen reads are exactly the
       * rows that constraint does not cover.
       */
      const card = [
        row({ id: 'a', service_type: 'storage', rate: 10 }),
        row({ id: 'b', service_type: 'storage', rate: 99 }),
      ]
      expect(pricedServices(card, DATE))
        .toEqual({ state: 'none-priced', services: [], structuredCount: 0 })
    })

    it('offers the service that IS priced even when a sibling is not', () => {
      // A single bad line must not take the whole card down with it.
      const card = [
        row({ id: 'a', service_type: 'storage', rate: 10, unit: 'per_unit' }),
        row({ id: 'b', service_type: 'broken', rate: null }),
      ]
      expect(pricedServices(card, DATE).services).toEqual([
        { service_type: 'storage', rate: 10, unit: 'per_unit' },
      ])
    })

    it('respects the effective window, so a future rate is not offered today', () => {
      const card = [
        row({ id: 'a', service_type: 'storage', rate: 10, effective_from: '2027-01-01' }),
      ]
      expect(pricedServices(card, DATE).services).toEqual([])
    })

    it('offers a service whose window opens exactly today', () => {
      // Half-open [from, to): `from === date` is in effect. Pinned because an
      // off-by-one here silently hides a rate on its first day.
      const card = [
        row({ id: 'a', service_type: 'storage', rate: 10, unit: 'per_unit', effective_from: DATE }),
      ]
      expect(pricedServices(card, DATE).services).toEqual([
        { service_type: 'storage', rate: 10, unit: 'per_unit' },
      ])
    })

    it('does NOT offer a service whose window closes exactly today', () => {
      // The other half of [from, to): `to === date` is already over.
      const card = [row({ id: 'a', service_type: 'storage', rate: 10, effective_to: DATE })]
      expect(pricedServices(card, DATE).services).toEqual([])
    })
  })

  describe('shapes that must not become actions', () => {
    it('ignores blank and whitespace-only service_type', () => {
      /**
       * A blank name would render as an unlabelled row the operator cannot
       * identify, and would be submitted as a service_type of ''. Dropped
       * here rather than filtered in the component, so every caller gets the
       * same answer.
       */
      const card = [
        row({ id: 'a', service_type: '', rate: 1 }),
        row({ id: 'b', service_type: '   ', rate: 1 }),
        row({ id: 'c', service_type: null, rate: 1 }),
      ]
      expect(pricedServices(card, DATE))
        .toEqual({ state: 'none-priced', services: [], structuredCount: 0 })
    })

    it('lists each service once even when the card repeats it in dead rows', () => {
      /**
       * One live row plus an expired one is a normal, correct card -- a rate
       * that changed. It must appear once, at the live price, not twice and
       * not as ambiguous.
       */
      const card = [
        row({ id: 'old', service_type: 'storage', rate: 5, unit: 'per_unit', effective_to: '2026-06-01' }),
        row({ id: 'new', service_type: 'storage', rate: 8, unit: 'per_unit', effective_from: '2026-06-01' }),
      ]
      expect(pricedServices(card, DATE).services).toEqual([
        { service_type: 'storage', rate: 8, unit: 'per_unit' },
      ])
    })

    it('reads the unit off the LIVE row, not whichever row comes first', () => {
      /**
       * The test above cannot catch this: both its rows carry 'per_unit', so
       * an implementation that reads the unit from the expired line still
       * passes. Here the rate changed basis as well as amount -- per_unit to
       * per_pallet, which is a real thing a rate renegotiation does -- and
       * picking the wrong row shows the operator "8.00 per_unit" while the
       * save bills 8.00 per pallet.
       *
       * The expired row is listed FIRST so that a `.find()` without the
       * in-effect predicate lands on it.
       */
      const card = [
        row({ id: 'old', service_type: 'storage', rate: 5, unit: 'per_unit', effective_to: '2026-06-01' }),
        row({ id: 'new', service_type: 'storage', rate: 8, unit: 'per_pallet', effective_from: '2026-06-01' }),
      ]
      expect(pricedServices(card, DATE).services).toEqual([
        { service_type: 'storage', rate: 8, unit: 'per_pallet' },
      ])
    })

    it('is priced, not structured-only, when the card holds BOTH partitions', () => {
      /**
       * Nayax's shape plus one usable legacy line. The structured lines are
       * then beside the point: the screen is usable, and reporting
       * structured-only would send someone to the charge calculator for work
       * this screen can bill today.
       *
       * This pins the ORDER of the two checks in the implementation. Testing
       * the structured condition before the services condition typechecks,
       * reads naturally, and is wrong only in this combination.
       */
      const card = [
        row({ id: 'a', service_type: null, charge_type: 'receiving' }),
        row({ id: 'b', service_type: 'storage', rate: 25, unit: 'per_pallet' }),
      ]
      expect(pricedServices(card, DATE)).toEqual({
        state: 'priced',
        services: [{ service_type: 'storage', rate: 25, unit: 'per_pallet' }],
        // Counted and reported even though the state is `priced`. This is the
        // Nayax case in miniature, and it is why structuredCount exists: the
        // state says the form works, and this says what is not in it.
        structuredCount: 1,
      })
    })

    it('orders services by name so the menu does not reshuffle between loads', () => {
      /**
       * Row order from PostgREST is not guaranteed. An operator who has
       * learned where "storage" sits should not find it somewhere else
       * tomorrow -- misclicks on this screen become wrong invoices.
       */
      const card = [
        row({ id: 'a', service_type: 'storage', rate: 1 }),
        row({ id: 'b', service_type: 'devan_40ft', rate: 2 }),
        row({ id: 'c', service_type: 'loose_case', rate: 3 }),
      ]
      expect(pricedServices(card, DATE).services.map(s => s.service_type))
        .toEqual(['devan_40ft', 'loose_case', 'storage'])
    })

    it('reports a missing unit as null rather than inventing one', () => {
      // The unit is shown to the operator next to the rate. Guessing
      // 'per_unit' would put a number on screen that nobody agreed to.
      expect(pricedServices([row({ service_type: 'storage', rate: 4 })], DATE).services)
        .toEqual([{ service_type: 'storage', rate: 4, unit: null }])
    })
  })

  describe('structuredCount', () => {
    /**
     * Nayax as production actually holds it, measured 2026-10-14 by
     * supabase/verify/warehouse_log_gap_by_client.sql: 19 rows, 18 structured,
     * exactly ONE loggable action (storage @25.00 per_pallet).
     *
     * This is the shape that `state` alone describes badly. It is `priced`,
     * which is true -- and it was all the screen said, so an operator saw one
     * box and nothing about the eighteen other priced lines.
     */
    const nayax = [
      ...Array.from({ length: 18 }, (_, i) =>
        row({ id: `s${i}`, service_type: null, charge_type: `receiving_${i}` })),
      row({ id: 'legacy', service_type: 'storage', rate: 25, unit: 'per_pallet' }),
    ]

    it('counts the structured lines on a card that is still priced', () => {
      const card = pricedServices(nayax, DATE)
      expect(card.state).toBe('priced')
      expect(card.services).toHaveLength(1)
      expect(card.structuredCount).toBe(18)
    })

    it('counts only charge_type rows, not every row that is not loggable', () => {
      /**
       * A null rate and an expired window are also not loggable, and both
       * belong on the rate card rather than the charge calculator. Counting
       * them here would tell the operator to go bill them somewhere that
       * cannot bill them.
       */
      const card = [
        row({ id: 'a', service_type: 'storage', rate: 25 }),
        row({ id: 'b', service_type: 'broken', rate: null }),
        row({ id: 'c', service_type: 'gone', rate: 9, effective_to: '2026-01-01' }),
      ]
      expect(pricedServices(card, DATE).structuredCount).toBe(0)
    })

    it('counts a structured row even when it ALSO carries a service_type', () => {
      /**
       * Both columns populated on one row is not hypothetical -- charge_type
       * and service_type were added in different migrations and nothing
       * forbids the combination. The row is priceable here AND billed by the
       * calculator, so it is counted: the note says what else exists, not what
       * is missing.
       */
      const card = [
        row({ id: 'a', service_type: 'storage', rate: 25, charge_type: 'storage' }),
      ]
      const result = pricedServices(card, DATE)
      expect(result.state).toBe('priced')
      expect(result.structuredCount).toBe(1)
    })
  })

  describe('agreement with the function that actually bills', () => {
    it('never offers a service that priceServiceLine would refuse', () => {
      /**
       * The contract, stated as a property rather than a case. Every service
       * this function offers must price; every one it withholds must not.
       * Checked across a card that contains one row of each failure mode, so
       * a future edit that loosens one condition here but not there fails.
       */
      const card: WarehouseRateRow[] = [
        row({ id: '1', service_type: 'good', rate: 3, unit: 'per_unit' }),
        row({ id: '2', service_type: 'zero', rate: 0, unit: 'per_unit' }),
        row({ id: '3', service_type: 'nullrate', rate: null }),
        row({ id: '4', service_type: 'emptyrate', rate: '' }),
        row({ id: '5', service_type: 'expired', rate: 5, effective_to: '2026-01-01' }),
        row({ id: '6', service_type: 'dup', rate: 1 }),
        row({ id: '7', service_type: 'dup', rate: 2 }),
      ]
      const offered = pricedServices(card, DATE).services.map(s => s.service_type)
      expect(offered).toEqual(['good', 'zero'])
    })
  })
})
