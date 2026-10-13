import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { createFakeSupabase, type FakeDb } from '@/lib/ledger/fake-supabase'

const h: { db: FakeDb } = { db: createFakeSupabase() }
vi.mock('@/lib/supabase', () => ({
  get supabaseAdmin() { return h.db.client },
}))

const {
  shipmentIdFromChargeKey, readOrderNumbers, readShipmentFacts,
  factsByShipmentId, destinationOf, buildShipmentLines, unmatchedParcelNote,
  IN_CHUNK,
} = await import('@/lib/billing/statement-detail')

type AnyRow = Record<string, unknown>

const parcel = (over: AnyRow = {}): AnyRow => ({
  id: `s-${String(over.shipstation_shipment_id ?? '1')}`,
  shipstation_shipment_id: 1,
  ship_date: '2026-10-05T14:00:00Z',
  carrier: 'usps',
  service: 'ground_advantage',
  tracking_number: '9400100000000000000000',
  weight: 2.5,
  recipient_city: 'Dover',
  recipient_state: 'DE',
  recipient_zip: '19901',
  ...over,
})

const charge = (over: AnyRow = {}) => ({
  charge_type: 'shipping',
  charge_date: '2026-10-05',
  order_id: 'o-1',
  charge_key: 'shipment:1',
  amount: 7.25,
  ...over,
}) as Parameters<typeof buildShipmentLines>[0][number]

/** The ids an `.in()` filter asked for, per request. */
function inFilterSizes(): number[] {
  return h.db.calls.map(c => {
    const f = c.filters.find(x => x.op === 'in')
    return Array.isArray(f?.value) ? f.value.length : 0
  })
}

function allRequestedIds(): unknown[] {
  return h.db.calls.flatMap(c => {
    const f = c.filters.find(x => x.op === 'in')
    return Array.isArray(f?.value) ? f.value : []
  })
}

/** Source with comments stripped, so prose about a column is not the column. */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
}

beforeEach(() => { h.db = createFakeSupabase({ orders: [], shipments: [] }) })

describe('a shipping charge knows which parcel it billed', () => {
  it('reads the shipment id out of the charge key', () => {
    expect(shipmentIdFromChargeKey('shipment:1')).toBe('1')
    expect(shipmentIdFromChargeKey('shipment:900123456789')).toBe('900123456789')
  })

  it('does not match a return, which is a different parcel-shaped key', () => {
    // charge-key.ts:77-94 records the collision this prevents: a return sharing
    // 'shipment:<id>' silently UPDATED the outbound shipping charge it was meant
    // to sit beside. If this matched, a credit would be rendered as the parcel's
    // freight line.
    expect(shipmentIdFromChargeKey('return:1')).toBeNull()
  })

  it('does not match a surcharge on the parcel', () => {
    // Real money, but its own line. Folding it in here would make this sheet's
    // freight figure disagree with the same parcel's rows on the charges sheet.
    expect(shipmentIdFromChargeKey('shipment:1:FUEL')).toBeNull()
    expect(shipmentIdFromChargeKey('shipment:1:RESIDENTIAL')).toBeNull()
  })

  it('rejects anything that is not a bare numeric id', () => {
    // Anchored at both ends. Without the trailing anchor the surcharge case
    // above would match and return a truncated id; without the leading one,
    // 'return:1' would match on its tail.
    for (const key of ['shipment:', 'shipment:abc', 'shipment:1a', '', 'pick:1',
                       'x-shipment:1', 'storage:2026-10']) {
      expect(shipmentIdFromChargeKey(key), key).toBeNull()
    }
  })
})

describe('the lookups are chunked, because the filter travels in the URL', () => {
  it('never puts more than IN_CHUNK ids in one request', async () => {
    const ids = Array.from({ length: 301 }, (_, i) => `o-${i}`)
    h.db.tables.orders = ids.map(id => ({ id, order_number: `SO-${id}` }))

    const res = await readOrderNumbers(ids)

    expect(res.error).toBeNull()
    expect(res.data).toHaveLength(301)
    // The claim, stated as the limit rather than as a request count, so it
    // survives a change to how many pages each chunk takes. Removing the
    // chunking entirely makes this 301.
    expect(Math.max(...inFilterSizes())).toBeLessThanOrEqual(IN_CHUNK)
    // And nothing was dropped on the way: chunking that lost a slice would
    // still satisfy the limit above.
    expect([...new Set(allRequestedIds())].sort()).toEqual([...ids].sort())
  })

  it('asks for each id once, however many charges share an order', async () => {
    h.db.tables.orders = [{ id: 'o-1', order_number: 'SO-1' }]

    const res = await readOrderNumbers(['o-1', 'o-1', 'o-1'])

    expect(res.error).toBeNull()
    // Asserted per REQUEST, not over the union: the pager asks each chunk for a
    // tail page to find the end, so one id legitimately appears in two requests.
    // What must not happen is one id appearing three times in ONE filter, which
    // is what dropping the dedupe does -- and on a client whose charges share a
    // few hundred orders that is a URL several times longer than it needs to be.
    expect(inFilterSizes().every(n => n === 1)).toBe(true)
    expect([...new Set(allRequestedIds())]).toEqual(['o-1'])
  })

  it('issues no request at all for an empty period', async () => {
    const res = await readOrderNumbers([])

    expect(res.error).toBeNull()
    expect(res.data).toEqual([])
    expect(h.db.calls).toHaveLength(0)
  })

  it('discards the rows it already had when a later chunk fails', async () => {
    const ids = Array.from({ length: 301 }, (_, i) => `o-${i}`)
    h.db.tables.orders = ids.map(id => ({ id, order_number: `SO-${id}` }))
    // Fail once the first chunk has already succeeded, which is the case a
    // prefix-returning pager gets wrong.
    let seen = 0
    h.db.failOn = () => (++seen > 2 ? { message: 'boom', code: '42703' } : null)

    const res = await readOrderNumbers(ids)

    // Not a short list. A prefix presented as the answer is a statement with
    // order numbers missing from exactly the rows nobody looked at.
    expect(res.data).toBeNull()
    expect(res.error?.message).toBe('boom')
  })

  it('orders every page on a unique column, or paging repeats rows', async () => {
    h.db.tables.orders = [{ id: 'o-1', order_number: 'SO-1' }]
    await readOrderNumbers(['o-1'])
    expect(h.db.calls[0].sort.map(s => s.column)).toContain('id')
  })
})

