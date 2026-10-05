import { supabaseAdmin } from '@/lib/supabase'
import {
  formatPrice, priceOf, sumPriced, sumAbsPriced, unpricedNote, UNPRICED_DASH,
} from '@/lib/billing/unpriced'
import { read, readErrors, loaded, type LoadedData } from '@/lib/db/read'
import ViewUnreadable from '@/components/ui/ViewUnreadable'

// This page answers "which shipments are we losing money on". An unpriced
// shipment is NOT on it and must not be: `is_loss` is false when profit is
// UNKNOWN, deliberately, because a shipment of unknown profit is not evidence
// of a loss and filling a loss report with unknowns is how a real loss stops
// being noticed (see shipmentProfit in lib/billing/shipment-rate.ts).
//
// But the margin figures at the top are computed over ALL shipments, and those
// did include the unpriced ones as $0 revenue -- which makes the margin look
// worse than it is, on the one screen where a bad margin is the thing being
// investigated. They are now excluded from the figures and counted beside
// them instead.
//
// A failed read used to arrive here as `[]` and produce something stranger than
// an empty screen: "Loss Shipments 0 · 0.0% of all shipments · Total Loss
// Amount -$0.00". That is not missing information, it is the single most
// reassuring sentence this app can print, and it is printed on no evidence.
// Worse, the loss table is where a thin margin gets investigated, so the moment
// someone comes here asking "where is the money going" is exactly the moment a
// blank answer is most likely to be believed and acted on.
//
// Both reads are refused together. `lossRes` is the table and `allRes` is the
// denominator for every rate and total beside it, and a loss count without its
// denominator is not a partial answer -- 12 losses out of 0 shipments is not a
// smaller claim than 12 out of 4,000, it is an incoherent one.

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

  const lossRead = read('shipments (losses)', lossRes)
  const allRead = read('shipments (all assigned)', allRes)
  const unreadable = readErrors(lossRead, allRead)
  // Everything below is inside the thunk, so on the failure path not one of
  // these aggregations runs. A full set of byClient / byService / byZone /
  // byWeight breakdowns reading "no losses" should not exist in the program at
  // all, not even for long enough to be discarded.
  return loaded(unreadable, () => {
    const losses = lossRead.rows
    const all = allRead.rows

    const totalShipments = all.length
    const revenueSum = sumPriced(all, 'client_rate')
    const totalRevenue = revenueSum.total
    const unpricedShipments = revenueSum.unpriced
    const totalCost = sumPriced(all, 'actual_cost').total
    const totalProfit = sumPriced(all, 'profit_loss').total
    const lossSum = sumAbsPriced(losses, 'profit_loss')

    // Five breakdowns that each carried their own
    // `s + Math.abs(r.profit_loss ?? 0)` accumulator -- five copies of a rule
    // about money, which is the shape lib/billing/unpriced.ts exists to delete.
    // Group first, then let the one tested accumulator make all three decisions
    // the hand-rolled version got wrong: `Math.abs('')` is 0, so a column
    // arriving as an empty string became a confident $0.00 loss; adding dollars
    // as floats drifts; and `?? 0` cannot tell a loss of nothing from a loss
    // nobody has measured.
    // `typeof losses[number]` rather than a bare `any`: today the rows are
    // untyped, so it resolves to the same thing, but it says "whatever a loss
    // row is" instead of "anything at all" -- and it follows along for free if
    // these rows ever get a type.
    const breakdown = (
      keyOf: (s: typeof losses[number]) => string,
    ): [string, { count: number; lossAmt: number }][] => {
      // A Map, not an object literal, because the keys here are client names
      // and carrier strings off the wire -- `__proto__` is a real string and
      // `byClient['__proto__'] = ...` does not do what it looks like.
      const groups = new Map<string, typeof losses>()
      for (const s of losses) {
        const key = keyOf(s)
        const g = groups.get(key)
        if (g) g.push(s)
        else groups.set(key, [s])
      }
      return [...groups].map(([key, rows]) => [
        key,
        { count: rows.length, lossAmt: sumAbsPriced(rows, 'profit_loss').total },
      ])
    }

    const byService = breakdown(s => `${s.carrier ?? '?'} · ${s.service ?? '?'}`)
    const byZone = breakdown(s => (s.zone ? `Zone ${s.zone}` : 'Zone unknown'))
    const byClient = breakdown(s => (s.clients as any)?.name ?? 'Unassigned')
    const byWeight = breakdown(s => {
      const oz = s.billed_weight ?? s.weight ?? 0
      const lb = Math.ceil(oz / 16)
      return lb <= 1 ? '≤1 lb' : lb <= 5 ? '2–5 lb' : lb <= 10 ? '6–10 lb' : lb <= 20 ? '11–20 lb' : '20+ lb'
    })

    return {
      losses,
      totalShipments,
      totalRevenue,
      unpricedShipments,
      totalCost,
      totalProfit,
      totalLossAmt: lossSum.total,
      // Should always be 0 -- see the banner that renders it. Carried rather
      // than asserted: the sum knows what it withheld, and dropping the number
      // here is exactly how the old accumulators managed to understate a loss
      // total with nothing on the screen to say so.
      unmeasuredLosses: lossSum.unpriced,
      lossCount: losses.length,
      lossRate: totalShipments > 0 ? (losses.length / totalShipments) * 100 : 0,
      byClient: byClient.map(([name, v]) => ({ name, ...v })).sort((a, b) => b.lossAmt - a.lossAmt),
      byService: byService.sort((a, b) => b[1].lossAmt - a[1].lossAmt).slice(0, 10),
      byZone: byZone.sort((a, b) => a[0].localeCompare(b[0])),
      byWeight,
    }
  })
}

