import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createFakeSupabase, type FakeDb } from '@/lib/ledger/fake-supabase'

const h = vi.hoisted(() => ({ db: null as unknown as FakeDb }))
vi.mock('@/lib/supabase', () => ({
  get supabaseAdmin() { return h.db.client },
}))

const {
  getLedgerSummary,
  netProfitUnavailableReason,
  threeMonthWindowStart,
  fmtMonth,
  PICK_ROW_LIMIT,
} = await import('@/lib/ledger/summary')

type MonthlyRow = Parameters<typeof netProfitUnavailableReason>[0]

/** Every view the summary reads, so an unseeded one cannot look like a failure. */
function seed(over: Partial<Record<string, Record<string, unknown>[]>> = {}) {
  h.db = createFakeSupabase({
    leaks_monthly: [], pnl_monthly: [], pnl_client_monthly: [], pick_days: [],
    ...over,
  })
}

beforeEach(() => seed())

// ---------------------------------------------------------------------------

describe('threeMonthWindowStart', () => {
  it('subtracts three months arithmetically, not via setMonth', () => {
    // 31 May is the case that breaks setMonth(): it normalises 31 February to
    // 3 March and silently narrows the window to two months.
    expect(threeMonthWindowStart(new Date('2026-05-31T12:00:00'))).toBe('2026-02-01')
  })

  it('carries the year when the month underflows', () => {
    expect(threeMonthWindowStart(new Date('2026-02-15T12:00:00'))).toBe('2025-11-01')
    expect(threeMonthWindowStart(new Date('2026-01-01T12:00:00'))).toBe('2025-10-01')
  })
})

describe('fmtMonth', () => {
  it('names the undated bucket instead of printing a broken date', () => {
    expect(fmtMonth(null)).toBe('undated')
  })
})

// ---------------------------------------------------------------------------

const monthlyRow = (over: Partial<MonthlyRow> = {}): MonthlyRow => ({
  period_month: '2026-09-01',
  revenue: 1000,
  direct_cost: 100,
  revenue_unknown_charges: 0,
  cost_unknown_charges: 0,
  gross_margin: 900,
  overhead: 50, direct_labor: 50, direct_storage: 50,
  overhead_rows: 1, direct_labor_rows: 1, direct_storage_rows: 1,
  net_profit: null,
  has_estimates: false,
  ...over,
})

describe('netProfitUnavailableReason', () => {
  it('never returns an empty or null reason on any reachable shape', () => {
    // The screen prints this immediately after the word "unknown". Anything
    // falsy here renders a dangling "unknown — " with nothing after it.
    const shapes: MonthlyRow[] = [
      monthlyRow(),
      monthlyRow({ revenue: null }),
      monthlyRow({ overhead_rows: null, direct_labor_rows: null, direct_storage_rows: null, overhead: null, direct_labor: null, direct_storage: null }),
      monthlyRow({ direct_storage_rows: 0, direct_storage: null }),
      monthlyRow({ revenue: null, direct_storage_rows: 0, direct_storage: null }),
      monthlyRow({ revenue: null, overhead_rows: null, direct_labor_rows: null, direct_storage_rows: null }),
    ]
    for (const row of shapes) {
      const reason = netProfitUnavailableReason(row)
      expect(reason, JSON.stringify(row)).toBeTruthy()
      expect(reason.trim().length).toBeGreaterThan(0)
    }
  })

  it('blames the revenue side on an overhead-only row from the FULL OUTER JOIN', () => {
    // September's rent entered before the charge calculator has run for
    // September: operating_costs has the month, order_charges does not, so
    // every r.* column is null while all three *_rows counts are > 0. The
    // previous helper found no missing category here, returned null, and the
    // screen printed "unknown — " beside a tooltip blaming a cost category.
    const reason = netProfitUnavailableReason(monthlyRow({
      revenue: null, direct_cost: null, gross_margin: null,
      revenue_unknown_charges: null, cost_unknown_charges: null,
      overhead_rows: 2, direct_labor_rows: 1, direct_storage_rows: 1,
    }))
    expect(reason).toContain('no billed revenue')
    expect(reason).toContain('Sep 2026')
    expect(reason).not.toContain('overhead')
  })

  it('blames revenue when every charge in the month has a null amount', () => {
    // At-cost freight whose carrier has not reported: sum(amount) over all
    // nulls is null, so revenue is null with operating costs fully entered.
    const reason = netProfitUnavailableReason(monthlyRow({
      revenue: null, revenue_unknown_charges: 12, gross_margin: null,
    }))
    expect(reason).toContain('no billed revenue')
  })

  it('names the single missing cost category', () => {
    const reason = netProfitUnavailableReason(monthlyRow({ direct_storage_rows: 0, direct_storage: null }))
    expect(reason).toBe('no direct storage cost recorded for Sep 2026')
  })

  it('says so when no operating costs were entered at all', () => {
    const reason = netProfitUnavailableReason(monthlyRow({
      overhead: null, direct_labor: null, direct_storage: null,
      overhead_rows: null, direct_labor_rows: null, direct_storage_rows: null,
    }))
    expect(reason).toBe('no operating costs entered for Sep 2026')
  })

  it('reports both sides when revenue AND a cost category are missing', () => {
    const reason = netProfitUnavailableReason(monthlyRow({
      revenue: null, direct_labor_rows: 0, direct_labor: null,
    }))
    expect(reason).toContain('no billed revenue')
    expect(reason).toContain('direct labor')
  })
})

