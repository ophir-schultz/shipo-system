import { supabaseAdmin } from '@/lib/supabase'
import SyncButton from '@/components/dashboard/SyncButton'
import AutoSync from '@/components/dashboard/AutoSync'

function buildClientBreakdown(clients: any[], shipments: any[], warehouse: any[], adjustments: any[]) {
  return clients.map(client => {
    const cs = shipments.filter(s => s.client_id === client.id)
    const cw = warehouse.filter(w => w.client_id === client.id)
    const ca = adjustments.filter(a => a.client_id === client.id)
    const revenue = cs.reduce((s, r) => s + (r.client_rate ?? 0), 0) + cw.reduce((s, r) => s + (r.total ?? 0), 0)
    const cost = cs.reduce((s, r) => s + (r.actual_cost ?? 0), 0)
    const profit = cs.reduce((s, r) => s + (r.profit_loss ?? 0), 0)
    const pendingAdj = ca.reduce((s, r) => s + (r.adjustment_amount ?? 0), 0)
    const lossCount = cs.filter(s => s.is_loss).length
    return { id: client.id, name: client.name, shipments: cs.length, revenue, cost, profit, pendingAdj, lossCount }
  }).sort((a, b) => b.revenue - a.revenue)
}

async function getDashboardData() {
  const now = new Date()
  const weekStart = new Date(now)
  weekStart.setDate(now.getDate() - now.getDay())
  weekStart.setHours(0, 0, 0, 0)
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
  const yearStart = new Date(now.getFullYear(), 0, 1)

  const [
    clientsRes, allShipmentsRes, lossShipmentsRes,
    weekShipmentsRes, monthShipmentsRes, yearShipmentsRes,
    pendingAdjRes, weekWarehouseRes, monthWarehouseRes,
    weekManualRes, monthManualRes, billsRes,
    clientShipmentsRes, clientWarehouseRes, clientAdjRes,
  ] = await Promise.all([
    supabaseAdmin.from('clients').select('id, name, active').eq('active', true),
    supabaseAdmin.from('shipments').select('actual_cost, client_rate, profit_loss, is_loss'),
    supabaseAdmin.from('shipments')
      .select('order_number, client_id, actual_cost, client_rate, profit_loss, clients(name), ship_date, carrier, service, tracking_number')
      .eq('is_loss', true).order('profit_loss', { ascending: true }).limit(50),
    supabaseAdmin.from('shipments').select('actual_cost, client_rate, profit_loss').gte('ship_date', weekStart.toISOString()),
    supabaseAdmin.from('shipments').select('actual_cost, client_rate, profit_loss').gte('ship_date', monthStart.toISOString()),
    supabaseAdmin.from('shipments').select('actual_cost, client_rate, profit_loss').gte('ship_date', yearStart.toISOString()),
    supabaseAdmin.from('rate_adjustments')
      .select('id, order_number, adjustment_amount, reason, adjustment_date, client_id, clients(name)')
      .eq('status', 'pending').order('adjustment_amount', { ascending: false }),
    supabaseAdmin.from('warehouse_daily_log').select('total').gte('log_date', weekStart.toISOString().split('T')[0]),
    supabaseAdmin.from('warehouse_daily_log').select('total').gte('log_date', monthStart.toISOString().split('T')[0]),
    supabaseAdmin.from('manual_charges').select('amount').eq('approved', true).gte('charge_date', weekStart.toISOString().split('T')[0]),
    supabaseAdmin.from('manual_charges').select('amount').eq('approved', true).gte('charge_date', monthStart.toISOString().split('T')[0]),
    supabaseAdmin.from('bills').select('grand_total, status, week_start, week_end, client_id, clients(name)').order('week_start', { ascending: false }).limit(10),
    supabaseAdmin.from('shipments').select('client_id, actual_cost, client_rate, profit_loss, is_loss, clients(name)').gte('ship_date', monthStart.toISOString()),
    supabaseAdmin.from('warehouse_daily_log').select('client_id, total').gte('log_date', monthStart.toISOString().split('T')[0]),
    supabaseAdmin.from('rate_adjustments').select('client_id, adjustment_amount').eq('status', 'pending'),
  ])

  const sum = (arr: any[], key: string) => (arr ?? []).reduce((s, r) => s + (r[key] ?? 0), 0)

  return {
    activeClients: clientsRes.data?.length ?? 0,
    allTime: {
      revenue: sum(allShipmentsRes.data ?? [], 'client_rate'),
      cost: sum(allShipmentsRes.data ?? [], 'actual_cost'),
      profit: sum(allShipmentsRes.data ?? [], 'profit_loss'),
      shipments: allShipmentsRes.data?.length ?? 0,
    },
    week: {
      revenue: sum(weekShipmentsRes.data ?? [], 'client_rate') + sum(weekWarehouseRes.data ?? [], 'total') + sum(weekManualRes.data ?? [], 'amount'),
      shippingCost: sum(weekShipmentsRes.data ?? [], 'actual_cost'),
      profit: sum(weekShipmentsRes.data ?? [], 'profit_loss'),
    },
    month: {
      revenue: sum(monthShipmentsRes.data ?? [], 'client_rate') + sum(monthWarehouseRes.data ?? [], 'total') + sum(monthManualRes.data ?? [], 'amount'),
      shippingCost: sum(monthShipmentsRes.data ?? [], 'actual_cost'),
      profit: sum(monthShipmentsRes.data ?? [], 'profit_loss'),
    },
    year: {
      revenue: sum(yearShipmentsRes.data ?? [], 'client_rate'),
      cost: sum(yearShipmentsRes.data ?? [], 'actual_cost'),
      profit: sum(yearShipmentsRes.data ?? [], 'profit_loss'),
    },
    lossShipments: lossShipmentsRes.data ?? [],
    lossTotal: Math.abs(sum(lossShipmentsRes.data ?? [], 'profit_loss')),
    pendingAdjustments: pendingAdjRes.data ?? [],
    pendingAdjustmentsTotal: sum(pendingAdjRes.data ?? [], 'adjustment_amount'),
    recentBills: billsRes.data ?? [],
    clientBreakdown: buildClientBreakdown(
      clientsRes.data ?? [],
      clientShipmentsRes.data ?? [],
      clientWarehouseRes.data ?? [],
      clientAdjRes.data ?? []
    ),
  }
}

