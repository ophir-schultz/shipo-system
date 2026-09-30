import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createFakeSupabase, type FakeDb, type FakeRow } from '@/lib/ledger/fake-supabase'

// persist-storage-charges reads `supabaseAdmin` on every call rather than
// capturing it, so a getter is enough to swap the whole database per test. Same
// pattern as persist-charges.test.ts:7-11.
const h = vi.hoisted(() => ({ db: null as unknown as FakeDb }))
vi.mock('@/lib/supabase', () => ({
  get supabaseAdmin() { return h.db.client },
}))

const { persistStorageCharges } = await import('@/lib/ledger/persist-storage-charges')

// The clock is pinned so that monthStart(3)/monthStart(0) are fixed and the
// fixtures below sit inside the window whatever day the suite runs.
const NOW = new Date('2026-09-30T10:00:00.000Z')

const palletRate = {
  id: 'rate-pallet', client_id: 'client-1', charge_type: 'storage', variant: 'pallet',
  rate: 25, rate_type: 'per_pallet', effective_from: null, effective_to: null,
}
const shelfRate = {
  id: 'rate-shelf', client_id: 'client-1', charge_type: 'storage', variant: 'shelf',
  rate: 12, rate_type: 'per_shelf', effective_from: null, effective_to: null,
}
const storageCost = {
  id: 'cost-storage', cost_type: 'storage', variant: null, unit: 'per_pallet_month',
  rate: 12, effective_from: '2026-01-01', effective_to: null, basis: 'estimated',
}

function db(overrides: Partial<Record<string, FakeRow[]>> = {}) {
  return createFakeSupabase({
    client_storage_months: [
      { id: 'm1', client_id: 'client-1', period_month: '2026-09-01',
        pallet_positions: 4, shelf_positions: 3, basis: 'estimated' },
    ],
    client_warehouse_rates: [palletRate, shelfRate],
    cost_rates: [storageCost],
    order_charges: [],
    ...overrides,
  })
}

const storageRows = () =>
  ((h.db.tables.order_charges ?? []) as FakeRow[])
    .filter((c) => c.charge_type === 'storage')

const sumAmount = (rows: FakeRow[]) => rows.reduce((s, r) => s + Number(r.amount ?? 0), 0)

/** Every statement the module issued against `table` with `verb`. */
const callsFor = (table: string, verb: string) =>
  h.db.calls.filter((c) => c.table === table && c.verb === verb)

beforeEach(() => {
  h.db = db()
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})

afterEach(() => { vi.useRealTimers() })

describe('persistStorageCharges — writing', () => {
  it('writes one row per declared variant, keyed on month AND variant', async () => {
    const result = await persistStorageCharges()

    expect(result.skipped).toBe(false)
    if (result.skipped) return
    expect(result.written).toBe(2)
    expect(result.inserted).toBe(2)
    expect(result.updated).toBe(0)

    const keys = storageRows().map((r) => r.charge_key).sort()
    expect(keys).toEqual(['storage:2026-09-01:pallet', 'storage:2026-09-01:shelf'])
    expect(sumAmount(storageRows())).toBe(136)      // 4 * 25 + 3 * 12
  })

  it('gives every storage row a null order_id and a client_id', async () => {
    await persistStorageCharges()
    for (const r of storageRows()) {
      expect(r.order_id).toBeNull()
      expect(r.client_id).toBe('client-1')
    }
  })

  // THE IDEMPOTENCY CLAIM. Three crons a day recalculate these rows; if the
  // second run inserted rather than updated, storage revenue would triple daily.
  // Asserted on the row COUNT and the amount SUM together: a count alone passes
  // if the rows were replaced with wrong numbers.
  it('is idempotent: a second run changes neither the row count nor the total', async () => {
    await persistStorageCharges()
    const afterFirst = { count: storageRows().length, total: sumAmount(storageRows()) }

    const second = await persistStorageCharges()

    expect(storageRows()).toHaveLength(afterFirst.count)
    expect(sumAmount(storageRows())).toBe(afterFirst.total)
    expect(second.skipped).toBe(false)
    if (second.skipped) return
    expect(second.cleared).toBe(0)
  })

  it('the second run UPDATEs and does not INSERT', async () => {
    await persistStorageCharges()
    const insertsAfterFirst = callsFor('order_charges', 'insert').length

    const second = await persistStorageCharges()

    expect(second.skipped).toBe(false)
    if (second.skipped) return
    expect(second.updated).toBe(2)
    expect(second.inserted).toBe(0)
    // And at the statement level, not only in the counters.
    expect(callsFor('order_charges', 'insert')).toHaveLength(insertsAfterFirst)
    expect(callsFor('order_charges', 'update').length).toBeGreaterThanOrEqual(2)
  })

  // A storage row is identified by `order_id is null` — that is the predicate of
  // the partial unique index it lives under. Without the filter the select could
  // match an order's charge that happened to share a key, and the run would
  // UPDATE it into a storage charge.
  it('reads existing rows with an `order_id is null` filter', async () => {
    await persistStorageCharges()
    const select = callsFor('order_charges', 'select')[0]
    expect(select).toBeDefined()
    expect(select.filters).toContainEqual({ op: 'is-null', column: 'order_id', value: null })
    expect(select.filters).toContainEqual({ op: 'eq', column: 'client_id', value: 'client-1' })
  })

  it('never touches another client-month or an order charge that shares the client', async () => {
    h.db.tables.order_charges = [
      { id: 'c-order', order_id: 'order-9', client_id: 'client-1',
        charge_key: 'item:x:pick', charge_type: 'pick', amount: 7 },
      { id: 'c-other-month', order_id: null, client_id: 'client-1',
        charge_key: 'storage:2026-08-01:pallet', charge_type: 'storage', amount: 50 },
    ]

    await persistStorageCharges()

    const ids = (h.db.tables.order_charges as FakeRow[]).map((r) => r.id)
    expect(ids).toContain('c-order')
    expect(ids).toContain('c-other-month')
  })
})

