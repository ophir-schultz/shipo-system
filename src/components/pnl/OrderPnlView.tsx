'use client'

import { useMemo, useState } from 'react'
import { rollupClients, type OrderProfit } from '@/lib/pricing/order-profit'
import { SHIP_DATE_FILTER_NOTE } from '@/lib/billing/ship-day-label'

const fmt = (n: number | null) => (n === null ? '—' : `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(2)}`)

export default function OrderPnlView({ orders }: { orders: OrderProfit[] }) {
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [clientId, setClientId] = useState('')

  const filteredOrders = useMemo(() => orders.filter((order) => {
    if (clientId && (order.clientId ?? '') !== clientId) return false
    if (!order.shipDate) return !dateFrom && !dateTo
    if (dateFrom && order.shipDate < dateFrom) return false
    if (dateTo && order.shipDate > dateTo) return false
    return true
  }), [orders, dateFrom, dateTo, clientId])

  const filteredClients = useMemo(() => rollupClients(filteredOrders), [filteredOrders])
  const clientIds = [...new Map(orders.map((order) => [order.clientId ?? '', order.clientName])).entries()]

  return (
    <div className="space-y-6">
      <p className="text-[11px] text-[#6B7A8D]">{SHIP_DATE_FILTER_NOTE}</p>
      <div className="bg-white rounded-xl p-5">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <label className="text-xs text-[#4B4F58]">
            From
            <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="mt-1 w-full bg-[#EEF3FA] border border-[#CBD5E1] rounded-lg px-3 py-2 text-sm" />
          </label>
          <label className="text-xs text-[#4B4F58]">
            To
            <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="mt-1 w-full bg-[#EEF3FA] border border-[#CBD5E1] rounded-lg px-3 py-2 text-sm" />
          </label>
          <label className="text-xs text-[#4B4F58] col-span-2">
            Client
            <select value={clientId} onChange={(e) => setClientId(e.target.value)} className="mt-1 w-full bg-[#EEF3FA] border border-[#CBD5E1] rounded-lg px-3 py-2 text-sm">
              <option value="">All clients</option>
              {clientIds.map(([id, name]) => (
                <option key={id || 'unassigned'} value={id}>{name}</option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <div className="bg-white rounded-xl p-5 overflow-x-auto">
        <h3 className="font-semibold text-[#0B1220] mb-3">Per client</h3>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[#4B4F58] text-left border-b border-[#E2E8F0] text-xs uppercase">
              <th className="pb-2 pr-3">Client</th>
              <th className="pb-2 pr-3 text-right">Orders</th>
              <th className="pb-2 pr-3 text-right">Client price</th>
              <th className="pb-2 pr-3 text-right">ShipStation cost</th>
              <th className="pb-2 text-right">Profit / loss</th>
            </tr>
          </thead>
          <tbody>
            {filteredClients.map((client) => (
              <tr key={client.clientId ?? 'unassigned'} className="border-b border-[#E2E8F0]/40">
                <td className="py-2.5 pr-3 text-[#0B1220]">
                  {client.clientName}
                  {client.unpricedOrders > 0 && (
                    <span className="block text-amber-700 text-xs">
                      {client.unpricedOrders} order{client.unpricedOrders === 1 ? '' : 's'} missing a price or a cost, not in these totals
                    </span>
                  )}
                </td>
                <td className="py-2.5 pr-3 text-right text-[#4B4F58]">{client.orders}</td>
                <td className="py-2.5 pr-3 text-right text-[#3A4658]">{fmt(client.clientPrice)}</td>
                <td className="py-2.5 pr-3 text-right text-[#3A4658]">{fmt(client.shipstationCost)}</td>
                <td className={`py-2.5 text-right font-medium ${client.profit === null ? 'text-[#6B7A8D]' : client.profit >= 0 ? 'text-emerald-700' : 'text-red-700'}`}>{fmt(client.profit)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="bg-white rounded-xl p-5 overflow-x-auto">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-semibold text-[#0B1220]">Per order</h3>
          <span className="text-xs text-[#6B7A8D]">{filteredOrders.length} orders</span>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[#4B4F58] text-left border-b border-[#E2E8F0] text-xs uppercase">
              <th className="pb-2 pr-3">Ship date</th>
              <th className="pb-2 pr-3">Order #</th>
              <th className="pb-2 pr-3">Client</th>
              <th className="pb-2 pr-3 text-right">Boxes</th>
              <th className="pb-2 pr-3 text-right">Client price</th>
              <th className="pb-2 pr-3 text-right">ShipStation cost</th>
              <th className="pb-2 text-right">Profit / loss</th>
            </tr>
          </thead>
          <tbody>
            {filteredOrders.slice(0, 300).map((order) => (
              <tr key={order.key} className="border-b border-[#E2E8F0]/40">
                <td className="py-2 pr-3 text-[#4B4F58]">
                  <div>
                    {order.carrierShipDate && order.shipDate && order.carrierShipDate !== order.shipDate
                      ? `${order.carrierShipDate} (stored ${order.shipDate})`
                      : (order.carrierShipDate ?? '—')}
                  </div>
                </td>
                <td className="py-2 pr-3 text-[#0B1220]">{order.orderNumber}</td>
                <td className="py-2 pr-3 text-[#4B4F58]">{order.clientName}</td>
                <td className="py-2 pr-3 text-right text-[#4B4F58]">{order.shipments}</td>
                <td className="py-2 pr-3 text-right">{fmt(order.clientPrice)}</td>
                <td className="py-2 pr-3 text-right">{fmt(order.shipstationCost)}</td>
                <td className={`py-2 text-right font-medium ${order.profit === null ? 'text-[#6B7A8D]' : order.profit >= 0 ? 'text-emerald-700' : 'text-red-700'}`}>{fmt(order.profit)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {filteredOrders.length > 300 && (
          <p className="mt-3 text-xs text-[#6B7A8D]">Showing the first 300 of {filteredOrders.length}. The client totals use the same dates and include every priced order in the range.</p>
        )}
      </div>
    </div>
  )
}
