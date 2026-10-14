import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as XLSX from 'xlsx'
import { createFakeSupabase, type FakeDb } from '@/lib/ledger/fake-supabase'
import { statementToday, periodRange } from '@/lib/billing/statement'

// THE WORKBOOK, because the workbook is what gets emailed to the client.
//
// The unit tests in statement-detail.test.ts prove the join is right. What they
// cannot prove is that the ROUTE wires it in -- that the Order column is
// actually populated from the lookup rather than left blank, that a failed
// lookup refuses instead of shipping a sheet full of empty carriers, and above
// all that the Shipments sheet's amounts still add up to the shipping figure
// printed two tabs away in the same file.
//
// That last one is the whole design. There are two plausible ways to build a
// freight detail sheet and only one of them is safe:
//
//   from `shipments` in the date window  -- includes parcels the ledger has not
//                                          billed, excludes billed ones whose
//                                          ship_date straddles the period edge
//                                          in the warehouse's timezone. A
//                                          different claim about the period
//                                          than the total beside it.
//   from the shipping CHARGES            -- what this route does. Equal to the
//                                          statement's shipping line by
//                                          construction.
//
// A test that only checked "the Shipments sheet has rows" would pass against
// either. So the assertions below compare the two sheets' arithmetic, and the
// multi-parcel case is here because it is the one an order_number join gets
// wrong: one order, three boxes, three charges, and nothing in the order number
// saying which parcel belongs to which.

const h = vi.hoisted(() => ({
  db: null as unknown as FakeDb,
  requireStaff: vi.fn(),
}))

vi.mock('@/lib/supabase', () => ({
  get supabaseAdmin() { return h.db.client },
}))
vi.mock('@/lib/require-staff', () => ({ requireStaff: h.requireStaff }))

const { GET } = await import('@/app/api/statements/download/route')

const CLIENT = 'c1'

// The period the route will actually ask for. Computed with the route's own
// functions rather than hardcoded, because `statementToday()` is the
// WAREHOUSE's today -- a fixed '2026-10-01' in this file would start failing on
// its own between warehouse midnight and UTC midnight, and would fail outright
// next month.
const RANGE = periodRange('month', statementToday())

/**
 * The charges behind one order that shipped in TWO boxes, plus the two
 * neighbouring charge_key namespaces that must not be mistaken for parcels.
 *
 * Amounts chosen so every subtotal is distinguishable: no two sheets can agree
 * by coincidence.
 */
function seed() {
  return {
    clients: [{ id: CLIENT, name: 'Creative Pea', active: true }],
    orders: [
      { id: 'o1', order_number: 'ORD-1001' },
      { id: 'o2', order_number: 'ORD-1002' },
    ],
    shipments: [
      {
        id: 's1', shipstation_shipment_id: 555, ship_date: `${RANGE.from}T12:00:00Z`,
        carrier: 'ups', service: 'ground', tracking_number: '1Z555', weight: 16,
        recipient_city: 'Wilmington', recipient_state: 'DE', recipient_zip: '19801',
        // Present in the table and never selected. If either ever reaches the
        // workbook, the privacy test below reads it out of the real bytes.
        actual_cost: 6.73, profit_loss: 3.77, is_loss: false, client_id: CLIENT,
      },
      {
        id: 's2', shipstation_shipment_id: 556, ship_date: `${RANGE.from}T12:00:00Z`,
        carrier: 'fedex', service: 'express', tracking_number: 'FX556', weight: 4,
        recipient_city: 'Austin', recipient_state: 'TX', recipient_zip: '78701',
        actual_cost: 9.10, profit_loss: 2.15, is_loss: false, client_id: CLIENT,
      },
    ],
    order_charges: [
      // Two boxes, one order. The case an order_number join cannot resolve.
      {
        id: 'ch1', client_id: CLIENT, order_id: 'o1', charge_date: RANGE.from,
        charge_type: 'shipping', label: 'Shipping', quantity: 1,
        unit_rate: 10.50, amount: 10.50, is_estimate: false,
        charge_key: 'shipment:555',
      },
      {
        id: 'ch2', client_id: CLIENT, order_id: 'o1', charge_date: RANGE.from,
        charge_type: 'shipping', label: 'Shipping', quantity: 1,
        unit_rate: 11.25, amount: 11.25, is_estimate: false,
        charge_key: 'shipment:556',
      },
      // A return. Its key names shipment 555, and it is NOT that shipment --
      // charge-key.ts records the collision where a return silently overwrote
      // the outbound charge it was meant to sit beside.
      {
        id: 'ch3', client_id: CLIENT, order_id: 'o1', charge_date: RANGE.from,
        charge_type: 'shipping', label: 'Shipping', quantity: 1,
        unit_rate: -5.00, amount: -5.00, is_estimate: false,
        charge_key: 'return:555',
      },
      // A carrier surcharge on parcel 555. Real money, its own line, and not a
      // row on the Shipments sheet -- folding it into the parcel's freight row
      // would make that sheet disagree with the Charges sheet.
      {
        id: 'ch4', client_id: CLIENT, order_id: 'o1', charge_date: RANGE.from,
        charge_type: 'surcharge', label: 'Delivery area', quantity: 1,
        unit_rate: 3.95, amount: 3.95, is_estimate: false,
        charge_key: 'shipment:555:DAS',
      },
      // A pick on a different order. No parcel at all, and the reason the
      // Shipments sheet is not simply "every charge".
      {
        id: 'ch5', client_id: CLIENT, order_id: 'o2', charge_date: RANGE.from,
        charge_type: 'pick', label: 'Pick - single', quantity: 3,
        unit_rate: 0.35, amount: 1.05, is_estimate: false,
        charge_key: 'pick',
      },
    ],
  }
}

