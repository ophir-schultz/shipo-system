import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as XLSX from 'xlsx'
import { createFakeSupabase, type FakeDb } from '@/lib/ledger/fake-supabase'
import { statementToday, periodRange } from '@/lib/billing/statement'

// THE TAB AND THE SPREADSHEET MUST AGREE, because the operator checks the
// figure on screen and then emails the file.
//
// So the load-bearing test in this file is `agrees with the spreadsheet`, which
// runs BOTH routes over the same fake database and compares the money. That is
// the only assertion here that could not be satisfied by a route returning
// plausible-looking numbers of its own.
//
// Everything else is the refusals: a failed read, an unknown client, a bad
// period. Each of those, left unrefused, produces a screen showing $0.00 --
// which is a sentence about the client's activity, not about our read.

const h = vi.hoisted(() => ({
  db: null as unknown as FakeDb,
  requireStaff: vi.fn(),
}))

vi.mock('@/lib/supabase', () => ({
  get supabaseAdmin() { return h.db.client },
}))
vi.mock('@/lib/require-staff', () => ({ requireStaff: h.requireStaff }))

const { GET } = await import('@/app/api/statements/data/route')
const { GET: DOWNLOAD } = await import('@/app/api/statements/download/route')

const CLIENT = 'c1'

// Computed with the route's own functions and not hardcoded: statementToday()
// is the WAREHOUSE's today, so a fixed date here would start failing on its own
// between warehouse midnight and UTC midnight, and outright next month.
const RANGE = periodRange('month', statementToday())

/**
 * Charges chosen so no two figures can agree by coincidence, and so the three
 * states a money cell can be in are all present:
 *
 *   priced         pick and the two freight lines
 *   UNPRICED       an at-cost freight line the carrier has not reported
 *   estimated      a surcharge priced off an assumed rate
 *
 * A seed with only priced rows would let a `?? 0` anywhere in the chain pass
 * every test in this file.
 */
function seed() {
  return {
    clients: [{ id: CLIENT, name: 'Creative Pea', active: true }],
    orders: [{ id: 'o1', order_number: 'ORD-1001' }],
    shipments: [
      {
        id: 's1', shipstation_shipment_id: 555, ship_date: `${RANGE.from}T12:00:00Z`,
        carrier: 'ups', service: 'ground', tracking_number: '1Z555', weight: 16,
        recipient_city: 'Wilmington', recipient_state: 'DE', recipient_zip: '19801',
        actual_cost: 6.73, profit_loss: 3.77, is_loss: false, client_id: CLIENT,
      },
    ],
    order_charges: [
      {
        id: 'ch1', client_id: CLIENT, order_id: 'o1', charge_date: RANGE.from,
        charge_type: 'pick', label: 'Pick - single', quantity: 3,
        unit_rate: 0.35, amount: 1.05, is_estimate: false, charge_key: 'pick',
      },
      {
        id: 'ch2', client_id: CLIENT, order_id: 'o1', charge_date: RANGE.from,
        charge_type: 'shipping', label: 'Shipping', quantity: 1,
        unit_rate: 10.50, amount: 10.50, is_estimate: false,
        charge_key: 'shipment:555',
      },
      // At cost, carrier has not reported. `amount: null` is UNKNOWN, and the
      // reason every total on this response carries the count it left out.
      {
        id: 'ch3', client_id: CLIENT, order_id: 'o1', charge_date: RANGE.to,
        charge_type: 'shipping', label: 'Shipping', quantity: 1,
        unit_rate: null, amount: null, is_estimate: false,
        charge_key: 'shipment:556',
      },
      {
        id: 'ch4', client_id: CLIENT, order_id: 'o1', charge_date: RANGE.to,
        charge_type: 'surcharge', label: 'Peak', quantity: null,
        unit_rate: null, amount: 2.20, is_estimate: true,
        charge_key: 'shipment:555:PEAK',
      },
    ],
  }
}

function url(params: Record<string, string> = {}) {
  const qs = new URLSearchParams({ client: CLIENT, grain: 'month', ...params })
  return new Request(`http://localhost/api/statements/data?${qs}`)
}

type Body = {
  error?: string
  client?: { id: string; name: string | null }
  from?: string
  to?: string
  period?: string
  lines?: Array<{
    charge_type: string; label: string; quantity: number | null; rate: string
    amount: number | null; unpriced: number; counted: number; estimated: number
  }>
  total?: number | null
  unpriced?: number
  counted?: number
  estimated?: number
  notes?: string[]
}

const body = (res: Response): Promise<Body> => res.json() as Promise<Body>

beforeEach(() => {
  h.db = createFakeSupabase(structuredClone(seed()))
  h.requireStaff.mockResolvedValue(null)
})

