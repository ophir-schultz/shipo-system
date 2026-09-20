import { supabaseAdmin } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

const CHANNEL_LABELS: Record<string, string> = {
  dtc_email: 'DTC Email (Apollo)',
  fba_linkedin: 'FBA LinkedIn',
  partner_linkedin: 'Partner LinkedIn',
  seo: 'AI / SEO',
  backlinks: 'Backlinks / PR',
  spn: 'Amazon SPN',
  other: 'Other',
}

async function getPnlData() {
  const [shipRes, whRes, inboundRes, campaignsRes, clientsRes, payoutsRes] = await Promise.all([
    supabaseAdmin
      .from('shipments')
      .select('client_id, client_rate, actual_cost, profit_loss, clients(name)'),
    supabaseAdmin
      .from('warehouse_daily_log')
      .select('client_id, total'),
    // new tables — may not exist until migration is applied; errors → empty
    supabaseAdmin
      .from('inbound_shipments')
      .select('id, client_id, reference, received_date, units, our_cost, billed_amount, notes, clients(name)')
      .order('received_date', { ascending: false })
      .limit(500),
    supabaseAdmin
      .from('campaigns')
      .select('id, name, channel, status, start_date, monthly_cost, one_time_cost, notes'),
    supabaseAdmin
      .from('clients')
      .select('id, name, acquisition_campaign_id, referral_partner_id'),
    supabaseAdmin
      .from('referral_payouts')
      .select('id, amount, period, status, notes, referral_partners(name), clients(name)')
      .order('created_at', { ascending: false })
      .limit(200),
  ])

  const shipments = shipRes.data ?? []
  const warehouse = whRes.data ?? []
  const inbound = inboundRes.data ?? []
  const campaigns = campaignsRes.data ?? []
  const clients = clientsRes.data ?? []
  const payouts = payoutsRes.data ?? []

  const migrationApplied = !campaignsRes.error

  // ---- Per-client fulfillment P&L ----
  type Agg = { name: string; shipRev: number; shipCost: number; whRev: number; inRev: number; inCost: number }
  const byClient: Record<string, Agg> = {}
  const ensure = (id: string | null, name: string) => {
    const key = id ?? 'unassigned'
    if (!byClient[key]) byClient[key] = { name, shipRev: 0, shipCost: 0, whRev: 0, inRev: 0, inCost: 0 }
    return byClient[key]
  }

  let unassignedCount = 0
  let unassignedCost = 0
  for (const s of shipments) {
    if (!s.client_id) {
      unassignedCount++
      unassignedCost += s.actual_cost ?? 0
      continue
    }
    const a = ensure(s.client_id, (s.clients as any)?.name ?? 'Unassigned')
    a.shipRev += s.client_rate ?? 0
    a.shipCost += s.actual_cost ?? 0
  }
  for (const w of warehouse) {
    const a = ensure(w.client_id, 'Unassigned')
    a.whRev += w.total ?? 0
  }
  for (const i of inbound) {
    const a = ensure(i.client_id, (i.clients as any)?.name ?? 'Unassigned')
    a.inRev += i.billed_amount ?? 0
    a.inCost += i.our_cost ?? 0
  }

  const clientPnl = Object.entries(byClient).map(([id, a]) => {
    const revenue = a.shipRev + a.whRev + a.inRev
    const cost = a.shipCost + a.inCost
    const profit = revenue - cost
    const margin = revenue > 0 ? (profit / revenue) * 100 : 0
    return { id, ...a, revenue, cost, profit, margin }
  }).sort((x, y) => y.profit - x.profit)

  // client_id -> total fulfillment revenue (for campaign attribution)
  const clientRevenue: Record<string, number> = {}
  for (const c of clientPnl) clientRevenue[c.id] = c.revenue

  // ---- Campaign ROI ----
  const clientsByCampaign: Record<string, number> = {}
  const revByCampaign: Record<string, number> = {}
  for (const c of clients) {
    const cid = (c as any).acquisition_campaign_id
    if (cid) {
      clientsByCampaign[cid] = (clientsByCampaign[cid] ?? 0) + 1
      revByCampaign[cid] = (revByCampaign[cid] ?? 0) + (clientRevenue[c.id] ?? 0)
    }
  }

  const campaignPnl = campaigns.map((c: any) => {
    const spend = (c.monthly_cost ?? 0) + (c.one_time_cost ?? 0)
    const clientsWon = clientsByCampaign[c.id] ?? 0
    const revenue = revByCampaign[c.id] ?? 0
    const profit = revenue - spend
    const roi = spend > 0 ? (profit / spend) * 100 : null
    const cac = clientsWon > 0 ? spend / clientsWon : null
    return { ...c, spend, clientsWon, revenue, profit, roi, cac }
  }).sort((a: any, b: any) => b.revenue - a.revenue)

  // ---- Totals ----
  const totalRevenue = clientPnl.reduce((s, c) => s + c.revenue, 0)
  const totalCost = clientPnl.reduce((s, c) => s + c.cost, 0)
  const totalProfit = totalRevenue - totalCost
  const totalSpend = campaignPnl.reduce((s: number, c: any) => s + c.spend, 0)
  const totalPayouts = payouts.reduce((s, p: any) => s + (p.amount ?? 0), 0)
  const pendingPayouts = payouts.filter((p: any) => p.status === 'pending').reduce((s, p: any) => s + (p.amount ?? 0), 0)

  return {
    migrationApplied,
    clientPnl,
    campaignPnl,
    payouts,
    inbound,
    totalRevenue,
    totalCost,
    totalProfit,
    totalSpend,
    totalPayouts,
    pendingPayouts,
    rawShipmentCount: shipments.length,
    unassignedCount,
    unassignedCost,
    activeCampaigns: campaigns.filter((c: any) => c.status === 'active').length,
    clientCount: clientPnl.filter(c => c.id !== 'unassigned').length,
  }
}

