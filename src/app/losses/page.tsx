import { supabaseAdmin } from '@/lib/supabase'

async function getLossData() {
  const [lossRes, allRes] = await Promise.all([
    supabaseAdmin
      .from('shipments')
      .select('id, order_number, ship_date, carrier, service, weight, billed_weight, actual_cost, client_rate, profit_loss, zone, recipient_state, client_id, clients(name)')
      .eq('is_loss', true)
      .order('profit_loss', { ascending: true })
      .limit(2000),
    supabaseAdmin
      .from('shipments')
      .select('actual_cost, client_rate, profit_loss, is_loss')
      .not('client_id', 'is', null),
  ])

  const losses = lossRes.data ?? []
  const all = allRes.data ?? []

  const totalShipments = all.length
  const totalRevenue = all.reduce((s, r) => s + (r.client_rate ?? 0), 0)
  const totalCost = all.reduce((s, r) => s + (r.actual_cost ?? 0), 0)
  const totalProfit = all.reduce((s, r) => s + (r.profit_loss ?? 0), 0)
  const totalLossAmt = losses.reduce((s, r) => s + Math.abs(r.profit_loss ?? 0), 0)

  // By client
  const byClient: Record<string, { name: string; count: number; lossAmt: number }> = {}
  for (const s of losses) {
    const name = (s.clients as any)?.name ?? 'Unassigned'
    if (!byClient[name]) byClient[name] = { name, count: 0, lossAmt: 0 }
    byClient[name].count++
    byClient[name].lossAmt += Math.abs(s.profit_loss ?? 0)
  }

  // By carrier/service
  const byService: Record<string, { count: number; lossAmt: number }> = {}
  for (const s of losses) {
    const key = `${s.carrier ?? '?'} · ${s.service ?? '?'}`
    if (!byService[key]) byService[key] = { count: 0, lossAmt: 0 }
    byService[key].count++
    byService[key].lossAmt += Math.abs(s.profit_loss ?? 0)
  }

  // By zone
  const byZone: Record<string, { count: number; lossAmt: number }> = {}
  for (const s of losses) {
    const key = s.zone ? `Zone ${s.zone}` : 'Zone unknown'
    if (!byZone[key]) byZone[key] = { count: 0, lossAmt: 0 }
    byZone[key].count++
    byZone[key].lossAmt += Math.abs(s.profit_loss ?? 0)
  }

  // By weight bracket (lb)
  const byWeight: Record<string, { count: number; lossAmt: number }> = {}
  for (const s of losses) {
    const oz = s.billed_weight ?? s.weight ?? 0
    const lb = Math.ceil(oz / 16)
    const key = lb <= 1 ? '≤1 lb' : lb <= 5 ? '2–5 lb' : lb <= 10 ? '6–10 lb' : lb <= 20 ? '11–20 lb' : '20+ lb'
    if (!byWeight[key]) byWeight[key] = { count: 0, lossAmt: 0 }
    byWeight[key].count++
    byWeight[key].lossAmt += Math.abs(s.profit_loss ?? 0)
  }

  return {
    losses,
    totalShipments,
    totalRevenue,
    totalCost,
    totalProfit,
    totalLossAmt,
    lossCount: losses.length,
    lossRate: totalShipments > 0 ? (losses.length / totalShipments) * 100 : 0,
    byClient: Object.values(byClient).sort((a, b) => b.lossAmt - a.lossAmt),
    byService: Object.entries(byService).sort((a, b) => b[1].lossAmt - a[1].lossAmt).slice(0, 10),
    byZone: Object.entries(byZone).sort((a, b) => a[0].localeCompare(b[0])),
    byWeight: Object.entries(byWeight),
  }
}

