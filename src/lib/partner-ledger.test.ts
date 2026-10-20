import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createFakeSupabase, type FakeDb, type FakeRow, type FakeCall } from '@/lib/ledger/fake-supabase'

const h = vi.hoisted(() => ({ db: null as unknown as FakeDb }))

vi.mock('@/lib/supabase', () => ({
  get supabaseAdmin() { return h.db.client },
}))

// A static import: partner-activity is pure and touches no supabase client, so
// it does not need the hoisted mock the loader below does.
import { ORDER_UNITS_LIMIT } from './partner-activity'

const {
  loadPartnerLedger,
  reconcile,
  monthKey,
  ledgerInvoiceId,
  isLedgerInvoiceId,
} = await import('./partner-ledger')

// This module decides what a partner is PAID. It is almost entirely database
// choreography plus one merge, and the merge is where the money is: the ledger
// and the hand-typed fba_invoices row can both describe the same month, and
// picking the wrong field from the wrong source is a payment that is wrong
// without anything looking broken.
//
// The hazards these tests exist for, in order of how much they would cost:
//
//  1. A figure derived from a TRUNCATED read presented as fact. The order-units
//     query is capped, so an order count taken from it is a count of the rows
//     that survived the cap. 0 is not the risk; a plausible wrong number is.
//  2. A month whose costs are not fully priced being paid on. Unpriced costs
//     read as FREE, which overstates net profit, and 5% of a margin we never
//     earned does not come back.
//  3. Reconciliation comparing a row to ITSELF. The synthetic ledger id has to
//     be excluded when finding the hand-typed row, or every ledger-only month
//     reconciles against its own figure and reports a reassuring delta of 0.
//  4. A past statement vanishing. fba_invoices rows are the record of what was
//     already paid and may predate the ledger entirely.

const PARTNER = 'partner-1'
const OTHER_PARTNER = 'partner-2'

function clientRow(id: string, over: FakeRow = {}): FakeRow {
  return {
    id,
    name: `Client ${id}`,
    referral_partner_id: PARTNER,
    referral_signup_date: '2026-01-15',
    referral_first_payment_date: '2026-02-01',
    founding_bonus_seq: null,
    ...over,
  }
}

/** A partner_client_monthly row: fully priced and payable unless told otherwise. */
function monthRow(clientId: string, period: string, over: FakeRow = {}): FakeRow {
  return {
    period_month: period,
    client_id: clientId,
    client_name: `Client ${clientId}`,
    referral_partner_id: PARTNER,
    revenue: 1000,
    cost_freight: 200,
    cost_materials: 50,
    cost_storage: 25,
    cost_labour_not_deducted: 300,
    net_profit_before_processing: 725,
    revenue_unknown_charges: 0,
    cost_unknown_charges: 0,
    payable: true,
    has_estimates: false,
    ...over,
  }
}

/**
 * A partner_order_units row — ONE ORDER, and no money in it anywhere.
 *
 * The default `order_number` is deliberately the same string on every row. The
 * view groups by orders.id, not by order_number, because order_number is `not
 * null` but NOT unique — it is whatever the source system called the order, and
 * two integrations can hand us the same one. So a fixture of identical numbers
 * is the realistic shape, and anything in the loader that counted DISTINCT
 * numbers instead of rows would under-count the month here.
 */
function unitRow(clientId: string, period: string, over: FakeRow = {}): FakeRow {
  return {
    period_month: period,
    client_id: clientId,
    client_name: `Client ${clientId}`,
    referral_partner_id: PARTNER,
    order_date: `${period.slice(0, 7)}-04`,
    order_number: 'SO-1001',
    units: 12,
    units_estimated: false,
    ...over,
  }
}

/** A hand-typed fba_invoices row. */
function invoiceRow(clientId: string, period: string, over: FakeRow = {}): FakeRow {
  return {
    id: `inv-${clientId}-${period}`,
    client_id: clientId,
    period,
    amount: 900,
    units_shipped: 1200,
    orders_shipped: 40,
    cost_freight: 190,
    cost_materials: 45,
    cost_storage: 20,
    cost_processing: 30,
    ...over,
  }
}

