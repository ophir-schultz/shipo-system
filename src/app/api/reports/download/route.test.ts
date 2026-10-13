import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as XLSX from 'xlsx'
import { createFakeSupabase, type FakeDb } from '@/lib/ledger/fake-supabase'

// THE ROUTE HANDLER, because the artefact under test is a FILE.
//
// What this guards is not a calculation. Every branch of this route mapped its
// columns correctly; the defect was that each one read `const { data } = await
// q` and dropped the error, so a read that FAILED produced the same `rows = []`
// as a period that was genuinely quiet -- and the tail of the handler turns
// `[]` into a sheet that reads
//
//     No Data | No records found for the selected period
//
// A .xlsx is read as a record. It gets attached to an email next to an invoice,
// and it outlives the outage that produced it, carrying no trace that its rows
// were never READ rather than never existed. reports/page.tsx refuses for
// exactly this reason, but its gate is not in this path: the browser requests
// this URL directly.
//
// So the assertions below are mostly about the DIFFERENCE between two cases
// that used to be identical -- a failed read and an empty month. A test that
// only checked "refuses on error" would pass against a handler that refused
// always, which is why the empty-month control is here and is not padding.

const h = vi.hoisted(() => ({
  db: null as unknown as FakeDb,
  requireStaff: vi.fn(),
}))

vi.mock('@/lib/supabase', () => ({
  get supabaseAdmin() { return h.db.client },
}))
vi.mock('@/lib/require-staff', () => ({ requireStaff: h.requireStaff }))

const { GET } = await import('@/app/api/reports/download/route')

/** Every table the six branches read, so an unseeded one is not a failure. */
const EMPTY_TABLES = {
  shipments: [] as Record<string, unknown>[],
  rate_adjustments: [] as Record<string, unknown>[],
  bills: [] as Record<string, unknown>[],
  warehouse_daily_log: [] as Record<string, unknown>[],
}

const FROM = '2026-10-01'
const TO = '2026-10-31'

function url(params: Record<string, string>) {
  const qs = new URLSearchParams(params).toString()
  return new Request(`http://localhost/api/reports/download?${qs}`)
}

/** The whole response body as text, whatever its content type. */
async function bodyText(res: Response) {
  return Buffer.from(await res.arrayBuffer()).toString('binary')
}

/** The first sheet of an xlsx response, as row objects. */
async function sheetRows(res: Response) {
  const wb = XLSX.read(Buffer.from(await res.arrayBuffer()), { type: 'buffer' })
  return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]) as Record<string, unknown>[]
}

beforeEach(() => {
  h.db = createFakeSupabase(structuredClone(EMPTY_TABLES))
  // Not denied. requireStaff returns a Response to refuse and null to allow.
  h.requireStaff.mockResolvedValue(null)
})

describe('GET /api/reports/download: a read that failed is not an empty month', () => {
  it('writes NO FILE when the shipments read fails', async () => {
    h.db.failOn = (call) => call.table === 'shipments'
      ? { message: 'terminating connection due to administrator command' }
      : null

    const res = await GET(url({ type: 'shipments', dateFrom: FROM, dateTo: TO }))

    expect(res.ok).toBe(false)
    expect(res.status).toBe(502)

    // The point of the whole change. The old handler answered this exact
    // request with a spreadsheet asserting the month was empty.
    const text = await bodyText(res)
    expect(text).not.toContain('No records found')
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(res.headers.get('content-disposition')).toBeNull()
  })

  it('names the read that failed and carries the underlying message', async () => {
    // Six reads feed this route. "could not be read" with no subject does not
    // tell an operator whether one table is unreachable or the database is.
    h.db.failOn = (call) => call.table === 'bills'
      ? { message: 'permission denied for table bills' }
      : null

    const res = await GET(url({ type: 'billing', dateFrom: FROM, dateTo: TO }))
    const { error } = await res.json()

    expect(error).toContain('bills')
    expect(error).toContain('permission denied for table bills')
  })

  it('says the figure is UNKNOWN rather than zero', async () => {
    // Wording, and load-bearing: the reader's next action differs. "Zero" ends
    // the enquiry; "unknown" sends them to retry or escalate.
    h.db.failOn = () => ({ message: 'timeout' })

    const res = await GET(url({ type: 'warehouse', dateFrom: FROM, dateTo: TO }))
    const { error } = await res.json()

    expect(error).toMatch(/UNKNOWN rather than zero/i)
  })

  it('STILL writes a file saying so when the month is genuinely empty', async () => {
    // The negative control, and the reason the assertions above mean anything.
    // Tables are seeded empty and no failure is injected, so this is a real
    // answer: there were no shipments. A handler that refused unconditionally
    // would pass every test above and fail here.
    const res = await GET(url({ type: 'shipments', dateFrom: FROM, dateTo: TO }))

    expect(res.ok).toBe(true)
    expect(res.headers.get('content-disposition')).toContain('.xlsx')

    const rows = await sheetRows(res)
    expect(rows).toHaveLength(1)
    expect(rows[0]['No Data']).toBe('No records found for the selected period')
  })

  it('returns the rows when the read succeeds', async () => {
    // The other control: proves the refusal path is not swallowing good reads.
    h.db = createFakeSupabase({
      ...structuredClone(EMPTY_TABLES),
      shipments: [{
        order_number: 'RET-2026-118', ship_date: '2026-10-12', carrier: 'ups',
        service: 'ground', tracking_number: '1Z999', recipient_name: 'A Person',
        recipient_city: 'Wilmington', recipient_state: 'DE', weight: 16,
        actual_cost: 6.73, client_rate: null, profit_loss: null,
        is_loss: false, source: 'shipstation', client_id: 'c1',
      }],
    })

    const res = await GET(url({ type: 'shipments', dateFrom: FROM, dateTo: TO }))
    expect(res.ok).toBe(true)

    const rows = await sheetRows(res)
    expect(rows).toHaveLength(1)
    expect(rows[0]['Order #']).toBe('RET-2026-118')
    expect(rows[0]['Carrier Cost ($)']).toBe(6.73)
    // An unpriced shipment arrives as a BLANK cell, never as 0.00 -- the
    // existing header comment's promise, pinned here because this is the sheet
    // an invoice gets built from and 0.00 reads as "free".
    expect(rows[0]['Client Rate ($)']).toBeUndefined()
  })
})