describe('the parcel read is scoped to what a client may see', () => {
  const src = () => readFileSync('src/lib/billing/statement-detail.ts', 'utf8')

  it('never selects what we paid the carrier or what we made', () => {
    // THE DEFECT THIS EXISTS FOR. This module feeds a workbook that gets
    // emailed to the client. `shipments` carries actual_cost, profit_loss and
    // is_loss in the same row as the carrier and tracking number, so adding one
    // more column to the select is how our margin leaves the building -- in
    // writing, to the party we negotiate with.
    //
    // Comments are stripped first: this file's header explains at length WHY
    // those columns are absent, and an unstripped scan would read the
    // explanation as the code and fail on the documentation.
    const code = codeOnly(src())
    for (const column of ['actual_cost', 'profit_loss', 'is_loss']) {
      expect(code, `${column} must not be selected into a client-facing file`)
        .not.toContain(column)
    }
  })

  it('does select the parcel facts a freight dispute actually needs', () => {
    // The converse, so the test above cannot be satisfied by selecting nothing.
    const code = codeOnly(src())
    for (const column of ['carrier', 'service', 'tracking_number', 'weight',
                          'recipient_city', 'recipient_state', 'recipient_zip']) {
      expect(code, column).toContain(column)
    }
  })

  it('does not filter parcels by client, which would blank billed freight', async () => {
    h.db.tables.shipments = [parcel()]
    await readShipmentFacts(['1'])

    // 241 shipments from nine unmapped stores have a null client_id right now.
    // An `.eq('client_id', ...)` here would strip carrier and tracking from
    // freight those clients are genuinely billed for, and the blanks would read
    // as a recording failure rather than a filter.
    const filtered = h.db.calls.flatMap(c => c.filters)
      .filter(f => f.op === 'eq' && f.column === 'client_id')
    expect(filtered).toEqual([])
  })
})

describe('matching a charge to its parcel', () => {
  it('keys a bigint id the same whether it arrives as a number or a string', () => {
    // PostgREST renders bigint as either depending on magnitude, and the key it
    // is matched against is parsed out of text. A Map keyed on the raw value
    // misses every parcel whose id crossed that threshold.
    const map = factsByShipmentId([
      parcel({ shipstation_shipment_id: 1 }),
      parcel({ shipstation_shipment_id: '900123456789' }),
    ] as never)
    expect(map.get('1')?.carrier).toBe('usps')
    expect(map.get('900123456789')?.carrier).toBe('usps')
  })

  it('skips a parcel with no shipstation id rather than keying it on null', () => {
    // The stamps_com rows have none. A 'null' key matches no charge while
    // looking like it might.
    const map = factsByShipmentId([
      parcel({ shipstation_shipment_id: null }),
    ] as never)
    expect(map.size).toBe(0)
    expect(map.has('null')).toBe(false)
  })
})

describe('the destination reads as an address', () => {
  it('joins city, state and zip', () => {
    expect(destinationOf(parcel() as never)).toBe('Dover, DE 19901')
  })

  it('omits whatever the carrier did not report, without stray punctuation', () => {
    expect(destinationOf(parcel({ recipient_city: null }) as never)).toBe('DE 19901')
    expect(destinationOf(parcel({ recipient_zip: null }) as never)).toBe('Dover, DE')
    expect(destinationOf(parcel({ recipient_state: null, recipient_zip: null }) as never))
      .toBe('Dover')
    expect(destinationOf(parcel({
      recipient_city: null, recipient_state: null, recipient_zip: null,
    }) as never)).toBe('')
  })
})