function seed(tables: Record<string, FakeRow[]> = {}) {
  h.db = createFakeSupabase({
    clients: [],
    partner_client_monthly: [],
    partner_order_units: [],
    fba_invoices: [],
    ...tables,
  })
}

function callTo(table: string): FakeCall {
  const call = h.db.calls.find((c) => c.table === table)
  if (!call) throw new Error(`no query was issued against ${table}`)
  return call
}

beforeEach(() => seed())

describe('the synthetic ledger invoice id', () => {
  it('round-trips and is recognisable', () => {
    const id = ledgerInvoiceId('c-1', '2026-03-01')
    expect(isLedgerInvoiceId(id)).toBe(true)
    expect(id).toContain(monthKey('c-1', '2026-03-01'))
  })

  it('does not mistake a real uuid for one', () => {
    // referral_payouts.fba_invoice_id is a uuid FK. Writing a synthetic id
    // there fails on the cast — which is the desired outcome — but only if the
    // write path can TELL, so a false positive here would make the guard drop
    // a legitimate invoice reference instead.
    expect(isLedgerInvoiceId('6f1b7a52-0e4c-4b3a-9a21-7c0d2f8e5b44')).toBe(false)
    expect(isLedgerInvoiceId(null)).toBe(false)
    expect(isLedgerInvoiceId(undefined)).toBe(false)
    expect(isLedgerInvoiceId('')).toBe(false)
  })
})

describe('a failed read is never presented as an empty one', () => {
  // THE hazard on this page. Every read ends in `.data ?? []`, so a database
  // error degrades to "owed nothing" — and the statement answers that case
  // with "Nothing is missing — there is simply nothing to report yet." A
  // partner would be told in writing that they earned nothing because a view
  // was absent.
  //
  // Not hypothetical: supabase/partner_ledger.sql has never been applied, so
  // both views return 42P01 on every request in production right now.

  const fail = (tables: string[], code = '42P01') => {
    h.db.failOn = (call) =>
      tables.includes(call.table)
        ? { message: `relation "${call.table}" does not exist`, code }
        : null
  }

  it('reports a missing view rather than an empty ledger', async () => {
    seed({ clients: [clientRow('c-1')] })
    fail(['partner_client_monthly'])

    const led = await loadPartnerLedger(PARTNER)

    expect(led.readFailed).toContain('partner_client_monthly')
    // Premise guard: if the rows stopped coming back empty, this test would
    // be proving nothing — the whole danger is that it LOOKS fine.
    expect(led.months).toEqual([])
  })

  it('names every failed table, not just the first', async () => {
    // "the views are missing" and "the views are missing AND fba_invoices is
    // unreadable" are different jobs. Stopping at the first hides the second
    // until the first is fixed.
    seed({ clients: [clientRow('c-1')] })
    fail(['partner_client_monthly', 'partner_order_units', 'fba_invoices'])

    const led = await loadPartnerLedger(PARTNER)

    expect(led.readFailed).toContain('partner_client_monthly')
    expect(led.readFailed).toContain('partner_order_units')
    expect(led.readFailed).toContain('fba_invoices')
  })

  it('distinguishes a failed clients read from a partner with no clients', async () => {
    // Both produce clients = [] and take the same early return. Without
    // readFailed they are the same value, and one of them is a lie.
    seed()
    const none = await loadPartnerLedger(PARTNER)
    expect(none.clients).toEqual([])
    expect(none.readFailed).toBeNull()

    seed()
    fail(['clients'])
    const broken = await loadPartnerLedger(PARTNER)
    expect(broken.clients).toEqual([])
    expect(broken.readFailed).toContain('clients')
  })

  it('stays null when every read succeeds', async () => {
    // The control. A readFailed that is always set would pass the three
    // tests above and permanently break both screens.
    seed({ clients: [clientRow('c-1')] })

    expect((await loadPartnerLedger(PARTNER)).readFailed).toBeNull()
  })
})

