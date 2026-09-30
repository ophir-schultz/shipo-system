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
  mapVarianceRows,
  varianceUnavailableReason,
  varianceUnavailableText,
  PICK_ROW_LIMIT,
} = await import('@/lib/ledger/summary')

type MonthlyRow = Parameters<typeof netProfitUnavailableReason>[0]
type VarianceInputRow = Parameters<typeof mapVarianceRows>[0][number]

/** Every view the summary reads, so an unseeded one cannot look like a failure. */
function seed(over: Partial<Record<string, Record<string, unknown>[]>> = {}) {
  h.db = createFakeSupabase({
    leaks_monthly: [], pnl_monthly: [], pnl_client_monthly: [], pick_days: [],
    labour_variance_inputs: [],
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

  it('reads all five views and returns the errors array', async () => {
    const s = await getLedgerSummary(NOW)
    expect(s.errors).toEqual([])
    const tables = h.db.calls.map((c) => c.table)
    expect(tables.filter((t) => t === 'leaks_monthly')).toHaveLength(2) // dated + undated
    expect(tables).toContain('pnl_monthly')
    expect(tables).toContain('pnl_client_monthly')
    expect(tables).toContain('pick_days')
    expect(tables).toContain('labour_variance_inputs')
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
    expect(h.db.calls).toHaveLength(6)
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

  it('names labour_variance_inputs when IT is the view that failed', async () => {
    h.db.failOn = (call) =>
      call.table === 'labour_variance_inputs' ? { message: 'relation does not exist' } : null
    const s = await getLedgerSummary(NOW)
    expect(s.errors).toEqual(['labour_variance_inputs: relation does not exist'])
    // An empty variance section must be the consequence of a NAMED error, not
    // a silent one that reads as "no variance to report".
    expect(s.variance).toEqual([])
  })

  it('maps the variance rows it reads rather than returning them raw', async () => {
    seed({
      labour_variance_inputs: [
        { ...varianceInput({ period_month: '2026-09-01', direct_labor: 260, standard_rate: 0.23, units_picked: 1000 }) },
      ],
    })
    const s = await getLedgerSummary(NOW)
    expect(s.variance).toHaveLength(1)
    expect(s.variance[0].absorbed).toBeCloseTo(230, 10)
    expect(s.variance[0].variance).toBeCloseTo(30, 10)
    expect(s.counts.variance).toBe(1)
  })

  it('queries labour_variance_inputs with a window floor and a descending order', async () => {
    // Asserted on the recorded FakeCall rather than row ordering: the ordering
    // guarantee is about the STATEMENT, not a fixture effect. Deleting the
    // .order() from getLedgerSummary would leave every data-shape test green
    // while silently removing the guarantee.
    await getLedgerSummary(NOW)
    const varianceCall = h.db.calls.find((c) => c.table === 'labour_variance_inputs')!
    expect(varianceCall).toBeDefined()
    // The gte filter sets the three-month window floor.
    expect(varianceCall.filters.some((f) => f.op === 'gte' && f.column === 'period_month')).toBe(true)
    // The sort must be recorded and descending, so recent months appear first.
    expect(varianceCall.sort).toEqual([{ column: 'period_month', ascending: false }])
  })
})

// ---------------------------------------------------------------------------
// The labour variance, §5.3.2. The single defect this whole section exists to
// prevent: a missing payroll figure rendered as $0.00, which reports the entire
// standard cost as a favourable variance -- a large fictitious saving.
// ---------------------------------------------------------------------------

const varianceInput = (over: Partial<VarianceInputRow> = {}): VarianceInputRow => ({
  period_month: '2026-09-01',
  units_picked: 1000,
  unattributable_pick_charges: 0,
  direct_labor: 260,
  standard_rate: 0.23,
  standard_rate_basis: 'estimated',
  implied_actual_rate: 0.26,
  variant_breakdown: [
    { variant: 'device', units: 1000, standard_rate: 0.23, basis: 'estimated' },
  ],
  ...over,
})

describe('mapVarianceRows', () => {
  it('reports a missing payroll figure as UNKNOWN, never as a zero-dollar variance', () => {
    // The defect this guards: direct_labor null coalesced to 0 gives
    // variance = 0 - 230 = -230, a $230 "saving" that never happened, sitting
    // in green beside a month nobody has entered payroll for.
    const [row] = mapVarianceRows([varianceInput({ direct_labor: null, implied_actual_rate: null })])

    expect(row.basis).toBe('unavailable')
    expect(row.variance).toBeNull()
    expect(row.direct_labor).toBeNull()
    // absorbed is still knowable -- the standard rate and the units are both
    // present -- and reporting it is how the reader sees what the payroll will
    // be compared against.
    expect(row.absorbed).toBeCloseTo(230, 10)
  })

  it('renders that month as the not-computable text and not as a dollar figure', () => {
    // This is the string Step 4 of the brief demands the screen show today,
    // asserted here because vitest cannot reach the .tsx page.
    const [row] = mapVarianceRows([varianceInput({ direct_labor: null })])

    expect(varianceUnavailableText(row)).toBe('not computable — payroll not entered')
    expect(varianceUnavailableText(row)).not.toContain('$')
    expect(varianceUnavailableText(row)).not.toContain('0.00')
  })

  it('does NOT suppress a genuine zero payroll, which means FREE and not UNKNOWN', () => {
    // The mirror of the test above, and the reason `== null` rather than
    // falsiness is used throughout. A month that genuinely cost nothing in
    // direct labour has a computable, fully favourable variance.
    const [row] = mapVarianceRows([varianceInput({ direct_labor: 0 })])

    expect(row.basis).toBe('measured')
    expect(row.variance).toBeCloseTo(-230, 10)
    expect(varianceUnavailableText(row)).toBeNull()
  })

  it('reports an overspend as POSITIVE, so the sign convention cannot be inverted', () => {
    // variance = actualCost - absorbed. Positive is unfavourable. A screen that
    // painted this green would show an overspend as a gain.
    const [over] = mapVarianceRows([varianceInput({ direct_labor: 300 })])
    const [under] = mapVarianceRows([varianceInput({ direct_labor: 200 })])

    expect(over.variance).toBeGreaterThan(0)
    expect(under.variance).toBeLessThan(0)
  })

  it('leaves the variance uncomputable when the month has no standard rate', () => {
    // R25: a variant with picks and no rate in effect nulls the whole month's
    // rate in the view. Averaging over the covered variants only would
    // understate absorbed and invent an unfavourable variance.
    const [row] = mapVarianceRows([varianceInput({
      standard_rate: null, standard_rate_basis: null,
      variant_breakdown: [
        { variant: 'device', units: 600, standard_rate: 0.23, basis: 'estimated' },
        { variant: 'component', units: 400, standard_rate: null, basis: null },
      ],
    })])

    expect(row.basis).toBe('unavailable')
    expect(row.absorbed).toBeNull()
    expect(row.variance).toBeNull()
    expect(varianceUnavailableText(row))
      .toBe('not computable — no standard pick rate in effect for every variant picked')
  })

  it('survives a payroll-only month and reports the full payroll as variance', () => {
    // R22: payroll entered before the charge calculator has run. The view emits
    // units_picked = 0. After the COMMIT 1 fix, labourVariance short-circuits at
    // quantity=0: absorbed=0, variance=payroll. The missing rate is irrelevant —
    // standardRate * 0 = 0 regardless — so the result is 'measured', not
    // 'unavailable'. The full payroll amount is correctly reported as variance.
    const [row] = mapVarianceRows([varianceInput({
      units_picked: 0, standard_rate: null, standard_rate_basis: null,
      implied_actual_rate: null, variant_breakdown: null,
    })])

    expect(row.units_picked).toBe(0)
    expect(row.basis).toBe('measured')
    expect(row.absorbed).toBe(0)
    expect(row.variance).toBeCloseTo(260, 10)   // default direct_labor in varianceInput
    expect(varianceUnavailableText(row)).toBeNull()
  })

  it('payroll-only month with no payroll entered is still unavailable', () => {
    // The exception to the zero-quantity short-circuit: if payroll itself is
    // null, there is nothing to compare absorbed against. absorbed=0 (rate is
    // irrelevant at zero quantity) but variance is UNKNOWN.
    const [row] = mapVarianceRows([varianceInput({
      units_picked: 0, standard_rate: null, standard_rate_basis: null,
      direct_labor: null, implied_actual_rate: null, variant_breakdown: null,
    })])

    expect(row.units_picked).toBe(0)
    expect(row.absorbed).toBe(0)
    expect(row.basis).toBe('unavailable')
    expect(varianceUnavailableText(row)).toContain('payroll not entered')
    expect(varianceUnavailableText(row)).toContain('confirm the charge calculator')
  })

  it('never throws on a quantity labourVariance would reject', () => {
    // labourVariance raises a RangeError on a negative or non-finite quantity,
    // and this runs inside a Server Component render -- an uncaught throw takes
    // the whole /ledger screen down, losing the leaks table over one bad row.
    for (const units of [-5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const [row] = mapVarianceRows([varianceInput({ units_picked: units })])
      expect(row.basis, `units_picked=${units}`).toBe('unavailable')
      expect(row.variance).toBeNull()
      // And it must NOT collapse to a measured zero, which would claim nothing
      // was picked and report the entire payroll as unabsorbed.
      expect(row.units_picked, `units_picked=${units}`).toBeNull()
      expect(varianceUnavailableText(row))
        .toBe('not computable — the units picked figure for this month is not a usable count')
    }
  })

  it('names both causes when payroll AND the standard rate are missing', () => {
    const [row] = mapVarianceRows([varianceInput({
      direct_labor: null, standard_rate: null, standard_rate_basis: null,
      implied_actual_rate: null,
    })])

    const reason = varianceUnavailableReason(row)
    expect(reason).toContain('payroll not entered')
    expect(reason).toContain('standard pick rate')
  })

  it('names unattributable pick charges as the cause rather than blaming the rate card', () => {
    // R21: a pick charge with a null rate_id is COUNTED and nulls the month's
    // rate. Dropping it would shrink units_picked and invent an overspend.
    const [row] = mapVarianceRows([varianceInput({
      unattributable_pick_charges: 3, standard_rate: null, standard_rate_basis: null,
    })])

    expect(row.unattributable_pick_charges).toBe(3)
    expect(varianceUnavailableReason(row)).toContain('3 pick charges carry no rate-card variant')
  })

  it('keeps standard_rate_basis from the VIEW, not from labourVariance', () => {
    // R24: variance.ts returns basis 'measured' whenever both inputs are
    // present, because it has no way to know the rate is a placeholder. Every
    // pick rate is 'estimated' today, so reading VarianceResult.basis for the
    // caveat would label a placeholder-derived figure measured.
    const [row] = mapVarianceRows([varianceInput()])

    expect(row.basis).toBe('measured')
    expect(row.standard_rate_basis).toBe('estimated')
  })

  it('never returns an empty reason on any shape that produces "unavailable"', () => {
    // Same contract as netProfitUnavailableReason: the screen prints this after
    // "not computable — " and a blank leaves a dangling dash.
    const shapes: VarianceInputRow[] = [
      varianceInput({ direct_labor: null }),
      varianceInput({ standard_rate: null }),
      varianceInput({ direct_labor: null, standard_rate: null }),
      // units_picked=0 with payroll present now produces 'measured' (COMMIT 1),
      // so it no longer belongs in this unavailable-shapes list.
      // units_picked=0, standard_rate=null, direct_labor=null: payroll is UNKNOWN
      // so the result is still unavailable even at zero quantity.
      varianceInput({ units_picked: 0, standard_rate: null, direct_labor: null }),
      varianceInput({ unattributable_pick_charges: 1, standard_rate: null }),
      varianceInput({ units_picked: -1 }),
      varianceInput({ units_picked: Number.NaN, direct_labor: null }),
      // units_picked:null is coerced to 0 by mapVarianceRows. With direct_labor
      // present, zero quantity now produces 'measured' (COMMIT 1). To get
      // 'unavailable' we also need the payroll to be absent.
      varianceInput({ units_picked: null, standard_rate: null, direct_labor: null }),
    ]
    for (const shape of shapes) {
      const [row] = mapVarianceRows([shape])
      expect(row.basis, JSON.stringify(shape)).toBe('unavailable')
      const text = varianceUnavailableText(row)
      expect(text, JSON.stringify(shape)).toBeTruthy()
      expect(text!.endsWith('— ')).toBe(false)
    }
  })

  it('coerces numeric strings without turning a null into a zero', () => {
    // PostgREST may hand numerics back as strings depending on client version.
    // The conversion must not be a blanket Number(), which maps null to 0.
    const [row] = mapVarianceRows([{
      ...varianceInput(),
      units_picked: '1000' as unknown as number,
      direct_labor: '260.00' as unknown as number,
      standard_rate: '0.2300' as unknown as number,
    }])

    expect(row.units_picked).toBe(1000)
    expect(row.absorbed).toBeCloseTo(230, 10)
    expect(row.variance).toBeCloseTo(30, 10)
  })
})
