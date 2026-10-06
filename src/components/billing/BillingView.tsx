'use client'

import { useState } from 'react'
import { downloadBillingExcel, downloadBillingPDF } from '@/lib/billing/download'
import {
  combinePriced, formatPrice, formatSignedPrice, isPriced, sumPriced,
  totalOrUnknown, unpricedNote, type Money,
} from '@/lib/billing/unpriced'

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
// see the note on `manual_total` below.
type ClientOption = { id: string; name: string | null }

type BillingShipment = {
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
  // UNVERIFIED. src/app/billing/page.tsx:34 selects `manual_total`, but
  // supabase/schema.sql:111 declares the column as `manual_charges_total`, and
  // `manual_total` appears in no migration in supabase/. calculator.ts:298
  // writes `manual_charges_total` and api/reports/download/route.ts:146 reads
  // it; only the two page selects disagree, both since the initial commit.
  //
  // If the live database matches schema.sql then PostgREST fails this whole
  // select with 42703 and the bills read has never once succeeded. This field
  // is typed because the select asks for it, which is all that is known; it is
  // NOT evidence that the column exists. Settle it with
  //   select column_name from information_schema.columns where table_name='bills';
  // and then either fix the select or the schema file, not this type.
  manual_total: Money
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
 * Behaviour-preserving, and the reason it had to be written down.
 *
 * Both filters below read `const d = row.date?.split('T')[0]`, so `d` is
 * `string | undefined`, and then compared it with `d >= dateFrom`. Against
 * `undefined` that comparison is not an error and is not true -- it is
 * silently false -- so a row whose date column is null disappeared from this
 * screen whenever either bound was set, which with both bounds defaulted is
 * always. Typing the prop is what surfaced it (TS18048, four times); with
 * `data: any` there was nothing to notice.
 *
 * The outcome is deliberately unchanged -- `return !from && !to` reproduces
 * the old result in all four bound combinations -- because whether an undated
 * shipment belongs on an invoice is a billing question, not a typing one.
 * Flagged rather than decided, and worth deciding, because ReportsTabs'
 * filterRows answers it the OTHER way: `dateFrom && d && d < dateFrom` KEEPS
 * undated rows. The same row is on one screen and off the other today.
 */
function inDateRange(d: string | undefined, from: string, to: string): boolean {
  if (d === undefined) return !from && !to
  return (!from || d >= from) && (!to || d <= to)
}

export default function BillingView({ data }: { data: BillingData }) {
  const [selectedClient, setSelectedClient] = useState<string>(data.clients[0]?.id ?? '')
  const [dateFrom, setDateFrom] = useState(data.defaultFrom)
  const [dateTo, setDateTo] = useState(data.defaultTo)
  const [activeTab, setActiveTab] = useState<BillingTab>('shipments')

  const client = data.clients.find(c => c.id === selectedClient)

  const shipments = data.shipments.filter(s => {
    if (s.client_id !== selectedClient) return false
    return inDateRange(s.ship_date?.split('T')[0], dateFrom, dateTo)
  })

  const warehouse = data.warehouse.filter(w => {
    if (w.client_id !== selectedClient) return false
    return (!dateFrom || w.log_date >= dateFrom) && (!dateTo || w.log_date <= dateTo)
  })

  const adjustments = data.adjustments.filter(a => {
    if (a.client_id !== selectedClient) return false
    return inDateRange(a.adjustment_date?.split('T')[0], dateFrom, dateTo)
  })

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
      <div className="bg-gray-800 rounded-xl px-5 py-4 flex flex-wrap items-end gap-4">
        <div>
          <label className="block text-xs text-gray-400 mb-1">Client</label>
          <select value={selectedClient} onChange={e => setSelectedClient(e.target.value)}
            className="bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-[#00AAFF] min-w-48">
            {data.clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-400 mb-1">From</label>
          <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
            className="bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-[#00AAFF]" />
        </div>
        <div>
          <label className="block text-xs text-gray-400 mb-1">To</label>
          <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
            className="bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-[#00AAFF]" />
        </div>
        <div className="ml-auto flex gap-2">
          <button onClick={handleExcel} disabled={dlLoading !== null}
            className="flex items-center gap-2 bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-white px-4 py-2 rounded-lg text-sm font-medium transition">
            {dlLoading === 'excel' ? '⏳' : '↓'} Excel
          </button>
          <button onClick={handlePDF} disabled={dlLoading !== null}
            className="flex items-center gap-2 disabled:opacity-50 text-white px-4 py-2 rounded-lg text-sm font-medium transition"
            style={{ background: '#00AAFF' }}>
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
          <SummaryCard label="Shipping Revenue" value={`$${shippingRevenue.toFixed(2)}`} sub={unpricedNote(shippingRevenueSum.unpriced) || `Cost: $${shippingCost.toFixed(2)}`} color={shippingRevenueSum.unpriced > 0 ? 'orange' : 'blue'} />
          <SummaryCard label="Warehouse Charges" value={`$${warehouseTotal.toFixed(2)}`} sub={unpricedNote(warehouseSum.unpriced, 'day') || `${warehouse.length} entries`} color={warehouseSum.unpriced > 0 ? 'orange' : 'gray'} />
          <SummaryCard label="Pending Adjustments" value={formatSignedPrice(totalOrUnknown(pendingAdjSum))} sub={unpricedNote(pendingAdjSum.unpriced, 'adjustment') || `${pendingAdjRows.length} pending`} color="orange" />
          <SummaryCard label="Total to Bill" value={formatPrice(totalOrUnknown(billTotal))} sub={unbillableNote || 'Shipping + WH + Adj'} color={billTotal.unpriced > 0 ? 'orange' : 'green'} />
          <SummaryCard label="Loss Shipments" value={lossCount.toString()} sub={lossCount > 0 ? '⚠️ Needs review' : '✓ All profitable'} color={lossCount > 0 ? 'red' : 'gray'} />
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 bg-gray-900 rounded-xl p-1">
        {tabs.map(tab => (
          <button key={tab.id} onClick={() => setActiveTab(tab.id)}
            className={`flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium transition ${
              activeTab === tab.id ? 'text-white' : 'text-gray-400 hover:text-white'
            }`}
            style={activeTab === tab.id ? { background: '#00AAFF' } : {}}>
            {tab.label}
            <span className={`text-xs px-1.5 py-0.5 rounded-full ${activeTab === tab.id ? 'bg-white/20' : 'bg-gray-700'}`}>{tab.count}</span>
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="bg-gray-800 rounded-xl overflow-hidden">
        {activeTab === 'shipments' && (
          <>
            <div className="grid grid-cols-4 divide-x divide-gray-700 border-b border-gray-700">
              <Stat label="Shipments" value={shipments.length} />
              <Stat label="We Paid (Carrier)" value={`$${shippingCost.toFixed(2)}`} />
              <Stat label="Charged Client" value={`$${shippingRevenue.toFixed(2)}`} />
              <Stat label="Net Profit" value={`${(shippingRevenue - shippingCost) >= 0 ? '+' : ''}$${(shippingRevenue - shippingCost).toFixed(2)}`} color={(shippingRevenue - shippingCost) >= 0 ? 'green' : 'red'} />
            </div>
            <div className="overflow-auto max-h-96">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-gray-900">
                  <tr className="text-gray-400 text-xs uppercase border-b border-gray-700 text-left">
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
                    ? <tr><td colSpan={6} className="px-5 py-10 text-center text-gray-500">No shipments in this period</td></tr>
                    : shipments.map(s => (
                      <tr key={s.order_number} className={`border-b border-gray-700/40 hover:bg-gray-700/30 ${s.is_loss ? 'bg-red-950/10' : ''}`}>
                        <td className="px-5 py-2.5 font-mono text-xs text-gray-300">{s.order_number}</td>
                        <td className="px-4 py-2.5 text-gray-400 text-xs">{s.ship_date ? new Date(s.ship_date).toLocaleDateString() : '—'}</td>
                        <td className="px-4 py-2.5 text-gray-300 text-xs">{[s.carrier, s.service].filter(Boolean).join(' · ') || '—'}</td>
                        <td className="px-4 py-2.5 text-right">{formatPrice(s.actual_cost)}</td>
                        <td className={`px-4 py-2.5 text-right ${isPriced(s.client_rate) ? '' : 'text-amber-400 font-semibold'}`}
                            title={isPriced(s.client_rate) ? undefined : 'No rate-card rate covers this shipment — it is NOT in the total to bill'}>
                          {formatPrice(s.client_rate)}
                        </td>
                        <td className={`px-4 py-2.5 text-right font-semibold ${
                          !isPriced(s.profit_loss) ? 'text-gray-500'
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
            <div className="grid grid-cols-3 divide-x divide-gray-700 border-b border-gray-700">
              <Stat label="Entries" value={warehouse.length} />
              <Stat label="Total Charges" value={`$${warehouseTotal.toFixed(2)}`} />
              <Stat label="Unique Days" value={new Set(warehouse.map(w => w.log_date)).size} />
            </div>
            <div className="overflow-auto max-h-96">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-gray-900">
                  <tr className="text-gray-400 text-xs uppercase border-b border-gray-700 text-left">
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
                    ? <tr><td colSpan={6} className="px-5 py-10 text-center text-gray-500">No warehouse activity in this period</td></tr>
                    : warehouse.map((w, i) => (
                      <tr key={i} className="border-b border-gray-700/40 hover:bg-gray-700/30">
                        <td className="px-5 py-2.5 text-gray-400 text-xs">{w.log_date ? new Date(w.log_date + 'T12:00:00').toLocaleDateString() : '—'}</td>
                        <td className="px-4 py-2.5 text-gray-300 capitalize">{w.service_type?.replace(/_/g, ' ') ?? '—'}</td>
                        <td className="px-4 py-2.5 text-right">{w.quantity}</td>
                        <td className="px-4 py-2.5 text-right text-gray-400">{formatPrice(w.rate)}</td>
                        <td className={`px-4 py-2.5 text-right font-semibold ${isPriced(w.total) ? 'text-green-400' : 'text-amber-400'}`}
                            title={isPriced(w.total) ? undefined : 'The daily log could not read a rate for this day — it is NOT in the total to bill'}>
                          {formatPrice(w.total)}
                        </td>
                        <td className="px-4 py-2.5 text-gray-500 text-xs">{w.notes ?? '—'}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {activeTab === 'adjustments' && (
          <>
            <div className="grid grid-cols-3 divide-x divide-gray-700 border-b border-gray-700">
              <Stat label="Total Adjustments" value={adjustments.length} />
              <Stat label="Pending" value={formatSignedPrice(totalOrUnknown(pendingAdjSum))} note={unpricedNote(pendingAdjSum.unpriced, 'adjustment')} color="orange" />
              <Stat label="Resolved" value={adjustments.filter(a => a.status !== 'pending').length} />
            </div>
            <div className="overflow-auto max-h-96">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-gray-900">
                  <tr className="text-gray-400 text-xs uppercase border-b border-gray-700 text-left">
                    <th className="px-5 py-3">Order #</th>
                    <th className="px-4 py-3">Reason</th>
                    <th className="px-4 py-3">Date</th>
                    <th className="px-4 py-3 text-right">Amount</th>
                    <th className="px-4 py-3 text-center">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {adjustments.length === 0
                    ? <tr><td colSpan={5} className="px-5 py-10 text-center text-gray-500">No adjustments in this period</td></tr>
                    : adjustments.map((a, i) => (
                      <tr key={i} className="border-b border-gray-700/40 hover:bg-gray-700/30">
                        <td className="px-5 py-2.5 font-mono text-xs text-gray-300">{a.order_number}</td>
                        <td className="px-4 py-2.5 text-gray-300 text-xs">{a.reason ?? 'Carrier reweigh'}</td>
                        <td className="px-4 py-2.5 text-gray-400 text-xs">{a.adjustment_date ? new Date(a.adjustment_date).toLocaleDateString() : '—'}</td>
                        <td className="px-4 py-2.5 text-right font-semibold text-orange-400">{formatSignedPrice(a.adjustment_amount)}</td>
                        <td className="px-4 py-2.5 text-center">
                          <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                            a.status === 'pending' ? 'bg-orange-900/60 text-orange-300' :
                            a.status === 'charged' ? 'bg-green-900/60 text-green-300' :
                            'bg-gray-700 text-gray-400'
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
            <div className="grid grid-cols-3 divide-x divide-gray-700 border-b border-gray-700">
              <Stat label="Bills Generated" value={bills.length} />
              <Stat label="Total Billed" value={formatPrice(totalOrUnknown(billedSum))} note={unpricedNote(billedSum.unpriced, 'bill')} />
              <Stat label="Paid" value={bills.filter(b => b.status === 'paid').length} color="green" />
            </div>
            <div className="overflow-auto max-h-96">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-gray-900">
                  <tr className="text-gray-400 text-xs uppercase border-b border-gray-700 text-left">
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
                    ? <tr><td colSpan={7} className="px-5 py-10 text-center text-gray-500">No bills generated yet for this client</td></tr>
                    : bills.map((b, i) => (
                      <tr key={i} className="border-b border-gray-700/40 hover:bg-gray-700/30">
                        <td className="px-5 py-2.5 text-gray-400 text-xs">{b.week_start} → {b.week_end}</td>
                        <td className="px-4 py-2.5 text-right text-gray-300">{formatPrice(b.shipping_total)}</td>
                        <td className="px-4 py-2.5 text-right text-gray-300">{formatPrice(b.warehouse_total)}</td>
                        <td className="px-4 py-2.5 text-right text-gray-300">{formatPrice(b.adjustments_total)}</td>
                        <td className="px-4 py-2.5 text-right text-gray-300">{formatPrice(b.manual_total)}</td>
                        <td className="px-4 py-2.5 text-right font-bold">{formatPrice(b.grand_total)}</td>
                        <td className="px-4 py-2.5 text-center">
                          <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                            b.status === 'paid' ? 'bg-green-900/60 text-green-300' :
                            b.status === 'sent' ? 'bg-[#00AAFF]/10 text-[#00AAFF]' :
                            'bg-gray-700 text-gray-400'
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
    blue: 'border-[#00AAFF]/30 bg-[#00AAFF]/5',
    green: 'border-green-700/40 bg-green-950/30',
    red: 'border-red-700/40 bg-red-950/30',
    orange: 'border-orange-700/40 bg-orange-950/30',
    gray: 'border-gray-700 bg-gray-800',
  }
  const textColors: Record<string, string> = {
    blue: 'text-[#00AAFF]', green: 'text-green-400', red: 'text-red-400', orange: 'text-orange-400', gray: 'text-white',
  }
  return (
    <div className={`rounded-xl p-4 border ${colors[color]}`}>
      <p className="text-xs text-gray-400 mb-1">{label}</p>
      <p className={`text-xl font-bold ${textColors[color]}`}>{value}</p>
      <p className="text-xs text-gray-500 mt-1">{sub}</p>
    </div>
  )
}

// `note` renders only when there is something to say, so the ordinary panel is
// unchanged. A partial total with no count beside it is the shape sumPriced
// exists to prevent, and these two Stats are now partial totals.
function Stat({ label, value, note, color }: { label: string; value: string | number; note?: string; color?: string }) {
  return (
    <div className="px-5 py-3">
      <p className="text-xs text-gray-400">{label}</p>
      <p className={`font-bold text-lg ${color === 'green' ? 'text-green-400' : color === 'red' ? 'text-red-400' : color === 'orange' ? 'text-orange-400' : 'text-white'}`}>{value}</p>
      {note && <p className="text-[11px] text-amber-400 mt-0.5">⚠ {note}</p>}
    </div>
  )
}
