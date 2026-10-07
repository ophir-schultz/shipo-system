'use client'

import { useState } from 'react'
import { showError, showSuccess } from '@/components/ui/Toast'
import {
  formatPrice, formatSignedPrice, isPriced, sumPriced, totalOrUnknown,
  unpricedNote, type Money,
} from '@/lib/billing/unpriced'
import { embedOne, type Embed } from '@/lib/db/read'
import { filterByDate, undatedNote, type DateFiltered } from '@/lib/billing/date-range'

// `client_rate`, the profit derived from it, and `warehouse_daily_log.total`
// are all nullable: recalculate.ts and the daily-log route write null when they
// cannot read a rate, rather than the billable 0 they used to write. `?? 0`
// printed those as "$0.00" -- indistinguishable from a line carried free -- and
// dropped them out of every total while leaving them in the count beside it.
//
// This file cannot be unit-tested here (vitest.config.ts excludes `.test.tsx`),
// so the rules live in lib/billing/unpriced.ts, which is tested and
// mutation-checked, and this file only calls them.
//
// `adjustment_amount` was previously left on `?? 0` here, on the grounds that
// nothing writes null to that column so changing it would be a guess dressed up
// as a fix. That reasoning is withdrawn, for two reasons neither of which was
// available when it was written:
//
//   1. It is not true as stated. schema.sql:68 declares `adjustment_amount
//      numeric(10,2)` with no `not null`, so the column accepts null whatever
//      today's writers happen to do. "No current writer emits null" is a fact
//      about four call sites, not about the data this page reads.
//   2. It answers the wrong question. `?? 0` guards null and undefined only,
//      and the hazard on a `numeric` column is the wire shape: PostgREST is
//      entitled to hand back '12.34', on which `.toFixed` is not a function and
//      `s + x` is string concatenation -- `0 + '12.34'` is '012.34', which then
//      poisons every remaining addition in the same reduce. Nullability was
//      never the only thing `?? 0` was failing to handle.
//
// So the columns below go through priceOf, which coerces rather than assuming
// either shape. If the column really is never null, nothing on screen changes.

// The payload, declared rather than inferred -- see the LoadedData docstring in
// src/lib/db/read.ts for why `data: any` here was load-bearing rather than
// untidy: it let /reports' refusal-to-render check be deleted without tsc
// noticing, on the one screen in the app that writes a .xlsx file.
//
// `type` and not `interface`, because an interface has no implicit index
// signature and so would not satisfy sumPriced's `Record<string, unknown>`.
//
// Note the row shapes are NOT shared with BillingView even where the table is
// the same. /billing selects `client_id`; /reports selects `clients(name)` and
// joins. A single shared row type would have to make both optional, which
// would describe neither page and would let a field that is always undefined
// on this page compile.
type ClientOption = { id: string; name: string | null }

/**
 * The `clients(name)` join.
 *
 * Written as an Embed rather than as the object this file's five render sites
 * already assume, because the cardinality is genuinely unverified here: the
 * fourteen consumers in this repo read `.name` off an object, supabase-js's
 * select-string parser types the same embed as an array, and nobody has asked
 * the database. See the Embed docstring in src/lib/db/read.ts. Reading it
 * through embedOne costs one call per cell and is right either way.
 */
type ClientRef = Embed<{ name: string | null }>

type ReportLossShipment = {
  order_number: string
  clients: ClientRef
  ship_date: string | null
  carrier: string | null
  service: string | null
  actual_cost: Money
  client_rate: Money
  profit_loss: Money
}

/** The shipments select is the losses select plus these two. */
type ReportShipment = ReportLossShipment & {
  tracking_number: string | null
  is_loss: boolean | null
}

type ReportAdjustment = {
  order_number: string
  clients: ClientRef
  reason: string | null
  adjustment_date: string | null
  original_cost: Money
  // UNVERIFIED, and the stronger of this file's two phantom columns.
  // src/app/reports/page.tsx:31 selects `new_cost`; supabase/schema.sql:67
  // declares `adjusted_cost`, shipstation.ts:582 writes `adjusted_cost`, and
  // api/reports/download/route.ts:123 plus AdjustmentsClient.tsx read
  // `adjusted_cost`. `new_cost` occurs nowhere else in the repo and in no
  // migration. Typed because the select asks for it, not because it exists.
  new_cost: Money
  adjustment_amount: Money
  status: string | null
}

