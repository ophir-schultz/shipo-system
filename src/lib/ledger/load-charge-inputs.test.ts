import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createFakeSupabase, type FakeDb } from '@/lib/ledger/fake-supabase'

const h = vi.hoisted(() => ({ db: null as unknown as FakeDb }))
vi.mock('@/lib/supabase', () => ({
  get supabaseAdmin() { return h.db.client },
}))

const { loadChargeInputs, fetchAllPages } =
  await import('@/lib/ledger/load-charge-inputs')

const WINDOW = '2026-09-01'

/** Every table the loader reads, so an unseeded one cannot look like a failure. */
function seed(over: Partial<Record<string, Record<string, unknown>[]>> = {}) {
  h.db = createFakeSupabase({
    orders: [], order_items: [], shipments: [],
    client_warehouse_rates: [], cost_rates: [],
    ...over,
  })
}

const rateRow = (over: Record<string, unknown> = {}) => ({
  id: 'r1', client_id: 'client-a', charge_type: 'pick', variant: 'device',
  rate: 2, rate_type: 'per_unit', effective_from: null, effective_to: null, ...over,
})

beforeEach(() => seed())

describe('fetchAllPages', () => {
  it('keeps reading until a page comes back empty', async () => {
    // Stopping at `length < PAGE_SIZE` reads a server-shortened first page as
    // end-of-table and silently drops every remaining row.
    const all = Array.from({ length: 7 }, (_, i) => ({ id: i }))
    const seenRanges: Array<[number, number]> = []
    const rows = await fetchAllPages<{ id: number }>('test', async (from, to) => {
      seenRanges.push([from, to])
      const page = all.slice(from, from + 3)          // server caps below PAGE_SIZE
      return { data: page, error: null }
    })
    expect(rows).toHaveLength(7)
    expect(seenRanges.length).toBe(4)                 // 3 + 3 + 1 + 0
  })

  it('treats PGRST103 as end of table, not as a failure', async () => {
    let call = 0
    const rows = await fetchAllPages<{ id: number }>('test', async () => {
      call++
      if (call === 1) return { data: [{ id: 1 }], error: null }
      return { data: null, error: { message: 'range not satisfiable', code: 'PGRST103' } }
    })
    expect(rows).toEqual([{ id: 1 }])
  })

  it('names the failing read and keeps the original error', async () => {
    // No error object may be discarded; without the table name every one of
    // these reads produces the same opaque PostgREST string.
    const original = { message: 'permission denied', code: '42501' }
    await expect(fetchAllPages('cost_rates', async () => ({ data: null, error: original })))
      .rejects.toMatchObject({
        message: expect.stringContaining('cost_rates'),
        cause: original,
      })
  })
})

describe('loadChargeInputs — the window', () => {
  it('includes orders with a null order_date and reports how many', async () => {
    // `.gte` is SQL `>=`, and `null >= '2026-09-01'` is NULL, not TRUE. Excluded,
    // such an order is invisible for ever: no future window picks it up either.
    seed({
      orders: [
        { id: 'o-dated', client_id: 'client-a', order_key: 'A1',
          order_number: 'A1', cancelled: false, order_date: '2026-09-10' },
        { id: 'o-undated', client_id: 'client-a', order_key: 'A2',
          order_number: 'A2', cancelled: false, order_date: null },
        { id: 'o-old', client_id: 'client-a', order_key: 'A3',
          order_number: 'A3', cancelled: false, order_date: '2026-01-01' },
      ],
    })
    const warnings: string[] = []

    const inputs = await loadChargeInputs(WINDOW, (ctx) => warnings.push(ctx))

    expect(inputs.map((i) => i.order.id).sort()).toEqual(['o-dated', 'o-undated'])
    expect(warnings).toContain('orders with no order_date')
  })

  it('says nothing when every order is dated', async () => {
    seed({
      orders: [{ id: 'o1', client_id: 'client-a', order_key: 'A1',
                 order_number: 'A1', cancelled: false, order_date: '2026-09-10' }],
    })
    const warnings: string[] = []
    await loadChargeInputs(WINDOW, (ctx) => warnings.push(ctx))
    expect(warnings).not.toContain('orders with no order_date')
  })
})

