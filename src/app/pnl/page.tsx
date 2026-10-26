import { supabaseAdmin } from '@/lib/supabase'
import {
  formatPrice, sumPriced, sumAllOrUnknown, unpricedNote, UNPRICED_DASH,
  pricedTally, combinePriced, totalOrUnknown,
  type PricedTally, type PricedSum,
} from '@/lib/billing/unpriced'
import { pnlFigures, campaignFigures, attributedRevenue } from '@/lib/billing/margin'
import { read, readErrors, loaded, isMigrationMissing, type LoadedData } from '@/lib/db/read'
import { readAllPages } from '@/lib/db/page'
import ViewUnreadable from '@/components/ui/ViewUnreadable'
import PartnerPayouts from '@/components/pnl/PartnerPayouts'

export const dynamic = 'force-dynamic'

/** The shape the paged shipment read returns; readAllPages cannot infer it. */
interface PnlShipmentRow {
  client_id: string | null
  client_rate: number | null
  actual_cost: number | null
  profit_loss: number | null
  clients: { name: string } | { name: string }[] | null
}

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
    // PAGED. Every shipment ever, with no window, feeding the per-client P&L.
    // Unpaged it returned the first 1000 rows of 1823 as a complete answer --
    // PostgREST caps at `db-max-rows` and says nothing, so the P&L was short
    // by whatever fell past row 1000 and read as a finished number. Found on
    // 2026-10-23 on the dashboard, where the same defect halved the revenue
    // figure; see src/lib/db/page.ts.
    readAllPages<PnlShipmentRow>((from, to) =>
      supabaseAdmin
        .from('shipments')
        .select('client_id, client_rate, actual_cost, profit_loss, clients(name)')
        .order('id').range(from, to)),
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
    //
    // Excluding and counting was only half the fix, and this is the other half.
    // A client whose figures were ALL withheld came out of the loops below with
    // `shipRev: 0, shipCost: 0`, and `0 - 0` is a profit of 0, and
    // `revenue > 0 ? ... : 0` made that a margin of 0%, printed in green beside
    // a $0.00 revenue and a $0.00 cost. The amber count was on the row, but
    // every figure on the row read as a decided, break-even zero. A client
    // nobody has priced is not a client who broke even.
    //
    // So each column is a tally rather than a running number: the count of
    // figures it could not read travels with its total, and `totalOrUnknown`
    // turns "counted some, read none" into null while leaving "counted none"
    // -- a client with no shipments at all -- as the real $0 it is.
    type Agg = {
      name: string
      shipRev: PricedTally; shipCost: PricedTally; whRev: PricedTally
      inRev: PricedTally; inCost: PricedTally
    }
    const byClient: Record<string, Agg> = {}
    const ensure = (id: string | null, name: string) => {
      const key = id ?? 'unassigned'
      if (!byClient[key]) {
        byClient[key] = {
          name,
          shipRev: pricedTally(), shipCost: pricedTally(), whRev: pricedTally(),
          inRev: pricedTally(), inCost: pricedTally(),
        }
      }
      return byClient[key]
    }

    let unassignedCount = 0
    // A tally for the same reason as the per-client columns. The banner this
    // feeds said "these N shipments carry $0.00 in carrier cost" when not one
    // of their costs could be read, and then said so again in the next
    // sentence; one of the two had to be the dash.
    const unassignedCostTally = pricedTally()
    for (const s of shipments) {
      if (!s.client_id) {
        unassignedCount++
        unassignedCostTally.take(s.actual_cost)
        continue
      }
      const a = ensure(s.client_id, (s.clients as any)?.name ?? 'Unassigned')
      a.shipRev.take(s.client_rate)
      // An unknown COST is the dangerous direction and used to be the one
      // handled carelessly: `priceOf(s.actual_cost) ?? 0` wore the sanctioned
      // coercion and then threw its answer away. An excluded revenue
      // understates profit, which is at worst a pessimistic figure; a cost
      // read as 0 against real revenue OVERSTATES profit, which is the figure
      // nobody double-checks. Both are now withheld and counted.
      a.shipCost.take(s.actual_cost)
    }
    for (const w of warehouse) {
      const a = ensure(w.client_id, 'Unassigned')
      // warehouse_daily_log.total is nullable for the same reason: the daily-log
      // route writes null for a line whose rate is not on the card.
      a.whRev.take(w.total)
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
      a.inRev.take(i.billed_amount)
      a.inCost.take(i.our_cost)
    }

    // Unknowns sort last, by a comparator that says so. `y.profit - x.profit`
    // with a null in it is NaN, and a NaN comparator is specified to mean
    // "equal", so the unknown rows would land wherever the sort happened to
    // leave them -- which in practice means scattered through a table ordered
    // by profit, reading as though their position meant something.
    const byDescUnknownLast = (a: number | null, b: number | null) =>
      a === null ? (b === null ? 0 : 1) : b === null ? -1 : b - a

    // The sum over no figures at all, which `totalOrUnknown` reads as a real $0
    // rather than UNKNOWN. Taken from combinePriced, which is tested to return
    // exactly this for no parts, rather than restating the literal here.
    const EMPTY_SUM = combinePriced()

    const clientPnl = Object.entries(byClient).map(([id, a]) => {
      // combinePriced rather than adding the totals, so the counts survive the
      // addition: revenue is UNKNOWN only when no part of it could be read, and
      // a client with warehouse revenue but no readable shipment rate still has
      // a real -- partial, and labelled -- revenue figure.
      const revSum = combinePriced(a.shipRev.sum(), a.whRev.sum(), a.inRev.sum())
      const costSum = combinePriced(a.shipCost.sum(), a.inCost.sum())
      // The four figures come from lib/billing/margin.ts rather than being
      // written out here, because reverting any of them to a zero compiles
      // cleanly in this file -- see that module's header, which records the
      // positive control. Composed, the rule is covered by tests; inline, it
      // was covered by nothing, this file being a .tsx.
      const figures = pnlFigures(revSum, costSum)
      // Built explicitly rather than `{ id, ...a, ...figures }`, because
      // spreading the Agg would put the five tallies on the row and shadow
      // `cost` with one of them.
      return {
        id,
        name: a.name,
        // Per column as well as in total, so that a client with real warehouse
        // revenue and no readable shipment rate shows which of the two it is
        // rather than $0.00 in both.
        shipRev: totalOrUnknown(a.shipRev.sum()),
        whRev: totalOrUnknown(a.whRev.sum()),
        inRev: totalOrUnknown(a.inRev.sum()),
        revSum,
        costSum,
        revenue: figures.revenue,
        cost: figures.cost,
        profit: figures.profit,
        margin: figures.margin,
        unpriced: figures.unread,
      }
    }).sort((x, y) => byDescUnknownLast(x.profit, y.profit))

    // client_id -> total fulfillment revenue (for campaign attribution).
    // `number | null` rather than `number`, so that an unknown revenue cannot
    // reach a campaign's ROI as a zero.
    const clientRevenue: Record<string, number | null> = {}
    for (const c of clientPnl) clientRevenue[c.id] = c.revenue

    // ---- Campaign ROI ----
    const clientsByCampaign: Record<string, number> = {}
    const revByCampaign: Record<string, PricedTally> = {}
    for (const c of clients) {
      const cid = (c as any).acquisition_campaign_id
      if (cid) {
        clientsByCampaign[cid] = (clientsByCampaign[cid] ?? 0) + 1
        if (!revByCampaign[cid]) revByCampaign[cid] = pricedTally()
        // Three cases where `(clientRevenue[c.id] ?? 0)` had one: a client with
        // no rows at all contributes a real $0, a client whose figures could not
        // be read contributes nothing and is counted, and a number is itself.
        // The distinction is in lib/billing/margin.ts because `?? 0` reads as
        // the obvious tidy-up of it and would re-merge the two states it exists
        // to separate.
        revByCampaign[cid].take(attributedRevenue(clientRevenue[c.id]))
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
      spend: number | null; clientsWon: number; revenue: number | null
      revSum: PricedSum
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
      // A campaign nobody has been tagged to has no tally, and its $0.00 of
      // attributed revenue is a real zero -- that is what an untagged campaign
      // has earned. A campaign whose every tagged client has unreadable revenue
      // is a different statement, and now makes a different one.
      const revSum = revByCampaign[c.id]?.sum() ?? EMPTY_SUM
      const revenue = totalOrUnknown(revSum)
      // Profit, ROI and CAC from the same tested module, for the same reason.
      // ROI in particular: an unknown revenue against a real spend used to give
      // a confident -100%, "this campaign lost its entire budget", which is an
      // argument for cancelling it assembled from figures nobody had read.
      const { profit, roi, cac } = campaignFigures(revenue, spend, clientsWon)
      return { ...c, spend, clientsWon, revenue, revSum, profit, roi, cac }
    }).sort((a, b) => byDescUnknownLast(a.revenue, b.revenue))

    // ---- Totals ----
    //
    // Derived from the per-row sums rather than re-read off the tables, so the
    // headline cards and the table footer can never disagree with the rows
    // about which figures were counted. A total is UNKNOWN only when every
    // figure under it was withheld; one readable client rescues it, and the
    // count beside it is what says the rest are missing.
    const revenueSum = combinePriced(...clientPnl.map(c => c.revSum))
    const costSum = combinePriced(...clientPnl.map(c => c.costSum))
    // The same function the rows use, so the footer cannot decide differently
    // from the table above it about what counts as unknown.
    const totals = pnlFigures(revenueSum, costSum)
    const totalRevenue = totals.revenue
    const totalCost = totals.cost
    const totalProfit = totals.profit
    // Derived from the per-row decision above rather than re-summing the
    // columns, so the headline figure and the table can never disagree about
    // which campaigns were counted.
    //
    // sumPriced over the rows rather than `reduce((s, c) => s + c.spend, 0)`
    // beside a separate `.filter(...).length`, for two reasons, only one of
    // which is the arithmetic:
    //
    //   - The total and the count of what it left out came from two separate
    //     passes that had to agree with each other by hand. That is the
    //     coupling this module exists to delete, and the statement that gets
    //     forgotten is always the count.
    //   - It accumulates in cents. Campaign spends are 2dp figures and adding
    //     them as floats drifts: `1752.10 + 297.94 + 2934.02` is
    //     4984.0599999999995. Measured before being asserted -- 29.8% of
    //     realistic 2-to-7-campaign spend sets drift this way, and NONE of two
    //     million of them rendered differently, because `fmt` is toFixed(2) and
    //     the exact sum of 2dp values lands ON a cent, a full 0.005 from the
    //     nearest rounding boundary against a drift of ~7e-12. So this half
    //     moves no figure on the page today and is not claimed to. It is here
    //     because toFixed(2) is a property of the two call sites, not of the
    //     value: the moment this total is divided, exported, or compared
    //     against the cent-accurate sums beside it, the drift is live, and a
    //     second rule for rounding the same money is the thing that disagrees
    //     in the last cent.
    const spendSum = sumPriced(campaignPnl, 'spend')
    // A spend of $0.00 across every campaign is the same defect the three cards
    // above were just fixed for: when NOBODY has entered a spend, the old
    // reduce returned 0 and the card read "Marketing Spend $0.00", which is the
    // most reassuring thing this page can say about a budget nobody recorded.
    const totalSpend = totalOrUnknown(spendSum)
    const unknownSpend = spendSum.unpriced
    // The campaign table's revenue footer, computed here for the same reason:
    // it was `reduce((s, c) => s + c.revenue, 0)` inline in the JSX, which a
    // nullable revenue turns into the string 'NaN' on screen. Reducing money in
    // a template is how this defect keeps coming back, so the reduction moves
    // into the data layer where the null is visible.
    const campaignRevenueSum = combinePriced(...campaignPnl.map(c => c.revSum))
    const campaignRevenue = totalOrUnknown(campaignRevenueSum)
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
      // The counts that belong to each of those three figures, so a card can
      // say what its own total left out. Three sums over three different
      // columns withhold three different sets of figures; one count quoted for
      // all of them is a figure described by somebody else's footnote.
      unreadRevenue: revenueSum.unpriced,
      unreadCost: costSum.unpriced,
      countedFigures: revenueSum.counted + costSum.counted,
      totalSpend,
      unknownSpend,
      campaignRevenue,
      unreadCampaignRevenue: campaignRevenueSum.unpriced,
      totalPayouts,
      unmeasuredPayouts: payoutSum.unpriced,
      pendingPayouts,
      rawShipmentCount: shipments.length,
      unassignedCount,
      unassignedCost: totalOrUnknown(unassignedCostTally.sum()),
      unassignedUnpriced: unassignedCostTally.sum().unpriced,
      activeCampaigns: campaigns.filter((c: any) => c.status === 'active').length,
      clientCount: clientPnl.filter(c => c.id !== 'unassigned').length,
    }
  }) }
}

