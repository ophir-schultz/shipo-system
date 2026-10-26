'use client'

import { useState } from 'react'
import { downloadBillingExcel, downloadBillingPDF } from '@/lib/billing/download'
import {
  combinePriced, formatPrice, formatSignedPrice, isPriced, sumPriced,
  totalOrUnknown, unpricedNote, UNPRICED_DASH, type Money,
} from '@/lib/billing/unpriced'
import { exclusionNote, reconcile, reconciledOrUnknown } from '@/lib/billing/profit-rollup'
import { filterByDate, undatedNote } from '@/lib/billing/date-range'

// `client_rate` and `warehouse_daily_log.total` are nullable: recalculate.ts
// and the daily-log route write null when they cannot read a rate, instead of
// the billable 0 they used to write. On this page that matters more than
// anywhere else -- it is where the invoice is read off -- because `?? 0` left
// the unpriced lines out of "Total to Bill" while the counts beside it still
// included them.
//
// The `rate_adjustments` and `bills` columns below were missed by that sweep
// and are fixed here on a second ground that applies whatever the columns
// contain: `?? 0` only defends against null and undefined, and `numeric(10,2)`
// does not necessarily arrive as a number. `(x ?? 0).toFixed(2)` on the string
// '12.34' throws, and `s + (x ?? 0)` on it yields the string '012.34' and
// corrupts every later addition in the same reduce. `priceOf` coerces instead
// of guessing which of the two it is.
//
// This file cannot be unit-tested here (vitest.config.ts excludes `.test.tsx`),
// so the rules live in lib/billing/unpriced.ts, which is tested and
// mutation-checked, and this file only calls them.

// The payload, declared rather than inferred. `data: any` was not merely
// untidy here: it is the hole that read.ts's LoadedData exists to patch. A
// `Loaded<T>` only gates a page if the component it feeds rejects `undefined`,
// and `any` accepts it, so /billing's refusal-to-render check could be deleted
// and tsc stayed silent. See the LoadedData docstring in src/lib/db/read.ts.
//
// Written as `type` and not `interface` on purpose: an interface has no
// implicit index signature, so `BillingShipment[]` would not be assignable to
// sumPriced's `ReadonlyArray<Record<string, unknown>>` and every call below
// would stop compiling. Type aliases of object literals do get one.
//
// These describe what the two `.select()` strings in src/app/billing/page.tsx
// ask for, which is not the same claim as what supabase/schema.sql defines --
// see the note on `manual_charges_total` below.
type ClientOption = { id: string; name: string | null }

type BillingShipment = {
  // The row's React key, and that is the whole reason it is selected.
  // `order_number` is NOT unique -- supabase/ledger_03_charges.sql:8 states it
  // outright: multi-package orders, reships and return labels share one. Keying
  // by it made React reconcile two distinct shipments as one row.
  //
  // Optional, because `id` being absent is a `.select()` that was not updated
  // rather than a row with no primary key, and the fallback below keeps the
  // table rendering instead of crashing on a key of `undefined`.
  id?: string | null
  client_id: string | null
  order_number: string
  ship_date: string | null
  carrier: string | null
  service: string | null
  actual_cost: Money
  client_rate: Money
  profit_loss: Money
  is_loss: boolean | null
}

type BillingWarehouseLine = {
  client_id: string | null
  log_date: string
  service_type: string | null
  // Not Money -- it is a count, it is rendered raw rather than summed, and
  // `numeric(10,2)` still means the wire shape is not guaranteed, hence the
  // union rather than `number`.
  quantity: number | string | null
  rate: Money
  total: Money
  notes: string | null
}

type BillingAdjustment = {
  client_id: string | null
  order_number: string
  adjustment_amount: Money
  reason: string | null
  adjustment_date: string | null
  status: string | null
}

type BillingBill = {
  client_id: string | null
  week_start: string
  week_end: string
  shipping_total: Money
  warehouse_total: Money
  adjustments_total: Money
  // Was `manual_total`, which no migration creates and no code writes.
  //
  // Settled WITHOUT the database, because the answer is the same under both
  // possibilities. The only writer to `bills` is calculator.ts:298 and it writes
  // `manual_charges_total`:
  //
  //   If the live column is only `manual_charges_total` -- what schema.sql:111
  //   declares -- the old select was a PostgREST 42703. read() turns that into
  //   an error and billing/page.tsx refuses the WHOLE screen, by design. The
  //   bills read had then never once succeeded, and "Billing is not working" is
  //   precisely what that looks like from the outside.
  //
  //   If a `manual_total` column also exists, nothing has ever written to it, so
  //   this cell showed blank under a heading claiming it was the manual charges
  //   on the bill -- understated, beside a grand total that includes them.
  //
  // So this does not wait on supabase/verify/phantom_columns_verify.sql. Run
  // that anyway, to find out whether a stray `manual_total` is sitting in the
  // table holding nothing, and drop it if it is.
  manual_charges_total: Money
  grand_total: Money
  status: string | null
}