describe('every read is scoped to the partner', () => {
  it('filters the clients query by partner, not the render', async () => {
    seed({ clients: [clientRow('c-1'), clientRow('c-9', { referral_partner_id: OTHER_PARTNER })] })

    const led = await loadPartnerLedger(PARTNER)

    expect(led.clients.map((c) => c.id)).toEqual(['c-1'])
    expect(callTo('clients').filters).toEqual([
      { op: 'eq', column: 'referral_partner_id', value: PARTNER },
    ])
  })

  it('filters the two views by partner and fba_invoices by client', async () => {
    // fba_invoices carries no partner column, so it is the one read that can
    // only be scoped by client id. Asserting on the STATEMENT and not just the
    // rows: on a fixture holding one partner's data, an unscoped query returns
    // exactly the same rows as a scoped one.
    seed({ clients: [clientRow('c-1'), clientRow('c-2')] })

    await loadPartnerLedger(PARTNER)

    for (const view of ['partner_client_monthly', 'partner_order_units']) {
      expect(callTo(view).filters, view).toEqual([
        { op: 'eq', column: 'referral_partner_id', value: PARTNER },
      ])
    }
    expect(callTo('fba_invoices').filters).toEqual([
      { op: 'in', column: 'client_id', value: ['c-1', 'c-2'] },
    ])
  })

  it('does not leak another partner rows that slipped past the view filter', async () => {
    // Belt and braces: the view is filtered, but if a row for another partner
    // were ever returned it must not reach the statement.
    seed({
      clients: [clientRow('c-1')],
      partner_client_monthly: [
        monthRow('c-1', '2026-03-01'),
        monthRow('c-9', '2026-03-01', { referral_partner_id: OTHER_PARTNER }),
      ],
    })

    const led = await loadPartnerLedger(PARTNER)
    expect(led.months.map((m) => m.client_id)).toEqual(['c-1'])
  })

  it('asks nothing further when the partner has no clients', async () => {
    const led = await loadPartnerLedger(PARTNER)

    expect(led.clients).toEqual([])
    expect(led.invoices).toEqual([])
    expect(led.months).toEqual([])
    expect(led.orderUnits).toEqual([])
    expect(led.orderUnitsTruncated).toBe(false)
    expect(led.provisionalKeys.size).toBe(0)

    // One query total. An `.in('client_id', [])` matches nothing but still
    // asks the question, and the early return is what avoids three of them.
    expect(h.db.calls.map((c) => c.table)).toEqual(['clients'])
  })
})

describe('the reads are ordered and capped', () => {
  it('sorts both views newest-first', async () => {
    // Deleting an .order() would otherwise leave every test green: the double
    // returns insertion order, which happens to be what the fixtures use.
    seed({ clients: [clientRow('c-1')] })
    await loadPartnerLedger(PARTNER)

    expect(callTo('partner_client_monthly').sort).toEqual([
      { column: 'period_month', ascending: false },
    ])
    expect(callTo('partner_order_units').sort).toEqual([
      { column: 'period_month', ascending: false },
      { column: 'order_date', ascending: false },
    ])
  })

  it('caps the order-units read and says when it hit the cap', async () => {
    seed({
      clients: [clientRow('c-1')],
      partner_order_units: Array.from({ length: ORDER_UNITS_LIMIT + 5 }, () =>
        unitRow('c-1', '2026-03-01'),
      ),
    })

    const led = await loadPartnerLedger(PARTNER)

    expect(callTo('partner_order_units').limit).toBe(ORDER_UNITS_LIMIT)
    expect(led.orderUnits).toHaveLength(ORDER_UNITS_LIMIT)
    expect(led.orderUnitsTruncated).toBe(true)
  })

  it('does not claim truncation one row short of the cap', async () => {
    seed({
      clients: [clientRow('c-1')],
      partner_order_units: Array.from({ length: ORDER_UNITS_LIMIT - 1 }, () =>
        unitRow('c-1', '2026-03-01'),
      ),
    })

    const led = await loadPartnerLedger(PARTNER)
    expect(led.orderUnitsTruncated).toBe(false)
  })
})