export default async function DashboardPage() {
  const d = await getDashboardData()

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-white">Dashboard</h2>
          <p className="text-gray-400 text-sm mt-1">Live billing & operations overview</p>
        </div>
        <div className="flex items-center gap-4">
          <AutoSync />
          <a href="/reports" className="bg-gray-700 hover:bg-gray-600 text-white px-4 py-2 rounded-lg text-sm font-medium transition">
            📥 Download Reports
          </a>
          <SyncButton />
        </div>
      </div>

      {/* ── ALERTS SECTION ── */}
      <div className="grid grid-cols-2 gap-4">

        {/* Loss Shipments Panel */}
        <div className="rounded-xl overflow-hidden border border-red-800/60" style={{ background: '#1a0a0a' }}>
          <div className="flex items-center justify-between px-5 py-3 border-b border-red-800/40" style={{ background: '#2a0f0f' }}>
            <a href="/shipments?filter=loss" className="flex items-center gap-2 hover:opacity-80 transition">
              <span className="text-red-400 text-lg">⚠️</span>
              <span className="text-red-300 font-bold text-sm underline-offset-2 hover:underline">Shipping Losses</span>
              {d.lossShipments.length > 0 && (
                <span className="bg-red-700 text-red-100 text-xs font-bold px-2 py-0.5 rounded-full">{d.lossShipments.length}</span>
              )}
            </a>
            <span className="text-red-400 font-bold text-sm">
              {d.lossShipments.length > 0 ? `-$${d.lossTotal.toFixed(2)}` : ''}
            </span>
          </div>
          {d.lossShipments.length === 0 ? (
            <div className="px-5 py-8 text-center">
              <p className="text-green-400 text-sm font-medium">✓ No loss shipments</p>
              <p className="text-gray-600 text-xs mt-1">All shipments are profitable</p>
            </div>
          ) : (
            <div className="overflow-auto max-h-72">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-red-400/70 text-left border-b border-red-900/40">
                    <th className="px-4 py-2">Order #</th>
                    <th className="px-2 py-2">Client</th>
                    <th className="px-2 py-2 text-right">We Paid</th>
                    <th className="px-2 py-2 text-right">Charged</th>
                    <th className="px-2 py-2 text-right">Loss</th>
                  </tr>
                </thead>
                <tbody>
                  {d.lossShipments.map((s: any) => (
                    <tr key={s.order_number} className="border-b border-red-900/20 hover:bg-red-900/20">
                      <td className="px-4 py-2 font-mono text-gray-300">{s.order_number}</td>
                      <td className="px-2 py-2 text-gray-300">{s.clients?.name ?? '—'}</td>
                      <td className="px-2 py-2 text-right text-gray-400">${(s.actual_cost ?? 0).toFixed(2)}</td>
                      <td className="px-2 py-2 text-right text-gray-400">${(s.client_rate ?? 0).toFixed(2)}</td>
                      <td className="px-2 py-2 text-right font-bold text-red-400">-${Math.abs(s.profit_loss ?? 0).toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-red-800/40">
                    <td colSpan={4} className="px-4 py-2 text-red-400 text-xs font-semibold">Total Loss</td>
                    <td className="px-2 py-2 text-right font-bold text-red-400">-${d.lossTotal.toFixed(2)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>

        {/* Pending Adjustments Panel */}
        <div className="rounded-xl overflow-hidden border border-orange-800/60" style={{ background: '#1a1000' }}>
          <div className="flex items-center justify-between px-5 py-3 border-b border-orange-800/40" style={{ background: '#2a1800' }}>
            <a href="/adjustments" className="flex items-center gap-2 hover:opacity-80 transition">
              <span className="text-orange-400 text-lg">🔔</span>
              <span className="text-orange-300 font-bold text-sm hover:underline underline-offset-2">Carrier Price Adjustments</span>
              {d.pendingAdjustments.length > 0 && (
                <span className="bg-orange-700 text-orange-100 text-xs font-bold px-2 py-0.5 rounded-full">{d.pendingAdjustments.length}</span>
              )}
            </a>
            <span className="text-orange-400 font-bold text-sm">
              {d.pendingAdjustments.length > 0 ? `+$${d.pendingAdjustmentsTotal.toFixed(2)}` : ''}
            </span>
          </div>
          {d.pendingAdjustments.length === 0 ? (
            <div className="px-5 py-8 text-center">
              <p className="text-green-400 text-sm font-medium">✓ No pending adjustments</p>
              <p className="text-gray-600 text-xs mt-1">No carrier price changes detected</p>
            </div>
          ) : (
            <div className="overflow-auto max-h-72">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-orange-400/70 text-left border-b border-orange-900/40">
                    <th className="px-4 py-2">Order #</th>
                    <th className="px-2 py-2">Client</th>
                    <th className="px-2 py-2">Reason</th>
                    <th className="px-2 py-2">Date</th>
                    <th className="px-2 py-2 text-right">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {d.pendingAdjustments.map((a: any) => (
                    <tr key={a.id} className="border-b border-orange-900/20 hover:bg-orange-900/20">
                      <td className="px-4 py-2 font-mono text-gray-300">{a.order_number}</td>
                      <td className="px-2 py-2 text-gray-300">{a.clients?.name ?? '—'}</td>
                      <td className="px-2 py-2 text-gray-400">{a.reason ?? 'Carrier reweigh'}</td>
                      <td className="px-2 py-2 text-gray-400">{a.adjustment_date ? new Date(a.adjustment_date).toLocaleDateString() : '—'}</td>
                      <td className="px-2 py-2 text-right font-bold text-orange-400">+${(a.adjustment_amount ?? 0).toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-orange-800/40">
                    <td colSpan={4} className="px-4 py-2 text-orange-400 text-xs font-semibold">Total to Recover</td>
                    <td className="px-2 py-2 text-right font-bold text-orange-400">+${d.pendingAdjustmentsTotal.toFixed(2)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Period Revenue Cards */}
      <div className="grid grid-cols-3 gap-4">
        <PeriodCard title="This Week" revenue={d.week.revenue} cost={d.week.shippingCost} profit={d.week.profit} />
        <PeriodCard title="This Month" revenue={d.month.revenue} cost={d.month.shippingCost} profit={d.month.profit} />
        <PeriodCard title="This Year" revenue={d.year.revenue} cost={d.year.cost} profit={d.year.profit} />
      </div>

      {/* All Time Summary */}
      <div className="grid grid-cols-4 gap-4">
        <BigStat label="Total Revenue" value={`$${d.allTime.revenue.toFixed(2)}`} color="blue" />
        <BigStat label="Total Carrier Cost" value={`$${d.allTime.cost.toFixed(2)}`} color="gray" />
        <BigStat label="Net Profit / Loss" value={`${d.allTime.profit >= 0 ? '+' : ''}$${d.allTime.profit.toFixed(2)}`} color={d.allTime.profit >= 0 ? 'green' : 'red'} />
        <BigStat label="Active Clients" value={d.activeClients.toString()} color="blue" />
      </div>

      {/* Client Breakdown */}
      <div className="bg-gray-800 rounded-xl p-6">
        <h3 className="text-lg font-semibold mb-1">Client Overview — This Month</h3>
        <p className="text-gray-400 text-sm mb-4">Revenue, cost and profit per client</p>
        {d.clientBreakdown.length === 0 ? (
          <p className="text-gray-500 text-center py-8">No clients yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-gray-400 text-left border-b border-gray-700">
                <th className="pb-3">Client</th>
                <th className="pb-3 text-right">Shipments</th>
                <th className="pb-3 text-right">Revenue</th>
                <th className="pb-3 text-right">Carrier Cost</th>
                <th className="pb-3 text-right">Profit / Loss</th>
                <th className="pb-3 text-right">Pending Adj.</th>
                <th className="pb-3 text-center">Flags</th>
              </tr>
            </thead>
            <tbody>
              {d.clientBreakdown.map((c: any) => (
                <tr key={c.id} className="border-b border-gray-700/50 hover:bg-gray-700/30">
                  <td className="py-3 font-medium">
                    <a href={`/clients/${c.id}`} className="hover:text-[#00AAFF] transition">{c.name}</a>
                  </td>
                  <td className="py-3 text-right text-gray-300">{c.shipments}</td>
                  <td className="py-3 text-right">${c.revenue.toFixed(2)}</td>
                  <td className="py-3 text-right text-gray-300">${c.cost.toFixed(2)}</td>
                  <td className={`py-3 text-right font-semibold ${c.profit >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                    {c.profit >= 0 ? '+' : ''}${c.profit.toFixed(2)}
                  </td>
                  <td className={`py-3 text-right ${c.pendingAdj > 0 ? 'text-orange-400 font-semibold' : 'text-gray-500'}`}>
                    {c.pendingAdj > 0 ? `+$${c.pendingAdj.toFixed(2)}` : '—'}
                  </td>
                  <td className="py-3 text-center">
                    {c.lossCount > 0 && (
                      <span className="bg-red-900/60 text-red-300 px-2 py-0.5 rounded text-xs mr-1">⚠ {c.lossCount} loss</span>
                    )}
                    {c.pendingAdj > 0 && (
                      <span className="bg-orange-900/60 text-orange-300 px-2 py-0.5 rounded text-xs">🔔 adj</span>
                    )}
                    {c.lossCount === 0 && c.pendingAdj === 0 && (
                      <span className="text-green-400 text-xs">✓</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-gray-600 text-sm font-semibold">
                <td className="pt-3">Total</td>
                <td className="pt-3 text-right">{d.clientBreakdown.reduce((s: number, c: any) => s + c.shipments, 0)}</td>
                <td className="pt-3 text-right">${d.clientBreakdown.reduce((s: number, c: any) => s + c.revenue, 0).toFixed(2)}</td>
                <td className="pt-3 text-right">${d.clientBreakdown.reduce((s: number, c: any) => s + c.cost, 0).toFixed(2)}</td>
                <td className={`pt-3 text-right ${d.clientBreakdown.reduce((s: number, c: any) => s + c.profit, 0) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                  {d.clientBreakdown.reduce((s: number, c: any) => s + c.profit, 0) >= 0 ? '+' : ''}${d.clientBreakdown.reduce((s: number, c: any) => s + c.profit, 0).toFixed(2)}
                </td>
                <td className="pt-3 text-right text-orange-400">
                  ${d.clientBreakdown.reduce((s: number, c: any) => s + c.pendingAdj, 0).toFixed(2)}
                </td>
                <td></td>
              </tr>
            </tfoot>
          </table>
        )}
      </div>

      {/* Recent Bills */}
      <div className="bg-gray-800 rounded-xl p-6">
        <h3 className="text-lg font-semibold mb-4">Recent Bills</h3>
        {d.recentBills.length === 0 ? (
          <p className="text-gray-500 text-center py-8">No bills generated yet. Bills are created weekly per client.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-gray-400 text-left border-b border-gray-700">
                <th className="pb-3">Client</th>
                <th className="pb-3">Week</th>
                <th className="pb-3 text-right">Total</th>
                <th className="pb-3 text-center">Status</th>
              </tr>
            </thead>
            <tbody>
              {d.recentBills.map((b: any, i: number) => (
                <tr key={i} className="border-b border-gray-700/50 hover:bg-gray-700/30">
                  <td className="py-3">{b.clients?.name ?? '—'}</td>
                  <td className="py-3 text-gray-400">{b.week_start} → {b.week_end}</td>
                  <td className="py-3 text-right font-semibold">${(b.grand_total ?? 0).toFixed(2)}</td>
                  <td className="py-3 text-center">
                    <span className={`px-2 py-0.5 rounded text-xs ${
                      b.status === 'paid' ? 'bg-green-900 text-green-300' :
                      b.status === 'sent' ? 'bg-[#00AAFF]/10 text-[#33BBFF]' :
                      'bg-gray-700 text-gray-300'
                    }`}>{b.status}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

function PeriodCard({ title, revenue, cost, profit }: { title: string; revenue: number; cost: number; profit: number }) {
  return (
    <div className="bg-gray-800 rounded-xl p-5">
      <p className="text-gray-400 text-sm font-medium mb-4">{title}</p>
      <div className="space-y-2">
        <div className="flex justify-between text-sm">
          <span className="text-gray-400">Revenue</span>
          <span className="text-white font-semibold">${revenue.toFixed(2)}</span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-gray-400">Carrier Cost</span>
          <span className="text-white">${cost.toFixed(2)}</span>
        </div>
        <div className="border-t border-gray-700 pt-2 flex justify-between text-sm">
          <span className="text-gray-400">Profit / Loss</span>
          <span className={`font-bold ${profit >= 0 ? 'text-green-400' : 'text-red-400'}`}>
            {profit >= 0 ? '+' : ''}${profit.toFixed(2)}
          </span>
        </div>
      </div>
    </div>
  )
}

function BigStat({ label, value, color }: { label: string; value: string; color: string }) {
  const colors: Record<string, string> = {
    blue: 'border-[#00AAFF]/30 bg-[#00AAFF]/5',
    green: 'border-green-700/50 bg-green-950/50',
    red: 'border-red-700/50 bg-red-950/50',
    gray: 'border-gray-700 bg-gray-800',
  }
  return (
    <div className={`rounded-xl p-5 border ${colors[color]}`}>
      <p className="text-gray-400 text-xs uppercase tracking-wider">{label}</p>
      <p className="text-2xl font-bold mt-2 text-white">{value}</p>
    </div>
  )
}