function Header() {
  return (
    <div>
      <h2 className="text-2xl font-bold text-[#0B1220]">Campaigns + P&amp;L</h2>
      <p className="text-[#4B4F58] text-sm mt-1">Marketing ROI by campaign, fulfillment margin by client, referral payouts, and the inbound receiving log.</p>
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
        <StatCard label="Total Revenue" value={fmtOrDash(d.totalRevenue)}
          sub={d.unreadRevenue > 0
            ? `${d.clientCount} active clients — ${d.unreadRevenue} revenue figure${d.unreadRevenue === 1 ? '' : 's'} unreadable, excluded`
            : `${d.clientCount} active clients`}
          color={d.totalRevenue === null ? 'unknown' : 'blue'} />
        <StatCard label="Total Cost" value={fmtOrDash(d.totalCost)}
          sub={d.unreadCost > 0
            ? `Carrier + receiving cost — ${d.unreadCost} unreadable, excluded`
            : 'Carrier + receiving cost'}
          color={d.totalCost === null ? 'unknown' : 'gray'} />
        {/* Not green when it is unknown. A Net Profit of $0.00 in green is the
            single most reassuring thing this page can say, and it was what it
            said when every figure under it had been withheld. */}
        <StatCard label="Net Profit" value={fmtOrDash(d.totalProfit)}
          sub={d.totalProfit === null
            ? 'No readable revenue or cost to compute it from'
            : 'Gross of warehouse labor'}
          color={d.totalProfit === null ? 'unknown' : d.totalProfit >= 0 ? 'green' : 'red'} />
        {/* A dash, not $0.00, when not one campaign has a spend entered. The
            count in `sub` was already telling the truth underneath a figure
            that was not. */}
        <StatCard label="Marketing Spend" value={fmtOrDash(d.totalSpend)}
          sub={d.totalSpend === null
            ? `${d.activeCampaigns} active campaigns — no spend entered for any of them`
            : d.unknownSpend > 0
              ? `${d.activeCampaigns} active campaigns — ${d.unknownSpend} with no spend entered, excluded`
              : `${d.activeCampaigns} active campaigns`}
          color={d.totalSpend === null ? 'unknown' : 'gray'} />
      </div>

      {/* ---- Marketing Campaign P&L ---- */}
      <div className="bg-white rounded-xl p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold text-[#0B1220]">Marketing Campaign P&amp;L</h3>
          <span className="text-xs text-[#4B4F58]">Revenue is attributed once clients are tagged to a campaign</span>
        </div>
        {d.campaignPnl.length === 0
          ? <p className="text-[#6B7A8D] text-sm">No campaigns yet. Run the migration to seed the known campaigns, or add one via the form.</p>
          : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-[#4B4F58] text-left border-b border-[#E2E8F0] text-xs uppercase">
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
                    <tr key={c.id} className="border-b border-[#E2E8F0]/40 hover:bg-[#EEF3FA]/30">
                      <td className="py-2.5 pr-3 text-gray-200">{c.name}</td>
                      <td className="py-2.5 pr-3 text-[#4B4F58]">{CHANNEL_LABELS[c.channel] ?? c.channel}</td>
                      <td className="py-2.5 pr-3">
                        <span className={`px-1.5 py-0.5 rounded text-xs ${c.status === 'active' ? 'bg-green-900/50 text-green-400' : c.status === 'paused' ? 'bg-yellow-900/40 text-yellow-400' : 'bg-[#EEF3FA] text-[#4B4F58]'}`}>{c.status}</span>
                      </td>
                      <td className="py-2.5 pr-3 text-right text-[#3A4658]"
                        title={c.spend === null ? 'Spend not entered for this campaign. Not $0 — ROI and CAC cannot be computed.' : undefined}>{fmtOrDash(c.spend)}</td>
                      <td className="py-2.5 pr-3 text-right text-[#4B4F58]">{c.clientsWon}</td>
                      <td className="py-2.5 pr-3 text-right text-[#3A4658]"
                        title={c.revenue === null
                          ? 'Every client tagged to this campaign has unreadable fulfillment revenue. Not $0 — ROI and profit cannot be computed.'
                          : c.revSum.unpriced > 0
                            ? `${c.revSum.unpriced} of ${c.revSum.counted} tagged clients have unreadable revenue and are not in this figure.`
                            : undefined}>{fmtOrDash(c.revenue)}</td>
                      {/* Grey, not green. The old `c.profit >= 0` was decided
                          on a profit computed from a spend of zero, so an
                          un-costed campaign showed a green profit equal to its
                          whole revenue. */}
                      <td className={`py-2.5 pr-3 text-right font-medium ${c.profit === null ? 'text-[#6B7A8D]' : c.profit >= 0 ? 'text-green-400' : 'text-red-400'}`}>{fmtOrDash(c.profit)}</td>
                      <td className="py-2.5 pr-3 text-right text-[#4B4F58]">{c.roi === null ? '—' : `${c.roi.toFixed(0)}%`}</td>
                      <td className="py-2.5 text-right text-[#4B4F58]">{c.cac === null ? '—' : fmt(c.cac)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-[#CBD5E1]">
                    <td colSpan={3} className="pt-3 text-[#3A4658] text-xs font-semibold uppercase">
                      Total
                      {d.unknownSpend > 0 && (
                        <span className="block text-amber-400/90 text-xs font-normal normal-case mt-0.5">
                          ⚠ {d.unknownSpend} campaign{d.unknownSpend === 1 ? '' : 's'} with no spend entered, not included
                        </span>
                      )}
                      {/* Its own line, because the remedy is a different one:
                          a missing spend is a figure to enter here, an
                          unreadable client revenue is a rate card to fix. */}
                      {d.unreadCampaignRevenue > 0 && (
                        <span className="block text-amber-400/90 text-xs font-normal normal-case mt-0.5">
                          ⚠ {d.unreadCampaignRevenue} tagged client{d.unreadCampaignRevenue === 1 ? '' : 's'} with unreadable revenue, not included
                        </span>
                      )}
                    </td>
                    <td className="pt-3 text-right text-[#3A4658] text-sm">{fmtOrDash(d.totalSpend)}</td>
                    <td className="pt-3 text-right text-[#4B4F58] text-sm">{d.campaignPnl.reduce((s, c) => s + c.clientsWon, 0)}</td>
                    <td className="pt-3 text-right text-[#3A4658] text-sm">{fmtOrDash(d.campaignRevenue)}</td>
                    <td className="pt-3 text-right text-sm text-[#3A4658]" colSpan={3}></td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )
        }
      </div>

      {/* ---- Per-Client Fulfillment P&L ---- */}
      <div className="bg-white rounded-xl p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold text-[#0B1220]">Per-Client Fulfillment P&amp;L</h3>
          <span className="text-xs text-[#4B4F58]">Revenue = shipping + warehouse + inbound · Cost = carrier + receiving · gross of labor</span>
        </div>
        {d.unassignedCount > 0 && (
          <div className="mb-4 rounded-lg px-4 py-3 border border-orange-800/40 bg-orange-950/20 text-xs text-orange-300/90">
            <span className="font-medium text-orange-300">{d.unassignedCount} unassigned shipments</span> carry {fmtOrDash(d.unassignedCost)} in carrier cost not yet attributed to any client or priced. Assign them to clients + run rate calculation to move this cost into per-client margin.
            {d.unassignedUnpriced > 0 && (
              <span className="block mt-1 text-orange-200/80">
                {/* Two sentences, because "understated by an unknown amount"
                    describes a figure, and when every cost was unreadable there
                    is no figure above to understate -- only a dash. */}
                {d.unassignedCost === null
                  ? `None of their carrier costs could be read, so there is no total above. It is not $0.00.`
                  : `${d.unassignedUnpriced} of them have no readable carrier cost and are not in that figure — it is understated by an unknown amount.`}
              </span>
            )}
          </div>
        )}
        {d.clientPnl.length === 0
          ? (
            <div className="text-sm text-[#4B4F58] space-y-1">
              <p>No priced, client-assigned shipments yet — so there&apos;s nothing to compute margin on.</p>
              <p className="text-[#6B7A8D] text-xs">{d.rawShipmentCount} shipments are uploaded but not linked to a client or rated. Assign them to clients and run rate calculation (Shipments → Recalculate) to light up per-client P&amp;L.</p>
            </div>
          )
          : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-[#4B4F58] text-left border-b border-[#E2E8F0] text-xs uppercase">
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
                    <tr key={c.id} className="border-b border-[#E2E8F0]/40 hover:bg-[#EEF3FA]/30">
                      <td className="py-2.5 pr-3 text-gray-200">
                        {c.id === 'unassigned' ? <span className="text-[#6B7A8D] italic">unassigned</span> : c.name}
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
                      {/* A dash per column rather than one for the row, because
                          the columns fail independently: a client can have real
                          warehouse revenue and no readable shipment rate, and
                          that is worth seeing. The alternative was $0.00 in
                          every one of them. */}
                      <td className="py-2.5 pr-3 text-right text-[#4B4F58]">{fmtOrDash(c.shipRev)}</td>
                      <td className="py-2.5 pr-3 text-right text-[#4B4F58]">{fmtOrDash(c.whRev)}</td>
                      <td className="py-2.5 pr-3 text-right text-[#4B4F58]">{fmtOrDash(c.inRev)}</td>
                      <td className="py-2.5 pr-3 text-right text-[#3A4658]">{fmtOrDash(c.revenue)}</td>
                      <td className="py-2.5 pr-3 text-right text-[#3A4658]">{fmtOrDash(c.cost)}</td>
                      <td className={`py-2.5 pr-3 text-right font-medium ${c.profit === null ? 'text-[#6B7A8D]' : c.profit >= 0 ? 'text-green-400' : 'text-red-400'}`}>{fmtOrDash(c.profit)}</td>
                      <td className="py-2.5 pl-1">
                        {/* No bar at all for an unknown margin, and no colour.
                            `revenue > 0 ? ... : 0` gave a client whose every
                            figure was withheld a margin of 0% in green with an
                            empty bar, which is what a client trading exactly at
                            cost looks like. The bar is now absent rather than
                            empty, so the two cannot be mistaken for each
                            other. */}
                        {c.margin === null
                          ? (
                            <span className="text-xs text-[#6B7A8D]"
                              title="No readable revenue to compute a margin from. Not 0%.">
                              {UNPRICED_DASH}
                            </span>
                          )
                          : (
                            <div className="flex items-center gap-2">
                              <div className="flex-1 h-1.5 bg-[#EEF3FA] rounded-full overflow-hidden">
                                <div className={`h-full rounded-full ${c.margin >= 0 ? 'bg-green-500' : 'bg-red-500'}`} style={{ width: `${Math.min(100, Math.abs(c.margin))}%` }} />
                              </div>
                              <span className={`text-xs shrink-0 ${c.margin >= 0 ? 'text-green-400' : 'text-red-400'}`}>{c.margin.toFixed(0)}%</span>
                            </div>
                          )
                        }
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-[#CBD5E1]">
                    <td className="pt-3 text-[#3A4658] text-xs font-semibold uppercase">
                      Total
                      {d.clientPnl.reduce((s, c) => s + c.unpriced, 0) > 0 && (
                        <span className="block text-amber-400/90 text-xs font-normal normal-case mt-0.5">
                          ⚠ {unpricedNote(d.clientPnl.reduce((s, c) => s + c.unpriced, 0), 'line')}
                        </span>
                      )}
                    </td>
                    <td colSpan={3}></td>
                    <td className="pt-3 text-right text-[#3A4658] text-sm">{fmtOrDash(d.totalRevenue)}</td>
                    <td className="pt-3 text-right text-[#3A4658] text-sm">{fmtOrDash(d.totalCost)}</td>
                    <td className={`pt-3 text-right text-sm font-bold ${d.totalProfit === null ? 'text-[#6B7A8D]' : d.totalProfit >= 0 ? 'text-green-400' : 'text-red-400'}`}>{fmtOrDash(d.totalProfit)}</td>
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
        <div className="bg-white rounded-xl p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold text-[#0B1220]">Referral Payouts</h3>
            <span className="text-xs text-[#4B4F58]">{fmt(d.pendingPayouts)} pending approval</span>
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
            ? <p className="text-[#6B7A8D] text-sm">No referral payouts recorded. Every payout is held at <span className="text-yellow-400">pending</span> until you approve it.</p>
            : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-[#4B4F58] text-left border-b border-[#E2E8F0] text-xs uppercase">
                    <th className="pb-2 pr-3">Partner</th>
                    <th className="pb-2 pr-3">Client</th>
                    <th className="pb-2 pr-3">Period</th>
                    <th className="pb-2 pr-3 text-right">Amount</th>
                    <th className="pb-2 text-right">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {d.payouts.map((p: any) => (
                    <tr key={p.id} className="border-b border-[#E2E8F0]/40">
                      <td className="py-2 pr-3 text-gray-200">{(p.referral_partners as any)?.name ?? '—'}</td>
                      <td className="py-2 pr-3 text-[#4B4F58]">{(p.clients as any)?.name ?? '—'}</td>
                      <td className="py-2 pr-3 text-[#4B4F58]">{p.period ?? '—'}</td>
                      <td className="py-2 pr-3 text-right text-[#3A4658]">{formatPrice(p.amount)}</td>
                      <td className="py-2 text-right">
                        <span className={`px-1.5 py-0.5 rounded text-xs ${p.status === 'paid' ? 'bg-green-900/50 text-green-400' : p.status === 'approved' ? 'bg-[#1A73E8]/15 text-[#1A73E8]' : 'bg-yellow-900/40 text-yellow-400'}`}>{p.status}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          }
        </div>

        {/* Inbound log */}
        <div className="bg-white rounded-xl p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold text-[#0B1220]">Inbound Shipment Log</h3>
            <span className="text-xs text-[#4B4F58]">Receiving / packing list</span>
          </div>
          {d.inbound.length === 0
            ? <p className="text-[#6B7A8D] text-sm">No inbound shipments logged yet.</p>
            : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-[#4B4F58] text-left border-b border-[#E2E8F0] text-xs uppercase">
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
                    <tr key={i.id} className="border-b border-[#E2E8F0]/40">
                      <td className="py-2 pr-3 text-[#4B4F58]">{i.received_date ?? '—'}</td>
                      <td className="py-2 pr-3 text-gray-200">{(i.clients as any)?.name ?? '—'}</td>
                      <td className="py-2 pr-3 font-mono text-[#4B4F58]">{i.reference ?? '—'}</td>
                      <td className="py-2 pr-3 text-right text-[#4B4F58]">{i.units ?? 0}</td>
                      {/* The render-side twins of the two exclusions in the
                          inbound aggregation above. This log is where someone
                          checks what an inbound line was costed at, so a blank
                          column printing '$0.00' here is how it gets believed
                          and left alone. */}
                      <td className="py-2 pr-3 text-right text-[#4B4F58]">{formatPrice(i.our_cost)}</td>
                      <td className="py-2 text-right text-[#3A4658]">{formatPrice(i.billed_amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          }
        </div>
      </div>

      {/* ---- Partner payout detail ----
          The table above is the payout LEDGER: what has been recorded and
          approved. This is what the ledger says we owe, and every charge it
          was derived from. Its own component because it does its own reads
          and degrades on its own — see the note in its header. */}
      <PartnerPayouts />
    </div>
  )
}

function StatCard({ label, value, sub, color }: { label: string; value: string; sub: string; color: string }) {
  const colors: Record<string, string> = {
    red: 'border-red-800/50 bg-red-950/40',
    green: 'border-green-800/50 bg-green-950/40',
    blue: 'border-[#1A73E8]/20 bg-[#1A73E8]/5',
    gray: 'border-[#E2E8F0] bg-white',
    // The same neutral as `gray`, under its own name, so that a card reading
    // `color="unknown"` says it is deliberately neither green nor red rather
    // than looking like somebody thought grey suited it.
    unknown: 'border-[#E2E8F0] bg-white',
  }
  return (
    <div className={`rounded-xl p-5 border ${colors[color] ?? 'bg-white border-[#E2E8F0]'}`}>
      <p className="text-[#4B4F58] text-xs uppercase tracking-wider mb-2">{label}</p>
      <p className="text-2xl font-bold text-[#0B1220]">{value}</p>
      <p className="text-[#6B7A8D] text-xs mt-1">{sub}</p>
    </div>
  )
}
