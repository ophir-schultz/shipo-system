import { supabaseAdmin } from '@/lib/supabase'
import {
  formatPrice, priceOf, sumPriced, sumAllOrUnknown, unpricedNote, UNPRICED_DASH,
} from '@/lib/billing/unpriced'
import { read, readErrors, loaded, isMigrationMissing, type LoadedData } from '@/lib/db/read'
import ViewUnreadable from '@/components/ui/ViewUnreadable'

export const dynamic = 'force-dynamic'

// Six reads aggregated into per-client margin and a four-card summary bar, and
// the aggregation is the problem: every figure on this page is a SUM across
// tables, so a read that returned `[]` because it failed did not blank a cell,
// it moved a total. Revenue = shipping + warehouse + inbound. Lose the inbound
// read and Net Profit is wrong by exactly the inbound margin, with no dash and
// no asterisk to say so -- on the screen whose entire purpose is to say whether
// this business makes money.
//
// So the whole page is refused together. There is no useful partial view here:
// "Total Revenue" with one of its three terms silently missing is not a smaller
// number than the truth, it is a different claim presented in the same font.
//
// The three tables campaigns_pnl.sql creates are the exception, and only when
// they are genuinely absent -- see the note on the per-table predicates below.

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
    // The three tables campaigns_pnl.sql creates: may legitimately not exist
    // yet, which is asked about by error code below -- NOT excused wholesale.
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

  // Asked per table rather than inferred from `campaigns` alone. Those three
  // reads were all excused by a single `migrationApplied = !campaignsRes.error`,
  // which is two errors in one line: it excused `inbound_shipments` on the
  // strength of a DIFFERENT table's result, and it read every failure of any
  // kind as "the table does not exist". With the migration applied and
  // inbound_shipments timing out, the old code printed a confident Net Profit
  // short by the whole inbound margin and no banner at all, because `campaigns`
  // had answered fine.
  const inboundMissing = isMigrationMissing(inboundRes)
  const campaignsMissing = isMigrationMissing(campaignsRes)
  const payoutsMissing = isMigrationMissing(payoutsRes)
  const migrationMissing = inboundMissing || campaignsMissing || payoutsMissing

  const shipRead = read('shipments', shipRes)
  const whRead = read('warehouse_daily_log', whRes)
  const clientsRead = read('clients', clientsRes)
  const inboundRead = read('inbound_shipments', inboundRes)
  const campaignsRead = read('campaigns', campaignsRes)
  const payoutsRead = read('referral_payouts', payoutsRes)

  // shipments / warehouse_daily_log / clients are never excused: they are not
  // created by any pending migration, so a failure on one of them is a failure.
  // The other three are excused only when THEY report a missing relation, which
  // is the state the yellow banner already describes and already scopes -- "the
  // per-client P&L below is live from real shipment + warehouse data".
  const unreadable = readErrors(
    shipRead,
    whRead,
    clientsRead,
    inboundMissing ? null : inboundRead,
    campaignsMissing ? null : campaignsRead,
    payoutsMissing ? null : payoutsRead,
  )

  // Everything from here to the return is inside the thunk, so on the failure
  // path none of it runs. Six tables aggregate into a per-client margin table;
  // a complete set of plausible $0.00 margins for every client should not exist
  // in the program at all, not even long enough to be thrown away.
  return { migrationMissing, page: loaded(unreadable, () => {
    const shipments = shipRead.rows
    const warehouse = whRead.rows
    const clients = clientsRead.rows
    const inbound = inboundRead.rows
    const campaigns = campaignsRead.rows
    const payouts = payoutsRead.rows

    // ---- Per-client fulfillment P&L ----
    //
    // `unpriced` is counted alongside the revenue it is missing from. A margin
    // computed over shipments whose rate is UNKNOWN treats them as revenue of
    // zero against a real carrier cost, which understates the margin by the
    // whole of their price -- on the screen whose only job is to report the
    // margin. They are excluded and counted instead.
    type Agg = {
      name: string; shipRev: number; shipCost: number; whRev: number
      inRev: number; inCost: number; unpriced: number
    }
    const byClient: Record<string, Agg> = {}
    const ensure = (id: string | null, name: string) => {
      const key = id ?? 'unassigned'
      if (!byClient[key]) byClient[key] = { name, shipRev: 0, shipCost: 0, whRev: 0, inRev: 0, inCost: 0, unpriced: 0 }
      return byClient[key]
    }

    let unassignedCount = 0
    let unassignedCost = 0
    let unassignedUnpriced = 0
    for (const s of shipments) {
      if (!s.client_id) {
        unassignedCount++
        const cost = priceOf(s.actual_cost)
        if (cost === null) unassignedUnpriced++
        else unassignedCost += cost
        continue
      }
      const a = ensure(s.client_id, (s.clients as any)?.name ?? 'Unassigned')
      const rate = priceOf(s.client_rate)
      if (rate === null) a.unpriced++
      else a.shipRev += rate
      // An unknown COST is the dangerous direction and used to be the one
      // handled carelessly: `priceOf(s.actual_cost) ?? 0` wore the sanctioned
      // coercion and then threw its answer away. An excluded revenue
      // understates profit, which is at worst a pessimistic figure; a cost
      // read as 0 against real revenue OVERSTATES profit, which is the figure
      // nobody double-checks. Both are now withheld and counted.
      const cost = priceOf(s.actual_cost)
      if (cost === null) a.unpriced++
      else a.shipCost += cost
    }
    for (const w of warehouse) {
      const a = ensure(w.client_id, 'Unassigned')
      // warehouse_daily_log.total is nullable for the same reason: the daily-log
      // route writes null for a line whose rate is not on the card.
      const total = priceOf(w.total)
      if (total === null) a.unpriced++
      else a.whRev += total
    }
    for (const i of inbound) {
      const a = ensure(i.client_id, (i.clients as any)?.name ?? 'Unassigned')
      // Both columns are `numeric(10,2) default 0` and nullable (see
      // supabase/campaigns_pnl.sql), and nothing in the app writes this table
      // -- the rows are hand-entered, which is the likeliest place in the
      // system for a money column to arrive genuinely blank.
      //
      // `unpriced` counts FIGURES withheld, not rows: one inbound line with
      // neither amount readable has withheld two numbers from this client's
      // margin, and the note beside the row says "not included", which is true
      // of both of them.
      const inRev = priceOf(i.billed_amount)
      if (inRev === null) a.unpriced++
      else a.inRev += inRev
      const inCost = priceOf(i.our_cost)
      if (inCost === null) a.unpriced++
      else a.inCost += inCost
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

    // Named and annotated rather than inferred, because the rows arrive as
    // `any` and `{ ...c, spend }` would make the whole row `any` again -- at
    // which point `fmt(c.spend)` compiles, `Math.abs(null)` is 0, and the
    // campaign with no spend entered is back to reporting $0.00 with nothing
    // to say so. The annotation is the only thing standing between the null
    // and a cell that formats it as money. Verified by positive control: with
    // the type in place, `fmt(c.spend)` is TS2345.
    type CampaignPnl = {
      id: string; name: string; channel: string; status: string
      spend: number | null; clientsWon: number; revenue: number
      profit: number | null; roi: number | null; cac: number | null
    }
    const campaignPnl = campaigns.map((c: any): CampaignPnl => {
      // Spend is UNKNOWN if either component is, and that has to propagate
      // rather than collapse: `(c.monthly_cost ?? 0) + (c.one_time_cost ?? 0)`
      // turned a campaign whose cost nobody has entered into a campaign that
      // cost nothing, and then divided by it. The results were an infinite ROI
      // reported as a tidy percentage and a CAC of $0.00 per client won --
      // which is not a flattering estimate, it is a fabricated one, and it is
      // the number that decides where the next month's budget goes.
      //
      // The rule itself lives in lib/billing/unpriced.ts rather than here,
      // because the type system cannot hold it: `spend: number | null` is
      // satisfied just as well by a producer that never returns null, so
      // reverting this line to `?? 0` would compile cleanly. Verified -- that
      // mutation survived a compile-time positive control. In a .ts module it
      // is covered by tests instead; .tsx files cannot be tested here at all
      // (vitest.config.ts excludes them), which is the whole reason the
      // decision moved.
      const spend = sumAllOrUnknown(c.monthly_cost, c.one_time_cost)
      const clientsWon = clientsByCampaign[c.id] ?? 0
      const revenue = revByCampaign[c.id] ?? 0
      const profit = spend === null ? null : revenue - spend
      const roi = spend !== null && spend > 0 ? ((revenue - spend) / spend) * 100 : null
      const cac = spend !== null && clientsWon > 0 ? spend / clientsWon : null
      return { ...c, spend, clientsWon, revenue, profit, roi, cac }
    }).sort((a, b) => b.revenue - a.revenue)

    // ---- Totals ----
    const totalRevenue = clientPnl.reduce((s, c) => s + c.revenue, 0)
    const totalCost = clientPnl.reduce((s, c) => s + c.cost, 0)
    const totalProfit = totalRevenue - totalCost
    // Derived from the per-row decision above rather than re-summing the
    // columns, so the headline figure and the table can never disagree about
    // which campaigns were counted.
    const totalSpend = campaignPnl.reduce((s, c) => (c.spend === null ? s : s + c.spend), 0)
    const unknownSpend = campaignPnl.filter(c => c.spend === null).length
    // `referral_payouts.amount` is `not null`, so the old `?? 0` was
    // unreachable -- but `numeric(10,2)` still arrives as a string over
    // PostgREST, and `0 + '12.34'` is '012.34'. sumPriced is here for the
    // coercion and the cent-accurate accumulation, not for a null nobody
    // expects; if one ever appears, `.unpriced` is what says so.
    const payoutSum = sumPriced(payouts, 'amount')
    const totalPayouts = payoutSum.total
    const pendingPayouts = sumPriced(payouts.filter((p: any) => p.status === 'pending'), 'amount').total

    return {
      clientPnl,
      campaignPnl,
      payouts,
      inbound,
      totalRevenue,
      totalCost,
      totalProfit,
      totalSpend,
      unknownSpend,
      totalPayouts,
      unmeasuredPayouts: payoutSum.unpriced,
      pendingPayouts,
      rawShipmentCount: shipments.length,
      unassignedCount,
      unassignedCost,
      unassignedUnpriced,
      activeCampaigns: campaigns.filter((c: any) => c.status === 'active').length,
      clientCount: clientPnl.filter(c => c.id !== 'unassigned').length,
    }
  }) }
}

