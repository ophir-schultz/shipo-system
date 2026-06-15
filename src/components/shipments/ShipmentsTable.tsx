'use client'

import { useState, useMemo } from 'react'

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

  const totalPaid = filtered.reduce((s, r) => s + (r.actual_cost ?? 0), 0)
  const totalCharged = filtered.reduce((s, r) => s + (r.client_rate ?? 0), 0)
  const totalPL = filtered.reduce((s, r) => s + (r.profit_loss ?? 0), 0)
  const lossCount = filtered.filter(s => s.is_loss).length

  return (
    <div className="space-y-4">
      {/* Filter bar */}
      <div className="bg-gray-800 rounded-xl p-4 space-y-3">
        {/* Quick date ranges */}
        <div className="flex flex-wrap gap-2">
          {QUICK_RANGES.map(r => (
            <button
              key={r.label}
              onClick={() => applyQuick(r.label, r.days)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition ${
                activeQuick === r.label ? 'text-white' : 'bg-gray-700 text-gray-400 hover:text-white'
              }`}
              style={activeQuick === r.label ? { background: '#00AAFF' } : {}}
            >
              {r.label}
            </button>
          ))}
        </div>

        {/* Filter inputs */}
        <div className="flex flex-wrap gap-3 items-end">
          <div>
            <label className="block text-xs text-gray-400 mb-1">From</label>
            <input type="date" value={dateFrom} onChange={e => { setDateFrom(e.target.value); setActiveQuick('') }}
              className="bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-[#00AAFF]" />
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">To</label>
            <input type="date" value={dateTo} onChange={e => { setDateTo(e.target.value); setActiveQuick('') }}
              className="bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-[#00AAFF]" />
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">Client</label>
            <select value={clientId} onChange={e => setClientId(e.target.value)}
              className="bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-[#00AAFF]">
              <option value="">All Clients</option>
              {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">Carrier</label>
            <select value={carrier} onChange={e => setCarrier(e.target.value)}
              className="bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-[#00AAFF]">
              <option value="">All Carriers</option>
              {carriers.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">Search</label>
            <input type="text" placeholder="Order #, tracking, client…" value={search} onChange={e => setSearch(e.target.value)}
              className="bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-[#00AAFF] w-52" />
          </div>
          <button
            onClick={() => setLossOnly(v => !v)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition ${lossOnly ? 'bg-red-700 text-white' : 'bg-gray-700 text-gray-400 hover:text-white'}`}
          >
            ⚠️ Losses Only
          </button>
          <button onClick={() => { setDateFrom(monthStart); setDateTo(today); setClientId(''); setCarrier(''); setLossOnly(false); setSearch(''); setActiveQuick('This Month') }}
            className="px-3 py-2 rounded-lg text-xs text-gray-500 hover:text-white bg-gray-700 hover:bg-gray-600 transition">
            Clear
          </button>
        </div>
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-4 gap-3">
        <div className="bg-gray-800 rounded-xl px-4 py-3">
          <p className="text-xs text-gray-400">Shipments</p>
          <p className="text-xl font-bold text-white">{filtered.length}</p>
        </div>
        <div className="bg-gray-800 rounded-xl px-4 py-3">
          <p className="text-xs text-gray-400">We Paid (Carrier)</p>
          <p className="text-xl font-bold text-white">${totalPaid.toFixed(2)}</p>
        </div>
        <div className="bg-gray-800 rounded-xl px-4 py-3">
          <p className="text-xs text-gray-400">Charged Clients</p>
          <p className="text-xl font-bold text-white">${totalCharged.toFixed(2)}</p>
        </div>
        <div className={`rounded-xl px-4 py-3 ${totalPL >= 0 ? 'bg-gray-800' : 'bg-red-950/40 border border-red-800/40'}`}>
          <p className="text-xs text-gray-400">Net P / L {lossCount > 0 && <span className="text-red-400 ml-1">· {lossCount} losses</span>}</p>
          <p className={`text-xl font-bold ${totalPL >= 0 ? 'text-green-400' : 'text-red-400'}`}>
            {totalPL >= 0 ? '+' : ''}${totalPL.toFixed(2)}
          </p>
        </div>
      </div>

      {/* Table */}
      <div className="bg-gray-800 rounded-xl overflow-hidden">
        <div className="overflow-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-gray-400 text-left border-b border-gray-700 text-xs uppercase tracking-wider sticky top-0 bg-gray-900">
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
                  <td colSpan={12} className="px-5 py-12 text-center text-gray-500">No shipments match the current filters</td>
                </tr>
              ) : filtered.map((s: any) => (
                <tr key={s.id ?? s.order_number} className={`border-b border-gray-700/40 hover:bg-gray-700/30 ${s.is_loss ? 'bg-red-950/10' : ''}`}>
                  <td className="px-5 py-2.5 font-mono text-xs text-gray-300">{s.order_number}</td>
                  <td className="px-4 py-2.5 font-medium text-sm">{s.clients?.name ?? <span className="text-gray-500">Unassigned</span>}</td>
                  <td className="px-4 py-2.5 text-gray-400 text-xs whitespace-nowrap">{s.ship_date ? new Date(s.ship_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'}</td>
                  <td className="px-4 py-2.5 text-gray-300 text-xs whitespace-nowrap">{[s.carrier, s.service].filter(Boolean).join(' · ') || '—'}</td>
                  <td className="px-4 py-2.5 font-mono text-xs text-gray-500">{s.tracking_number ?? '—'}</td>
                  <td className="px-4 py-2.5 text-right text-xs text-gray-300">
                    {s.length && s.width && s.height ? `${s.length}×${s.width}×${s.height}` : '—'}
                  </td>
                  <td className="px-4 py-2.5 text-right text-xs text-gray-300">{s.weight ? `${s.weight}` : '—'}</td>
                  <td className={`px-4 py-2.5 text-right text-xs font-medium ${s.dim_weight > s.weight ? 'text-orange-400' : 'text-gray-400'}`}>
                    {s.dim_weight ? `${s.dim_weight}` : '—'}
                  </td>
                  <td className="px-4 py-2.5 text-right text-xs font-semibold text-[#00AAFF]">{s.billed_weight ? `${s.billed_weight}` : '—'}</td>
                  <td className="px-4 py-2.5 text-right">${(s.actual_cost ?? 0).toFixed(2)}</td>
                  <td className="px-4 py-2.5 text-right">${(s.client_rate ?? 0).toFixed(2)}</td>
                  <td className={`px-4 py-2.5 text-right font-bold ${s.is_loss ? 'text-red-400' : 'text-green-400'}`}>
                    {(s.profit_loss ?? 0) >= 0 ? '+' : ''}${(s.profit_loss ?? 0).toFixed(2)}
                  </td>
                </tr>
              ))}
            </tbody>
            {filtered.length > 0 && (
              <tfoot>
                <tr className="border-t border-gray-600 font-semibold bg-gray-900/50">
                  <td colSpan={9} className="px-5 py-3 text-gray-400 text-sm">Total ({filtered.length} shipments)</td>
                  <td className="px-4 py-3 text-right">${totalPaid.toFixed(2)}</td>
                  <td className="px-4 py-3 text-right">${totalCharged.toFixed(2)}</td>
                  <td className={`px-4 py-3 text-right ${totalPL >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                    {totalPL >= 0 ? '+' : ''}${totalPL.toFixed(2)}
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