type ReportBill = {
  clients: ClientRef
  week_start: string
  week_end: string
  shipping_total: Money
  warehouse_total: Money
  adjustments_total: Money
  // UNVERIFIED -- schema.sql:111 declares `manual_charges_total`. Same note as
  // the one on BillingView's BillingBill; both page selects carry it and no
  // migration defines it.
  manual_total: Money
  grand_total: Money
  status: string | null
}

type ReportWarehouseLine = {
  clients: ClientRef
  log_date: string
  service_type: string | null
  // A count rather than a price, rendered raw rather than summed -- so not
  // Money, but still a `numeric` column whose wire shape is not guaranteed.
  quantity: number | string | null
  rate: Money
  total: Money
  notes: string | null
}

export type ReportsData = {
  clients: ClientOption[]
  shipments: ReportShipment[]
  lossShipments: ReportLossShipment[]
  adjustments: ReportAdjustment[]
  bills: ReportBill[]
  warehouse: ReportWarehouseLine[]
  defaultFrom: string
  defaultTo: string
}

/** What every one of the five tables below is handed. */
type TableProps<T> = {
  rows: T[]
  clientId: string
  dateFrom: string
  dateTo: string
}

const TABS = [
  { id: 'shipments', label: 'Shipments', icon: '🚚' },
  { id: 'loss', label: 'Losses', icon: '⚠️' },
  { id: 'adjustments', label: 'Adjustments', icon: '🔔' },
  { id: 'billing', label: 'Billing', icon: '💰' },
  { id: 'warehouse', label: 'Warehouse', icon: '📦' },
]

