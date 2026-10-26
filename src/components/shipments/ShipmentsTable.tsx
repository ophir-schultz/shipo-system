'use client'

import { useState, useMemo } from 'react'
import {
  formatPrice, formatSignedPrice, isPriced, UNPRICED_DASH,
} from '@/lib/billing/unpriced'
import { exclusionNote, reconcile, reconciledOrUnknown } from '@/lib/billing/profit-rollup'

// The rate and profit columns are nullable: recalculate.ts writes null when
// the rate card does not cover a shipment. `?? 0` printed those as "$0.00",
// which is indistinguishable from a shipment carried free, and dropped them
// from the footer totals while leaving them in the row count above.
//
// This file cannot be unit-tested here -- vitest.config.ts excludes
// `.test.tsx` -- so the decisions live in lib/billing/unpriced.ts, which is
// tested and mutation-checked, and this file only calls them.

const QUICK_RANGES = [
  { label: 'Today', days: 0 },
  { label: 'Last 7 days', days: 7 },
  { label: 'Last 30 days', days: 30 },
  { label: 'Last 90 days', days: 90 },
  { label: 'This Month', days: -1 },
  { label: 'All Time', days: -2 },
]

function getQuickRange(days: number) {
  const to = new Date().toISOString().split('T')[0]
  if (days === -2) return { from: '', to: '' }
  if (days === -1) {
    const now = new Date()
    return { from: new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0], to }
  }
  if (days === 0) return { from: to, to }
  const from = new Date()
  from.setDate(from.getDate() - days)
  return { from: from.toISOString().split('T')[0], to }
}