function url(params: Record<string, string> = {}) {
  const qs = new URLSearchParams({ client: CLIENT, grain: 'month', ...params })
  return new Request(`http://localhost/api/statements/download?${qs}`)
}

async function workbook(res: Response) {
  return XLSX.read(Buffer.from(await res.arrayBuffer()), { type: 'buffer' })
}

/** One named sheet as row objects. Named, not indexed: tab ORDER is not the claim. */
function rowsOf(wb: XLSX.WorkBook, sheet: string) {
  const ws = wb.Sheets[sheet]
  expect(ws, `the workbook has no sheet named ${sheet}`).toBeDefined()
  return XLSX.utils.sheet_to_json(ws) as Record<string, unknown>[]
}

/**
 * A sheet as RAW rows of cells, header included.
 *
 * Needed for the header-only sheets. `aoa_to_sheet([[sentence]])` puts the
 * sentence in A1, which `sheet_to_json` then reads as the HEADER of a table
 * with no rows and returns `[]` -- so the sentence is in the file and invisible
 * to the row-object reader.
 */
function rawOf(wb: XLSX.WorkBook, sheet: string) {
  return XLSX.utils.sheet_to_json(wb.Sheets[sheet], { header: 1 }) as unknown[][]
}

const num = (v: unknown) => typeof v === 'number' ? v : 0

/**
 * The cell is blank: absent, or the empty string.
 *
 * Both render as an empty cell in Excel, and which one xlsx writes depends on
 * whether the value was `undefined` or `''` -- an encoding detail of the
 * library, not a claim this file makes. What IS the claim is that nothing was
 * invented for the column.
 */
function expectBlank(value: unknown, what: string) {
  expect(value ?? '', `${what} must be blank, not invented`).toBe('')
}

beforeEach(() => {
  h.db = createFakeSupabase(structuredClone(seed()))
  h.requireStaff.mockResolvedValue(null)
})