describe('loadChargeInputs — the shipment join', () => {
  const dated = (over: Record<string, unknown> = {}) => ({
    id: 'o1', client_id: 'client-a', order_key: 'A1',
    order_number: 'a1', cancelled: false, order_date: '2026-09-10', ...over,
  })

  it('fetches shipments on the normalised column, not the raw order number', async () => {
    // `.in()` is a case-SENSITIVE SQL IN. Normalising only after the fetch left
    // the query and the join disagreeing, and the revenue vanished silently.
    seed({ orders: [dated()] })

    await loadChargeInputs(WINDOW)

    const shipmentReads = h.db.calls.filter((c) => c.table === 'shipments')
    expect(shipmentReads.length).toBeGreaterThan(0)
    const filter = shipmentReads[0].filters.find((f) => f.op === 'in')
    expect(filter?.column).toBe('order_number_key')
    expect(filter?.value).toContain('A1')
  })

  it('attaches a label whose order number differs only in case', async () => {
    seed({
      orders: [dated()],
      shipments: [{ id: 's1', client_id: 'client-a', shipstation_shipment_id: 900,
                    order_number: '  a1  ', order_number_key: 'A1',
                    ship_date: '2026-09-11T14:00:00Z', actual_cost: 7.25, raw_data: {} }],
    })

    const [input] = await loadChargeInputs(WINDOW)

    expect(input.shipments).toHaveLength(1)
    expect(input.shipments[0].shipmentId).toBe(900)
    expect(input.shipments[0].actualCost).toBeCloseTo(7.25, 2)
  })

  it('leaves a label unattributed when two clients claim the number', async () => {
    // A charge on the WRONG client is worse than a missing one: it is invisible
    // in both clients' numbers and it corrupts the per-client margins.
    seed({
      orders: [
        dated(),
        { id: 'o2', client_id: 'client-b', order_key: 'A1', order_number: 'A1',
          cancelled: false, order_date: '2026-09-12' },
      ],
      shipments: [{ id: 's1', client_id: null, shipstation_shipment_id: 900,
                    order_number: 'A1', order_number_key: 'A1',
                    ship_date: '2026-09-11T14:00:00Z', actual_cost: 7.25, raw_data: {} }],
    })
    const warnings: string[] = []

    const inputs = await loadChargeInputs(WINDOW, (ctx) => warnings.push(ctx))

    expect(inputs.flatMap((i) => i.shipments)).toHaveLength(0)
    expect(warnings).toContain('ambiguous shipment attribution')
  })

  it('checks ambiguity against claimants outside the window too', async () => {
    // The out-of-window order is the whole point: with only the windowed one
    // loaded, the claimant set has size 1 and the label is billed to the wrong
    // client with nothing to show it happened.
    seed({
      orders: [
        dated({ id: 'o-window', client_id: 'client-a', order_date: '2026-09-12' }),
        { id: 'o-old', client_id: 'client-b', order_key: 'A1', order_number: 'A1',
          cancelled: false, order_date: '2026-01-01' },
      ],
      shipments: [{ id: 's1', client_id: null, shipstation_shipment_id: 900,
                    order_number: 'A1', order_number_key: 'A1',
                    ship_date: '2026-09-11T14:00:00Z', actual_cost: 7.25, raw_data: {} }],
    })
    const warnings: string[] = []

    const inputs = await loadChargeInputs(WINDOW, (ctx) => warnings.push(ctx))

    expect(inputs.map((i) => i.order.id)).toEqual(['o-window'])
    expect(inputs[0].shipments).toHaveLength(0)
    expect(warnings).toContain('ambiguous shipment attribution')
  })

  it('still attributes when the label already names one of the clients', async () => {
    // Client attribution settles the ambiguity rather than creating it.
    seed({
      orders: [
        dated(),
        { id: 'o2', client_id: 'client-b', order_key: 'A1', order_number: 'A1',
          cancelled: false, order_date: '2026-09-12' },
      ],
      shipments: [{ id: 's1', client_id: 'client-a', shipstation_shipment_id: 900,
                    order_number: 'A1', order_number_key: 'A1',
                    ship_date: '2026-09-11T14:00:00Z', actual_cost: 7.25, raw_data: {} }],
    })

    const inputs = await loadChargeInputs(WINDOW)

    expect(inputs.find((i) => i.order.id === 'o1')?.shipments).toHaveLength(1)
    expect(inputs.find((i) => i.order.id === 'o2')?.shipments).toHaveLength(0)
  })

  it('dates a label by the warehouse calendar day, not the UTC one', async () => {
    // 20:00 ET on the 30th is 00:00 UTC on the 1st. Slicing the timestamp would
    // move the charge into the next month and move the revenue with it.
    seed({
      orders: [dated({ order_date: '2026-09-30' })],
      shipments: [{ id: 's1', client_id: 'client-a', shipstation_shipment_id: 900,
                    order_number: 'A1', order_number_key: 'A1',
                    ship_date: '2026-10-01T00:30:00Z', actual_cost: 7.25, raw_data: {} }],
    })

    const [input] = await loadChargeInputs(WINDOW)

    expect(input.shipments[0].shipDate).toBe('2026-09-30')
  })
})