describe('the merge: which source wins which field', () => {
  const PERIOD = '2026-03-01'

  beforeEach(() => {
    seed({
      clients: [clientRow('c-1')],
      partner_client_monthly: [monthRow('c-1', PERIOD)],
      fba_invoices: [invoiceRow('c-1', PERIOD)],
      partner_order_units: [],
    })
  })

  it('takes revenue and the three ledger buckets from the ledger', async () => {
    const led = await loadPartnerLedger(PARTNER)
    expect(led.invoices).toHaveLength(1)

    expect(led.invoices[0]).toMatchObject({
      amount: 1000,        // ledger, not the hand-typed 900
      cost_freight: 200,   // ledger, not 190
      cost_materials: 50,  // ledger, not 45
      cost_storage: 25,    // ledger, not 20
    })
  })

  it('takes processing from the hand-typed row, the one bucket the ledger lacks', async () => {
    // There is no payment-processor charge type in the ledger and no Stripe
    // code in this repo. If this ever silently became 0, the deduction would
    // vanish and every partner would be overpaid on it.
    const led = await loadPartnerLedger(PARTNER)
    expect(led.invoices[0].cost_processing).toBe(30)
  })

  it('keeps the hand-typed row id so the month stays linkable', async () => {
    const led = await loadPartnerLedger(PARTNER)
    expect(led.invoices[0].id).toBe('inv-c-1-2026-03-01')
    expect(isLedgerInvoiceId(led.invoices[0].id)).toBe(false)
  })

  it('mints a synthetic id for a month the ledger alone knows', async () => {
    seed({
      clients: [clientRow('c-1')],
      partner_client_monthly: [monthRow('c-1', PERIOD)],
    })

    const led = await loadPartnerLedger(PARTNER)
    expect(isLedgerInvoiceId(led.invoices[0].id)).toBe(true)
  })

  it('never derives prep units from the ledger', async () => {
    // `pick` quantity is not a unit count, so there is no honest way to get
    // this from charges. Null must stay null: a 0 reads on the statement as
    // "your client shipped nothing" and invites a dispute.
    seed({
      clients: [clientRow('c-1')],
      partner_client_monthly: [monthRow('c-1', PERIOD)],
      partner_order_units: [unitRow('c-1', PERIOD), unitRow('c-1', PERIOD)],
    })

    const led = await loadPartnerLedger(PARTNER)
    expect(led.invoices[0].units_shipped).toBeNull()
  })

  it('still carries a month that exists only in the already-paid record', async () => {
    // These rows may predate the ledger. Dropping them makes a partner's past
    // statements disappear.
    seed({
      clients: [clientRow('c-1')],
      partner_client_monthly: [monthRow('c-1', '2026-03-01')],
      fba_invoices: [invoiceRow('c-1', '2026-01-01', { amount: 777 })],
    })

    const led = await loadPartnerLedger(PARTNER)
    const periods = led.invoices.map((i) => i.period).sort()
    expect(periods).toEqual(['2026-01-01', '2026-03-01'])
    expect(led.invoices.find((i) => i.period === '2026-01-01')?.amount).toBe(777)
  })

  it('emits one row per month, not one per source', async () => {
    const led = await loadPartnerLedger(PARTNER)
    // The same month is in both sources. Two rows would double every figure
    // the statement sums.
    expect(led.invoices).toHaveLength(1)
  })
})