describe('GET /api/statements/download: the file carries the detail behind the total', () => {
  it('writes all three sheets', async () => {
    const wb = await workbook(await GET(url()))
    expect(wb.SheetNames).toEqual(['Statement', 'Charges', 'Shipments'])
  })

  it('names the order beside every charge', async () => {
    const rows = rowsOf(await workbook(await GET(url())), 'Charges')

    // The question a client asks of a total before any other. Previously
    // unanswerable from the file: order_charges carries a UUID.
    expect(rows).toHaveLength(5)
    expect(rows.map(r => r['Order'])).toEqual([
      'ORD-1001', 'ORD-1001', 'ORD-1001', 'ORD-1001', 'ORD-1002',
    ])
    // And it is the ORDER NUMBER, not the uuid that happens to be in the row.
    expect(JSON.stringify(rows)).not.toContain('o1')
  })

  it('gives one order that shipped in two boxes two separate parcel rows', async () => {
    const rows = rowsOf(await workbook(await GET(url())), 'Shipments')

    // THE DISCRIMINATING CASE. A join on order_number would see one order
    // number against three shipping charges and have no way to say which
    // carrier, tracking number and weight belongs to which -- so it would
    // either repeat one parcel three times or pick arbitrarily. charge_key ->
    // shipstation_shipment_id is 1:1 and unique-indexed, so it cannot.
    const byTracking = new Map(rows.map(r => [r['Tracking'], r]))
    expect([...byTracking.keys()].sort()).toEqual(['', '1Z555', 'FX556'])

    expect(byTracking.get('1Z555')).toMatchObject({
      'Order': 'ORD-1001', 'Carrier': 'ups', 'Service': 'ground',
      'Weight (lb)': 16, 'Destination': 'Wilmington, DE 19801',
      'Amount ($)': 10.50, 'Parcel record found': 'yes',
    })
    expect(byTracking.get('FX556')).toMatchObject({
      'Order': 'ORD-1001', 'Carrier': 'fedex', 'Service': 'express',
      'Weight (lb)': 4, 'Destination': 'Austin, TX 78701',
      'Amount ($)': 11.25, 'Parcel record found': 'yes',
    })
  })

  it('does not hand a return the parcel it reverses', async () => {
    const rows = rowsOf(await workbook(await GET(url())), 'Shipments')

    // `return:555` names shipment 555 and must not inherit its carrier. The
    // row is still PRESENT with its amount, because the money is real -- it is
    // the parcel facts that are unknown, and the sheet says which.
    const ret = rows.find(r => num(r['Amount ($)']) === -5)
    expect(ret).toMatchObject({ 'Parcel record found': 'no', 'Amount ($)': -5 })
    expectBlank(ret?.['Carrier'], 'the carrier of a return')
    expectBlank(ret?.['Tracking'], 'the tracking number of a return')
    expectBlank(ret?.['Weight (lb)'], 'the weight of a return')
    // Not 'ups' from the shipment whose id its key happens to contain.
    expect(JSON.stringify(ret)).not.toContain('1Z555')
  })

  it('leaves a surcharge on the Charges sheet and off the Shipments sheet', async () => {
    const wb = await workbook(await GET(url()))

    // `shipment:555:DAS` is real money on parcel 555, but it is its own line.
    // Counting it as a parcel row would double the Shipments sheet against the
    // shipping figure on sheet 1.
    expect(rowsOf(wb, 'Charges').some(r => r['Line'] === 'Delivery area')).toBe(true)
    expect(rowsOf(wb, 'Shipments')).toHaveLength(3)
    expect(rowsOf(wb, 'Shipments').map(r => num(r['Amount ($)'])))
      .not.toContain(3.95)
  })

  it('sums the Shipments sheet to the shipping line on the Statement sheet', async () => {
    // THE LOAD-BEARING CLAIM OF THE WHOLE FILE. Two tabs of one workbook that
    // disagree about freight give a client disputing the bill a choice between
    // our own two numbers, which is worse than carrying no detail at all.
    const wb = await workbook(await GET(url()))

    const parcels = rowsOf(wb, 'Shipments')
      .reduce((t, r) => t + num(r['Amount ($)']), 0)
    const shippingLines = rowsOf(wb, 'Statement')
      .filter(r => r['Charge'] === 'shipping')
      .reduce((t, r) => t + num(r['Amount ($)']), 0)

    expect(parcels).toBeCloseTo(shippingLines, 2)
    // Pinned to the arithmetic, so a change that made BOTH sides wrong in the
    // same direction still fails: 10.50 + 11.25 - 5.00.
    expect(parcels).toBeCloseTo(16.75, 2)

    // And the grand total still includes the surcharge and the pick.
    const total = rowsOf(wb, 'Statement').find(r => r['Line'] === 'TOTAL')
    expect(num(total?.['Amount ($)'])).toBeCloseTo(21.75, 2)
  })

  it('explains the blank carrier columns in words, on the Statement sheet', async () => {
    const rows = rowsOf(await workbook(await GET(url())), 'Statement')
    const notes = rows.filter(r => r['Charge'] === 'NOTE').map(r => String(r['Line']))

    // The note goes where the reader is looking, not only on the sheet the
    // blanks are on. One charge here is unmatched: the return.
    const note = notes.find(n => n.includes('could not be matched to a parcel'))
    expect(note).toBeDefined()
    expect(note).toContain('1 shipping charge')
    // Says the money is unaffected. Without that sentence a blank carrier
    // reads as a charge that should not have been billed.
    expect(note).toMatch(/amount charged is unaffected/i)
  })
})