describe('loadChargeInputs — the rate card', () => {
  it('carries the effective dates through so the lookup can be dated', async () => {
    // Dropped from the select, the rate lookup degrades to a bare .find() and a
    // superseded rate wins by array order.
    seed({
      orders: [{ id: 'o1', client_id: 'client-a', order_key: 'A1', order_number: 'A1',
                 cancelled: false, order_date: '2026-09-10' }],
      client_warehouse_rates: [
        rateRow({ id: 'old', rate: 1, effective_from: '2020-01-01', effective_to: '2026-06-01' }),
        rateRow({ id: 'new', rate: 3, effective_from: '2026-06-01' }),
      ],
    })

    const [input] = await loadChargeInputs(WINDOW)

    // Order is deliberately not asserted: buildCharges dates the lookup rather
    // than trusting array position, which is the defect this select fixes.
    expect(input.rateCard).toEqual(expect.arrayContaining([
      { id: 'old', chargeType: 'pick', variant: 'device', rate: 1, rateType: 'per_unit',
        effectiveFrom: '2020-01-01', effectiveTo: '2026-06-01' },
      { id: 'new', chargeType: 'pick', variant: 'device', rate: 3, rateType: 'per_unit',
        effectiveFrom: '2026-06-01', effectiveTo: null },
    ]))
    expect(input.rateCard).toHaveLength(2)
  })

  it('gives an order only its own client rate card', async () => {
    seed({
      orders: [{ id: 'o1', client_id: 'client-a', order_key: 'A1', order_number: 'A1',
                 cancelled: false, order_date: '2026-09-10' }],
      client_warehouse_rates: [rateRow(), rateRow({ id: 'r2', client_id: 'client-b' })],
    })

    const [input] = await loadChargeInputs(WINDOW)

    expect(input.rateCard.map((r) => r.id)).toEqual(['r1'])
  })

  it('reads the peak percentage off the card rather than a constant', async () => {
    seed({
      orders: [{ id: 'o1', client_id: 'client-a', order_key: 'A1', order_number: 'A1',
                 cancelled: false, order_date: '2026-09-10' }],
      client_warehouse_rates: [
        rateRow({ id: 'peak', charge_type: 'surcharge', variant: 'peak', rate: 8 }),
      ],
    })

    const [input] = await loadChargeInputs(WINDOW)

    expect(input.peakSurchargePct).toBeCloseTo(8, 2)
  })

  it('gives a client with no peak line zero, not a default', async () => {
    seed({
      orders: [{ id: 'o1', client_id: 'client-a', order_key: 'A1', order_number: 'A1',
                 cancelled: false, order_date: '2026-09-10' }],
      client_warehouse_rates: [rateRow()],
    })

    const [input] = await loadChargeInputs(WINDOW)

    expect(input.peakSurchargePct).toBe(0)
  })
})

describe('loadChargeInputs — order items', () => {
  it('reclassifies a pre-Task-12 line by SKU instead of defaulting it', async () => {
    // is_component is null for lines synced before Task 12. A blanket default
    // would mis-bill the two highest-volume SKUs and never surface as an error.
    seed({
      orders: [{ id: 'o1', client_id: 'client-a', order_key: 'A1', order_number: 'A1',
                 cancelled: false, order_date: '2026-09-10' }],
      order_items: [
        { id: 'i1', order_id: 'o1', sku: 'D-100', quantity_picked: '2',
          is_component: null, pick_date: '2026-09-11' },
      ],
    })

    const [input] = await loadChargeInputs(WINDOW)

    expect(input.items[0].isComponent).toBe(false)
    expect(input.items[0].quantityPicked).toBe(2)
  })

  it('reads a null cancelled flag as not cancelled', async () => {
    seed({
      orders: [{ id: 'o1', client_id: 'client-a', order_key: 'A1', order_number: 'A1',
                 cancelled: null, order_date: '2026-09-10' }],
    })

    const [input] = await loadChargeInputs(WINDOW)

    expect(input.order.cancelled).toBe(false)
  })
})