describe('GET /api/statements/data', () => {
  it('returns the client, the period and the lines', async () => {
    const res = await GET(url())
    expect(res.ok).toBe(true)
    const b = await body(res)

    expect(b.client).toEqual({ id: CLIENT, name: 'Creative Pea' })
    expect(b.from).toBe(RANGE.from)
    expect(b.to).toBe(RANGE.to)
    // Three lines, not four charges: the two freight rows group by (type,
    // label) and the grouping is what the client is shown.
    expect(b.lines?.map(l => l.label).sort())
      .toEqual(['Peak', 'Pick - single', 'Shipping'])
  })

  it('leaves an UNKNOWN amount null rather than summing it as zero', async () => {
    // The freight line holds one priced row ($10.50) and one at-cost row the
    // carrier has not reported. The line total is the priced part, and the
    // response says so with a count -- it does not quietly become $10.50 with
    // no indication that a parcel is missing from it.
    const b = await body(await GET(url()))
    const freight = b.lines?.find(l => l.label === 'Shipping')
    expect(freight?.amount).toBe(10.50)
    expect(freight?.unpriced).toBe(1)
    expect(freight?.counted).toBe(2)
  })

  it('counts the unpriced and estimated rows at the top level too', async () => {
    const b = await body(await GET(url()))
    expect(b.unpriced).toBe(1)
    expect(b.counted).toBe(4)
    expect(b.estimated).toBe(1)
  })

  it('totals only what it could price', async () => {
    // 1.05 + 10.50 + 2.20. The at-cost row is NOT in it, and `unpriced` above
    // is how a reader knows.
    expect((await body(await GET(url()))).total).toBeCloseTo(13.75, 10)
  })

  it('renders the three non-numeric rates as three different sentences', async () => {
    const b = await body(await GET(url()))
    // One shared rate across the rows on a line -> the number, four decimals.
    expect(b.lines?.find(l => l.label === 'Pick - single')?.rate).toBe('$0.3500')
    // No rate on any row -> 'at cost'. The freight line's priced row DOES
    // carry 10.50, so this line has exactly one rate and prints it.
    expect(b.lines?.find(l => l.label === 'Shipping')?.rate).toBe('$10.5000')
    // The surcharge has no rate at all.
    expect(b.lines?.find(l => l.label === 'Peak')?.rate).toBe('at cost')
  })

  it('carries a quantity of null, not 0, for a line that has none', async () => {
    // A peak surcharge is a percentage of a basis. Rendering a quantity of 0
    // beside it states that nothing was handled, beside a charge for handling.
    expect(b2(await body(await GET(url())), 'Peak').quantity).toBeNull()
    expect(b2(await body(await GET(url())), 'Pick - single').quantity).toBe(3)
  })

  it('reports the estimate note, because the figure can still move', async () => {
    const b = await body(await GET(url()))
    expect(b.notes?.some(n => /assumed rate/.test(n))).toBe(true)
    expect(b.notes?.some(n => /unpriced charge/.test(n))).toBe(true)
  })

  it('sends null, not 0, for a line whose EVERY row is unpriced', async () => {
    /**
     * The case the main seed cannot distinguish, found by mutation: swapping
     * `totalOrUnknown(line.sum)` for `line.sum.total` left every other test in
     * this file green. The Shipping line there holds one priced row and one
     * unpriced one, so both implementations return 10.50 and the difference is
     * invisible.
     *
     * It only shows up when a line has NO priced row -- a client billed purely
     * at cost whose carrier has not reported. `sum.total` is 0 there, and a
     * $0.00 beside 'Storage' says the storage was free. The dash says we do
     * not know yet, which is the truth.
     */
    h.db = createFakeSupabase({
      ...structuredClone(seed()),
      order_charges: [{
        id: 'ch9', client_id: CLIENT, order_id: 'o1', charge_date: RANGE.from,
        charge_type: 'storage', label: 'Storage', quantity: 2,
        unit_rate: null, amount: null, is_estimate: false, charge_key: 'storage',
      }],
    })

    const b = await body(await GET(url()))
    const line = b2(b, 'Storage')
    expect(line.amount).toBeNull()
    expect(line.unpriced).toBe(1)
    expect(line.counted).toBe(1)
  })

  it('sends a null TOTAL when the whole statement is unpriced', async () => {
    // Same mutation, one level up. `statement.sum.total` is 0 for a statement
    // every row of which is UNKNOWN, and a $0.00 grand total on the screen an
    // operator invoices from is the worst available answer -- it is the one
    // figure they will not question.
    h.db = createFakeSupabase({
      ...structuredClone(seed()),
      order_charges: structuredClone(seed().order_charges)
        .map(c => ({ ...c, amount: null })),
    })

    const b = await body(await GET(url()))
    expect(b.total).toBeNull()
    // And NOT because there was nothing to add up -- the rows are there, they
    // are just all unknown. Without this the test would pass against an empty
    // period, which is a different fact.
    expect(b.counted).toBe(4)
    expect(b.unpriced).toBe(4)
  })

  it('sends 0, not null, for a period that is genuinely empty', async () => {
    // The other side of the doctrine, and the reason the two tests above are
    // not satisfied by returning null whenever a total looks suspicious.
    // `counted === 0` is a real $0.00: nothing was billed, and that is known.
    h.db = createFakeSupabase({ ...structuredClone(seed()), order_charges: [] })
    const b = await body(await GET(url()))
    expect(b.total).toBe(0)
    expect(b.counted).toBe(0)
  })

  it('says the ledger holds nothing when it holds nothing', async () => {
    // A $0.00 total means either "nothing was billed" or "we have no record",
    // and only the earliest-charge read can tell them apart. Without the note
    // the screen shows the confident reading of an ambiguous figure.
    h.db = createFakeSupabase({ ...structuredClone(seed()), order_charges: [] })
    const b = await body(await GET(url()))
    expect(b.lines).toEqual([])
    expect(b.notes?.some(n => /no charges for this client on any date/i.test(n)))
      .toBe(true)
  })
})