describe('GET /api/statements/download: what the client must not be sent', () => {
  it('puts no carrier cost or margin anywhere in the workbook', async () => {
    const wb = await workbook(await GET(url()))

    // Asserted against the REAL BYTES of all three sheets, not against the
    // source text. The source-level guard in statement-detail.test.ts proves
    // the columns are not SELECTED; this proves none of them reached the file
    // by another route -- a wider select elsewhere, a spread, a debug column.
    const everything = JSON.stringify(
      wb.SheetNames.map(n => rowsOf(wb, n)),
    )
    for (const forbidden of ['actual_cost', 'profit_loss', 'is_loss', 'Cost', 'Margin', 'Profit']) {
      expect(everything, `${forbidden} must not be in a client-facing workbook`)
        .not.toContain(forbidden)
    }
    // The positive control: the two cost figures seeded on the shipments rows
    // are genuinely in the fake database and genuinely absent from the file.
    expect(everything).not.toContain('6.73')
    expect(everything).not.toContain('9.1')
    // And the parcel facts a freight dispute DOES need are present, so this
    // test cannot be satisfied by exporting nothing.
    expect(everything).toContain('1Z555')
  })
})

describe('GET /api/statements/download: a failed lookup is not a parcel we have no record of', () => {
  it('writes NO FILE when the order-number read fails', async () => {
    h.db.failOn = (call) => call.table === 'orders'
      ? { message: 'permission denied for table orders' }
      : null

    const res = await GET(url())

    // A blank Order column does not read as "the join failed". It reads as
    // charges we cannot attribute to an order, which is a claim about the
    // ledger rather than about our read of it -- in a file sent to a client.
    expect(res.status).toBe(502)
    const { error } = await res.json()
    expect(error).toContain('order numbers')
    expect(error).toContain('permission denied for table orders')
    expect(res.headers.get('content-disposition')).toBeNull()
  })

  it('writes NO FILE when the parcel-detail read fails', async () => {
    h.db.failOn = (call) => call.table === 'shipments'
      ? { message: 'terminating connection due to administrator command' }
      : null

    const res = await GET(url())

    expect(res.status).toBe(502)
    const { error } = await res.json()
    expect(error).toContain('shipment details')
    expect(error).toMatch(/UNKNOWN rather than zero/i)
  })

  it('STILL writes the file when the client genuinely has no charges', async () => {
    // The negative control, and the reason the two refusals above mean
    // anything: a handler that refused whenever a sheet came back empty would
    // pass both of them and fail here. An empty period is a real answer.
    h.db = createFakeSupabase({ ...structuredClone(seed()), order_charges: [] })

    const res = await GET(url())
    expect(res.ok).toBe(true)

    const wb = await workbook(res)
    expect(rowsOf(wb, 'Statement')[0]['Line'])
      .toContain('No charges recorded for Creative Pea')
    // And the Shipments tab exists rather than being omitted: a missing tab
    // reads as a feature that did not run.
    expect(wb.SheetNames).toContain('Shipments')
  })

  it('says no SHIPPING charges, not no charges, when only freight is absent', async () => {
    // The two are a different fact about the period, and the distinction only
    // exists because each empty sheet carries its own sentence. A client who
    // was picked and packed but shipped nothing has charges.
    h.db = createFakeSupabase({
      ...structuredClone(seed()),
      order_charges: structuredClone(seed().order_charges)
        .filter(c => c.charge_type === 'pick'),
    })

    const wb = await workbook(await GET(url()))
    expect(rawOf(wb, 'Shipments').flat())
      .toContain('No shipping charges in this period')
    // And NOT the other sentence, which is the whole distinction.
    expect(rawOf(wb, 'Shipments').flat()).not.toContain('No charge rows in this period')
    expect(rowsOf(wb, 'Charges')).toHaveLength(1)
  })
})

