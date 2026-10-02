import { supabaseAdmin } from '@/lib/supabase'
import SyncButton from '@/components/dashboard/SyncButton'
import AutoSync from '@/components/dashboard/AutoSync'
import {
  formatPrice, sumPriced, combinePriced, unpricedNote,
} from '@/lib/billing/unpriced'

// Every money figure on this page was built by `?? 0`, which reads an UNKNOWN
// price as a decision that the work was free. recalculate.ts now writes
// `client_rate: null` for a shipment the rate card does not cover, and the
// warehouse log writes `total: null` for a line with no agreed rate, so the
// nulls behind these figures are real and they mean "nobody has priced this".
//
// No figure here MOVES as a result of this change -- the stored value used to
// be 0, and 0 contributes 0 to a sum either way. What changes is that each
// total now carries the count of rows it left out, and says so on screen. The
// row count beside a total already included those rows, so before this the
// total and the count disagreed with nothing to explain the gap.

function buildClientBreakdown(clients: any[], shipments: any[], warehouse: any[], adjustments: any[]) {
  return clients.map(client => {
    const cs = shipments.filter(s => s.client_id === client.id)
    const cw = warehouse.filter(w => w.client_id === client.id)
    const ca = adjustments.filter(a => a.client_id === client.id)
    // Shipping revenue and warehouse revenue go through combinePriced rather
    // than `+`, because both columns are nullable and a bare addition is
    // exactly where the two withheld counts would be dropped.
    const revenue = combinePriced(
      sumPriced(cs, 'client_rate'), sumPriced(cw, 'total'))
    const cost = sumPriced(cs, 'actual_cost')
    const profit = sumPriced(cs, 'profit_loss')
    const pendingAdj = sumPriced(ca, 'adjustment_amount')
    const lossCount = cs.filter(s => s.is_loss).length
    return {
      id: client.id, name: client.name, shipments: cs.length,
      revenue: revenue.total, cost: cost.total, profit: profit.total,
      pendingAdj: pendingAdj.total, lossCount,
      // Counted per client, so the row says WHOSE rate card has the gap. A
      // page-level total can only say the figure is incomplete; this says
      // where to go and fix it.
      unpricedRevenue: revenue.unpriced,
      unknownProfit: profit.unpriced,
    }
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

  const sum = (arr: any[], key: string) => sumPriced(arr, key).total

  // One period's figures, each carrying what it left out. `extra` is the
  // non-shipment revenue (warehouse lines, approved manual charges) and is
  // combined rather than added, so an unpriced warehouse line is counted
  // against the week's revenue note too.
  const period = (shipments: any[] | null | undefined, ...extra: any[][]) => {
    const shipRevenue = sumPriced(shipments, 'client_rate')
    const revenue = combinePriced(
      shipRevenue,
      ...extra.map((rows, i) => sumPriced(rows, i === 0 ? 'total' : 'amount')),
    )
    const cost = sumPriced(shipments, 'actual_cost')
    const profit = sumPriced(shipments, 'profit_loss')
    return {
      revenue: revenue.total,
      cost: cost.total,
      shippingCost: cost.total,
      profit: profit.total,
      shipments: shipRevenue.counted,
      unpricedRevenue: revenue.unpriced,
      // Profit is UNKNOWN whenever the rate is unknown AND also whenever the
      // carrier invoice has not landed, so this count can exceed the revenue
      // one. They are kept apart rather than merged into a single "problems"
      // figure, because they send you to two different places: a rate card,
      // or a carrier bill that has not arrived.
      unknownProfit: profit.unpriced,
    }
  }

  return {
    activeClients: clientsRes.data?.length ?? 0,
    allTime: period(allShipmentsRes.data),
    week: period(weekShipmentsRes.data, weekWarehouseRes.data ?? [], weekManualRes.data ?? []),
    month: period(monthShipmentsRes.data, monthWarehouseRes.data ?? [], monthManualRes.data ?? []),
    year: period(yearShipmentsRes.data),
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
                      <td className="px-2 py-2 text-right text-gray-400">{formatPrice(s.actual_cost)}</td>
                      <td className="px-2 py-2 text-right text-gray-400">{formatPrice(s.client_rate)}</td>
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
        <PeriodCard title="This Week" revenue={d.week.revenue} cost={d.week.shippingCost} profit={d.week.profit}
          unpricedRevenue={d.week.unpricedRevenue} unknownProfit={d.week.unknownProfit} />
        <PeriodCard title="This Month" revenue={d.month.revenue} cost={d.month.shippingCost} profit={d.month.profit}
          unpricedRevenue={d.month.unpricedRevenue} unknownProfit={d.month.unknownProfit} />
        <PeriodCard title="This Year" revenue={d.year.revenue} cost={d.year.cost} profit={d.year.profit}
          unpricedRevenue={d.year.unpricedRevenue} unknownProfit={d.year.unknownProfit} />
      </div>

      {/* All Time Summary */}
      <div className="grid grid-cols-4 gap-4">
        <BigStat label="Total Revenue" value={`$${d.allTime.revenue.toFixed(2)}`} color="blue"
          note={unpricedNote(d.allTime.unpricedRevenue)} />
        <BigStat label="Total Carrier Cost" value={`$${d.allTime.cost.toFixed(2)}`} color="gray" />
        <BigStat label="Net Profit / Loss" value={`${d.allTime.profit >= 0 ? '+' : ''}$${d.allTime.profit.toFixed(2)}`} color={d.allTime.profit >= 0 ? 'green' : 'red'}
          note={unpricedNote(d.allTime.unknownProfit)} />
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
                    {/* The unpriced flag is on the same row as the client's
                        revenue, because this client's rate card is the thing
                        that has to be edited to make the figure complete. */}
                    {c.unpricedRevenue > 0 && (
                      <span className="bg-amber-900/60 text-amber-300 px-2 py-0.5 rounded text-xs mr-1"
                        title="Revenue excludes these -- the rate card does not cover them. They are not $0.">
                        ⚠ {c.unpricedRevenue} unpriced
                      </span>
                    )}
                    {c.pendingAdj > 0 && (
                      <span className="bg-orange-900/60 text-orange-300 px-2 py-0.5 rounded text-xs">🔔 adj</span>
                    )}
                    {/* The green tick now requires the revenue figure to be
                        complete as well. It used to appear beside a total that
                        silently excluded unpriced work. */}
                    {c.lossCount === 0 && c.pendingAdj === 0 && c.unpricedRevenue === 0 && (
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
                <td className="pt-3 text-right">
                  ${d.clientBreakdown.reduce((s: number, c: any) => s + c.revenue, 0).toFixed(2)}
                  {/* The shipment count in the cell to the left includes the
                      unpriced rows; this total does not. Saying so is the
                      whole point -- otherwise the two disagree in silence. */}
                  {d.clientBreakdown.reduce((s: number, c: any) => s + c.unpricedRevenue, 0) > 0 && (
                    <span className="block text-amber-400/90 text-xs font-normal">
                      ⚠ {unpricedNote(d.clientBreakdown.reduce((s: number, c: any) => s + c.unpricedRevenue, 0))}
                    </span>
                  )}
                </td>
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

function PeriodCard(
  { title, revenue, cost, profit, unpricedRevenue = 0, unknownProfit = 0 }:
  {
    title: string; revenue: number; cost: number; profit: number
    unpricedRevenue?: number; unknownProfit?: number
  },
) {
  return (
    <div className="bg-gray-800 rounded-xl p-5">
      <p className="text-gray-400 text-sm font-medium mb-4">{title}</p>
      <div className="space-y-2">
        <div className="flex justify-between text-sm">
          <span className="text-gray-400">Revenue</span>
          <span className="text-white font-semibold">${revenue.toFixed(2)}</span>
        </div>
        {unpricedRevenue > 0 && (
          <p className="text-amber-400/90 text-xs">⚠ {unpricedNote(unpricedRevenue)}</p>
        )}
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
        {unknownProfit > 0 && (
          <p className="text-amber-400/90 text-xs">
            ⚠ {unpricedNote(unknownProfit)} (no rate, or the carrier bill has not landed)
          </p>
        )}
      </div>
    </div>
  )
}

function BigStat(
  { label, value, color, note }:
  { label: string; value: string; color: string; note?: string },
) {
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
      {/* Amber rather than red: the figure is incomplete, which is a thing to
          go and fix, not a failure. `note` is '' when nothing was withheld, so
          nothing renders in the ordinary case -- a permanent all-clear under
          every figure is how a real one stops being read. */}
      {note ? <p className="text-amber-400/90 text-xs mt-1.5">⚠ {note}</p> : null}
    </div>
  )
}
