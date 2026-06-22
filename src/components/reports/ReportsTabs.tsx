'use client'

import { useState } from 'react'
import { showError, showSuccess } from '@/components/ui/Toast'

const TABS = [
  { id: 'shipments', label: 'Shipments', icon: '🚚' },
  { id: 'loss', label: 'Losses', icon: '⚠️' },
  { id: 'adjustments', label: 'Adjustments', icon: '🔔' },
  { id: 'billing', label: 'Billing', icon: '💰' },
  { id: 'warehouse', label: 'Warehouse', icon: '📦' },
]

export default function ReportsTabs({ data }: { data: any }) {
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
            {data.clients.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
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
        {activeTab === 'loss' && <LossTable rows={data.lossShipments} clientId={clientId} dateFrom={dateFrom} dateTo={dateTo} clients={data.clients} />}
        {activeTab === 'adjustments' && <AdjustmentsTable rows={data.adjustments} clientId={clientId} dateFrom={dateFrom} dateTo={dateTo} clients={data.clients} />}
        {activeTab === 'billing' && <BillingTable rows={data.bills} clientId={clientId} dateFrom={dateFrom} dateTo={dateTo} clients={data.clients} />}
        {activeTab === 'warehouse' && <WarehouseTable rows={data.warehouse} clientId={clientId} dateFrom={dateFrom} dateTo={dateTo} clients={data.clients} />}
      </div>
    </div>
  )
}

function filterRows(rows: any[], clientId: string, dateFrom: string, dateTo: string, dateKey: string, clientKey = 'client_id') {
  return rows.filter(r => {
    const d = r[dateKey]?.split('T')[0]
    if (dateFrom && d && d < dateFrom) return false
    if (dateTo && d && d > dateTo) return false
    return true
  })
}

function Empty({ msg }: { msg: string }) {
  return <div className="px-6 py-12 text-center text-gray-500 text-sm">{msg}</div>
}