describe('the order count', () => {
  const PERIOD = '2026-03-01'

  it('prefers the figure already shown to the partner', async () => {
    seed({
      clients: [clientRow('c-1')],
      partner_client_monthly: [monthRow('c-1', PERIOD)],
      fba_invoices: [invoiceRow('c-1', PERIOD, { orders_shipped: 40 })],
      partner_order_units: [unitRow('c-1', PERIOD), unitRow('c-1', PERIOD)],
    })

    const led = await loadPartnerLedger(PARTNER)
    expect(led.invoices[0].orders_shipped).toBe(40)
  })

  it('falls back to counting ledger orders when nothing was recorded', async () => {
    seed({
      clients: [clientRow('c-1')],
      partner_client_monthly: [monthRow('c-1', PERIOD)],
      partner_order_units: [unitRow('c-1', PERIOD), unitRow('c-1', PERIOD)],
    })

    const led = await loadPartnerLedger(PARTNER)
    expect(led.invoices[0].orders_shipped).toBe(2)
  })

  it('counts two orders that share an order number as two orders', async () => {
    // The replacement hazard for this source. partner_order_transactions had
    // account-level rows with no order at all, and the risk there was counting
    // them and OVER-stating the figure. partner_order_units has no such rows —
    // every row is one order, because the view groups by orders.id.
    //
    // What it does have is repeated order NUMBERS: the column is `not null` and
    // not unique, and two integrations can supply the same string. So the risk
    // reverses. A count of distinct numbers would report two real orders as one,
    // under-stating a figure the partner reads as "orders shipped" — and an
    // order count is a QUALIFICATION bar on the Founding Client offer, so
    // under-stating it can withhold a bonus that was earned.
    seed({
      clients: [clientRow('c-1')],
      partner_client_monthly: [monthRow('c-1', PERIOD)],
      partner_order_units: [
        unitRow('c-1', PERIOD, { order_number: 'SO-777' }),
        unitRow('c-1', PERIOD, { order_number: 'SO-777' }),
        unitRow('c-1', PERIOD, { order_number: 'SO-778' }),
      ],
    })

    const led = await loadPartnerLedger(PARTNER)
    expect(led.invoices[0].orders_shipped).toBe(3)
  })

  it('counts an order whose unit count is unknown', async () => {
    // `units` is null when every line on the order is unquantified, and `sum`
    // skips nulls so that reads low rather than erroring. The ORDER still
    // happened. A count that skipped it would under-state the month for a
    // reason that has nothing to do with whether the client shipped.
    seed({
      clients: [clientRow('c-1')],
      partner_client_monthly: [monthRow('c-1', PERIOD)],
      partner_order_units: [
        unitRow('c-1', PERIOD),
        unitRow('c-1', PERIOD, { units: null }),
      ],
    })

    const led = await loadPartnerLedger(PARTNER)
    expect(led.invoices[0].orders_shipped).toBe(2)
  })

  it('counts each month separately', async () => {
    seed({
      clients: [clientRow('c-1')],
      partner_client_monthly: [monthRow('c-1', '2026-03-01'), monthRow('c-1', '2026-04-01')],
      partner_order_units: [
        unitRow('c-1', '2026-03-01'),
        unitRow('c-1', '2026-04-01'),
        unitRow('c-1', '2026-04-01'),
      ],
    })

    const led = await loadPartnerLedger(PARTNER)
    const by = new Map(led.invoices.map((i) => [i.period, i.orders_shipped]))
    expect(by.get('2026-03-01')).toBe(1)
    expect(by.get('2026-04-01')).toBe(2)
  })

  it('does not attribute one client orders to another', async () => {
    seed({
      clients: [clientRow('c-1'), clientRow('c-2')],
      partner_client_monthly: [monthRow('c-1', PERIOD), monthRow('c-2', PERIOD)],
      partner_order_units: [
        unitRow('c-1', PERIOD),
        unitRow('c-2', PERIOD),
        unitRow('c-2', PERIOD),
        unitRow('c-2', PERIOD),
      ],
    })

    const led = await loadPartnerLedger(PARTNER)
    const by = new Map(led.invoices.map((i) => [i.client_id, i.orders_shipped]))
    expect(by.get('c-1')).toBe(1)
    expect(by.get('c-2')).toBe(3)
  })

  it('reports no count at all rather than a count of the surviving rows', async () => {
    // THE expensive one. Once the read is truncated, the ledger count is a
    // count of what fit under the cap — a plausible wrong number, which is
    // worse than an absent one. A recorded figure is still honoured, because
    // it does not come from the truncated read.
    const many = Array.from({ length: ORDER_UNITS_LIMIT }, () => unitRow('c-1', PERIOD))
    seed({
      clients: [clientRow('c-1'), clientRow('c-2')],
      partner_client_monthly: [monthRow('c-1', PERIOD), monthRow('c-2', PERIOD)],
      fba_invoices: [invoiceRow('c-2', PERIOD, { orders_shipped: 40 })],
      partner_order_units: [...many, unitRow('c-2', PERIOD)],
    })

    const led = await loadPartnerLedger(PARTNER)
    expect(led.orderUnitsTruncated).toBe(true)

    const by = new Map(led.invoices.map((i) => [i.client_id, i.orders_shipped]))
    expect(by.get('c-1')).toBeNull()
    expect(by.get('c-2')).toBe(40)
  })

  it('reports no count rather than a zero when a month has no ledger orders', async () => {
    seed({
      clients: [clientRow('c-1')],
      partner_client_monthly: [monthRow('c-1', PERIOD)],
      partner_order_units: [],
    })

    const led = await loadPartnerLedger(PARTNER)
    expect(led.invoices[0].orders_shipped).toBeNull()
  })
})