describe('GET /api/reports/download: a bad request is not an empty month either', () => {
  it('refuses an unknown report type instead of exporting "No Data"', async () => {
    // An unrecognised type fell through all six branches and left rows empty.
    // The filename still carried the requested period, so the file looked like
    // an answer to the question that was asked.
    const res = await GET(url({ type: 'shipmets', dateFrom: FROM, dateTo: TO }))

    expect(res.status).toBe(400)
    // Read ONCE. A Response body is single-use, so asserting on the raw text
    // and then calling res.json() throws "Body has already been read" -- which
    // is a bug in the test, not the handler, and it cost a run to find.
    const text = await bodyText(res)
    expect(text).not.toContain('No records found')

    const { error } = JSON.parse(text)
    expect(error).toContain('shipmets')
    // The valid set, so the caller can fix it without reading this source.
    expect(error).toContain('profit-loss')
  })

  it('refuses a missing date range rather than filtering on null', async () => {
    // `dateFrom!` asserted a parameter the URL need not carry. Absent, the
    // filter became .gte('ship_date', null); `null >= x` is NULL, never TRUE,
    // so nothing matched and the route reported a quiet month.
    const res = await GET(url({ type: 'shipments' }))

    expect(res.status).toBe(400)
    const { error } = await res.json()
    expect(error).toMatch(/dateFrom and dateTo are required/i)
  })

  it('refuses a non-ISO date', async () => {
    const res = await GET(url({ type: 'shipments', dateFrom: '10/01/2026', dateTo: TO }))

    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('yyyy-mm-dd')
  })

  it('refuses a reversed range, which no row can satisfy', async () => {
    const res = await GET(url({ type: 'shipments', dateFrom: TO, dateTo: FROM }))

    expect(res.status).toBe(400)
    const { error } = await res.json()
    expect(error).toContain(TO)
    expect(error).toContain(FROM)
  })

  it('accepts the whole valid type set, so the guard cannot drift from the branches', async () => {
    // Every type the handler branches on must pass validation. A type added to
    // one list and not the other would otherwise fail as a 400 that reads like
    // a caller mistake.
    for (const type of ['shipments', 'profit-loss', 'loss-shipments',
                        'adjustments', 'billing', 'warehouse']) {
      const res = await GET(url({ type, dateFrom: FROM, dateTo: TO }))
      expect(res.status, `type ${type} was rejected`).toBe(200)
    }
  })
})

describe('GET /api/reports/download: staff only', () => {
  it('returns requireStaff\'s refusal and reads nothing', async () => {
    h.requireStaff.mockResolvedValue(
      new Response(JSON.stringify({ error: 'nope' }), { status: 401 }))

    const res = await GET(url({ type: 'shipments', dateFrom: FROM, dateTo: TO }))

    expect(res.status).toBe(401)
    // The gate is before the reads, not merely before the response.
    expect(h.db.calls).toHaveLength(0)
  })
})