describe('GET /api/statements/download: the period can be named by grain OR by dates', () => {
  /**
   * The Statement tab inside /reports shares that screen's From and To inputs
   * with five other tabs, so it cannot ask for a grain. Both forms therefore
   * reach this route, and these tests are about the one thing that must stay
   * true of the pair: the FILE's period is the period that was requested.
   *
   * A wrong answer here is not an error message. It is a correctly-formatted
   * workbook, headed with the right client name, totalling a period the
   * operator did not pick -- and it gets emailed.
   */

  /** Like `url()`, but with no grain, so the dates are the only period named. */
  function datedUrl(params: Record<string, string>) {
    const qs = new URLSearchParams({ client: CLIENT, ...params })
    return new Request(`http://localhost/api/statements/download?${qs}`)
  }

  it('builds the file from explicit from/to', async () => {
    const res = await GET(datedUrl({ from: RANGE.from, to: RANGE.to }))
    expect(res.ok).toBe(true)

    // The filename carries the dates, and they are the requested ones.
    expect(res.headers.get('content-disposition'))
      .toContain(`${RANGE.from}-to-${RANGE.to}`)

    // And it is the SAME file the grain form produces for the same dates --
    // which is the claim that matters, and the one a test asserting only
    // "status 200" would miss entirely.
    const dated = rowsOf(await workbook(res), 'Charges')
    h.db = createFakeSupabase(structuredClone(seed()))
    const grained = rowsOf(await workbook(await GET(url())), 'Charges')
    expect(dated).toEqual(grained)
  })

  it('honours dates that are NOT a calendar period', async () => {
    // The case that distinguishes a real range from one quietly rounded to a
    // month: a single day inside the period, which must return only that day's
    // charges rather than the month containing it.
    const res = await GET(datedUrl({ from: RANGE.from, to: RANGE.from }))
    expect(res.ok).toBe(true)
    expect(res.headers.get('content-disposition'))
      .toContain(`${RANGE.from}-to-${RANGE.from}`)
  })

  it('reports an empty period for dates the ledger has no charges in', async () => {
    // The positive control for the filter actually being applied. Without it,
    // the test above passes against a route that ignores from/to entirely.
    const res = await GET(datedUrl({ from: '2019-01-01', to: '2019-01-31' }))
    expect(res.ok).toBe(true)
    expect(rowsOf(await workbook(res), 'Statement')[0]['Line'])
      .toContain('No charges recorded for Creative Pea')
  })

  it('does not print a grain on a period that has none', async () => {
    // periodLabel's nullable grain, measured in the artefact. An explicit
    // 1st-to-month-end is not 'month' -- it coincides with it -- and labelling
    // it as one states how the figure was derived.
    h.db = createFakeSupabase({ ...structuredClone(seed()), order_charges: [] })
    const line = String(rowsOf(await workbook(
      await GET(datedUrl({ from: RANGE.from, to: RANGE.to })),
    ), 'Statement')[0]['Line'])
    expect(line).toContain(`${RANGE.from} to ${RANGE.to}`)
    expect(line).not.toContain('(month)')
  })

  it('WRITES NO FILE when the period is asked for twice', async () => {
    // `url()` already sets grain, so adding dates is the ambiguous request --
    // and it is the one a half-finished refactor of the Statement tab would
    // actually send.
    const res = await GET(url({ from: RANGE.from, to: RANGE.to }))
    expect(res.status).toBe(400)
    const { error } = await res.json()
    expect(error).toMatch(/asked for twice/)
    expect(res.headers.get('content-disposition')).toBeNull()
  })

  it('WRITES NO FILE for a reversed range', async () => {
    // Not a 200 with an empty Statement sheet. `.gte(to).lte(from)` matches
    // nothing, so the file would say "No charges recorded" about a client who
    // was invoiced -- a false record, in writing, over a period that cannot
    // exist.
    const res = await GET(datedUrl({ from: RANGE.to, to: RANGE.from }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/backwards/)
  })

  it('WRITES NO FILE for half a range', async () => {
    const res = await GET(datedUrl({ from: RANGE.from }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/to is missing/)
  })

  it('WRITES NO FILE when no period is named at all', async () => {
    const res = await GET(datedUrl({}))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/No period/)
  })

  it('still refuses an unknown grain', async () => {
    // Unchanged behaviour, pinned because the validation moved. 'weekly' used
    // to fall through periodRange onto the year arm.
    const res = await GET(url({ grain: 'weekly' }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('weekly')
  })
})