describe('a month that is not finished pricing', () => {
  const PERIOD = '2026-03-01'

  it('is marked provisional, by key and on the invoice', async () => {
    seed({
      clients: [clientRow('c-1')],
      partner_client_monthly: [
        monthRow('c-1', PERIOD, { payable: false, cost_unknown_charges: 2 }),
        monthRow('c-1', '2026-02-01'),
      ],
    })

    const led = await loadPartnerLedger(PARTNER)

    expect(led.provisionalKeys.has(monthKey('c-1', PERIOD))).toBe(true)
    expect(led.provisionalKeys.has(monthKey('c-1', '2026-02-01'))).toBe(false)

    const by = new Map(led.invoices.map((i) => [i.period, i.provisional]))
    expect(by.get(PERIOD)).toBe(true)
    expect(by.get('2026-02-01')).toBe(false)
  })

  it('carries a null revenue as 0 and flags the month', async () => {
    // Revenue is null only when EVERY amount in the month is unknown. The 0 is
    // only safe because the month is provisional — a 0 on a PAYABLE month
    // would be a figure someone gets paid on.
    seed({
      clients: [clientRow('c-1')],
      partner_client_monthly: [monthRow('c-1', PERIOD, { revenue: null, payable: false })],
    })

    const led = await loadPartnerLedger(PARTNER)
    expect(led.invoices[0].amount).toBe(0)
    expect(led.invoices[0].provisional).toBe(true)
  })
})

describe('reconciliation against the hand-typed record', () => {
  const PERIOD = '2026-03-01'

  /** Only `manualInvoices` is read, so a hand-built ledger keeps these honest. */
  const manual = (rows: FakeRow[]) => ({ manualInvoices: rows as never })

  it('reports the delta, with float dust rounded out', () => {
    // 1000.10 - 900.20 is 99.89999999999998 in binary floating point. Without
    // the rounding the reconciliation column reads "99.89999999999998" and the
    // screen looks broken on a month where the two sources agree to the cent.
    const month = monthRow('c-1', PERIOD, { revenue: 1000.1 }) as never

    expect(reconcile(month, manual([invoiceRow('c-1', PERIOD, { amount: 900.2 })]))).toEqual({
      manualAmount: 900.2,
      ledgerAmount: 1000.1,
      delta: 99.9,
    })
  })

  it('signs the delta so it is clear which source is higher', () => {
    // Ledger minus manual. A ledger figure BELOW the hand-typed one means we
    // may have already overpaid, which is the direction worth noticing.
    const month = monthRow('c-1', PERIOD, { revenue: 800 }) as never
    expect(reconcile(month, manual([invoiceRow('c-1', PERIOD, { amount: 900 })]))?.delta).toBe(-100)
  })

  it('is silent when only one source has the month — that is coverage, not disagreement', () => {
    const month = monthRow('c-1', PERIOD) as never
    expect(reconcile(month, manual([]))).toBeNull()
    expect(reconcile(month, manual([invoiceRow('c-1', '2026-02-01')]))).toBeNull()
    expect(reconcile(month, manual([invoiceRow('c-2', PERIOD)]))).toBeNull()
  })

  it('is silent when the ledger does not know the revenue', () => {
    const month = monthRow('c-1', PERIOD, { revenue: null }) as never
    expect(reconcile(month, manual([invoiceRow('c-1', PERIOD)]))).toBeNull()
  })

  it('says nothing about a month the ledger alone knows', async () => {
    // A month with no hand-typed record has nothing to reconcile against.
    seed({
      clients: [clientRow('c-1')],
      partner_client_monthly: [monthRow('c-1', PERIOD)],
    })

    const led = await loadPartnerLedger(PARTNER)
    expect(isLedgerInvoiceId(led.invoices[0].id)).toBe(true)
    expect(reconcile(led.months[0], led)).toBeNull()
  })

  it('reads the HAND-TYPED amount off a merged month, not the ledger amount', async () => {
    // THE regression test. The merged row for this month keeps the hand-typed
    // id and carries the ledger's amount, so anything that reconciles against
    // `ledger.invoices` compares 1000 to 1000 and answers 0 — which is what
    // /pnl did until 2026-10-12. The delta here must be the real 100.
    seed({
      clients: [clientRow('c-1')],
      partner_client_monthly: [monthRow('c-1', PERIOD), monthRow('c-1', '2026-02-01')],
      fba_invoices: [invoiceRow('c-1', PERIOD, { amount: 900 })],
    })

    const led = await loadPartnerLedger(PARTNER)
    const march = led.months.find((m) => m.period_month === PERIOD)!

    // The trap, stated: the merged row is indistinguishable by id.
    const merged = led.invoices.find((i) => i.period === PERIOD)!
    expect(isLedgerInvoiceId(merged.id)).toBe(false)
    expect(merged.amount).toBe(1000)

    expect(reconcile(march, led)).toEqual({
      manualAmount: 900,
      ledgerAmount: 1000,
      delta: 100,
    })
  })

  it('keeps the unmerged rows for every month, not just uncovered ones', async () => {
    seed({
      clients: [clientRow('c-1')],
      partner_client_monthly: [monthRow('c-1', PERIOD)],
      fba_invoices: [
        invoiceRow('c-1', PERIOD, { amount: 900 }),
        invoiceRow('c-1', '2026-01-01', { amount: 500 }),
      ],
    })

    const led = await loadPartnerLedger(PARTNER)
    expect(led.manualInvoices.map((i) => i.amount).sort((a, b) => a - b)).toEqual([500, 900])
  })

  it('reports a zero delta rather than nothing when the two sources agree', () => {
    // Agreement is a RESULT, and it has to be distinguishable from "no
    // comparison was possible" — both would otherwise render as a blank cell.
    const month = monthRow('c-1', PERIOD, { revenue: 900 }) as never
    expect(reconcile(month, manual([invoiceRow('c-1', PERIOD, { amount: 900 })]))).toEqual({
      manualAmount: 900,
      ledgerAmount: 900,
      delta: 0,
    })
  })

  it('treats an unusable hand-typed amount as 0 rather than producing NaN', () => {
    // A NaN delta renders as "NaN" on /pnl and makes the whole reconciliation
    // column untrustworthy. 0 is wrong too, but it is visibly wrong.
    const month = monthRow('c-1', PERIOD, { revenue: 1000 }) as never
    const res = reconcile(month, manual([invoiceRow('c-1', PERIOD, { amount: null })]))
    expect(res).toEqual({ manualAmount: 0, ledgerAmount: 1000, delta: 1000 })
  })
})

