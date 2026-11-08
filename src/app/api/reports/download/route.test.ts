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

// A read that was TRUNCATED, as distinct from one that failed.
//
// The refusal above is built on `error`, and a capped read does not set one:
// PostgREST returns the server's `db-max-rows` as a 200 with `error: null`, so
// every gate in this route passes it. The resulting workbook is complete,
// well-formed and short -- the one failure mode that survives the fix above,
// and the one an invoice is actually built from.
//
// The fake database does not model a row cap, so none of these assert "2500 rows
// came back" against an unpaginated read: it would come back either way. What
// discriminates is that the route makes SEVERAL contiguous requests instead of
// one, which is the only thing a capped server responds to.
describe('GET /api/reports/download: a truncated read is not an empty month either', () => {
  /** `n` shipments in the window, distinguishable, with ship_date all equal. */
  function seedShipments(n: number) {
    h.db = createFakeSupabase({
      ...structuredClone(EMPTY_TABLES),
      shipments: Array.from({ length: n }, (_, i) => ({
        id: `s${String(i).padStart(5, '0')}`,
        order_number: `ORD-${i}`,
        // Deliberately IDENTICAL across every row. This is the real shape of
        // the data -- a day's labels all carry one ship_date -- and it is the
        // condition under which an OFFSET page boundary is undefined.
        ship_date: '2026-10-12',
        carrier: 'ups', service: 'ground', actual_cost: 1, client_rate: 2,
        profit_loss: 1, is_loss: false, source: 'shipstation', client_id: 'c1',
      })),
    })
  }

  const readsOf = (table: string) =>
    h.db.calls.filter(c => c.table === table && c.verb === 'select')

  it('reads a period of 2500 shipments in pages and exports all of them', async () => {
    seedShipments(2500)

    const res = await GET(url({ type: 'shipments', dateFrom: FROM, dateTo: TO }))
    expect(res.ok).toBe(true)

    // The discriminating assertion. One request means one page means whatever
    // the server felt like returning.
    const reads = readsOf('shipments')
    expect(reads.length).toBeGreaterThan(1)
    // Contiguous and advancing: a loop that re-asked for [0, 999] forever would
    // also make several requests, and would hang or duplicate.
    expect(reads.map(c => c.range)).toEqual([
      [0, 999], [1000, 1999], [2000, 2999], [2500, 3499],
    ])

    const rows = await sheetRows(res)
    expect(rows).toHaveLength(2500)
    // Not only the count. A page boundary that repeated a row would still give
    // 2500 and would be one billable line charged twice and another dropped.
    expect(new Set(rows.map(r => r['Order #'])).size).toBe(2500)
  })

  it('orders every paged read by a UNIQUE column last', async () => {
    // Postgres does not promise a stable row order across two OFFSET queries
    // sorted on a non-unique column, and every sort key this route uses --
    // ship_date, profit_loss, adjustment_date, week_start, log_date -- has
    // thousands of ties. Paging without a tiebreaker is how you get a
    // duplicated line and a missing one with a plausible row count.
    //
    // Asserted per type, because the tiebreaker is one call per branch and six
    // branches are six chances to forget it.
    for (const [type, table] of [
      ['shipments', 'shipments'],
      ['profit-loss', 'shipments'],
      ['loss-shipments', 'shipments'],
      ['adjustments', 'rate_adjustments'],
      ['billing', 'bills'],
      ['warehouse', 'warehouse_daily_log'],
    ] as const) {
      h.db = createFakeSupabase(structuredClone(EMPTY_TABLES))

      await GET(url({ type, dateFrom: FROM, dateTo: TO }))

      const reads = readsOf(table)
      expect(reads.length, `${type} did not read ${table}`).toBeGreaterThan(0)
      for (const call of reads) {
        expect(call.range, `${type}: an unpaged read of ${table}`).toBeDefined()
        expect(call.sort.length, `${type}: ${table} read with no ordering`)
          .toBeGreaterThan(0)
        expect(call.sort[call.sort.length - 1].column,
          `${type}: ${table} paged without a unique tiebreaker`).toBe('id')
      }
    }
  })

  it('writes NO FILE when a LATER page fails', async () => {
    // The rows already read are a PREFIX of the answer. Returning them would be
    // the original defect with extra steps: a workbook of the first thousand
    // shipments of a month that has 2500, with nothing saying so. This is the
    // case a per-read `if (error)` check at the top would miss entirely.
    seedShipments(2500)
    let seen = 0
    h.db.failOn = (call) => {
      if (call.table !== 'shipments') return null
      seen++
      return seen >= 2 ? { message: 'terminating connection due to administrator command' } : null
    }

    const res = await GET(url({ type: 'shipments', dateFrom: FROM, dateTo: TO }))

    expect(res.status).toBe(502)
    const text = await bodyText(res)
    expect(text).not.toContain('No records found')
    expect(text).toContain('shipments')
    expect(res.headers.get('content-disposition')).toBeNull()
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

describe('GET /api/reports/download: profit summary is a shipment client rate', () => {
  it('prints the rate basis, no date column, and the same dollars', async () => {
    h.db = createFakeSupabase({
      ...structuredClone(EMPTY_TABLES),
      shipments: [
        {
          id: 'priced', client_id: 'c1', clients: { name: 'Nayax' },
          ship_date: '2026-10-15T15:00:00.000Z',
          actual_cost: 4873.52, client_rate: 6313.47, profit_loss: 1439.95,
          is_loss: false, raw_data: {},
        },
        {
          id: 'unrated', client_id: 'c1', clients: { name: 'Nayax' },
          ship_date: '2026-10-16T15:00:00.000Z',
          actual_cost: 12, client_rate: null, profit_loss: null,
          is_loss: true, raw_data: {},
        },
      ],
    })

    const rows = await sheetRows(await GET(url({ type: 'profit-loss', dateFrom: FROM, dateTo: TO })))
    const keys = Object.keys(rows[0])
    expect(keys).toContain('Shipment client rate ($)')
    expect(keys).toContain('Rate minus carrier cost ($)')
    expect(keys).not.toContain('Revenue ($)')
    expect(keys).not.toContain('Profit ($)')
    expect(keys.some((key) => /date/i.test(key))).toBe(false)

    const total = rows.find((row) => row.Client === 'TOTAL')
    expect(total).toMatchObject({
      'Shipments': 2,
      'Reconciled (in the figures below)': 1,
      'No agreed rate (excluded)': 1,
      'Shipment client rate ($)': '6313.47',
      'Carrier Cost ($)': '4873.52',
      'Rate minus carrier cost ($)': '1439.95',
      'Margin %': '22.8%',
      'Loss-flagged Shipments': 1,
    })
    expect(String(rows.find((row) => row.Client === 'NOTE')?.['Shipment client rate ($)']))
      .toMatch(/not invoiced, charged, or realized revenue/)
    expect(String(rows.find((row) => row.Client === 'NOTE')?.['Shipment client rate ($)']))
      .toMatch(/not company profit/)

    const csv = await bodyText(await GET(url({
      type: 'profit-loss', dateFrom: FROM, dateTo: TO, format: 'csv',
    })))
    const header = csv.split('\n')[0]
    expect(header).toContain('Shipment client rate ($)')
    expect(header).not.toMatch(/Date/)
    expect(csv).toContain('6313.47')
    expect(csv).toContain('not company profit')
  })
})

describe('GET /api/reports/download: ship date is the carrier calendar day', () => {
  function parcel(over: Record<string, unknown>) {
    return {
      carrier: 'ups', service: 'ground', tracking_number: '1Z',
      recipient_name: 'A', recipient_city: 'Dover', recipient_state: 'DE',
      weight: 1, actual_cost: 4, client_rate: 9, profit_loss: 5, is_loss: false,
      source: 'shipstation', client_id: 'c1', clients: { name: 'Nayax' },
      ...over,
    }
  }

  beforeEach(() => {
    h.db = createFakeSupabase({
      ...structuredClone(EMPTY_TABLES),
      shipments: [
        parcel({
          id: 'raw', order_number: 'SO601061446',
          ship_date: '2026-10-09T00:00:00.000Z',
          raw_data: { shipDate: '2026-10-09', secretCost: 'secret-cost-87873' },
          tracking_number: '1ZRAW',
        }),
        parcel({
          id: 'gate', order_number: 'SO-GATE',
          ship_date: '2026-10-01T00:00:00.000Z',
          raw_data: { shipDate: '2026-10-01' },
          tracking_number: '1ZGATE', is_loss: true, profit_loss: -2,
        }),
        parcel({
          id: 'instant', order_number: 'SO-INSTANT',
          ship_date: '2026-10-01T00:00:00.000Z',
          raw_data: { shipDate: '2026-10-01T00:00:00.000Z' },
          tracking_number: '1ZINSTANT', is_loss: true, profit_loss: -3,
        }),
        parcel({
          id: 'late', order_number: 'SO-LATE',
          ship_date: '2026-11-01T03:30:00.000Z',
          raw_data: {}, tracking_number: '1ZLATE',
        }),
      ],
    })
  })

  it('prints the carrier day and leaves a September instant out of October', async () => {
    const october = await sheetRows(await GET(url({ type: 'shipments', dateFrom: FROM, dateTo: TO })))
    const byOrder = new Map(october.map((row) => [row['Order #'], row]))
    expect(byOrder.get('SO601061446')).toMatchObject({
      'Ship Date': '2026-10-09',
      'Stored ship day': '2026-10-08',
    })
    expect(byOrder.get('SO-LATE')).toMatchObject({ 'Ship Date': '2026-10-31' })
    expect(byOrder.get('SO-LATE')?.['Stored ship day'] ?? '').toBe('')
    expect(byOrder.has('SO-GATE')).toBe(false)
    expect(byOrder.has('SO-INSTANT')).toBe(false)
    expect(JSON.stringify(october)).not.toContain('secret-cost-87873')

    const september = await sheetRows(await GET(url({
      type: 'shipments', dateFrom: '2026-09-01', dateTo: '2026-09-30',
    })))
    const earlier = new Map(september.map((row) => [row['Order #'], row]))
    expect(earlier.get('SO-GATE')).toMatchObject({
      'Ship Date': '2026-10-01',
      'Stored ship day': '2026-09-30',
    })
    expect(earlier.get('SO-INSTANT')).toMatchObject({ 'Ship Date': '2026-09-30' })
    expect(earlier.get('SO-INSTANT')?.['Stored ship day'] ?? '').toBe('')
    expect(earlier.has('SO601061446')).toBe(false)
  })

  it('uses the same dates on the loss export', async () => {
    const october = await sheetRows(await GET(url({ type: 'loss-shipments', dateFrom: FROM, dateTo: TO })))
    expect(october.map((row) => row['Order #'])).not.toContain('SO-GATE')
    const september = await sheetRows(await GET(url({
      type: 'loss-shipments', dateFrom: '2026-09-01', dateTo: '2026-09-30',
    })))
    const byOrder = new Map(september.map((row) => [row['Order #'], row]))
    expect(byOrder.get('SO-GATE')).toMatchObject({
      'Ship Date': '2026-10-01',
      'Stored ship day': '2026-09-30',
    })
    expect(byOrder.get('SO-INSTANT')).toMatchObject({ 'Ship Date': '2026-09-30' })
  })
})