export type BillingData = {
  clients: ClientOption[]
  shipments: BillingShipment[]
  warehouse: BillingWarehouseLine[]
  adjustments: BillingAdjustment[]
  bills: BillingBill[]
  defaultFrom: string
  defaultTo: string
}

type BillingTab = 'shipments' | 'warehouse' | 'adjustments' | 'bills'

/**
 * Two notes on one line, in the order the reader needs them.
 *
 * The figures below can be short for two unrelated reasons -- a line with no
 * price, and a line with no date -- and a card showing one of them while hiding
 * the other would be a new instance of the defect it was built to report.
 * `·` matches the separator used in the empty states elsewhere in this app.
 */
function notes(...parts: string[]): string {
  return parts.filter(p => p !== '').join(' · ')
}

export default function BillingView({ data }: { data: BillingData }) {
  const [selectedClient, setSelectedClient] = useState<string>(data.clients[0]?.id ?? '')
  const [dateFrom, setDateFrom] = useState(data.defaultFrom)
  const [dateTo, setDateTo] = useState(data.defaultTo)
  const [activeTab, setActiveTab] = useState<BillingTab>('shipments')

  const client = data.clients.find(c => c.id === selectedClient)

  // Client first, then period, through the one predicate both screens now
  // share -- see src/lib/billing/date-range.ts. This screen's row selection is
  // UNCHANGED by that move: it already dropped undated rows when a bound was
  // set, which is what Postgres and the Excel export do. What is new is that
  // the drop is now counted, so a shipment missing from the invoice because
  // nobody recorded its ship date says so instead of just not being there.
  const shipmentsFiltered = filterByDate(
    data.shipments.filter(s => s.client_id === selectedClient), 'ship_date', dateFrom, dateTo)
  const shipments = shipmentsFiltered.rows

  // log_date is `date not null` (schema.sql:80), so the undated branch is
  // unreachable here and this is a pure refactor. Routed through the same
  // predicate anyway: if the column is ever made nullable, the count is
  // already wired rather than needing to be remembered.
  const warehouseFiltered = filterByDate(
    data.warehouse.filter(w => w.client_id === selectedClient), 'log_date', dateFrom, dateTo)
  const warehouse = warehouseFiltered.rows

  const adjustmentsFiltered = filterByDate(
    data.adjustments.filter(a => a.client_id === selectedClient), 'adjustment_date', dateFrom, dateTo)
  const adjustments = adjustmentsFiltered.rows

  // Bills keep their own predicate, deliberately. This is not a single column
  // in a range: it is containment of a [week_start, week_end] interval inside
  // the window, which filterByDate cannot express and should not try to.
  // Both columns are `date not null` (schema.sql:106,107), so there is no
  // undated case here to disagree about.
  const bills = data.bills.filter(b => {
    if (b.client_id !== selectedClient) return false
    return (!dateFrom || b.week_start >= dateFrom) && (!dateTo || b.week_end <= dateTo)
  })

  // This is the screen the invoice is read off, so an omission here is money
  // not billed rather than a figure looking slightly low. `?? 0` dropped every
  // unpriced shipment out of shippingRevenue and so out of grandTotal, while
  // the shipment count beside it still included them -- the invoice totalled
  // less than the lines it claimed to cover, with nothing saying so.
  const shippingRevenueSum = sumPriced(shipments, 'client_rate')
  const shippingCostSum = sumPriced(shipments, 'actual_cost')
  const warehouseSum = sumPriced(warehouse, 'total')
  const shippingRevenue = shippingRevenueSum.total
  const shippingCost = shippingCostSum.total
  const warehouseTotal = warehouseSum.total
  const pendingAdjRows = adjustments.filter(a => a.status === 'pending')
  const pendingAdjSum = sumPriced(pendingAdjRows, 'adjustment_amount')
  const pendingAdj = pendingAdjSum.total
  const billedSum = sumPriced(bills, 'grand_total')
  // combinePriced rather than `+`: adding the two totals is exactly where the
  // withheld counts would be dropped, and this is the number that gets billed.
  const billable = combinePriced(shippingRevenueSum, warehouseSum)
  // The adjustments join the total here rather than at `billable`, which stays
  // the rate-card figure the amber banner below speaks for. An adjustment with
  // no amount shortens "Total to Bill" just as surely as an unpriced shipment
  // does, so the count has to reach the figure it affects -- but the banner's
  // copy is about rate cards, and widening it would make it say something about
  // adjustments that is not true.
  const billTotal = combinePriced(billable, pendingAdjSum)
  const grandTotal = billTotal.total
  const unbillableNote = unpricedNote(billTotal.unpriced, 'line')
  const lossCount = shipments.filter(s => s.is_loss).length

  // A SECOND, NARROWER set of figures, for the margin and only the margin.
  //
  // `shippingRevenue` above is the WIDE one and has to stay wide: a shipment
  // with an agreed rate is owed whether or not the carrier has invoiced us yet,
  // and it feeds `billable`, `grandTotal` and the download. But the Net Profit
  // stat used to be `shippingRevenue - shippingCost`, and those two sums skip
  // DIFFERENT rows -- a shipment with a rate and no carrier cost was in the
  // first and not the second, so it added its full rate to "profit" as though
  // it had cost nothing. The subtraction was real; the two operands were not
  // measured over the same shipments.
  //
  // So the three stats below come off one `reconcile` instead, which keeps only
  // the rows where both sides are known. That is the same call the dashboard,
  // /losses, /shipments and the reports tab make, which is what makes all five
  // agree. The two figures are different on purpose and are labelled
  // differently: "Total to Bill" is what to invoice, this is what we kept.
  const margin = reconcile(shipments)
  const known = reconciledOrUnknown(margin)
  const marginNote = exclusionNote(margin)
  const fig = (n: number | null) => (n === null ? UNPRICED_DASH : `$${n.toFixed(2)}`)
  // `known.profit >= 0` would be TRUE for null -- `null >= 0` is true in
  // JavaScript -- and would paint an unmeasurable margin green.
  const profitPositive = known.profit !== null && known.profit >= 0

  const [dlLoading, setDlLoading] = useState<'excel' | 'pdf' | null>(null)

  const dlArgs = {
    clientName: client?.name ?? 'client',
    dateFrom, dateTo,
    shipments, warehouse, adjustments, bills,
    shippingRevenue, shippingCost, warehouseTotal, pendingAdj, grandTotal,
    // Passed down so the spreadsheet and the PDF say the same thing this screen
    // says. A downloaded invoice outlives the page it came from, so it has to
    // carry the omission itself rather than rely on the reader having seen the
    // banner above.
    unpricedShipments: shippingRevenueSum.unpriced,
    unpricedWarehouse: warehouseSum.unpriced,
    unpricedLines: billable.unpriced,
  }

  async function handleExcel() {
    setDlLoading('excel')
    downloadBillingExcel(dlArgs)
    setDlLoading(null)
  }

  async function handlePDF() {
    setDlLoading('pdf')
    await downloadBillingPDF(dlArgs)
    setDlLoading(null)
  }

  // Annotated so `tab.id` is the union rather than `string`. It used to be
  // `setActiveTab(tab.id as any)`, which would have accepted a typo'd id and
  // left the panel permanently blank.
  const tabs: Array<{ id: BillingTab; label: string; count: number }> = [
    { id: 'shipments', label: 'Shipments', count: shipments.length },
    { id: 'warehouse', label: 'Warehouse', count: warehouse.length },
    { id: 'adjustments', label: 'Adjustments', count: adjustments.length },
    { id: 'bills', label: 'Bills', count: bills.length },
  ]

  return (
    <div className="space-y-4">
      {/* Top filters */}
      <div className="bg-white rounded-xl px-5 py-4 flex flex-wrap items-end gap-4">
        <div>
          <label className="block text-xs text-[#4B4F58] mb-1">Client</label>
          <select value={selectedClient} onChange={e => setSelectedClient(e.target.value)}
            className="bg-[#EEF3FA] border border-[#CBD5E1] rounded-lg px-3 py-2 text-[#0B1220] text-sm focus:outline-none focus:border-[#1A73E8] min-w-48">
            {data.clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs text-[#4B4F58] mb-1">From</label>
          <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
            className="bg-[#EEF3FA] border border-[#CBD5E1] rounded-lg px-3 py-2 text-[#0B1220] text-sm focus:outline-none focus:border-[#1A73E8]" />
        </div>
        <div>
          <label className="block text-xs text-[#4B4F58] mb-1">To</label>
          <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
            className="bg-[#EEF3FA] border border-[#CBD5E1] rounded-lg px-3 py-2 text-[#0B1220] text-sm focus:outline-none focus:border-[#1A73E8]" />
        </div>
        <div className="ml-auto flex gap-2">
          <button onClick={handleExcel} disabled={dlLoading !== null}
            className="flex items-center gap-2 bg-[#EEF3FA] hover:bg-[#DDE6F2] disabled:opacity-50 text-[#0B1220] px-4 py-2 rounded-lg text-sm font-medium transition">
            {dlLoading === 'excel' ? '⏳' : '↓'} Excel
          </button>
          <button onClick={handlePDF} disabled={dlLoading !== null}
            className="flex items-center gap-2 disabled:opacity-50 text-[#0B1220] px-4 py-2 rounded-lg text-sm font-medium transition"
            style={{ background: '#1A73E8' }}>
            {dlLoading === 'pdf' ? '⏳ Generating…' : '↓ PDF Invoice'}
          </button>
        </div>
      </div>

      {/* An invoice that silently omits lines is the one thing on this page
          that must not happen quietly, so the warning sits above the figures
          rather than beside one of them. It renders only when there is
          something to say. */}
      {client && billable.unpriced > 0 && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-5 py-4">
          <p className="font-semibold text-amber-300">
            ⚠ Not ready to bill — {billable.unpriced} of {billable.counted} line
            {billable.counted === 1 ? '' : 's'} has no price
          </p>
          <p className="mt-1 text-sm text-amber-200/80">
            No rate card covers {billable.unpriced === 1 ? 'it' : 'them'}, so{' '}
            {billable.unpriced === 1 ? 'it is' : 'they are'} missing from
            &ldquo;Total to Bill&rdquo; below. Price {billable.unpriced === 1 ? 'it' : 'them'} and
            re-run the recalculate before sending this invoice, or the client is
            under-billed by an unknown amount.
          </p>
        </div>
      )}

      {/* Client summary cards */}
      {client && (
        <div className="grid grid-cols-5 gap-3">
          {/* Each `sub` carries BOTH reasons the figure above it can be short:
              lines with no price, and lines left out for having no date. The
              `||` fallback is only reached when there is nothing to report. */}
          <SummaryCard label="Shipping Revenue" value={`$${shippingRevenue.toFixed(2)}`} sub={notes(unpricedNote(shippingRevenueSum.unpriced), undatedNote(shipmentsFiltered.undated)) || `Cost: $${shippingCost.toFixed(2)}`} color={shippingRevenueSum.unpriced > 0 || shipmentsFiltered.undated > 0 ? 'orange' : 'blue'} />
          <SummaryCard label="Warehouse Charges" value={`$${warehouseTotal.toFixed(2)}`} sub={notes(unpricedNote(warehouseSum.unpriced, 'day'), undatedNote(warehouseFiltered.undated, 'day')) || `${warehouse.length} entries`} color={warehouseSum.unpriced > 0 || warehouseFiltered.undated > 0 ? 'orange' : 'gray'} />
          <SummaryCard label="Pending Adjustments" value={formatSignedPrice(totalOrUnknown(pendingAdjSum))} sub={notes(unpricedNote(pendingAdjSum.unpriced, 'adjustment'), undatedNote(adjustmentsFiltered.undated, 'adjustment')) || `${pendingAdjRows.length} pending`} color="orange" />
          <SummaryCard label="Total to Bill" value={formatPrice(totalOrUnknown(billTotal))} sub={notes(unbillableNote, undatedNote(shipmentsFiltered.undated + adjustmentsFiltered.undated, 'line')) || 'Shipping + WH + Adj'} color={billTotal.unpriced > 0 || shipmentsFiltered.undated + adjustmentsFiltered.undated > 0 ? 'orange' : 'green'} />
          <SummaryCard label="Loss Shipments" value={lossCount.toString()} sub={lossCount > 0 ? '⚠️ Needs review' : '✓ All profitable'} color={lossCount > 0 ? 'red' : 'gray'} />
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 bg-[#F1F5FB] rounded-xl p-1">
        {tabs.map(tab => (
          <button key={tab.id} onClick={() => setActiveTab(tab.id)}
            className={`flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium transition ${
              activeTab === tab.id ? 'text-[#0B1220]' : 'text-[#4B4F58] hover:text-[#0B1220]'
            }`}
            style={activeTab === tab.id ? { background: '#1A73E8' } : {}}>
            {tab.label}
            <span className={`text-xs px-1.5 py-0.5 rounded-full ${activeTab === tab.id ? 'bg-white/20' : 'bg-[#EEF3FA]'}`}>{tab.count}</span>
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="bg-white rounded-xl overflow-hidden">
        {activeTab === 'shipments' && (
          <>
            {/* All three money stats come off one reconciliation, so Charged
                minus We Paid is exactly Net Profit. "Charged" here is therefore
                NARROWER than "Total to Bill" above -- it holds back shipments
                whose carrier cost has not landed, because those have no
                knowable margin. Two questions, two figures, two labels; the
                note underneath says which rows are held back and why. */}
            <div className="grid grid-cols-4 divide-x divide-[#E2E8F0] border-b border-[#E2E8F0]">
              <Stat label="Shipments" value={shipments.length} />
              <Stat label="We Paid (Carrier)" value={fig(known.cost)} />
              <Stat label="Charged Client" value={fig(known.revenue)} />
              <Stat label="Net Profit"
                value={known.profit === null
                  ? UNPRICED_DASH
                  : `${profitPositive ? '+' : ''}$${known.profit.toFixed(2)}`}
                color={known.profit === null ? 'gray' : profitPositive ? 'green' : 'red'} />
            </div>
            {marginNote && (
              <p className="px-5 py-2 text-xs text-amber-400 border-b border-[#E2E8F0]">⚠ {marginNote}</p>
            )}
            <div className="overflow-auto max-h-96">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-[#F1F5FB]">
                  <tr className="text-[#4B4F58] text-xs uppercase border-b border-[#E2E8F0] text-left">
                    <th className="px-5 py-3">Order #</th>
                    <th className="px-4 py-3">Ship Date</th>
                    <th className="px-4 py-3">Carrier / Service</th>
                    <th className="px-4 py-3 text-right">We Paid</th>
                    <th className="px-4 py-3 text-right">Charged</th>
                    <th className="px-4 py-3 text-right">P / L</th>
                  </tr>
                </thead>
                <tbody>
                  {shipments.length === 0
                    ? <tr><td colSpan={6} className="px-5 py-10 text-center text-[#6B7A8D]">No shipments in this period</td></tr>
                    : shipments.map(s => (
                      <tr key={s.id ?? s.order_number} className={`border-b border-[#E2E8F0]/40 hover:bg-[#EEF3FA]/30 ${s.is_loss ? 'bg-red-950/10' : ''}`}>
                        <td className="px-5 py-2.5 font-mono text-xs text-[#3A4658]">{s.order_number}</td>
                        <td className="px-4 py-2.5 text-[#4B4F58] text-xs">{s.ship_date ? new Date(s.ship_date).toLocaleDateString() : '—'}</td>
                        <td className="px-4 py-2.5 text-[#3A4658] text-xs">{[s.carrier, s.service].filter(Boolean).join(' · ') || '—'}</td>
                        <td className="px-4 py-2.5 text-right">{formatPrice(s.actual_cost)}</td>
                        <td className={`px-4 py-2.5 text-right ${isPriced(s.client_rate) ? '' : 'text-amber-400 font-semibold'}`}
                            title={isPriced(s.client_rate) ? undefined : 'No rate-card rate covers this shipment — it is NOT in the total to bill'}>
                          {formatPrice(s.client_rate)}
                        </td>
                        <td className={`px-4 py-2.5 text-right font-semibold ${
                          !isPriced(s.profit_loss) ? 'text-[#6B7A8D]'
                            : s.is_loss ? 'text-red-400' : 'text-green-400'
                        }`}>
                          {formatSignedPrice(s.profit_loss)}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {activeTab === 'warehouse' && (
          <>
            <div className="grid grid-cols-3 divide-x divide-[#E2E8F0] border-b border-[#E2E8F0]">
              <Stat label="Entries" value={warehouse.length} />
              <Stat label="Total Charges" value={`$${warehouseTotal.toFixed(2)}`} />
              <Stat label="Unique Days" value={new Set(warehouse.map(w => w.log_date)).size} />
            </div>
            <div className="overflow-auto max-h-96">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-[#F1F5FB]">
                  <tr className="text-[#4B4F58] text-xs uppercase border-b border-[#E2E8F0] text-left">
                    <th className="px-5 py-3">Date</th>
                    <th className="px-4 py-3">Service</th>
                    <th className="px-4 py-3 text-right">Qty</th>
                    <th className="px-4 py-3 text-right">Rate</th>
                    <th className="px-4 py-3 text-right">Total</th>
                    <th className="px-4 py-3">Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {warehouse.length === 0
                    ? <tr><td colSpan={6} className="px-5 py-10 text-center text-[#6B7A8D]">No warehouse activity in this period</td></tr>
                    : warehouse.map((w, i) => (
                      <tr key={i} className="border-b border-[#E2E8F0]/40 hover:bg-[#EEF3FA]/30">
                        <td className="px-5 py-2.5 text-[#4B4F58] text-xs">{w.log_date ? new Date(w.log_date + 'T12:00:00').toLocaleDateString() : '—'}</td>
                        <td className="px-4 py-2.5 text-[#3A4658] capitalize">{w.service_type?.replace(/_/g, ' ') ?? '—'}</td>
                        <td className="px-4 py-2.5 text-right">{w.quantity}</td>
                        <td className="px-4 py-2.5 text-right text-[#4B4F58]">{formatPrice(w.rate)}</td>
                        <td className={`px-4 py-2.5 text-right font-semibold ${isPriced(w.total) ? 'text-green-400' : 'text-amber-400'}`}
                            title={isPriced(w.total) ? undefined : 'The daily log could not read a rate for this day — it is NOT in the total to bill'}>
                          {formatPrice(w.total)}
                        </td>
                        <td className="px-4 py-2.5 text-[#6B7A8D] text-xs">{w.notes ?? '—'}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {activeTab === 'adjustments' && (
          <>
            <div className="grid grid-cols-3 divide-x divide-[#E2E8F0] border-b border-[#E2E8F0]">
              <Stat label="Total Adjustments" value={adjustments.length} />
              <Stat label="Pending" value={formatSignedPrice(totalOrUnknown(pendingAdjSum))} note={unpricedNote(pendingAdjSum.unpriced, 'adjustment')} color="orange" />
              <Stat label="Resolved" value={adjustments.filter(a => a.status !== 'pending').length} />
            </div>
            <div className="overflow-auto max-h-96">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-[#F1F5FB]">
                  <tr className="text-[#4B4F58] text-xs uppercase border-b border-[#E2E8F0] text-left">
                    <th className="px-5 py-3">Order #</th>
                    <th className="px-4 py-3">Reason</th>
                    <th className="px-4 py-3">Date</th>
                    <th className="px-4 py-3 text-right">Amount</th>
                    <th className="px-4 py-3 text-center">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {adjustments.length === 0
                    ? <tr><td colSpan={5} className="px-5 py-10 text-center text-[#6B7A8D]">No adjustments in this period</td></tr>
                    : adjustments.map((a, i) => (
                      <tr key={i} className="border-b border-[#E2E8F0]/40 hover:bg-[#EEF3FA]/30">
                        <td className="px-5 py-2.5 font-mono text-xs text-[#3A4658]">{a.order_number}</td>
                        <td className="px-4 py-2.5 text-[#3A4658] text-xs">{a.reason ?? 'Carrier reweigh'}</td>
                        <td className="px-4 py-2.5 text-[#4B4F58] text-xs">{a.adjustment_date ? new Date(a.adjustment_date).toLocaleDateString() : '—'}</td>
                        <td className="px-4 py-2.5 text-right font-semibold text-orange-400">{formatSignedPrice(a.adjustment_amount)}</td>
                        <td className="px-4 py-2.5 text-center">
                          <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                            a.status === 'pending' ? 'bg-orange-900/60 text-orange-300' :
                            a.status === 'charged' ? 'bg-green-900/60 text-green-300' :
                            'bg-[#EEF3FA] text-[#4B4F58]'
                          }`}>{a.status}</span>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {activeTab === 'bills' && (
          <>
            <div className="grid grid-cols-3 divide-x divide-[#E2E8F0] border-b border-[#E2E8F0]">
              <Stat label="Bills Generated" value={bills.length} />
              <Stat label="Total Billed" value={formatPrice(totalOrUnknown(billedSum))} note={unpricedNote(billedSum.unpriced, 'bill')} />
              <Stat label="Paid" value={bills.filter(b => b.status === 'paid').length} color="green" />
            </div>
            <div className="overflow-auto max-h-96">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-[#F1F5FB]">
                  <tr className="text-[#4B4F58] text-xs uppercase border-b border-[#E2E8F0] text-left">
                    <th className="px-5 py-3">Week</th>
                    <th className="px-4 py-3 text-right">Shipping</th>
                    <th className="px-4 py-3 text-right">Warehouse</th>
                    <th className="px-4 py-3 text-right">Adjustments</th>
                    <th className="px-4 py-3 text-right">Manual</th>
                    <th className="px-4 py-3 text-right">Total</th>
                    <th className="px-4 py-3 text-center">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {bills.length === 0
                    ? <tr><td colSpan={7} className="px-5 py-10 text-center text-[#6B7A8D]">No bills generated yet for this client</td></tr>
                    : bills.map((b, i) => (
                      <tr key={i} className="border-b border-[#E2E8F0]/40 hover:bg-[#EEF3FA]/30">
                        <td className="px-5 py-2.5 text-[#4B4F58] text-xs">{b.week_start} → {b.week_end}</td>
                        <td className="px-4 py-2.5 text-right text-[#3A4658]">{formatPrice(b.shipping_total)}</td>
                        <td className="px-4 py-2.5 text-right text-[#3A4658]">{formatPrice(b.warehouse_total)}</td>
                        <td className="px-4 py-2.5 text-right text-[#3A4658]">{formatPrice(b.adjustments_total)}</td>
                        <td className="px-4 py-2.5 text-right text-[#3A4658]">{formatPrice(b.manual_charges_total)}</td>
                        <td className="px-4 py-2.5 text-right font-bold">{formatPrice(b.grand_total)}</td>
                        <td className="px-4 py-2.5 text-center">
                          <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                            b.status === 'paid' ? 'bg-green-900/60 text-green-300' :
                            b.status === 'sent' ? 'bg-[#1A73E8]/10 text-[#1A73E8]' :
                            'bg-[#EEF3FA] text-[#4B4F58]'
                          }`}>{b.status}</span>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function SummaryCard({ label, value, sub, color }: { label: string; value: string; sub: string; color: string }) {
  const colors: Record<string, string> = {
    blue: 'border-[#1A73E8]/30 bg-[#1A73E8]/5',
    green: 'border-green-700/40 bg-green-950/30',
    red: 'border-red-700/40 bg-red-950/30',
    orange: 'border-orange-700/40 bg-orange-950/30',
    gray: 'border-[#E2E8F0] bg-white',
  }
  const textColors: Record<string, string> = {
    blue: 'text-[#1A73E8]', green: 'text-green-400', red: 'text-red-400', orange: 'text-orange-400', gray: 'text-[#0B1220]',
  }
  return (
    <div className={`rounded-xl p-4 border ${colors[color]}`}>
      <p className="text-xs text-[#4B4F58] mb-1">{label}</p>
      <p className={`text-xl font-bold ${textColors[color]}`}>{value}</p>
      <p className="text-xs text-[#6B7A8D] mt-1">{sub}</p>
    </div>
  )
}

// `note` renders only when there is something to say, so the ordinary panel is
// unchanged. A partial total with no count beside it is the shape sumPriced
// exists to prevent, and these two Stats are now partial totals.
function Stat({ label, value, note, color }: { label: string; value: string | number; note?: string; color?: string }) {
  return (
    <div className="px-5 py-3">
      <p className="text-xs text-[#4B4F58]">{label}</p>
      {/* 'gray' is deliberately not white: a figure nobody could compute
          should not be styled like one that was measured, and it must not
          borrow green or red either. Same rule as the 'unknown' StatCard on
          /losses. */}
      <p className={`font-bold text-lg ${color === 'green' ? 'text-green-400' : color === 'red' ? 'text-red-400' : color === 'orange' ? 'text-orange-400' : color === 'gray' ? 'text-[#4B4F58]' : 'text-[#0B1220]'}`}>{value}</p>
      {note && <p className="text-[11px] text-amber-400 mt-0.5">⚠ {note}</p>}
    </div>
  )
}