describe('persistStorageCharges — the stale sweep (C1)', () => {
  // THE DEFECT THIS EXISTS FOR. Declare 4 pallets, $100 is written. Discover it
  // was really 0 and set it to 0. Before the sweep, `rows.length === 0` hit a
  // `continue` and the $100 stayed for ever, with no log line and no error;
  // leaks_monthly has no over-billing branch, so nothing downstream caught it.
  it('removes the storage charge when the declared count drops to zero', async () => {
    await persistStorageCharges()
    expect(storageRows()).toHaveLength(2)

    const month = (h.db.tables.client_storage_months as FakeRow[])[0]
    month.pallet_positions = 0
    month.shelf_positions = 0

    const result = await persistStorageCharges()

    expect(storageRows()).toEqual([])
    expect(result.skipped).toBe(false)
    if (result.skipped) return
    expect(result.cleared).toBe(2)
    expect(result.written).toBe(0)
  })

  it('removes only the variant that went to zero', async () => {
    await persistStorageCharges()
    ;(h.db.tables.client_storage_months as FakeRow[])[0].shelf_positions = 0

    const result = await persistStorageCharges()

    expect(storageRows().map((r) => r.charge_key)).toEqual(['storage:2026-09-01:pallet'])
    expect(result.skipped).toBe(false)
    if (result.skipped) return
    expect(result.cleared).toBe(1)
  })

  // Removing the storage line from the rate card is the other way a charge is
  // meant to go to zero, and it also produces zero built rows.
  it('removes the storage charge when the rate card line is withdrawn', async () => {
    await persistStorageCharges()
    h.db.tables.client_warehouse_rates = []

    await persistStorageCharges()

    expect(storageRows()).toEqual([])
  })

  // `.in('id', [])` renders as `id=in.()`, which is a PostgREST syntax error
  // rather than a no-op. Nothing stale means no delete statement at all.
  it('issues no delete when there is nothing stale', async () => {
    await persistStorageCharges()
    const before = callsFor('order_charges', 'delete').length
    await persistStorageCharges()
    expect(callsFor('order_charges', 'delete')).toHaveLength(before)
  })

  it('sweeps a key prefixed by this month only, leaving other months alone', async () => {
    h.db.tables.order_charges = [
      { id: 'c-aug', order_id: null, client_id: 'client-1',
        charge_key: 'storage:2026-08-01:pallet', charge_type: 'storage', amount: 50 },
      { id: 'c-sep-dead', order_id: null, client_id: 'client-1',
        charge_key: 'storage:2026-09-01:mezzanine', charge_type: 'storage', amount: 11 },
    ]

    await persistStorageCharges()

    const ids = storageRows().map((r) => r.id)
    expect(ids).toContain('c-aug')
    expect(ids).not.toContain('c-sep-dead')
  })
})