/** One line by label, asserted present so a typo is not a silent undefined. */
function b2(b: Body, label: string) {
  const line = b.lines?.find(l => l.label === label)
  expect(line, `no line labelled ${label}`).toBeDefined()
  return line!
}

describe('GET /api/statements/data: agrees with the spreadsheet', () => {
  /**
   * THE test in this file.
   *
   * The operator reads the figure on the tab and then emails the .xlsx. If the
   * two are built from different reads they will differ eventually -- on a
   * boundary day, on an unpriced row, on a rate that changed mid-period -- and
   * the disagreement surfaces as a client disputing a number one of our own
   * screens still shows, with nothing to say which was right.
   *
   * Compared as MONEY and not as JSON shape, because the shapes are properly
   * different (one is a workbook) and it is the arithmetic that has to match.
   */
  async function sheetRows() {
    const res = await DOWNLOAD(new Request(
      `http://localhost/api/statements/download?client=${CLIENT}&grain=month`,
    ))
    expect(res.ok, 'the spreadsheet route refused').toBe(true)
    const wb = XLSX.read(Buffer.from(await res.arrayBuffer()), { type: 'buffer' })
    return XLSX.utils.sheet_to_json(wb.Sheets['Statement']!) as
      Record<string, unknown>[]
  }

  it('shows the same lines, rates and amounts as the Statement sheet', async () => {
    const b = await body(await GET(url()))
    h.db = createFakeSupabase(structuredClone(seed()))
    const sheet = await sheetRows()

    // Drop the TOTAL and NOTE rows: those are the sheet's own layout.
    const sheetLines = sheet.filter(r => r['Line'] !== 'TOTAL' && r['Charge'] !== 'NOTE')

    expect(sheetLines).toHaveLength(b.lines!.length)
    for (const line of b.lines!) {
      const row = sheetLines.find(r => r['Line'] === line.label)
      expect(row, `the sheet has no line ${line.label}`).toBeDefined()
      expect(row!['Rate'], line.label).toBe(line.rate)
      // The sheet writes the word UNPRICED where the JSON sends null. Both are
      // refusals to print a number, and neither is a 0 -- that equivalence is
      // the claim, so it is asserted rather than normalised away.
      if (line.amount === null) {
        expect(row!['Amount ($)'], line.label).toBe('UNPRICED')
      } else {
        expect(row!['Amount ($)'], line.label).toBeCloseTo(line.amount, 10)
      }
      expect(row!['Unpriced rows'], line.label).toBe(line.unpriced)
      expect(row!['Estimated rows'], line.label).toBe(line.estimated)
    }
  })

  it('shows the same TOTAL as the Statement sheet', async () => {
    const b = await body(await GET(url()))
    h.db = createFakeSupabase(structuredClone(seed()))
    const total = (await sheetRows()).find(r => r['Line'] === 'TOTAL')
    expect(total, 'the sheet has no TOTAL row').toBeDefined()
    expect(total!['Amount ($)']).toBeCloseTo(b.total!, 10)
    expect(total!['Unpriced rows']).toBe(b.unpriced)
    expect(total!['Estimated rows']).toBe(b.estimated)
  })

  it('carries the same notes as the sheet', async () => {
    // The sheet has one note this does not -- unmatchedParcelNote, which is
    // about the parcel join the tab does not run. So this asserts containment
    // in the direction that matters: every caveat the TAB omits must be one
    // the tab does not need.
    const b = await body(await GET(url()))
    h.db = createFakeSupabase(structuredClone(seed()))
    const sheetNotes = (await sheetRows())
      .filter(r => r['Charge'] === 'NOTE')
      .map(r => String(r['Line']))

    for (const note of b.notes!) {
      expect(sheetNotes, `the sheet is missing: ${note}`).toContain(note)
    }
  })
})