describe('the shipments sheet is built from the charges', () => {
  const numbers = new Map([['o-1', 'SO-1001'], ['o-2', 'SO-1002']])
  const facts = factsByShipmentId([
    parcel({ shipstation_shipment_id: 1 }),
    parcel({ shipstation_shipment_id: 2, carrier: 'ups', weight: 11 }),
  ] as never)

  it('carries only shipping charges, not picks or packs', () => {
    const { lines } = buildShipmentLines([
      charge({ charge_type: 'pick', charge_key: 'pick:o-1' }),
      charge({ charge_type: 'pack', charge_key: 'pack:o-1' }),
      charge({ charge_type: 'shipping', charge_key: 'shipment:1' }),
    ], numbers, facts)

    expect(lines).toHaveLength(1)
    expect(lines[0].carrier).toBe('usps')
  })

  it('names the order the client knows, not its uuid', () => {
    const { lines } = buildShipmentLines([charge({ order_id: 'o-2', charge_key: 'shipment:2' })],
      numbers, facts)
    expect(lines[0].order_number).toBe('SO-1002')
    expect(lines[0].carrier).toBe('ups')
  })

  it('leaves the order blank rather than inventing one', () => {
    // order_id is a nullable FK, and an unattributed charge still has to appear.
    const { lines } = buildShipmentLines(
      [charge({ order_id: null })], numbers, facts)
    expect(lines[0].order_number).toBe('')
    const unknown = buildShipmentLines(
      [charge({ order_id: 'o-missing' })], numbers, facts)
    expect(unknown.lines[0].order_number).toBe('')
  })

  it('dates the row from the charge, which is what the period filtered on', () => {
    // The parcel's ship_date is the same fact but was not the filter, so a
    // timezone boundary could put it outside the period the sheet is headed
    // with. Fixture deliberately disagrees to prove which one is used.
    const { lines } = buildShipmentLines(
      [charge({ charge_date: '2026-10-05' })], numbers, facts)
    expect(lines[0].ship_date).toBe('2026-10-05')
  })

  it('reports a charge whose parcel is missing, and still bills it', () => {
    const { lines, unmatched } = buildShipmentLines(
      [charge({ charge_key: 'shipment:999', amount: 12.5 })], numbers, facts)

    expect(unmatched).toBe(1)
    expect(lines[0].matched).toBe(false)
    expect(lines[0].carrier).toBe('')
    expect(lines[0].tracking_number).toBe('')
    // The money is the point: an unmatched parcel must not quietly drop a
    // charge out of a sheet whose column sums to the statement's freight line.
    expect(lines[0].amount).toBe(12.5)
  })

  it('leaves weight unknown rather than zero when the parcel is missing', () => {
    // 0 lb is a measurement. null is the absence of one, and only null stays
    // out of an average.
    const { lines } = buildShipmentLines(
      [charge({ charge_key: 'shipment:999' })], numbers, facts)
    expect(lines[0].weight).toBeNull()
  })

  it('passes an unpriced freight amount through as unknown, not zero', () => {
    // An at-cost label whose carrier has not reported yet. `?? 0` here would
    // say we billed the client nothing for a parcel they will be invoiced for.
    const { lines } = buildShipmentLines(
      [charge({ amount: null })], numbers, facts)
    expect(lines[0].amount).toBeNull()
  })

  it('sums to the same freight figure as the charges it was built from', () => {
    // THE LOAD-BEARING CLAIM of the whole sheet. Two sheets in one workbook
    // stating different freight totals for one period is the dispute this
    // design exists to make impossible -- which is why the sheet is driven by
    // the charges and not by a second read of the shipments table.
    const charges = [
      charge({ charge_key: 'shipment:1', amount: 7.25 }),
      charge({ charge_key: 'shipment:2', amount: 11.1 }),
      charge({ charge_key: 'shipment:999', amount: 3.4 }),
      charge({ charge_type: 'pick', charge_key: 'pick:o-1', amount: 99 }),
    ]
    const { lines } = buildShipmentLines(charges, numbers, facts)

    const sheet = lines.reduce((t, l) => t + (l.amount as number), 0)
    const freight = charges
      .filter(c => c.charge_type === 'shipping')
      .reduce((t, c) => t + (c.amount as number), 0)
    expect(sheet).toBeCloseTo(freight, 2)
    expect(sheet).toBeCloseTo(21.75, 2)
  })
})

describe('the note that explains the blanks', () => {
  it('says nothing when every parcel matched', () => {
    expect(unmatchedParcelNote(0)).toBe('')
    expect(unmatchedParcelNote(-1)).toBe('')
  })

  it('counts them, and says the amount still stands', () => {
    expect(unmatchedParcelNote(1)).toContain('1 shipping charge could not')
    expect(unmatchedParcelNote(1)).toContain('its carrier')
    expect(unmatchedParcelNote(4)).toContain('4 shipping charges could not')
    expect(unmatchedParcelNote(4)).toContain('their carrier')
    // The reassurance is the load-bearing half: without it the note reads as
    // "some of this period is missing".
    for (const n of [1, 4]) {
      expect(unmatchedParcelNote(n)).toContain('included in the total')
    }
  })
})