describe('persistStorageCharges — isolation and counting', () => {
  // persist-charges.ts:211-216 already ruled this for orders: one broken order
  // must not stop the other few thousand. A corrupt count in one client-month
  // used to throw out of the loop and unbill every client sorting after it.
  it('one corrupt client-month does not cost the others their billing', async () => {
    h.db.tables.client_storage_months = [
      { id: 'm-bad', client_id: 'client-1', period_month: '2026-08-01',
        pallet_positions: 'not-a-number', shelf_positions: null, basis: 'estimated' },
      { id: 'm-good', client_id: 'client-1', period_month: '2026-09-01',
        pallet_positions: 4, shelf_positions: null, basis: 'estimated' },
    ]

    const result = await persistStorageCharges()

    expect(result.skipped).toBe(false)
    if (result.skipped) return
    expect(result.failedMonths).toBe(1)
    expect(storageRows().map((r) => r.charge_key)).toEqual(['storage:2026-09-01:pallet'])
    expect(result.errors.join(' ')).toMatch(/failed/i)
  })

  // PostgREST row order is unspecified. Without an explicit order, WHICH
  // client-months go unbilled after a failure differs run to run — an
  // intermittent bug that never reproduces.
  it('reads the declarations in a stable order', async () => {
    await persistStorageCharges()
    const read = h.db.calls.find((c) => c.table === 'client_storage_months')!
    expect(read).toBeDefined()
    // The window is floored AND capped: a typo'd 2030-01-01 must not bill today.
    expect(read.filters.some((f) => f.op === 'gte' && f.column === 'period_month')).toBe(true)
    expect(read.filters.some((f) => f.op === 'lte' && f.column === 'period_month')).toBe(true)
  })

  it('does not bill a month in the future', async () => {
    h.db.tables.client_storage_months = [
      { id: 'm-typo', client_id: 'client-1', period_month: '2030-01-01',
        pallet_positions: 4, shelf_positions: null, basis: 'estimated' },
    ]
    const result = await persistStorageCharges()
    expect(storageRows()).toEqual([])
    expect(result.skipped).toBe(false)
    if (result.skipped) return
    expect(result.months).toBe(0)
  })

  // A positive count that raised no charge is storage being given away. Same
  // detector persist-charges.ts:241-243 runs for orders, and it must reach
  // errors[] rather than a log line nobody reads.
  it('counts and reports a declared month with no rate card line', async () => {
    h.db.tables.client_warehouse_rates = []

    const result = await persistStorageCharges()

    expect(result.skipped).toBe(false)
    if (result.skipped) return
    expect(result.unpricedMonths).toBe(1)
    expect(result.errors.join(' ')).toMatch(/no storage charge/i)
  })

  // Nobody has answered yet. Different from a client who stored nothing, and
  // only this one should be chased up.
  it('counts a declaration row with no counts in it as undeclared, not unpriced', async () => {
    h.db.tables.client_storage_months = [
      { id: 'm1', client_id: 'client-1', period_month: '2026-09-01',
        pallet_positions: null, shelf_positions: null, basis: 'estimated' },
    ]

    const result = await persistStorageCharges()

    expect(result.skipped).toBe(false)
    if (result.skipped) return
    expect(result.undeclaredMonths).toBe(1)
    expect(result.unpricedMonths).toBe(0)
    expect(result.errors).toEqual([])
    expect(storageRows()).toEqual([])
  })

  it('counts estimated charges, so a declared count never wears a confident badge', async () => {
    const result = await persistStorageCharges()
    expect(result.skipped).toBe(false)
    if (result.skipped) return
    expect(result.estimatedCharges).toBe(2)
  })
})

describe('persistStorageCharges — before the migration is applied', () => {
  // There is no migration runner in this project: supabase/*.sql is pasted into
  // the SQL editor by a person. On day one the table does not exist, and that is
  // the EXPECTED state — not an incident worth a 🚨 subject line on all three
  // crons and a dashboard toast every five minutes.
  it('reports a missing client_storage_months as skipped, not as a failure', async () => {
    h.db.failOn = (call) =>
      call.table === 'client_storage_months'
        ? { message: 'relation "public.client_storage_months" does not exist', code: '42P01' }
        : null

    const result = await persistStorageCharges()

    expect(result.skipped).toBe(true)
    if (!result.skipped) return
    expect(result.cause).toBe('missing-table')
    // fetchAllPages' migrationHint names the file to paste, which is the whole
    // point of routing this read through it.
    expect(result.reason).toContain('supabase/ledger_07_storage.sql')
  })

  it('still throws on a read failure that is NOT a missing table', async () => {
    h.db.failOn = (call) =>
      call.table === 'client_storage_months'
        ? { message: 'connection reset', code: '08006' }
        : null

    await expect(persistStorageCharges()).rejects.toThrow(/connection reset/)
  })
})