function Header() {
  return (
    <div>
      <h2 className="text-2xl font-bold text-white">Loss Analysis</h2>
      <p className="text-gray-400 text-sm mt-1">All shipments where carrier cost exceeded what we charged the client</p>
    </div>
  )
}

export default async function LossesPage() {
  const page = await getLossData()
  if (!page.ok) {
    return (
      <div className="space-y-6">
        <Header />
        <ViewUnreadable message={page.error} />
      </div>
    )
  }
  // Annotated, not inferred. The body below reads `d.` about forty times, and
  // every one of those sites would accept `undefined` happily through the `any`
  // rows; the annotation is what makes deleting the check above a compile error
  // rather than a silent return to printing "-$0.00" over an unread table.
  const d: LoadedData<typeof page> = page.data
  const fmt = (n: number) => `$${Math.abs(n).toFixed(2)}`
  // '-$12.34' for a measured loss, a dash when the row's profit will not read
  // as a number at all. `Math.abs(s.profit_loss ?? 0)` printed '-$0.00' in that
  // case, which in a column headed "Loss" reads as "we lost nothing on this
  // one" -- the most misleading thing it could say about a row it cannot read.
  const lossFigure = (value: unknown) => {
    const n = priceOf(value)
    return n === null ? UNPRICED_DASH : `-$${Math.abs(n).toFixed(2)}`
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <Header />

      {/* An unpriced shipment cannot be known to be a loss, so it is correctly
          absent from the table below -- but it is also absent from the margin
          figures, and that needs saying on the screen where a thin margin is
          the thing being investigated. A shipment with no agreed rate may well
          be the worst loss in the business; nothing here can tell yet. */}
      {d.unpricedShipments > 0 && (
        <div className="rounded-xl border border-amber-700/60 bg-amber-950/30 px-5 py-3">
          <p className="text-amber-300 text-sm font-semibold">
            ⚠ {d.unpricedShipments} shipment{d.unpricedShipments === 1 ? '' : 's'} have no agreed rate
          </p>
          <p className="text-amber-200/70 text-xs mt-1">
            They are excluded from the revenue, profit and margin figures below, and they
            are not in the loss table — a shipment whose price is unknown cannot be shown
            to be a loss. They are not $0. Fix the client&rsquo;s rate card, then re-run the
            sync to price them.
          </p>
        </div>
      )}

      {/* Instrumenting an invariant rather than trusting it. Every row on this
          page has is_loss = true, which shipmentProfit can only set on the
          branch where both figures came back finite, so this count should be
          zero forever. If it is ever not, every total and breakdown below is
          understated by an unknown amount -- which is precisely the failure the
          five `Math.abs(x ?? 0)` accumulators were silently absorbing. */}
      {d.unmeasuredLosses > 0 && (
        <div className="rounded-xl border border-red-700/60 bg-red-950/30 px-5 py-3">
          <p className="text-red-300 text-sm font-semibold">
            ⚠ {d.unmeasuredLosses} loss shipment{d.unmeasuredLosses === 1 ? '' : 's'} have an unreadable loss amount
          </p>
          <p className="text-red-200/70 text-xs mt-1">
            They are flagged as losses, but their profit figure will not read as a number,
            so every total and breakdown on this page is understating the loss by an unknown
            amount. They are not $0. This should not be reachable — worth reporting.
          </p>
        </div>
      )}

      {/* Summary bar */}
      <div className="grid grid-cols-4 gap-4">
        <StatCard label="Loss Shipments" value={d.lossCount.toString()} sub={`${d.lossRate.toFixed(1)}% of all shipments`} color="red" />
        <StatCard label="Total Loss Amount" value={`-${fmt(d.totalLossAmt)}`} sub="Money we lost on those shipments" color="red" />
        <StatCard label="Net Profit (all)" value={`${d.totalProfit >= 0 ? '+' : '-'}${fmt(d.totalProfit)}`}
          sub={d.unpricedShipments > 0
            ? `${d.totalShipments - d.unpricedShipments} of ${d.totalShipments} priced shipments`
            : `${d.totalShipments} assigned shipments`}
          color={d.totalProfit >= 0 ? 'green' : 'red'} />
        <StatCard label="Revenue vs Cost" value={`${fmt(d.totalRevenue)} / ${fmt(d.totalCost)}`}
          sub={d.unpricedShipments > 0
            ? `Revenue / Carrier cost — ${unpricedNote(d.unpricedShipments)}`
            : 'Revenue / Carrier cost'}
          color="blue" />
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
                      <td className="py-2 pr-3 text-right text-gray-300">{formatPrice(s.actual_cost)}</td>
                      <td className="py-2 pr-3 text-right text-gray-300">{formatPrice(s.client_rate)}</td>
                      <td className="py-2 text-right font-bold text-red-400">{lossFigure(s.profit_loss)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-red-800/40">
                    <td colSpan={7} className="pt-3 text-red-400 text-xs font-semibold">TOTAL LOSSES</td>
                    {/* Every row in this table has is_loss = true, which can
                        only be set when both figures are known, so neither of
                        these totals can be withholding anything. sumPriced is
                        used anyway for the cent-accurate accumulation and the
                        string coercion -- not because a null is expected. */}
                    <td className="pt-3 text-right text-gray-300 text-xs">${sumPriced(d.losses, 'actual_cost').total.toFixed(2)}</td>
                    <td className="pt-3 text-right text-gray-300 text-xs">${sumPriced(d.losses, 'client_rate').total.toFixed(2)}</td>
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