export default async function LossesPage() {
  const d = await getLossData()
  const fmt = (n: number) => `$${Math.abs(n).toFixed(2)}`

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-2xl font-bold text-white">Loss Analysis</h2>
        <p className="text-gray-400 text-sm mt-1">All shipments where carrier cost exceeded what we charged the client</p>
      </div>

      {/* Summary bar */}
      <div className="grid grid-cols-4 gap-4">
        <StatCard label="Loss Shipments" value={d.lossCount.toString()} sub={`${d.lossRate.toFixed(1)}% of all shipments`} color="red" />
        <StatCard label="Total Loss Amount" value={`-${fmt(d.totalLossAmt)}`} sub="Money we lost on those shipments" color="red" />
        <StatCard label="Net Profit (all)" value={`${d.totalProfit >= 0 ? '+' : '-'}${fmt(d.totalProfit)}`} sub={`${d.totalShipments} assigned shipments`} color={d.totalProfit >= 0 ? 'green' : 'red'} />
        <StatCard label="Revenue vs Cost" value={`${fmt(d.totalRevenue)} / ${fmt(d.totalCost)}`} sub="Revenue / Carrier cost" color="blue" />
      </div>

      {/* Breakdown panels */}
      <div className="grid grid-cols-3 gap-4">
        {/* By Client */}
        <div className="bg-gray-800 rounded-xl p-5">
          <h3 className="font-semibold text-white mb-3">By Client</h3>
          {d.byClient.length === 0
            ? <p className="text-gray-500 text-sm">No losses</p>
            : <div className="space-y-2">
              {d.byClient.map(c => (
                <div key={c.name} className="flex items-center gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex justify-between text-sm mb-1">
                      <span className="text-gray-300 truncate">{c.name}</span>
                      <span className="text-red-400 font-medium ml-2 shrink-0">-${c.lossAmt.toFixed(2)}</span>
                    </div>
                    <div className="h-1.5 bg-gray-700 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-red-500 rounded-full"
                        style={{ width: `${Math.min(100, (c.lossAmt / (d.byClient[0]?.lossAmt || 1)) * 100)}%` }}
                      />
                    </div>
                    <p className="text-xs text-gray-500 mt-0.5">{c.count} shipments</p>
                  </div>
                </div>
              ))}
            </div>
          }
        </div>

        {/* By Zone */}
        <div className="bg-gray-800 rounded-xl p-5">
          <h3 className="font-semibold text-white mb-3">By Zone</h3>
          {d.byZone.length === 0
            ? <p className="text-gray-500 text-sm">No zone data — run Recalculate after uploading zone chart</p>
            : <div className="space-y-2">
              {d.byZone.map(([zone, v]) => (
                <div key={zone} className="flex items-center gap-2">
                  <div className="flex-1">
                    <div className="flex justify-between text-sm mb-1">
                      <span className="text-gray-300">{zone}</span>
                      <span className="text-red-400 font-medium">-${v.lossAmt.toFixed(2)}</span>
                    </div>
                    <div className="h-1.5 bg-gray-700 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-orange-500 rounded-full"
                        style={{ width: `${Math.min(100, (v.lossAmt / (d.byZone[0]?.[1]?.lossAmt || 1)) * 100)}%` }}
                      />
                    </div>
                    <p className="text-xs text-gray-500 mt-0.5">{v.count} shipments</p>
                  </div>
                </div>
              ))}
            </div>
          }
        </div>

        {/* By Weight */}
        <div className="bg-gray-800 rounded-xl p-5">
          <h3 className="font-semibold text-white mb-3">By Weight (billed)</h3>
          {d.byWeight.length === 0
            ? <p className="text-gray-500 text-sm">No data</p>
            : <div className="space-y-2">
              {d.byWeight.map(([bracket, v]) => (
                <div key={bracket} className="flex items-center gap-2">
                  <div className="flex-1">
                    <div className="flex justify-between text-sm mb-1">
                      <span className="text-gray-300">{bracket}</span>
                      <span className="text-red-400 font-medium">-${v.lossAmt.toFixed(2)}</span>
                    </div>
                    <div className="h-1.5 bg-gray-700 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-purple-500 rounded-full"
                        style={{ width: `${Math.min(100, (v.lossAmt / Math.max(...d.byWeight.map(([, x]) => x.lossAmt))) * 100)}%` }}
                      />
                    </div>
                    <p className="text-xs text-gray-500 mt-0.5">{v.count} shipments</p>
                  </div>
                </div>
              ))}
            </div>
          }
        </div>
      </div>

      {/* By Carrier/Service */}
      <div className="bg-gray-800 rounded-xl p-5">
        <h3 className="font-semibold text-white mb-3">By Carrier & Service (top 10)</h3>
        {d.byService.length === 0
          ? <p className="text-gray-500 text-sm">No losses recorded</p>
          : <table className="w-full text-sm">
            <thead>
              <tr className="text-gray-400 text-left border-b border-gray-700 text-xs uppercase">
                <th className="pb-2">Carrier · Service</th>
                <th className="pb-2 text-right"># Losses</th>
                <th className="pb-2 text-right">Total Lost</th>
                <th className="pb-2 text-right">Avg per Shipment</th>
                <th className="pb-2 w-40">Share</th>
              </tr>
            </thead>
            <tbody>
              {d.byService.map(([svc, v]) => (
                <tr key={svc} className="border-b border-gray-700/40 hover:bg-gray-700/30">
                  <td className="py-2.5 text-gray-200">{svc}</td>
                  <td className="py-2.5 text-right text-gray-400">{v.count}</td>
                  <td className="py-2.5 text-right text-red-400 font-medium">-${v.lossAmt.toFixed(2)}</td>
                  <td className="py-2.5 text-right text-gray-400">-${(v.lossAmt / v.count).toFixed(2)}</td>
                  <td className="py-2.5 pl-4">
                    <div className="h-2 bg-gray-700 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-red-500 rounded-full"
                        style={{ width: `${(v.lossAmt / d.totalLossAmt) * 100}%` }}
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        }
      </div>

      {/* Full Loss Shipments Table */}
      <div className="bg-gray-800 rounded-xl p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold text-white">All Loss Shipments</h3>
          <span className="text-xs text-gray-400">{d.lossCount} shipments · sorted by biggest loss first</span>
        </div>
        {d.losses.length === 0
          ? (
            <div className="text-center py-12">
              <p className="text-green-400 text-lg font-medium">✓ No loss shipments found</p>
              <p className="text-gray-500 text-sm mt-2">Either there are no losses, or rates haven&apos;t been calculated yet.</p>
              <p className="text-gray-600 text-xs mt-1">Try: Dashboard → Recalculate Weights after uploading rate cards.</p>
            </div>
          )
          : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-gray-400 text-left border-b border-gray-700 uppercase">
                    <th className="pb-2 pr-3">Date</th>
                    <th className="pb-2 pr-3">Order #</th>
                    <th className="pb-2 pr-3">Client</th>
                    <th className="pb-2 pr-3">Carrier · Service</th>
                    <th className="pb-2 pr-3 text-right">Wt (oz)</th>
                    <th className="pb-2 pr-3 text-center">Zone</th>
                    <th className="pb-2 pr-3 text-right">State</th>
                    <th className="pb-2 pr-3 text-right">We Paid</th>
                    <th className="pb-2 pr-3 text-right">Charged</th>
                    <th className="pb-2 text-right">Loss</th>
                  </tr>
                </thead>
                <tbody>
                  {d.losses.map((s: any) => (
                    <tr key={s.id} className="border-b border-gray-700/30 hover:bg-red-950/20">
                      <td className="py-2 pr-3 text-gray-400">{s.ship_date?.split('T')[0] ?? '—'}</td>
                      <td className="py-2 pr-3 font-mono text-gray-300">{s.order_number}</td>
                      <td className="py-2 pr-3 text-gray-300">{(s.clients as any)?.name ?? <span className="text-gray-600 italic">unassigned</span>}</td>
                      <td className="py-2 pr-3 text-gray-400">{s.carrier} · {s.service}</td>
                      <td className="py-2 pr-3 text-right text-gray-400">{(s.billed_weight ?? s.weight ?? 0).toFixed(1)}</td>
                      <td className="py-2 pr-3 text-center">
                        {s.zone
                          ? <span className="px-1.5 py-0.5 rounded text-xs" style={{ background: '#00AAFF22', color: '#00AAFF' }}>Z{s.zone}</span>
                          : <span className="text-gray-600">—</span>}
                      </td>
                      <td className="py-2 pr-3 text-right text-gray-400">{s.recipient_state ?? '—'}</td>
                      <td className="py-2 pr-3 text-right text-gray-300">${(s.actual_cost ?? 0).toFixed(2)}</td>
                      <td className="py-2 pr-3 text-right text-gray-300">${(s.client_rate ?? 0).toFixed(2)}</td>
                      <td className="py-2 text-right font-bold text-red-400">-${Math.abs(s.profit_loss ?? 0).toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-red-800/40">
                    <td colSpan={7} className="pt-3 text-red-400 text-xs font-semibold">TOTAL LOSSES</td>
                    <td className="pt-3 text-right text-gray-300 text-xs">${d.losses.reduce((s, r) => s + (r.actual_cost ?? 0), 0).toFixed(2)}</td>
                    <td className="pt-3 text-right text-gray-300 text-xs">${d.losses.reduce((s, r) => s + (r.client_rate ?? 0), 0).toFixed(2)}</td>
                    <td className="pt-3 text-right font-bold text-red-400">-${d.totalLossAmt.toFixed(2)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )
        }
      </div>
    </div>
  )
}

function StatCard({ label, value, sub, color }: { label: string; value: string; sub: string; color: string }) {
  const colors: Record<string, string> = {
    red: 'border-red-800/50 bg-red-950/40',
    green: 'border-green-800/50 bg-green-950/40',
    blue: 'border-[#00AAFF]/20 bg-[#00AAFF]/5',
  }
  return (
    <div className={`rounded-xl p-5 border ${colors[color] ?? 'bg-gray-800 border-gray-700'}`}>
      <p className="text-gray-400 text-xs uppercase tracking-wider mb-2">{label}</p>
      <p className="text-2xl font-bold text-white">{value}</p>
      <p className="text-gray-500 text-xs mt-1">{sub}</p>
    </div>
  )
}