export default async function PnlPage() {
  const d = await getPnlData()
  const fmt = (n: number) => `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(2)}`

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-2xl font-bold text-white">Campaigns + P&amp;L</h2>
        <p className="text-gray-400 text-sm mt-1">Marketing ROI by campaign, fulfillment margin by client, referral payouts, and the inbound receiving log.</p>
      </div>

      {!d.migrationApplied && (
        <div className="rounded-xl p-4 border border-yellow-700/50 bg-yellow-950/30">
          <p className="text-yellow-300 text-sm font-medium">⚠ Campaign / referral / inbound tables not created yet</p>
          <p className="text-yellow-500/80 text-xs mt-1">Per-client P&amp;L below is live from real shipment + warehouse data. Run <span className="font-mono">supabase/campaigns_pnl.sql</span> in Supabase to enable the campaign ROI, referral payout, and inbound-log sections.</p>
        </div>
      )}

      {/* Summary bar */}
      <div className="grid grid-cols-4 gap-4">
        <StatCard label="Total Revenue" value={fmt(d.totalRevenue)} sub={`${d.clientCount} active clients`} color="blue" />
        <StatCard label="Total Cost" value={fmt(d.totalCost)} sub="Carrier + receiving cost" color="gray" />
        <StatCard label="Net Profit" value={fmt(d.totalProfit)} sub="Gross of warehouse labor" color={d.totalProfit >= 0 ? 'green' : 'red'} />
        <StatCard label="Marketing Spend" value={fmt(d.totalSpend)} sub={`${d.activeCampaigns} active campaigns`} color="gray" />
      </div>

      {/* ---- Marketing Campaign P&L ---- */}
      <div className="bg-gray-800 rounded-xl p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold text-white">Marketing Campaign P&amp;L</h3>
          <span className="text-xs text-gray-400">Revenue is attributed once clients are tagged to a campaign</span>
        </div>
        {d.campaignPnl.length === 0
          ? <p className="text-gray-500 text-sm">No campaigns yet. Run the migration to seed the known campaigns, or add one via the form.</p>
          : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-gray-400 text-left border-b border-gray-700 text-xs uppercase">
                    <th className="pb-2 pr-3">Campaign</th>
                    <th className="pb-2 pr-3">Channel</th>
                    <th className="pb-2 pr-3">Status</th>
                    <th className="pb-2 pr-3 text-right">Spend</th>
                    <th className="pb-2 pr-3 text-right">Clients</th>
                    <th className="pb-2 pr-3 text-right">Revenue</th>
                    <th className="pb-2 pr-3 text-right">Profit</th>
                    <th className="pb-2 pr-3 text-right">ROI</th>
                    <th className="pb-2 text-right">CAC</th>
                  </tr>
                </thead>
                <tbody>
                  {d.campaignPnl.map((c: any) => (
                    <tr key={c.id} className="border-b border-gray-700/40 hover:bg-gray-700/30">
                      <td className="py-2.5 pr-3 text-gray-200">{c.name}</td>
                      <td className="py-2.5 pr-3 text-gray-400">{CHANNEL_LABELS[c.channel] ?? c.channel}</td>
                      <td className="py-2.5 pr-3">
                        <span className={`px-1.5 py-0.5 rounded text-xs ${c.status === 'active' ? 'bg-green-900/50 text-green-400' : c.status === 'paused' ? 'bg-yellow-900/40 text-yellow-400' : 'bg-gray-700 text-gray-400'}`}>{c.status}</span>
                      </td>
                      <td className="py-2.5 pr-3 text-right text-gray-300">{fmt(c.spend)}</td>
                      <td className="py-2.5 pr-3 text-right text-gray-400">{c.clientsWon}</td>
                      <td className="py-2.5 pr-3 text-right text-gray-300">{fmt(c.revenue)}</td>
                      <td className={`py-2.5 pr-3 text-right font-medium ${c.profit >= 0 ? 'text-green-400' : 'text-red-400'}`}>{fmt(c.profit)}</td>
                      <td className="py-2.5 pr-3 text-right text-gray-400">{c.roi === null ? '—' : `${c.roi.toFixed(0)}%`}</td>
                      <td className="py-2.5 text-right text-gray-400">{c.cac === null ? '—' : fmt(c.cac)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-gray-600">
                    <td colSpan={3} className="pt-3 text-gray-300 text-xs font-semibold uppercase">Total</td>
                    <td className="pt-3 text-right text-gray-300 text-sm">{fmt(d.totalSpend)}</td>
                    <td className="pt-3 text-right text-gray-400 text-sm">{d.campaignPnl.reduce((s: number, c: any) => s + c.clientsWon, 0)}</td>
                    <td className="pt-3 text-right text-gray-300 text-sm">{fmt(d.campaignPnl.reduce((s: number, c: any) => s + c.revenue, 0))}</td>
                    <td className="pt-3 text-right text-sm text-gray-300" colSpan={3}></td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )
        }
      </div>

      {/* ---- Per-Client Fulfillment P&L ---- */}
      <div className="bg-gray-800 rounded-xl p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold text-white">Per-Client Fulfillment P&amp;L</h3>
          <span className="text-xs text-gray-400">Revenue = shipping + warehouse + inbound · Cost = carrier + receiving · gross of labor</span>
        </div>
        {d.unassignedCount > 0 && (
          <div className="mb-4 rounded-lg px-4 py-3 border border-orange-800/40 bg-orange-950/20 text-xs text-orange-300/90">
            <span className="font-medium text-orange-300">{d.unassignedCount} unassigned shipments</span> carry {fmt(d.unassignedCost)} in carrier cost not yet attributed to any client or priced. Assign them to clients + run rate calculation to move this cost into per-client margin.
          </div>
        )}
        {d.clientPnl.length === 0
          ? (
            <div className="text-sm text-gray-400 space-y-1">
              <p>No priced, client-assigned shipments yet — so there&apos;s nothing to compute margin on.</p>
              <p className="text-gray-500 text-xs">{d.rawShipmentCount} shipments are uploaded but not linked to a client or rated. Assign them to clients and run rate calculation (Shipments → Recalculate) to light up per-client P&amp;L.</p>
            </div>
          )
          : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-gray-400 text-left border-b border-gray-700 text-xs uppercase">
                    <th className="pb-2 pr-3">Client</th>
                    <th className="pb-2 pr-3 text-right">Ship Rev</th>
                    <th className="pb-2 pr-3 text-right">Warehouse</th>
                    <th className="pb-2 pr-3 text-right">Inbound</th>
                    <th className="pb-2 pr-3 text-right">Revenue</th>
                    <th className="pb-2 pr-3 text-right">Cost</th>
                    <th className="pb-2 pr-3 text-right">Profit</th>
                    <th className="pb-2 w-32">Margin</th>
                  </tr>
                </thead>
                <tbody>
                  {d.clientPnl.map((c) => (
                    <tr key={c.id} className="border-b border-gray-700/40 hover:bg-gray-700/30">
                      <td className="py-2.5 pr-3 text-gray-200">{c.id === 'unassigned' ? <span className="text-gray-600 italic">unassigned</span> : c.name}</td>
                      <td className="py-2.5 pr-3 text-right text-gray-400">{fmt(c.shipRev)}</td>
                      <td className="py-2.5 pr-3 text-right text-gray-400">{fmt(c.whRev)}</td>
                      <td className="py-2.5 pr-3 text-right text-gray-400">{fmt(c.inRev)}</td>
                      <td className="py-2.5 pr-3 text-right text-gray-300">{fmt(c.revenue)}</td>
                      <td className="py-2.5 pr-3 text-right text-gray-300">{fmt(c.cost)}</td>
                      <td className={`py-2.5 pr-3 text-right font-medium ${c.profit >= 0 ? 'text-green-400' : 'text-red-400'}`}>{fmt(c.profit)}</td>
                      <td className="py-2.5 pl-1">
                        <div className="flex items-center gap-2">
                          <div className="flex-1 h-1.5 bg-gray-700 rounded-full overflow-hidden">
                            <div className={`h-full rounded-full ${c.profit >= 0 ? 'bg-green-500' : 'bg-red-500'}`} style={{ width: `${Math.min(100, Math.abs(c.margin))}%` }} />
                          </div>
                          <span className={`text-xs shrink-0 ${c.profit >= 0 ? 'text-green-400' : 'text-red-400'}`}>{c.margin.toFixed(0)}%</span>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-gray-600">
                    <td className="pt-3 text-gray-300 text-xs font-semibold uppercase">Total</td>
                    <td colSpan={3}></td>
                    <td className="pt-3 text-right text-gray-300 text-sm">{fmt(d.totalRevenue)}</td>
                    <td className="pt-3 text-right text-gray-300 text-sm">{fmt(d.totalCost)}</td>
                    <td className={`pt-3 text-right text-sm font-bold ${d.totalProfit >= 0 ? 'text-green-400' : 'text-red-400'}`}>{fmt(d.totalProfit)}</td>
                    <td></td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )
        }
      </div>

      {/* ---- Referral payouts + Inbound log ---- */}
      <div className="grid grid-cols-2 gap-4">
        {/* Referral payouts */}
        <div className="bg-gray-800 rounded-xl p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold text-white">Referral Payouts</h3>
            <span className="text-xs text-gray-400">{fmt(d.pendingPayouts)} pending approval</span>
          </div>
          {d.payouts.length === 0
            ? <p className="text-gray-500 text-sm">No referral payouts recorded. Every payout is held at <span className="text-yellow-400">pending</span> until you approve it.</p>
            : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-gray-400 text-left border-b border-gray-700 text-xs uppercase">
                    <th className="pb-2 pr-3">Partner</th>
                    <th className="pb-2 pr-3">Client</th>
                    <th className="pb-2 pr-3">Period</th>
                    <th className="pb-2 pr-3 text-right">Amount</th>
                    <th className="pb-2 text-right">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {d.payouts.map((p: any) => (
                    <tr key={p.id} className="border-b border-gray-700/40">
                      <td className="py-2 pr-3 text-gray-200">{(p.referral_partners as any)?.name ?? '—'}</td>
                      <td className="py-2 pr-3 text-gray-400">{(p.clients as any)?.name ?? '—'}</td>
                      <td className="py-2 pr-3 text-gray-400">{p.period ?? '—'}</td>
                      <td className="py-2 pr-3 text-right text-gray-300">{fmt(p.amount ?? 0)}</td>
                      <td className="py-2 text-right">
                        <span className={`px-1.5 py-0.5 rounded text-xs ${p.status === 'paid' ? 'bg-green-900/50 text-green-400' : p.status === 'approved' ? 'bg-[#00AAFF]/15 text-[#00AAFF]' : 'bg-yellow-900/40 text-yellow-400'}`}>{p.status}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          }
        </div>

        {/* Inbound log */}
        <div className="bg-gray-800 rounded-xl p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold text-white">Inbound Shipment Log</h3>
            <span className="text-xs text-gray-400">Receiving / packing list</span>
          </div>
          {d.inbound.length === 0
            ? <p className="text-gray-500 text-sm">No inbound shipments logged yet.</p>
            : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-gray-400 text-left border-b border-gray-700 text-xs uppercase">
                    <th className="pb-2 pr-3">Date</th>
                    <th className="pb-2 pr-3">Client</th>
                    <th className="pb-2 pr-3">Ref</th>
                    <th className="pb-2 pr-3 text-right">Units</th>
                    <th className="pb-2 pr-3 text-right">Cost</th>
                    <th className="pb-2 text-right">Billed</th>
                  </tr>
                </thead>
                <tbody>
                  {d.inbound.map((i: any) => (
                    <tr key={i.id} className="border-b border-gray-700/40">
                      <td className="py-2 pr-3 text-gray-400">{i.received_date ?? '—'}</td>
                      <td className="py-2 pr-3 text-gray-200">{(i.clients as any)?.name ?? '—'}</td>
                      <td className="py-2 pr-3 font-mono text-gray-400">{i.reference ?? '—'}</td>
                      <td className="py-2 pr-3 text-right text-gray-400">{i.units ?? 0}</td>
                      <td className="py-2 pr-3 text-right text-gray-400">{fmt(i.our_cost ?? 0)}</td>
                      <td className="py-2 text-right text-gray-300">{fmt(i.billed_amount ?? 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          }
        </div>
      </div>
    </div>
  )
}

function StatCard({ label, value, sub, color }: { label: string; value: string; sub: string; color: string }) {
  const colors: Record<string, string> = {
    red: 'border-red-800/50 bg-red-950/40',
    green: 'border-green-800/50 bg-green-950/40',
    blue: 'border-[#00AAFF]/20 bg-[#00AAFF]/5',
    gray: 'border-gray-700 bg-gray-800',
  }
  return (
    <div className={`rounded-xl p-5 border ${colors[color] ?? 'bg-gray-800 border-gray-700'}`}>
      <p className="text-gray-400 text-xs uppercase tracking-wider mb-2">{label}</p>
      <p className="text-2xl font-bold text-white">{value}</p>
      <p className="text-gray-500 text-xs mt-1">{sub}</p>
    </div>
  )
}