export default function ShipmentsTable({ shipments, clients, initialFilter }: {
  shipments: any[]
  clients: any[]
  initialFilter: string
}) {
  const now = new Date()
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0]
  const today = now.toISOString().split('T')[0]

  const [dateFrom, setDateFrom] = useState(monthStart)
  const [dateTo, setDateTo] = useState(today)
  const [clientId, setClientId] = useState('')
  const [carrier, setCarrier] = useState('')
  const [lossOnly, setLossOnly] = useState(initialFilter === 'loss')
  const [search, setSearch] = useState('')
  const [activeQuick, setActiveQuick] = useState('This Month')

  function applyQuick(label: string, days: number) {
    setActiveQuick(label)
    const { from, to } = getQuickRange(days)
    setDateFrom(from)
    setDateTo(to)
  }

  // Unique carriers
  const carriers = useMemo(() => {
    const set = new Set(shipments.map(s => s.carrier).filter(Boolean))
    return Array.from(set).sort()
  }, [shipments])

  const filtered = useMemo(() => {
    return shipments.filter(s => {
      const d = s.ship_date?.split('T')[0] ?? ''
      if (dateFrom && d < dateFrom) return false
      if (dateTo && d > dateTo) return false
      if (clientId && s.client_id !== clientId) return false
      if (carrier && s.carrier !== carrier) return false
      if (lossOnly && !s.is_loss) return false
      if (search) {
        const q = search.toLowerCase()
        if (
          !s.order_number?.toLowerCase().includes(q) &&
          !s.tracking_number?.toLowerCase().includes(q) &&
          !s.clients?.name?.toLowerCase().includes(q)
        ) return false
      }
      return true
    })
  }, [shipments, dateFrom, dateTo, clientId, carrier, lossOnly, search])

  // THE SAME DEFECT THE DASHBOARD, /losses AND THE REPORTS TAB HAD. These were
  // three independent sums -- sumPriced(actual_cost), sumPriced(client_rate),
  // sumPriced(profit_loss) -- shown as three cards in a row and again as three
  // cells in one footer. Each withheld its own unreadable rows, so the three
  // figures described three different sets of shipments and Charged minus Paid
  // was not Net P/L. Net P/L also came off the STORED profit_loss column, so
  // this screen could print a different profit for a period than the dashboard
  // printed for the same one.
  //
  // One `reconcile` over one row set, margin derived by subtraction -- the same
  // call every other money screen now makes. `null` where nothing could be
  // reconciled, because a period whose margin is entirely unmeasured is not
  // +$0.00 in green.
  const margin = reconcile(filtered)
  const known = reconciledOrUnknown(margin)
  const fig = (n: number | null) => (n === null ? UNPRICED_DASH : `$${n.toFixed(2)}`)
  // `known.profit >= 0` would be TRUE for null -- `null >= 0` is true in
  // JavaScript -- which would paint an unmeasurable period green.
  const plPositive = known.profit !== null && known.profit >= 0
  const plFigure = known.profit === null
    ? UNPRICED_DASH
    : `${plPositive ? '+' : ''}$${known.profit.toFixed(2)}`
  // One note for all three figures now that one row set is behind all three.
  // The per-figure notes existed because each sum withheld a different set,
  // which was the defect, not the remedy.
  const marginNote = exclusionNote(margin)
  const lossCount = filtered.filter(s => s.is_loss).length

  return (
    <div className="space-y-4">
      {/* Filter bar */}
      <div className="bg-white rounded-xl p-4 space-y-3">
        {/* Quick date ranges */}
        <div className="flex flex-wrap gap-2">
          {QUICK_RANGES.map(r => (
            <button
              key={r.label}
              onClick={() => applyQuick(r.label, r.days)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition ${
                activeQuick === r.label ? 'text-[#0B1220]' : 'bg-[#EEF3FA] text-[#4B4F58] hover:text-[#0B1220]'
              }`}
              style={activeQuick === r.label ? { background: '#1A73E8' } : {}}
            >
              {r.label}
            </button>
          ))}
        </div>

        {/* Filter inputs */}
        <div className="flex flex-wrap gap-3 items-end">
          <div>
            <label className="block text-xs text-[#4B4F58] mb-1">From</label>
            <input type="date" value={dateFrom} onChange={e => { setDateFrom(e.target.value); setActiveQuick('') }}
              className="bg-[#EEF3FA] border border-[#CBD5E1] rounded-lg px-3 py-2 text-[#0B1220] text-sm focus:outline-none focus:border-[#1A73E8]" />
          </div>
          <div>
            <label className="block text-xs text-[#4B4F58] mb-1">To</label>
            <input type="date" value={dateTo} onChange={e => { setDateTo(e.target.value); setActiveQuick('') }}
              className="bg-[#EEF3FA] border border-[#CBD5E1] rounded-lg px-3 py-2 text-[#0B1220] text-sm focus:outline-none focus:border-[#1A73E8]" />
          </div>
          <div>
            <label className="block text-xs text-[#4B4F58] mb-1">Client</label>
            <select value={clientId} onChange={e => setClientId(e.target.value)}
              className="bg-[#EEF3FA] border border-[#CBD5E1] rounded-lg px-3 py-2 text-[#0B1220] text-sm focus:outline-none focus:border-[#1A73E8]">
              <option value="">All Clients</option>
              {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs text-[#4B4F58] mb-1">Carrier</label>
            <select value={carrier} onChange={e => setCarrier(e.target.value)}
              className="bg-[#EEF3FA] border border-[#CBD5E1] rounded-lg px-3 py-2 text-[#0B1220] text-sm focus:outline-none focus:border-[#1A73E8]">
              <option value="">All Carriers</option>
              {carriers.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs text-[#4B4F58] mb-1">Search</label>
            <input type="text" placeholder="Order #, tracking, client…" value={search} onChange={e => setSearch(e.target.value)}
              className="bg-[#EEF3FA] border border-[#CBD5E1] rounded-lg px-3 py-2 text-[#0B1220] text-sm focus:outline-none focus:border-[#1A73E8] w-52" />
          </div>
          <button
            onClick={() => setLossOnly(v => !v)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition ${lossOnly ? 'bg-red-700 text-[#0B1220]' : 'bg-[#EEF3FA] text-[#4B4F58] hover:text-[#0B1220]'}`}
          >
            ⚠️ Losses Only
          </button>
          <button onClick={() => { setDateFrom(monthStart); setDateTo(today); setClientId(''); setCarrier(''); setLossOnly(false); setSearch(''); setActiveQuick('This Month') }}
            className="px-3 py-2 rounded-lg text-xs text-[#6B7A8D] hover:text-[#0B1220] bg-[#EEF3FA] hover:bg-[#DDE6F2] transition">
            Clear
          </button>
        </div>
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-4 gap-3">
        <div className="bg-white rounded-xl px-4 py-3">
          <p className="text-xs text-[#4B4F58]">Shipments</p>
          <p className="text-xl font-bold text-[#0B1220]">{filtered.length}</p>
        </div>
        <div className="bg-white rounded-xl px-4 py-3">
          <p className="text-xs text-[#4B4F58]">We Paid (Carrier)</p>
          <p className="text-xl font-bold text-[#0B1220]">{fig(known.cost)}</p>
        </div>
        <div className="bg-white rounded-xl px-4 py-3">
          <p className="text-xs text-[#4B4F58]">Charged Clients</p>
          <p className="text-xl font-bold text-[#0B1220]">{fig(known.revenue)}</p>
        </div>
        <div className={`rounded-xl px-4 py-3 ${known.profit !== null && !plPositive ? 'bg-red-50 border border-red-200' : 'bg-white'}`}>
          <p className="text-xs text-[#4B4F58]">Net P / L {lossCount > 0 && <span className="text-red-700 ml-1">· {lossCount} losses</span>}</p>
          <p className={`text-xl font-bold ${known.profit === null ? 'text-[#4B4F58]' : plPositive ? 'text-emerald-700' : 'text-red-700'}`}>
            {plFigure}
          </p>
        </div>
      </div>

      {/* One line under the cards naming the rows all three figures leave out,
          and why. The three cards are a subtraction now, which is only honest
          if what the subtraction excludes is visible beside it. '' when it
          excludes nothing -- a permanent all-clear is how a real warning stops
          being read. */}
      {marginNote && (
        <p className="text-xs text-amber-700 px-1">⚠ {marginNote}</p>
      )}

      {/* Table */}
      <div className="bg-white rounded-xl overflow-hidden">
        <div className="overflow-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[#4B4F58] text-left border-b border-[#E2E8F0] text-xs uppercase tracking-wider sticky top-0 bg-[#F1F5FB]">
                <th className="px-5 py-3">Order #</th>
                <th className="px-4 py-3">Client</th>
                <th className="px-4 py-3">Ship Date</th>
                <th className="px-4 py-3">Carrier / Service</th>
                <th className="px-4 py-3">Tracking</th>
                <th className="px-4 py-3 text-right">Dimensions (in)</th>
                <th className="px-4 py-3 text-right">Act. Wt (oz)</th>
                <th className="px-4 py-3 text-right">Dim. Wt (oz)</th>
                <th className="px-4 py-3 text-right">Bill. Wt (oz)</th>
                <th className="px-4 py-3 text-right">We Paid</th>
                <th className="px-4 py-3 text-right">Charged</th>
                <th className="px-4 py-3 text-right">P / L</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={12} className="px-5 py-12 text-center text-[#6B7A8D]">No shipments match the current filters</td>
                </tr>
              ) : filtered.map((s: any) => (
                <tr key={s.id ?? s.order_number} className={`border-b border-[#E2E8F0]/40 hover:bg-[#EEF3FA]/30 ${s.is_loss ? 'bg-red-50' : ''}`}>
                  <td className="px-5 py-2.5 font-mono text-xs text-[#3A4658]">{s.order_number}</td>
                  <td className="px-4 py-2.5 font-medium text-sm">{s.clients?.name ?? <span className="text-[#6B7A8D]">Unassigned</span>}</td>
                  <td className="px-4 py-2.5 text-[#4B4F58] text-xs whitespace-nowrap">{s.ship_date ? new Date(s.ship_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'}</td>
                  <td className="px-4 py-2.5 text-[#3A4658] text-xs whitespace-nowrap">{[s.carrier, s.service].filter(Boolean).join(' · ') || '—'}</td>
                  <td className="px-4 py-2.5 font-mono text-xs text-[#6B7A8D]">{s.tracking_number ?? '—'}</td>
                  <td className="px-4 py-2.5 text-right text-xs text-[#3A4658]">
                    {s.length && s.width && s.height ? `${s.length}×${s.width}×${s.height}` : '—'}
                  </td>
                  <td className="px-4 py-2.5 text-right text-xs text-[#3A4658]">{s.weight ? `${s.weight}` : '—'}</td>
                  <td className={`px-4 py-2.5 text-right text-xs font-medium ${s.dim_weight > s.weight ? 'text-amber-700' : 'text-[#4B4F58]'}`}>
                    {s.dim_weight ? `${s.dim_weight}` : '—'}
                  </td>
                  <td className="px-4 py-2.5 text-right text-xs font-semibold text-[#1A73E8]">{s.billed_weight ? `${s.billed_weight}` : '—'}</td>
                  <td className="px-4 py-2.5 text-right">{formatPrice(s.actual_cost)}</td>
                  <td className={`px-4 py-2.5 text-right ${isPriced(s.client_rate) ? '' : 'text-amber-700'}`}
                      title={isPriced(s.client_rate) ? undefined : 'No rate-card rate covers this shipment'}>
                    {formatPrice(s.client_rate)}
                  </td>
                  {/* Gray, not green, when the profit is UNKNOWN: `is_loss` is false
                      for an unpriced shipment, so the old ternary painted the
                      dash with the same green as a real profit. */}
                  <td className={`px-4 py-2.5 text-right font-bold ${
                    !isPriced(s.profit_loss) ? 'text-[#6B7A8D]'
                      : s.is_loss ? 'text-red-700' : 'text-emerald-700'
                  }`}>
                    {formatSignedPrice(s.profit_loss)}
                  </td>
                </tr>
              ))}
            </tbody>
            {filtered.length > 0 && (
              <tfoot>
                <tr className="border-t border-[#CBD5E1] font-semibold bg-[#F1F5FB]/50">
                  {/* One note on the label cell, not three different ones on
                      three cells. The three totals come off one reconciliation
                      now, so they are short by exactly the same rows and
                      `exclusionNote` says which rows and why. */}
                  <td colSpan={9} className="px-5 py-3 text-[#4B4F58] text-sm">
                    Total ({margin.reconciled} of {filtered.length} shipments)
                    {marginNote && (
                      <span className="ml-2 text-amber-700 font-normal">⚠ {marginNote}</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">{fig(known.cost)}</td>
                  <td className="px-4 py-3 text-right">{fig(known.revenue)}</td>
                  <td className={`px-4 py-3 text-right ${known.profit === null ? 'text-[#4B4F58]' : plPositive ? 'text-emerald-700' : 'text-red-700'}`}>
                    {plFigure}
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
    </div>
  )
}