function Header() {
  return (
    <div>
      <h2 className="text-2xl font-bold text-white">Campaigns + P&amp;L</h2>
      <p className="text-gray-400 text-sm mt-1">Marketing ROI by campaign, fulfillment margin by client, referral payouts, and the inbound receiving log.</p>
    </div>
  )
}

export default async function PnlPage() {
  const res = await getPnlData()
  if (!res.page.ok) {
    return (
      <div className="space-y-6">
        <Header />
        <ViewUnreadable message={res.page.error} />
      </div>
    )
  }
  // Annotated, not inferred. The body below reads `d.` dozens of times and
  // every one of those sites would take `undefined` without complaint, so this
  // line is what makes deleting the check above a compile error instead of a
  // quiet return to publishing a Net Profit assembled from reads that failed.
  const d: LoadedData<typeof res.page> = res.page.data
  const fmt = (n: number) => `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(2)}`
  // A dash for a figure that is genuinely unknown, and `fmt` otherwise so no
  // number already on this screen changes shape. Kept separate from `fmt`
  // rather than widening it, so that passing a `number | null` to a cell that
  // has not thought about the null stays a type error.
  const fmtOrDash = (n: number | null) => (n === null ? UNPRICED_DASH : fmt(n))

  return (
    <div className="space-y-6">
      {/* Header */}
      <Header />

      {res.migrationMissing && (
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
        <StatCard label="Marketing Spend" value={fmt(d.totalSpend)}
          sub={d.unknownSpend > 0
            ? `${d.activeCampaigns} active campaigns — ${d.unknownSpend} with no spend entered, excluded`
            : `${d.activeCampaigns} active campaigns`}
          color="gray" />
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
                  {d.campaignPnl.map(c => (
                    <tr key={c.id} className="border-b border-gray-700/40 hover:bg-gray-700/30">
                      <td className="py-2.5 pr-3 text-gray-200">{c.name}</td>
                      <td className="py-2.5 pr-3 text-gray-400">{CHANNEL_LABELS[c.channel] ?? c.channel}</td>
                      <td className="py-2.5 pr-3">
                        <span className={`px-1.5 py-0.5 rounded text-xs ${c.status === 'active' ? 'bg-green-900/50 text-green-400' : c.status === 'paused' ? 'bg-yellow-900/40 text-yellow-400' : 'bg-gray-700 text-gray-400'}`}>{c.status}</span>
                      </td>
                      <td className="py-2.5 pr-3 text-right text-gray-300"
                        title={c.spend === null ? 'Spend not entered for this campaign. Not $0 — ROI and CAC cannot be computed.' : undefined}>{fmtOrDash(c.spend)}</td>
                      <td className="py-2.5 pr-3 text-right text-gray-400">{c.clientsWon}</td>
                      <td className="py-2.5 pr-3 text-right text-gray-300">{fmt(c.revenue)}</td>
                      {/* Grey, not green. The old `c.profit >= 0` was decided
                          on a profit computed from a spend of zero, so an
                          un-costed campaign showed a green profit equal to its
                          whole revenue. */}
                      <td className={`py-2.5 pr-3 text-right font-medium ${c.profit === null ? 'text-gray-500' : c.profit >= 0 ? 'text-green-400' : 'text-red-400'}`}>{fmtOrDash(c.profit)}</td>
                      <td className="py-2.5 pr-3 text-right text-gray-400">{c.roi === null ? '—' : `${c.roi.toFixed(0)}%`}</td>
                      <td className="py-2.5 text-right text-gray-400">{c.cac === null ? '—' : fmt(c.cac)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-gray-600">
                    <td colSpan={3} className="pt-3 text-gray-300 text-xs font-semibold uppercase">
                      Total
                      {d.unknownSpend > 0 && (
                        <span className="block text-amber-400/90 text-xs font-normal normal-case mt-0.5">
                          ⚠ {d.unknownSpend} campaign{d.unknownSpend === 1 ? '' : 's'} with no spend entered, not included
                        </span>
                      )}
                    </td>
                    <td className="pt-3 text-right text-gray-300 text-sm">{fmt(d.totalSpend)}</td>
                    <td className="pt-3 text-right text-gray-400 text-sm">{d.campaignPnl.reduce((s, c) => s + c.clientsWon, 0)}</td>
                    <td className="pt-3 text-right text-gray-300 text-sm">{fmt(d.campaignPnl.reduce((s, c) => s + c.revenue, 0))}</td>
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
            {d.unassignedUnpriced > 0 && (
              <span className="block mt-1 text-orange-200/80">
                {d.unassignedUnpriced} of them have no readable carrier cost and are not in that figure — it is understated by an unknown amount.
              </span>
            )}
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
                      <td className="py-2.5 pr-3 text-gray-200">
                        {c.id === 'unassigned' ? <span className="text-gray-600 italic">unassigned</span> : c.name}
                        {/* Beside the client's name, because this client's
                            rate card is what has to change for the margin on
                            this row to mean anything. The count now covers
                            unknown COSTS as well as unknown revenue, so the
                            tooltip no longer promises which side is short. */}
                        {c.unpriced > 0 && (
                          <span className="block text-amber-400/90 text-xs"
                            title="Figures this row could not read and left out of its revenue, cost, profit and margin. They are not $0.">
                            ⚠ {unpricedNote(c.unpriced, 'line')}
                          </span>
                        )}
                      </td>
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
                    <td className="pt-3 text-gray-300 text-xs font-semibold uppercase">
                      Total
                      {d.clientPnl.reduce((s, c) => s + c.unpriced, 0) > 0 && (
                        <span className="block text-amber-400/90 text-xs font-normal normal-case mt-0.5">
                          ⚠ {unpricedNote(d.clientPnl.reduce((s, c) => s + c.unpriced, 0), 'line')}
                        </span>
                      )}
                    </td>
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
          {/* `amount` is `not null`, so this should never render. It exists
              because the sum knows the answer and dropping it is free, and
              because a payout total that silently omits a row is money owed to
              a partner that nobody is tracking. */}
          {d.unmeasuredPayouts > 0 && (
            <p className="mb-3 text-xs text-red-300">
              ⚠ {d.unmeasuredPayouts} payout{d.unmeasuredPayouts === 1 ? '' : 's'} have an unreadable amount and are
              excluded from both totals here.
            </p>
          )}
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
                      <td className="py-2 pr-3 text-right text-gray-300">{formatPrice(p.amount)}</td>
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
                      {/* The render-side twins of the two exclusions in the
                          inbound aggregation above. This log is where someone
                          checks what an inbound line was costed at, so a blank
                          column printing '$0.00' here is how it gets believed
                          and left alone. */}
                      <td className="py-2 pr-3 text-right text-gray-400">{formatPrice(i.our_cost)}</td>
                      <td className="py-2 text-right text-gray-300">{formatPrice(i.billed_amount)}</td>
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