describe('GET /api/statements/data: refusals', () => {
  it('refuses with no figures when the charges read fails', async () => {
    // Not an empty statement. A failed read rendered as $0.00 is a false
    // statement about the client, shown beside a Download button.
    h.db.failOn = (call) => call.table === 'order_charges'
      ? { message: 'permission denied for table order_charges' }
      : null

    const res = await GET(url())
    expect(res.status).toBe(502)
    const b = await body(res)
    expect(b.error).toContain('order_charges')
    expect(b.error).toContain('permission denied')
    expect(b.error).toMatch(/UNKNOWN rather than zero/i)
    expect(b.total).toBeUndefined()
  })

  it('refuses when the earliest-charge read fails', async () => {
    // Refused as hard as the charges read: this is the read that decides
    // whether $0.00 means "nothing happened" or "we have no record".
    //
    // Targeted on `limit === 1`, which only readEarliestChargeDate sets --
    // readStatementCharges pages with `.range()`. Both reads hit the same
    // table, so without that discriminator this test would be failing the
    // charges read and asserting the wrong refusal.
    h.db.failOn = (call) => call.table === 'order_charges' && call.limit === 1
      ? { message: 'statement timeout' }
      : null

    const res = await GET(url())
    expect(res.status).toBe(502)
    const b = await body(res)
    // The exact phrase, so this cannot pass on the charges refusal instead.
    expect(b.error).toContain("the client's earliest charge")
    expect(b.error).toContain('statement timeout')
  })

  it('STILL answers when the client genuinely has no charges', async () => {
    // The negative control, and the reason the two refusals above mean
    // anything: a handler that refused on every empty result would pass both
    // and fail here. An empty period is a real answer.
    h.db = createFakeSupabase({ ...structuredClone(seed()), order_charges: [] })
    const res = await GET(url())
    expect(res.ok).toBe(true)
    const b = await body(res)
    expect(b.total).toBe(0)
    expect(b.lines).toEqual([])
  })

  it('refuses an unknown client rather than totalling $0.00 for nobody', async () => {
    const res = await GET(url({ client: 'no-such-client' }))
    expect(res.status).toBe(404)
    expect((await body(res)).error).toMatch(/quiet period/)
  })

  it('refuses a missing client', async () => {
    const res = await GET(new Request(
      'http://localhost/api/statements/data?grain=month',
    ))
    expect(res.status).toBe(400)
    expect((await body(res)).error).toMatch(/not an empty statement/)
  })

  it('refuses a reversed range rather than reporting an empty period', async () => {
    const res = await GET(new Request(
      `http://localhost/api/statements/data?client=${CLIENT}&from=${RANGE.to}&to=${RANGE.from}`,
    ))
    expect(res.status).toBe(400)
    expect((await body(res)).error).toMatch(/backwards/)
  })

  it('refuses a period asked for twice', async () => {
    const res = await GET(url({ from: RANGE.from, to: RANGE.to }))
    expect(res.status).toBe(400)
    expect((await body(res)).error).toMatch(/asked for twice/)
  })

  it('accepts explicit dates, which is how the Reports tab asks', async () => {
    // /reports holds its period in two date inputs shared by six tabs, so this
    // is the form the tab actually sends -- the grain tests above would all
    // pass against a route that only understood the dropdown.
    const res = await GET(new Request(
      `http://localhost/api/statements/data?client=${CLIENT}&from=${RANGE.from}&to=${RANGE.to}`,
    ))
    expect(res.ok).toBe(true)
    const b = await body(res)
    expect(b.from).toBe(RANGE.from)
    expect(b.to).toBe(RANGE.to)
    expect(b.total).toBeCloseTo(13.75, 10)
    // And no grain is claimed on a period that has none.
    expect(b.period).not.toContain('month')
  })

  it('narrows to the dates it was given', async () => {
    // The positive control for the filter being applied at all: the seed puts
    // two charges on RANGE.from and two on RANGE.to, so a single-day request
    // must return fewer than the month's four.
    const res = await GET(new Request(
      `http://localhost/api/statements/data?client=${CLIENT}&from=${RANGE.from}&to=${RANGE.from}`,
    ))
    expect(res.ok).toBe(true)
    const b = await body(res)
    expect(b.counted).toBe(2)
    expect(b.total).toBeCloseTo(11.55, 10)
  })

  it('refuses before reading anything when staff auth denies', async () => {
    h.requireStaff.mockResolvedValue(
      new Response(JSON.stringify({ error: 'nope' }), { status: 401 }),
    )
    const res = await GET(url())
    expect(res.status).toBe(401)
  })
})