// ---------------------------------------------------------------------------

describe('getLedgerSummary', () => {
  const NOW = new Date('2026-09-15T12:00:00')

  it('reads all four views and returns the errors array', async () => {
    const s = await getLedgerSummary(NOW)
    expect(s.errors).toEqual([])
    const tables = h.db.calls.map((c) => c.table)
    expect(tables.filter((t) => t === 'leaks_monthly')).toHaveLength(2) // dated + undated
    expect(tables).toContain('pnl_monthly')
    expect(tables).toContain('pnl_client_monthly')
    expect(tables).toContain('pick_days')
  })

  it('names the view in every error rather than returning a bare message', async () => {
    // A view that fails to load must not render as an empty table; with five
    // queries a bare Postgres string does not say which one broke.
    h.db.failOn = (call) =>
      call.table === 'pnl_monthly' ? { message: 'relation does not exist' } : null
    const s = await getLedgerSummary(NOW)
    expect(s.errors).toEqual(['pnl_monthly: relation does not exist'])
    expect(s.monthly).toEqual([])
  })

  it('surfaces undated leaks separately and never merges them into a month', async () => {
    // shipments.ship_date is nullable; date_trunc('month', null) is null; and
    // `null >= <window start>` is null — so the dated query drops these
    // without trace. They are real spend that can never be billed.
    seed({
      leaks_monthly: [
        { period_month: '2026-09-01', client_id: null, leak: 'unpriced_shipments', detail: 'd', records: 2, amount: 20 },
        { period_month: null, client_id: null, leak: 'unpriced_shipments', detail: 'd', records: 5, amount: 91.5 },
      ],
    })
    const s = await getLedgerSummary(NOW)

    expect(s.leaks).toHaveLength(1)
    expect(s.leaks[0].period_month).toBe('2026-09-01')
    expect(s.leaksUndated).toHaveLength(1)
    expect(s.leaksUndated[0].amount).toBe(91.5)
    // The undated row is not folded into the dated set under any month.
    expect(s.leaks.some((r) => r.period_month === null)).toBe(false)
  })

  it('reports the true row count so a truncated table cannot pass as a complete one', async () => {
    const picks = Array.from({ length: PICK_ROW_LIMIT + 7 }, (_, i) => ({
      client_id: 'c', pick_date: '2026-09-10', sku: `sku-${String(i).padStart(4, '0')}`,
      description: null, is_component: false, orders: 1, units_picked: 1,
      has_estimates: false, confidence: 3,
    }))
    seed({ pick_days: picks })

    const s = await getLedgerSummary(NOW)
    expect(s.picks).toHaveLength(PICK_ROW_LIMIT)
    expect(s.counts.picks).toBe(PICK_ROW_LIMIT + 7)
  })

  it('asks for an exact count on every query', async () => {
    await getLedgerSummary(NOW)
    expect(h.db.calls).toHaveLength(5)
    for (const call of h.db.calls) {
      expect(call.count, `${call.table} was read without a count`).toBe('exact')
    }
  })

  it('sorts within the month so truncation and page order are deterministic', async () => {
    seed({
      pnl_client_monthly: [
        { period_month: '2026-09-01', client_id: 'b', client_name: 'Beta', charge_type: 'pick' },
        { period_month: '2026-09-01', client_id: 'a', client_name: 'Alpha', charge_type: 'ship' },
        { period_month: '2026-09-01', client_id: 'a', client_name: 'Alpha', charge_type: 'pick' },
      ],
    })
    const s = await getLedgerSummary(NOW)
    expect(s.clients.map((r) => `${r.client_name}/${r.charge_type}`))
      .toEqual(['Alpha/pick', 'Alpha/ship', 'Beta/pick'])
  })
})