function ShipmentsTable({ rows, clientId, dateFrom, dateTo }: any) {
  const filtered = filterRows(rows, clientId, dateFrom, dateTo, 'ship_date')
  const totalPaid = filtered.reduce((s: number, r: any) => s + (r.actual_cost ?? 0), 0)
  const totalCharged = filtered.reduce((s: number, r: any) => s + (r.client_rate ?? 0), 0)
  const totalPL = filtered.reduce((s: number, r: any) => s + (r.profit_loss ?? 0), 0)

  return (
    <>
      <div className="grid grid-cols-4 divide-x divide-gray-700 border-b border-gray-700">
        {[['Shipments', filtered.length], ['We Paid', `$${totalPaid.toFixed(2)}`], ['Charged', `$${totalCharged.toFixed(2)}`], ['Net P/L', `${totalPL >= 0 ? '+' : ''}$${totalPL.toFixed(2)}`]].map(([l, v]) => (
          <div key={l} className="px-5 py-3">
            <p className="text-xs text-gray-400">{l}</p>
            <p className={`font-bold text-lg ${l === 'Net P/L' ? (totalPL >= 0 ? 'text-green-400' : 'text-red-400') : 'text-white'}`}>{v}</p>
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
            {filtered.length === 0 ? <tr><td colSpan={8}><Empty msg="No shipments in this range" /></td></tr> : filtered.map((s: any) => (
              <tr key={s.order_number} className={`border-b border-gray-700/40 hover:bg-gray-700/30 ${s.is_loss ? 'bg-red-950/10' : ''}`}>
                <td className="px-5 py-2.5 font-mono text-xs text-gray-300">{s.order_number}</td>
                <td className="px-4 py-2.5">{s.clients?.name ?? <span className="text-gray-500">—</span>}</td>
                <td className="px-4 py-2.5 text-gray-400 text-xs">{s.ship_date ? new Date(s.ship_date).toLocaleDateString() : '—'}</td>
                <td className="px-4 py-2.5 text-gray-300 text-xs">{[s.carrier, s.service].filter(Boolean).join(' · ') || '—'}</td>
                <td className="px-4 py-2.5 font-mono text-xs text-gray-500">{s.tracking_number ?? '—'}</td>
                <td className="px-4 py-2.5 text-right">${(s.actual_cost ?? 0).toFixed(2)}</td>
                <td className="px-4 py-2.5 text-right">${(s.client_rate ?? 0).toFixed(2)}</td>
                <td className={`px-4 py-2.5 text-right font-semibold ${s.is_loss ? 'text-red-400' : 'text-green-400'}`}>
                  {(s.profit_loss ?? 0) >= 0 ? '+' : ''}${(s.profit_loss ?? 0).toFixed(2)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

function LossTable({ rows, clientId, dateFrom, dateTo }: any) {
  const filtered = filterRows(rows, clientId, dateFrom, dateTo, 'ship_date')
  const total = Math.abs(filtered.reduce((s: number, r: any) => s + (r.profit_loss ?? 0), 0))
  return (
    <>
      <div className="grid grid-cols-3 divide-x divide-gray-700 border-b border-gray-700" style={{ background: '#1a0a0a' }}>
        {[['Loss Shipments', filtered.length], ['Total Lost', `-$${total.toFixed(2)}`], ['Avg Loss', filtered.length ? `-$${(total / filtered.length).toFixed(2)}` : '$0.00']].map(([l, v]) => (
          <div key={l} className="px-5 py-3">
            <p className="text-xs text-red-400/70">{l}</p>
            <p className="font-bold text-lg text-red-400">{v}</p>
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
            {filtered.length === 0 ? <tr><td colSpan={7}><Empty msg="✓ No loss shipments in this range" /></td></tr> : filtered.map((s: any) => (
              <tr key={s.order_number} className="border-b border-gray-700/40 hover:bg-red-950/20">
                <td className="px-5 py-2.5 font-mono text-xs text-gray-300">{s.order_number}</td>
                <td className="px-4 py-2.5">{s.clients?.name ?? '—'}</td>
                <td className="px-4 py-2.5 text-gray-400 text-xs">{s.ship_date ? new Date(s.ship_date).toLocaleDateString() : '—'}</td>
                <td className="px-4 py-2.5 text-gray-300 text-xs">{[s.carrier, s.service].filter(Boolean).join(' · ') || '—'}</td>
                <td className="px-4 py-2.5 text-right">${(s.actual_cost ?? 0).toFixed(2)}</td>
                <td className="px-4 py-2.5 text-right">${(s.client_rate ?? 0).toFixed(2)}</td>
                <td className="px-4 py-2.5 text-right font-bold text-red-400">-${Math.abs(s.profit_loss ?? 0).toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

function AdjustmentsTable({ rows, clientId, dateFrom, dateTo }: any) {
  const filtered = filterRows(rows, clientId, dateFrom, dateTo, 'adjustment_date')
  const pending = filtered.filter((r: any) => r.status === 'pending')
  const pendingTotal = pending.reduce((s: number, r: any) => s + (r.adjustment_amount ?? 0), 0)
  const statusBadge = (s: string) => s === 'pending'
    ? 'bg-orange-900/60 text-orange-300'
    : s === 'charged' ? 'bg-green-900/60 text-green-300' : 'bg-gray-700 text-gray-400'

  return (
    <>
      <div className="grid grid-cols-3 divide-x divide-gray-700 border-b border-gray-700">
        {[['Total', filtered.length], ['Pending', pending.length], ['To Recover', `+$${pendingTotal.toFixed(2)}`]].map(([l, v]) => (
          <div key={l} className="px-5 py-3">
            <p className="text-xs text-gray-400">{l}</p>
            <p className={`font-bold text-lg ${l === 'To Recover' ? 'text-orange-400' : 'text-white'}`}>{v}</p>
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
            {filtered.length === 0 ? <tr><td colSpan={8}><Empty msg="No adjustments in this range" /></td></tr> : filtered.map((a: any, i: number) => (
              <tr key={i} className="border-b border-gray-700/40 hover:bg-gray-700/30">
                <td className="px-5 py-2.5 font-mono text-xs text-gray-300">{a.order_number}</td>
                <td className="px-4 py-2.5">{a.clients?.name ?? '—'}</td>
                <td className="px-4 py-2.5 text-gray-300 text-xs">{a.reason ?? 'Carrier reweigh'}</td>
                <td className="px-4 py-2.5 text-gray-400 text-xs">{a.adjustment_date ? new Date(a.adjustment_date).toLocaleDateString() : '—'}</td>
                <td className="px-4 py-2.5 text-right text-gray-400">{a.original_cost != null ? `$${a.original_cost.toFixed(2)}` : '—'}</td>
                <td className="px-4 py-2.5 text-right text-gray-400">{a.new_cost != null ? `$${a.new_cost.toFixed(2)}` : '—'}</td>
                <td className="px-4 py-2.5 text-right font-bold text-orange-400">+${(a.adjustment_amount ?? 0).toFixed(2)}</td>
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

function BillingTable({ rows, clientId, dateFrom, dateTo }: any) {
  const filtered = filterRows(rows, clientId, dateFrom, dateTo, 'week_start')
  const totalBilled = filtered.reduce((s: number, r: any) => s + (r.grand_total ?? 0), 0)
  const statusBadge = (s: string) => s === 'paid' ? 'bg-green-900/60 text-green-300' : s === 'sent' ? 'bg-[#00AAFF]/10 text-[#00AAFF]' : 'bg-gray-700 text-gray-400'

  return (
    <>
      <div className="grid grid-cols-3 divide-x divide-gray-700 border-b border-gray-700">
        {[['Bills', filtered.length], ['Total Billed', `$${totalBilled.toFixed(2)}`], ['Paid', filtered.filter((r: any) => r.status === 'paid').length]].map(([l, v]) => (
          <div key={l} className="px-5 py-3">
            <p className="text-xs text-gray-400">{l}</p>
            <p className="font-bold text-lg text-white">{v}</p>
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
            {filtered.length === 0 ? <tr><td colSpan={8}><Empty msg="No bills in this range" /></td></tr> : filtered.map((b: any, i: number) => (
              <tr key={i} className="border-b border-gray-700/40 hover:bg-gray-700/30">
                <td className="px-5 py-2.5 font-medium">{b.clients?.name ?? '—'}</td>
                <td className="px-4 py-2.5 text-gray-400 text-xs">{b.week_start} → {b.week_end}</td>
                <td className="px-4 py-2.5 text-right text-gray-300">${(b.shipping_total ?? 0).toFixed(2)}</td>
                <td className="px-4 py-2.5 text-right text-gray-300">${(b.warehouse_total ?? 0).toFixed(2)}</td>
                <td className="px-4 py-2.5 text-right text-gray-300">${(b.adjustments_total ?? 0).toFixed(2)}</td>
                <td className="px-4 py-2.5 text-right text-gray-300">${(b.manual_total ?? 0).toFixed(2)}</td>
                <td className="px-4 py-2.5 text-right font-bold">${(b.grand_total ?? 0).toFixed(2)}</td>
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

function WarehouseTable({ rows, clientId, dateFrom, dateTo }: any) {
  const filtered = filterRows(rows, clientId, dateFrom, dateTo, 'log_date')
  const totalRevenue = filtered.reduce((s: number, r: any) => s + (r.total ?? 0), 0)

  return (
    <>
      <div className="grid grid-cols-3 divide-x divide-gray-700 border-b border-gray-700">
        {[['Entries', filtered.length], ['Total Revenue', `$${totalRevenue.toFixed(2)}`], ['Unique Days', new Set(filtered.map((r: any) => r.log_date)).size]].map(([l, v]) => (
          <div key={l} className="px-5 py-3">
            <p className="text-xs text-gray-400">{l}</p>
            <p className="font-bold text-lg text-white">{v}</p>
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
            {filtered.length === 0 ? <tr><td colSpan={7}><Empty msg="No warehouse activity in this range" /></td></tr> : filtered.map((w: any, i: number) => (
              <tr key={i} className="border-b border-gray-700/40 hover:bg-gray-700/30">
                <td className="px-5 py-2.5 text-gray-400 text-xs">{w.log_date ? new Date(w.log_date + 'T12:00:00').toLocaleDateString() : '—'}</td>
                <td className="px-4 py-2.5 font-medium">{w.clients?.name ?? '—'}</td>
                <td className="px-4 py-2.5 text-gray-300 capitalize">{w.service_type?.replace(/_/g, ' ') ?? '—'}</td>
                <td className="px-4 py-2.5 text-right">{w.quantity}</td>
                <td className="px-4 py-2.5 text-right text-gray-400">${(w.rate ?? 0).toFixed(2)}</td>
                <td className="px-4 py-2.5 text-right font-semibold text-green-400">${(w.total ?? 0).toFixed(2)}</td>
                <td className="px-4 py-2.5 text-gray-500 text-xs">{w.notes ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}