export default function ReportsTabs({ data }: { data: ReportsData }) {
  const [activeTab, setActiveTab] = useState('shipments')
  const [clientId, setClientId] = useState('')
  const [dateFrom, setDateFrom] = useState(data.defaultFrom)
  const [dateTo, setDateTo] = useState(data.defaultTo)
  const [downloading, setDownloading] = useState(false)

  function handlePrintPDF() {
    window.print()
  }

  async function handleDownload() {
    setDownloading(true)
    const typeMap: Record<string, string> = {
      shipments: 'shipments',
      loss: 'loss-shipments',
      adjustments: 'adjustments',
      billing: 'billing',
      warehouse: 'warehouse',
    }
    const params = new URLSearchParams({ type: typeMap[activeTab], dateFrom, dateTo, ...(clientId ? { clientId } : {}) })
    try {
      const res = await fetch(`/api/reports/download?${params}`)
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error ?? `Server error ${res.status}`)
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${typeMap[activeTab]}-${dateFrom}-${dateTo}.xlsx`
      a.click()
      URL.revokeObjectURL(url)
      showSuccess('Report downloaded')
    } catch (err: any) {
      showError('Download failed', err?.message ?? 'Could not generate report')
    } finally {
      setDownloading(false)
    }
  }

  return (
    <div className="space-y-4">
      {/* Filters + Download bar */}
      <div className="bg-gray-800 rounded-xl px-5 py-4 flex flex-wrap items-end gap-4">
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
        <div>
          <label className="block text-xs text-gray-400 mb-1">Client</label>
          <select value={clientId} onChange={e => setClientId(e.target.value)}
            className="bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-[#00AAFF]">
            <option value="">All Clients</option>
            {data.clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div className="ml-auto flex gap-2">
          <button onClick={handleDownload} disabled={downloading}
            className="px-4 py-2 rounded-lg text-sm font-semibold text-white bg-gray-700 hover:bg-gray-600 disabled:opacity-50 transition">
            {downloading ? '⏳…' : '↓ Excel'}
          </button>
          <button onClick={handlePrintPDF} disabled={downloading}
            className="px-4 py-2 rounded-lg text-sm font-semibold text-white disabled:opacity-50 transition"
            style={{ background: '#00AAFF' }}>
            ↓ PDF
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-gray-900 rounded-xl p-1">
        {TABS.map(tab => (
          <button key={tab.id} onClick={() => setActiveTab(tab.id)}
            className={`flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium transition ${
              activeTab === tab.id ? 'text-white' : 'text-gray-400 hover:text-white'
            }`}
            style={activeTab === tab.id ? { background: '#00AAFF' } : {}}>
            <span>{tab.icon}</span>{tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="bg-gray-800 rounded-xl overflow-hidden">
        {activeTab === 'shipments' && <ShipmentsTable rows={data.shipments} clientId={clientId} dateFrom={dateFrom} dateTo={dateTo} />}
        {activeTab === 'loss' && <LossTable rows={data.lossShipments} clientId={clientId} dateFrom={dateFrom} dateTo={dateTo} />}
        {activeTab === 'adjustments' && <AdjustmentsTable rows={data.adjustments} clientId={clientId} dateFrom={dateFrom} dateTo={dateTo} />}
        {activeTab === 'billing' && <BillingTable rows={data.bills} clientId={clientId} dateFrom={dateFrom} dateTo={dateTo} />}
        {activeTab === 'warehouse' && <WarehouseTable rows={data.warehouse} clientId={clientId} dateFrom={dateFrom} dateTo={dateTo} />}
      </div>
    </div>
  )
}

/**
 * Date-range filter, generic over the row so `dateKey` cannot be a key the row
 * does not have.
 *
 * Two things typing this made visible, neither of them changed here:
 *
 *   * `clientId` is accepted and never read. Picking a client in the dropdown
 *     above filters NOTHING on screen -- while the Excel button next to it DOES
 *     pass clientId to /api/reports/download, so the table and the spreadsheet
 *     you export from it disagree about which client you asked for. It cannot
 *     be fixed here: src/app/reports/page.tsx selects `clients(name)` and no
 *     `client_id`, so the column to filter on is not in the payload. The
 *     parameter stays in the signature because every caller passes it and
 *     because deleting it would hide the defect rather than fix it.
 *   * A dead `clientKey = 'client_id'` parameter, never referenced and never
 *     passed, removed -- it was the file's one eslint warning.
 *
 * The date logic itself now lives in src/lib/billing/date-range.ts, shared with
 * BillingView, because the two screens disagreed about undated rows and this one
 * was wrong. `if (dateFrom && d && d < dateFrom)` skips the comparison
 * altogether when `d` is absent, so a row with a null ship_date was KEPT in
 * every range it was ever asked for -- while BillingView dropped it, and more
 * to the point while the Excel export beside this table dropped it too, because
 * /api/reports/download filters in SQL where `null >= '2026-10-01'` is null and
 * therefore not true. The table disagreed with its own download button.
 *
 * Undated rows are now dropped when a bound is set, and COUNTED, so the drop is
 * stated instead of silent. Only ship_date and adjustment_date are nullable
 * (schema.sql:42,70); for week_start and log_date the count is always 0 and
 * nothing on screen changes.
 *
 * Kept as a wrapper rather than calling filterByDate at the five sites so the
 * dead-`clientId` finding above stays recorded in one place instead of being
 * repeated or quietly dropped.
 */
function filterRows<T>(
  rows: T[], clientId: string, dateFrom: string, dateTo: string, dateKey: keyof T & string,
): DateFiltered<T> {
  return filterByDate(rows, dateKey, dateFrom, dateTo)
}

function Empty({ msg }: { msg: string }) {
  return <div className="px-6 py-12 text-center text-gray-500 text-sm">{msg}</div>
}

function ShipmentsTable({ rows, clientId, dateFrom, dateTo }: TableProps<ReportShipment>) {
  const period = filterRows(rows, clientId, dateFrom, dateTo, 'ship_date')
  const filtered = period.rows
  const paidSum = sumPriced(filtered, 'actual_cost')
  const chargedSum = sumPriced(filtered, 'client_rate')
  const plSum = sumPriced(filtered, 'profit_loss')
  const totalPaid = paidSum.total
  const totalCharged = chargedSum.total
  const totalPL = plSum.total

  // Each stat carries the count its own total left out, rather than one note
  // for the panel: "We Paid" and "Charged" can be short by different rows, and
  // a single number would not say which figure to distrust.
  const stats: Array<[string, string | number, string]> = [
    ['Shipments', filtered.length, undatedNote(period.undated)],
    ['We Paid', `$${totalPaid.toFixed(2)}`, unpricedNote(paidSum.unpriced)],
    ['Charged', `$${totalCharged.toFixed(2)}`, unpricedNote(chargedSum.unpriced)],
    ['Net P/L', `${totalPL >= 0 ? '+' : ''}$${totalPL.toFixed(2)}`, unpricedNote(plSum.unpriced)],
  ]

  return (
    <>
      <div className="grid grid-cols-4 divide-x divide-gray-700 border-b border-gray-700">
        {stats.map(([l, v, note]) => (
          <div key={l} className="px-5 py-3">
            <p className="text-xs text-gray-400">{l}</p>
            <p className={`font-bold text-lg ${l === 'Net P/L' ? (totalPL >= 0 ? 'text-green-400' : 'text-red-400') : 'text-white'}`}>{v}</p>
            {note && <p className="text-[11px] text-amber-400 mt-0.5">⚠ {note}</p>}
          </div>
        ))}
      </div>
      <div className="overflow-auto max-h-[520px]">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-gray-900">
            <tr className="text-gray-400 text-left border-b border-gray-700 text-xs uppercase">
              <th className="px-5 py-3">Order #</th>
              <th className="px-4 py-3">Client</th>
              <th className="px-4 py-3">Date</th>
              <th className="px-4 py-3">Carrier / Service</th>
              <th className="px-4 py-3">Tracking</th>
              <th className="px-4 py-3 text-right">We Paid</th>
              <th className="px-4 py-3 text-right">Charged</th>
              <th className="px-4 py-3 text-right">P / L</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? <tr><td colSpan={8}><Empty msg="No shipments in this range" /></td></tr> : filtered.map(s => (
              <tr key={s.order_number} className={`border-b border-gray-700/40 hover:bg-gray-700/30 ${s.is_loss ? 'bg-red-950/10' : ''}`}>
                <td className="px-5 py-2.5 font-mono text-xs text-gray-300">{s.order_number}</td>
                <td className="px-4 py-2.5">{embedOne(s.clients)?.name ?? <span className="text-gray-500">—</span>}</td>
                <td className="px-4 py-2.5 text-gray-400 text-xs">{s.ship_date ? new Date(s.ship_date).toLocaleDateString() : '—'}</td>
                <td className="px-4 py-2.5 text-gray-300 text-xs">{[s.carrier, s.service].filter(Boolean).join(' · ') || '—'}</td>
                <td className="px-4 py-2.5 font-mono text-xs text-gray-500">{s.tracking_number ?? '—'}</td>
                <td className="px-4 py-2.5 text-right">{formatPrice(s.actual_cost)}</td>
                <td className={`px-4 py-2.5 text-right ${isPriced(s.client_rate) ? '' : 'text-amber-400'}`}
                    title={isPriced(s.client_rate) ? undefined : 'No rate-card rate covers this shipment'}>
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
  )
}

function LossTable({ rows, clientId, dateFrom, dateTo }: TableProps<ReportLossShipment>) {
  const period = filterRows(rows, clientId, dateFrom, dateTo, 'ship_date')
  const filtered = period.rows
  const plSum = sumPriced(filtered, 'profit_loss')
  const total = Math.abs(plSum.total)
  // Averaged over the rows that actually contributed, not over every row in the
  // table. `total / filtered.length` divides a short total by a full count,
  // which understates the average loss -- the direction that makes a problem
  // look smaller than it is.
  const priced = plSum.counted - plSum.unpriced
  const note = unpricedNote(plSum.unpriced)
  return (
    <>
      <div className="grid grid-cols-3 divide-x divide-gray-700 border-b border-gray-700" style={{ background: '#1a0a0a' }}>
        {([
          ['Loss Shipments', filtered.length, undatedNote(period.undated)],
          ['Total Lost', `-$${total.toFixed(2)}`, note],
          ['Avg Loss', priced ? `-$${(total / priced).toFixed(2)}` : '$0.00', note],
        ] as Array<[string, string | number, string]>).map(([l, v, n]) => (
          <div key={l} className="px-5 py-3">
            <p className="text-xs text-red-400/70">{l}</p>
            <p className="font-bold text-lg text-red-400">{v}</p>
            {n && <p className="text-[11px] text-amber-400 mt-0.5">⚠ {n}</p>}
          </div>
        ))}
      </div>
      <div className="overflow-auto max-h-[520px]">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-gray-900">
            <tr className="text-gray-400 text-left border-b border-gray-700 text-xs uppercase">
              <th className="px-5 py-3">Order #</th>
              <th className="px-4 py-3">Client</th>
              <th className="px-4 py-3">Date</th>
              <th className="px-4 py-3">Carrier / Service</th>
              <th className="px-4 py-3 text-right">We Paid</th>
              <th className="px-4 py-3 text-right">Charged</th>
              <th className="px-4 py-3 text-right">Loss</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? <tr><td colSpan={7}><Empty msg="✓ No loss shipments in this range" /></td></tr> : filtered.map(s => (
              <tr key={s.order_number} className="border-b border-gray-700/40 hover:bg-red-950/20">
                <td className="px-5 py-2.5 font-mono text-xs text-gray-300">{s.order_number}</td>
                <td className="px-4 py-2.5">{embedOne(s.clients)?.name ?? '—'}</td>
                <td className="px-4 py-2.5 text-gray-400 text-xs">{s.ship_date ? new Date(s.ship_date).toLocaleDateString() : '—'}</td>
                <td className="px-4 py-2.5 text-gray-300 text-xs">{[s.carrier, s.service].filter(Boolean).join(' · ') || '—'}</td>
                <td className="px-4 py-2.5 text-right">{formatPrice(s.actual_cost)}</td>
                <td className={`px-4 py-2.5 text-right ${isPriced(s.client_rate) ? '' : 'text-amber-400'}`}>
                  {formatPrice(s.client_rate)}
                </td>
                <td className={`px-4 py-2.5 text-right font-bold ${isPriced(s.profit_loss) ? 'text-red-400' : 'text-gray-500'}`}>
                  {isPriced(s.profit_loss) ? `-${formatPrice(Math.abs(Number(s.profit_loss)))}` : formatPrice(null)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

function AdjustmentsTable({ rows, clientId, dateFrom, dateTo }: TableProps<ReportAdjustment>) {
  const period = filterRows(rows, clientId, dateFrom, dateTo, 'adjustment_date')
  const filtered = period.rows
  const pending = filtered.filter(r => r.status === 'pending')
  const pendingSum = sumPriced(pending, 'adjustment_amount')
  // `string | null` and not `string`: bills.status and rate_adjustments.status
  // are both nullable, and widening is behaviour-preserving -- null never
  // equalled any of the labels, so it fell to the grey default before and
  // falls to it now. Narrowing instead would mean a non-null assertion, which
  // is a claim about the column nobody here has checked.
  const statusBadge = (s: string | null) => s === 'pending'
    ? 'bg-orange-900/60 text-orange-300'
    : s === 'charged' ? 'bg-green-900/60 text-green-300' : 'bg-gray-700 text-gray-400'

  return (
    <>
      <div className="grid grid-cols-3 divide-x divide-gray-700 border-b border-gray-700">
        {([
          ['Total', filtered.length, undatedNote(period.undated, 'adjustment')],
          ['Pending', pending.length, ''],
          ['To Recover', formatSignedPrice(totalOrUnknown(pendingSum)), unpricedNote(pendingSum.unpriced, 'adjustment')],
        ] as Array<[string, string | number, string]>).map(([l, v, n]) => (
          <div key={l} className="px-5 py-3">
            <p className="text-xs text-gray-400">{l}</p>
            <p className={`font-bold text-lg ${l === 'To Recover' ? 'text-orange-400' : 'text-white'}`}>{v}</p>
            {n && <p className="text-[11px] text-amber-400 mt-0.5">⚠ {n}</p>}
          </div>
        ))}
      </div>
      <div className="overflow-auto max-h-[520px]">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-gray-900">
            <tr className="text-gray-400 text-left border-b border-gray-700 text-xs uppercase">
              <th className="px-5 py-3">Order #</th>
              <th className="px-4 py-3">Client</th>
              <th className="px-4 py-3">Reason</th>
              <th className="px-4 py-3">Date</th>
              <th className="px-4 py-3 text-right">Original</th>
              <th className="px-4 py-3 text-right">New Cost</th>
              <th className="px-4 py-3 text-right">Adjustment</th>
              <th className="px-4 py-3 text-center">Status</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? <tr><td colSpan={8}><Empty msg="No adjustments in this range" /></td></tr> : filtered.map((a, i) => (
              <tr key={i} className="border-b border-gray-700/40 hover:bg-gray-700/30">
                <td className="px-5 py-2.5 font-mono text-xs text-gray-300">{a.order_number}</td>
                <td className="px-4 py-2.5">{embedOne(a.clients)?.name ?? '—'}</td>
                <td className="px-4 py-2.5 text-gray-300 text-xs">{a.reason ?? 'Carrier reweigh'}</td>
                <td className="px-4 py-2.5 text-gray-400 text-xs">{a.adjustment_date ? new Date(a.adjustment_date).toLocaleDateString() : '—'}</td>
                <td className="px-4 py-2.5 text-right text-gray-400">{formatPrice(a.original_cost)}</td>
                <td className="px-4 py-2.5 text-right text-gray-400">{formatPrice(a.new_cost)}</td>
                <td className="px-4 py-2.5 text-right font-bold text-orange-400">{formatSignedPrice(a.adjustment_amount)}</td>
                <td className="px-4 py-2.5 text-center">
                  <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${statusBadge(a.status)}`}>{a.status}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

function BillingTable({ rows, clientId, dateFrom, dateTo }: TableProps<ReportBill>) {
  const period = filterRows(rows, clientId, dateFrom, dateTo, 'week_start')
  const filtered = period.rows
  const billedSum = sumPriced(filtered, 'grand_total')
  // Nullable for the same reason as the one in AdjustmentsTable above.
  const statusBadge = (s: string | null) => s === 'paid' ? 'bg-green-900/60 text-green-300' : s === 'sent' ? 'bg-[#00AAFF]/10 text-[#00AAFF]' : 'bg-gray-700 text-gray-400'

  return (
    <>
      <div className="grid grid-cols-3 divide-x divide-gray-700 border-b border-gray-700">
        {([
          ['Bills', filtered.length, undatedNote(period.undated, 'bill')],
          ['Total Billed', formatPrice(totalOrUnknown(billedSum)), unpricedNote(billedSum.unpriced, 'bill')],
          ['Paid', filtered.filter(r => r.status === 'paid').length, ''],
        ] as Array<[string, string | number, string]>).map(([l, v, n]) => (
          <div key={l} className="px-5 py-3">
            <p className="text-xs text-gray-400">{l}</p>
            <p className="font-bold text-lg text-white">{v}</p>
            {n && <p className="text-[11px] text-amber-400 mt-0.5">⚠ {n}</p>}
          </div>
        ))}
      </div>
      <div className="overflow-auto max-h-[520px]">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-gray-900">
            <tr className="text-gray-400 text-left border-b border-gray-700 text-xs uppercase">
              <th className="px-5 py-3">Client</th>
              <th className="px-4 py-3">Week</th>
              <th className="px-4 py-3 text-right">Shipping</th>
              <th className="px-4 py-3 text-right">Warehouse</th>
              <th className="px-4 py-3 text-right">Adjustments</th>
              <th className="px-4 py-3 text-right">Manual</th>
              <th className="px-4 py-3 text-right">Total</th>
              <th className="px-4 py-3 text-center">Status</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? <tr><td colSpan={8}><Empty msg="No bills in this range" /></td></tr> : filtered.map((b, i) => (
              <tr key={i} className="border-b border-gray-700/40 hover:bg-gray-700/30">
                <td className="px-5 py-2.5 font-medium">{embedOne(b.clients)?.name ?? '—'}</td>
                <td className="px-4 py-2.5 text-gray-400 text-xs">{b.week_start} → {b.week_end}</td>
                <td className="px-4 py-2.5 text-right text-gray-300">{formatPrice(b.shipping_total)}</td>
                <td className="px-4 py-2.5 text-right text-gray-300">{formatPrice(b.warehouse_total)}</td>
                <td className="px-4 py-2.5 text-right text-gray-300">{formatPrice(b.adjustments_total)}</td>
                <td className="px-4 py-2.5 text-right text-gray-300">{formatPrice(b.manual_total)}</td>
                <td className="px-4 py-2.5 text-right font-bold">{formatPrice(b.grand_total)}</td>
                <td className="px-4 py-2.5 text-center">
                  <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${statusBadge(b.status)}`}>{b.status}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

function WarehouseTable({ rows, clientId, dateFrom, dateTo }: TableProps<ReportWarehouseLine>) {
  const period = filterRows(rows, clientId, dateFrom, dateTo, 'log_date')
  const filtered = period.rows
  const revenueSum = sumPriced(filtered, 'total')
  const totalRevenue = revenueSum.total

  return (
    <>
      <div className="grid grid-cols-3 divide-x divide-gray-700 border-b border-gray-700">
        {([
          ['Entries', filtered.length, undatedNote(period.undated, 'day')],
          ['Total Revenue', `$${totalRevenue.toFixed(2)}`, unpricedNote(revenueSum.unpriced, 'day')],
          ['Unique Days', new Set(filtered.map(r => r.log_date)).size, ''],
        ] as Array<[string, string | number, string]>).map(([l, v, n]) => (
          <div key={l} className="px-5 py-3">
            <p className="text-xs text-gray-400">{l}</p>
            <p className="font-bold text-lg text-white">{v}</p>
            {n && <p className="text-[11px] text-amber-400 mt-0.5">⚠ {n}</p>}
          </div>
        ))}
      </div>
      <div className="overflow-auto max-h-[520px]">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-gray-900">
            <tr className="text-gray-400 text-left border-b border-gray-700 text-xs uppercase">
              <th className="px-5 py-3">Date</th>
              <th className="px-4 py-3">Client</th>
              <th className="px-4 py-3">Service</th>
              <th className="px-4 py-3 text-right">Qty</th>
              <th className="px-4 py-3 text-right">Rate</th>
              <th className="px-4 py-3 text-right">Total</th>
              <th className="px-4 py-3">Notes</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? <tr><td colSpan={7}><Empty msg="No warehouse activity in this range" /></td></tr> : filtered.map((w, i) => (
              <tr key={i} className="border-b border-gray-700/40 hover:bg-gray-700/30">
                <td className="px-5 py-2.5 text-gray-400 text-xs">{w.log_date ? new Date(w.log_date + 'T12:00:00').toLocaleDateString() : '—'}</td>
                <td className="px-4 py-2.5 font-medium">{embedOne(w.clients)?.name ?? '—'}</td>
                <td className="px-4 py-2.5 text-gray-300 capitalize">{w.service_type?.replace(/_/g, ' ') ?? '—'}</td>
                <td className="px-4 py-2.5 text-right">{w.quantity}</td>
                <td className="px-4 py-2.5 text-right text-gray-400">{formatPrice(w.rate)}</td>
                <td className={`px-4 py-2.5 text-right font-semibold ${isPriced(w.total) ? 'text-green-400' : 'text-amber-400'}`}
                    title={isPriced(w.total) ? undefined : 'The daily log could not read a rate for this day'}>
                  {formatPrice(w.total)}
                </td>
                <td className="px-4 py-2.5 text-gray-500 text-xs">{w.notes ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}