describe('the loader survives a failed read', () => {
  it('returns an empty statement rather than throwing when the views are missing', async () => {
    // partner_ledger.sql has not been applied in production yet, so BOTH views
    // 404. A throw here is a 500 on the partner's own statement page; empty is
    // wrong but legible, and the screen can say so.
    seed({ clients: [clientRow('c-1')] })
    h.db.failOn = (c) =>
      c.table.startsWith('partner_') ? { message: 'relation does not exist', code: '42P01' } : null

    const led = await loadPartnerLedger(PARTNER)

    expect(led.clients.map((c) => c.id)).toEqual(['c-1'])
    expect(led.months).toEqual([])
    expect(led.orderUnits).toEqual([])
    expect(led.orderUnitsTruncated).toBe(false)
  })

  it('still shows the already-paid record when only the ledger views fail', async () => {
    seed({
      clients: [clientRow('c-1')],
      fba_invoices: [invoiceRow('c-1', '2026-03-01', { amount: 900 })],
    })
    h.db.failOn = (c) =>
      c.table.startsWith('partner_') ? { message: 'relation does not exist', code: '42P01' } : null

    const led = await loadPartnerLedger(PARTNER)
    expect(led.invoices).toHaveLength(1)
    expect(led.invoices[0].amount).toBe(900)
  })
})

