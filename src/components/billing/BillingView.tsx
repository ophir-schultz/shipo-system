'use client'

import { useState } from 'react'
import { downloadBillingExcel, downloadBillingPDF } from '@/lib/billing/download'

export default function BillingView({ data }: { data: any }) {
  const [selectedClient, setSelectedClient] = useState<string>(data.clients[0]?.id ?? '')
  const [dateFrom, setDateFrom] = useState(data.defaultFrom)
  const [dateTo, setDateTo] = useState(data.defaultTo)
  const [activeTab, setActiveTab] = useState<'shipments' | 'warehouse' | 'adjustments' | 'bills'>('shipments')

  const client = data.clients.find((c: any) => c.id === selectedClient)

  const shipments = data.shipments.filter((s: any) => {
    if (s.client_id !== selectedClient) return false
    const d = s.ship_date?.split('T')[0]
    return (!dateFrom || d >= dateFrom) && (!dateTo || d <= dateTo)
  })

  const warehouse = data.warehouse.filter((w: any) => {
    if (w.client_id !== selectedClient) return false
    return (!dateFrom || w.log_date >= dateFrom) && (!dateTo || w.log_date <= dateTo)
  })

  const adjustments = data.adjustments.filter((a: any) => {
    if (a.client_id !== selectedClient) return false
    const d = a.adjustment_date?.split('T')[0]
    return (!dateFrom || d >= dateFrom) && (!dateTo || d <= dateTo)
  })

  const bills = data.bills.filter((b: any) => {
    if (b.client_id !== selectedClient) return false
    return (!dateFrom || b.week_start >= dateFrom) && (!dateTo || b.week_end <= dateTo)
  })

  const shippingRevenue = shipments.reduce((s: number, r: any) => s + (r.client_rate ?? 0), 0)
  const shippingCost = shipments.reduce((s: number, r: any) => s + (r.actual_cost ?? 0), 0)
  const warehouseTotal = warehouse.reduce((s: number, r: any) => s + (r.total ?? 0), 0)
  const pendingAdj = adjustments.filter((a: any) => a.status === 'pending').reduce((s: number, r: any) => s + (r.adjustment_amount ?? 0), 0)
  const grandTotal = shippingRevenue + warehouseTotal + pendingAdj
  const lossCount = shipments.filter((s: any) => s.is_loss).length

  const [dlLoading, setDlLoading] = useState<'excel' | 'pdf' | null>(null)

  const dlArgs = {
    clientName: client?.name ?? 'client',
    dateFrom, dateTo,
    shipments, warehouse, adjustments, bills,
    shippingRevenue, shippingCost, warehouseTotal, pendingAdj, grandTotal,
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

  const tabs = [
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
            {data.clients.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
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

      {/* Client summary cards */}
      {client && (
        <div className="grid grid-cols-5 gap-3">
          <SummaryCard label="Shipping Revenue" value={`$${shippingRevenue.toFixed(2)}`} sub={`Cost: $${shippingCost.toFixed(2)}`} color="blue" />
          <SummaryCard label="Warehouse Charges" value={`$${warehouseTotal.toFixed(2)}`} sub={`${warehouse.length} entries`} color="gray" />
          <SummaryCard label="Pending Adjustments" value={`+$${pendingAdj.toFixed(2)}`} sub={`${adjustments.filter((a: any) => a.status === 'pending').length} pending`} color="orange" />
          <SummaryCard label="Total to Bill" value={`$${grandTotal.toFixed(2)}`} sub="Shipping + WH + Adj" color="green" />
          <SummaryCard label="Loss Shipments" value={lossCount.toString()} sub={lossCount > 0 ? '⚠️ Needs review' : '✓ All profitable'} color={lossCount > 0 ? 'red' : 'gray'} />
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 bg-gray-900 rounded-xl p-1">
        {tabs.map(tab => (
          <button key={tab.id} onClick={() => setActiveTab(tab.id as any)}
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
                    : shipments.map((s: any) => (
                      <tr key={s.order_number} className={`border-b border-gray-700/40 hover:bg-gray-700/30 ${s.is_loss ? 'bg-red-950/10' : ''}`}>
                        <td className="px-5 py-2.5 font-mono text-xs text-gray-300">{s.order_number}</td>
                        <td className="px-4 py-2.5 text-gray-400 text-xs">{s.ship_date ? new Date(s.ship_date).toLocaleDateString() : '—'}</td>
                        <td className="px-4 py-2.5 text-gray-300 text-xs">{[s.carrier, s.service].filter(Boolean).join(' · ') || '—'}</td>
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
        )}

        {activeTab === 'warehouse' && (
          <>
            <div className="grid grid-cols-3 divide-x divide-gray-700 border-b border-gray-700">
              <Stat label="Entries" value={warehouse.length} />
              <Stat label="Total Charges" value={`$${warehouseTotal.toFixed(2)}`} />
              <Stat label="Unique Days" value={new Set(warehouse.map((w: any) => w.log_date)).size} />
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
                    : warehouse.map((w: any, i: number) => (
                      <tr key={i} className="border-b border-gray-700/40 hover:bg-gray-700/30">
                        <td className="px-5 py-2.5 text-gray-400 text-xs">{w.log_date ? new Date(w.log_date + 'T12:00:00').toLocaleDateString() : '—'}</td>
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
        )}

        {activeTab === 'adjustments' && (
          <>
            <div className="grid grid-cols-3 divide-x divide-gray-700 border-b border-gray-700">
              <Stat label="Total Adjustments" value={adjustments.length} />
              <Stat label="Pending" value={`+$${pendingAdj.toFixed(2)}`} color="orange" />
              <Stat label="Resolved" value={adjustments.filter((a: any) => a.status !== 'pending').length} />
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
                    : adjustments.map((a: any, i: number) => (
                      <tr key={i} className="border-b border-gray-700/40 hover:bg-gray-700/30">
                        <td className="px-5 py-2.5 font-mono text-xs text-gray-300">{a.order_number}</td>
                        <td className="px-4 py-2.5 text-gray-300 text-xs">{a.reason ?? 'Carrier reweigh'}</td>
                        <td className="px-4 py-2.5 text-gray-400 text-xs">{a.adjustment_date ? new Date(a.adjustment_date).toLocaleDateString() : '—'}</td>
                        <td className="px-4 py-2.5 text-right font-semibold text-orange-400">+${(a.adjustment_amount ?? 0).toFixed(2)}</td>
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
              <Stat label="Total Billed" value={`$${bills.reduce((s: number, b: any) => s + (b.grand_total ?? 0), 0).toFixed(2)}`} />
              <Stat label="Paid" value={bills.filter((b: any) => b.status === 'paid').length} color="green" />
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
                    : bills.map((b: any, i: number) => (
                      <tr key={i} className="border-b border-gray-700/40 hover:bg-gray-700/30">
                        <td className="px-5 py-2.5 text-gray-400 text-xs">{b.week_start} → {b.week_end}</td>
                        <td className="px-4 py-2.5 text-right text-gray-300">${(b.shipping_total ?? 0).toFixed(2)}</td>
                        <td className="px-4 py-2.5 text-right text-gray-300">${(b.warehouse_total ?? 0).toFixed(2)}</td>
                        <td className="px-4 py-2.5 text-right text-gray-300">${(b.adjustments_total ?? 0).toFixed(2)}</td>
                        <td className="px-4 py-2.5 text-right text-gray-300">${(b.manual_total ?? 0).toFixed(2)}</td>
                        <td className="px-4 py-2.5 text-right font-bold">${(b.grand_total ?? 0).toFixed(2)}</td>
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

function Stat({ label, value, color }: { label: string; value: any; color?: string }) {
  return (
    <div className="px-5 py-3">
      <p className="text-xs text-gray-400">{label}</p>
      <p className={`font-bold text-lg ${color === 'green' ? 'text-green-400' : color === 'red' ? 'text-red-400' : color === 'orange' ? 'text-orange-400' : 'text-white'}`}>{value}</p>
    </div>
  )
}
