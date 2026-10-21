import { supabaseAdmin } from '@/lib/supabase'
import {
  formatPrice, priceOf, sumPriced, sumAbsPriced, UNPRICED_DASH,
} from '@/lib/billing/unpriced'
import { reconcile, reconciledOrUnknown, marginPct } from '@/lib/billing/profit-rollup'
import { billedOz, weightBracket } from '@/lib/billing/weight-bracket'
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
// AND THEY NOW AGREE WITH THE DASHBOARD. The three figures at the top of this
// page used to be three independent sums -- SUM(client_rate), SUM(actual_cost),
// SUM(profit_loss) -- over three DIFFERENT row subsets, with profit read from a
// stored column rather than subtracted. The dashboard was fixed to derive
// profit as revenue minus cost over one reconciled row set
// (lib/billing/profit-rollup.ts); this page was not, so the same period showed
// two different profits on two screens. Whichever figure was right, the pair of
// them was worse than either: two screens disagreeing about profit is how a
// team stops believing any number in the system. Both now come off `reconcile`,
// so `Revenue - Cost = Profit` holds to the cent here by construction, and the
// excluded rows are named beneath rather than silently absorbed.
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
    // ONE reconciliation, not three sums. The previous version summed
    // client_rate, actual_cost and profit_loss independently, so each figure
    // was built from a different set of rows: a shipment with an agreed rate
    // and no carrier invoice yet was IN revenue, out of cost and out of profit,
    // and the column of three read as a subtraction that had not been
    // performed. `reconcile` keeps only the rows where BOTH sides are known,
    // sums both over that one set, and DERIVES profit by subtracting in cents
    // -- the same call the dashboard makes, which is what makes the two screens
    // agree. The price of that is a narrower revenue figure, and the four
    // exclusion buckets it hands back are rendered below rather than dropped.
    const margin = reconcile(all)
    const triple = reconciledOrUnknown(margin)
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
    const byWeight = breakdown(weightBracket)

    return {
      losses,
      totalShipments,
      // reconciledOrUnknown, not the raw triple: when every row was withheld
      // the sum over the empty set is 0, and 0 rendered in green beside a ✓ is
      // the most reassuring thing this page can print on the strength of having
      // reconciled nothing at all. A period with no shipments at all is a real
      // $0 and is NOT dashed -- see the function.
      totalRevenue: triple.revenue,
      totalCost: triple.cost,
      totalProfit: triple.profit,
      marginPct: marginPct(margin),
      reconciledShipments: margin.reconciled,
      unpricedShipments: margin.unrated,
      uncostedShipments: margin.uncosted,
      unmeasuredShipments: margin.unmeasured,
      // Of the rows the figures ARE built from, how many have a stored
      // profit_loss that disagrees with client_rate - actual_cost. Nothing
      // above is derived from that column any more, but the loss TABLE below
      // still reads it per row, so a non-zero count here means the table and
      // the cards are describing the same shipments differently.
      staleProfits: margin.stale,
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
  /** A figure whose every contributing row was withheld is a dash, not $0.00. */
  const fmtOrDash = (n: number | null) => (n === null ? UNPRICED_DASH : fmt(n))
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
            They are excluded from the revenue, cost, profit and margin figures below, and
            they are not in the loss table — a shipment whose price is unknown cannot be
            shown to be a loss. They are not $0, and this is the urgent bucket: we paid a
            carrier and nobody agreed a price, so the work went out the door unbilled. Fix
            the client&rsquo;s rate card, then re-run the sync to price them.
          </p>
        </div>
      )}

      {/* Its own banner, and not folded into the one above, because the remedy
          is a different one. A missing RATE is a rate-card job; a missing
          CARRIER COST is waiting on, or importing, the carrier invoice. Telling
          someone to fix a rate card for a shipment whose rate is already fine
          sends them to the wrong screen. */}
      {d.uncostedShipments > 0 && (
        <div className="rounded-xl border border-amber-700/60 bg-amber-950/30 px-5 py-3">
          <p className="text-amber-300 text-sm font-semibold">
            ⚠ {d.uncostedShipments} shipment{d.uncostedShipments === 1 ? '' : 's'} have no carrier cost
          </p>
          <p className="text-amber-200/70 text-xs mt-1">
            They are excluded from the revenue, cost and profit figures below — all three,
            because those figures are now summed over one set of rows so that they subtract.
            A shipment whose cost is unknown has no knowable margin, so its revenue is held
            back with it rather than widening the gap on its own. They are not $0 — a
            shipment the carrier has not invoiced yet still cost us something, and its rate
            is still owed. Import the carrier invoice to fill them in.
          </p>
        </div>
      )}

      {/* The third exclusion bucket, which used to appear in no count at all.
          A row with neither a rate nor a cost was absent from all three sums
          and from both banners above, so it was invisible -- and "neither side
          known" is usually a sync that half-landed, which is a different job
          again from writing a rate card or chasing a carrier invoice. */}
      {d.unmeasuredShipments > 0 && (
        <div className="rounded-xl border border-amber-700/60 bg-amber-950/30 px-5 py-3">
          <p className="text-amber-300 text-sm font-semibold">
            ⚠ {d.unmeasuredShipments} shipment{d.unmeasuredShipments === 1 ? '' : 's'} have neither a rate nor a cost
          </p>
          <p className="text-amber-200/70 text-xs mt-1">
            Nothing is known about the money on these, so they are in none of the figures
            below. That is usually a sync that half-landed rather than a pricing gap — run
            the sync again, and if they persist they are worth reporting.
          </p>
        </div>
      )}

      {/* Not a money figure, a disagreement between two things on this page.
          The cards above no longer read the stored profit_loss column at all --
          they subtract cost from revenue -- but the loss TABLE at the bottom
          still prints that column per row, and `is_loss` is set from it. So a
          stale value does not corrupt the totals any more; it makes the table
          describe a shipment differently from the cards. Recalculate rewrites
          the column from the current rate card, which is the fix. */}
      {d.staleProfits > 0 && (
        <div className="rounded-xl border border-amber-700/60 bg-amber-950/30 px-5 py-3">
          <p className="text-amber-300 text-sm font-semibold">
            ⚠ {d.staleProfits} shipment{d.staleProfits === 1 ? '' : 's'} have a stored profit that no longer matches
          </p>
          <p className="text-amber-200/70 text-xs mt-1">
            Their saved profit figure disagrees with charged minus paid by a cent or more,
            so the rate or the cost changed after it was written. The totals above are
            unaffected — they subtract rather than read that column — but the Loss column in
            the table below comes from it, and so does whether a shipment appears here at
            all. Dashboard → Recalculate Weights rewrites them.
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
        {/* Both cards below are built from the SAME reconciled rows, so the
            figures in them subtract: Revenue minus Carrier cost is exactly Net
            Profit, to the cent. They used to come from three separate sums over
            three different row sets, which is why this page and the dashboard
            could print two different profits for one period.

            The label says "reconciled", not "all", because it is not all --
            and the count beneath says how many of how many. Colour follows the
            same rule as before: an UNKNOWN profit is not green, because the
            neutral card is the one that does not answer a question it cannot
            answer. */}
        <StatCard label="Net Profit (reconciled)"
          value={d.totalProfit === null ? UNPRICED_DASH : `${d.totalProfit >= 0 ? '+' : '-'}${fmt(d.totalProfit)}`}
          sub={[
            d.reconciledShipments === d.totalShipments
              ? `All ${d.totalShipments} assigned shipments`
              : `${d.reconciledShipments} of ${d.totalShipments} shipments — both sides known`,
            d.marginPct !== null ? `${d.marginPct.toFixed(1)}% margin` : '',
          ].filter(Boolean).join(' · ')}
          color={d.totalProfit === null ? 'unknown' : d.totalProfit >= 0 ? 'green' : 'red'} />
        <StatCard label="Revenue vs Cost"
          value={`${fmtOrDash(d.totalRevenue)} / ${fmtOrDash(d.totalCost)}`}
          sub={[
            'Revenue / Carrier cost — these subtract to Net Profit',
            d.unpricedShipments > 0 ? `${d.unpricedShipments} with no agreed rate` : '',
            d.uncostedShipments > 0 ? `${d.uncostedShipments} awaiting carrier cost` : '',
            d.unmeasuredShipments > 0 ? `${d.unmeasuredShipments} with neither` : '',
          ].filter(Boolean).join(' — ')}
          color={d.totalRevenue === null && d.totalCost === null ? 'unknown' : 'blue'} />
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
                      {/* A dash, not '0.0'. A printed weight of zero is a
                          measurement, and this column is the evidence someone
                          checks when a bracket above looks wrong. */}
                      <td className="py-2 pr-3 text-right text-gray-400">{billedOz(s)?.toFixed(1) ?? '—'}</td>
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
    // Deliberately not green and not red. A figure nobody could compute should
    // not borrow the styling of a good result or a bad one.
    unknown: 'border-gray-700 bg-gray-800',
  }
  return (
    <div className={`rounded-xl p-5 border ${colors[color] ?? 'bg-gray-800 border-gray-700'}`}>
      <p className="text-gray-400 text-xs uppercase tracking-wider mb-2">{label}</p>
      <p className="text-2xl font-bold text-white">{value}</p>
      <p className="text-gray-500 text-xs mt-1">{sub}</p>
    </div>
  )
}