// ---------------------------------------------------------------------------
// The view/interface contract.
//
// WHY THIS EXISTS: every test above runs against createFakeSupabase, which
// serves whatever rows the fixture hands it. That is the right way to test the
// merge, and it is structurally incapable of noticing that the REAL view does
// not have the columns LedgerMonth claims. A fixture that hand-feeds a field
// the live data does not carry tests your model of the data, not the data.
//
// The failure it guards is quiet in the worst way. Both reads are `select('*')`,
// so a renamed or dropped column raises nothing — the field arrives `undefined`,
// arithmetic on it yields NaN, and a partner statement renders a blank or a
// dash where a dollar figure belongs. Nothing throws, nothing logs, and the
// number is wrong in a direction nobody can predict.
//
// On 2026-10-12 the views were rebuilt in production from this very file after
// two failed attempts, which is exactly the moment a column name gets quietly
// edited. So: parse the column list out of the SQL, parse the field list out of
// the interface, and assert they are the same set.
// ---------------------------------------------------------------------------
describe('the ledger views match the interfaces that read them', () => {
  const read = (...parts: string[]) => readFileSync(join(process.cwd(), ...parts), 'utf8')

  /** Output column names of `create view public.<name>`, from its final select. */
  function viewColumns(sqlFile: string, view: string): string[] {
    const sql = read('supabase', sqlFile)
    const m = sql.match(
      new RegExp(`create view public\\.${view}\\s+as([\\s\\S]*?)(?=\\ndrop view|\\nrevoke|\\ncreate view)`),
    )
    expect(m, `cannot find "create view public.${view}" in supabase/${sqlFile}`).not.toBeNull()
    const selects = [...m![1].matchAll(/select\s+([\s\S]*?)\n\s*from\s/g)]
    expect(selects.length, `${view}: no select found in the view body`).toBeGreaterThan(0)

    return selects[selects.length - 1][1]
      .split(/,(?![^()]*\))/)
      .map((p) => p.trim())
      .map((p) => {
        const alias = p.match(/\bas\s+([a-z_][a-z0-9_]*)\s*$/i)
        return alias ? alias[1] : p.split('.').pop()!.trim()
      })
      .filter((c) => /^[a-z_][a-z0-9_]*$/.test(c))
  }

  /** Field names declared on `export interface <name>`. */
  function interfaceFields(tsFile: string, name: string): string[] {
    const ts = read('src', 'lib', tsFile)
    const m = ts.match(new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`))
    expect(m, `cannot find "export interface ${name}" in src/lib/${tsFile}`).not.toBeNull()
    const body = m![1]
      .replace(/\/\*\*[\s\S]*?\*\//g, '') // doc comments, which contain prose
      .replace(/\/\/.*$/gm, '')
    return [...body.matchAll(/^\s{2}([a-z_][a-z0-9_]*)\??\s*:/gim)].map((x) => x[1])
  }

  // Each pair carries its own two files. The second pair spans two modules
  // because the view and the interface that reads it were added together in a
  // later change and live beside the rest of that change — but the contract is
  // the same contract, and the whole value of this block is that it is the one
  // check neither file can satisfy alone.
  for (const [sqlFile, view, tsFile, iface] of [
    ['partner_ledger.sql', 'partner_client_monthly', 'partner-ledger.ts', 'LedgerMonth'],
    ['partner_order_units.sql', 'partner_order_units', 'partner-activity.ts', 'OrderUnitsRow'],
  ] as const) {
    it(`${view} and ${iface} declare the same columns`, () => {
      const cols = viewColumns(sqlFile, view)
      const fields = interfaceFields(tsFile, iface)

      // Guard on the guard. Either parser returning nothing makes the set
      // comparison below vacuously true, which is the one way this check can
      // be green while measuring nothing.
      expect(cols.length, `parsed no columns out of ${view} — the SQL parser is broken`).toBeGreaterThan(5)
      expect(fields.length, `parsed no fields out of ${iface} — the TS parser is broken`).toBeGreaterThan(5)

      const missing = fields.filter((f) => !cols.includes(f))
      const extra = cols.filter((c) => !fields.includes(c))
      expect(
        missing,
        `${iface} reads columns ${view} does not produce. select('*') will deliver these as ` +
          'undefined and the arithmetic downstream becomes NaN — silently.',
      ).toEqual([])
      expect(
        extra,
        `${view} produces columns ${iface} does not declare. Harmless today, but it means the ` +
          'view moved and the interface did not — check whether a figure changed meaning.',
      ).toEqual([])
    })
  }
})
