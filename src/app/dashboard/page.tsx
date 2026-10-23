import { supabaseAdmin } from '@/lib/supabase'
import SyncButton from '@/components/dashboard/SyncButton'
import AutoSync from '@/components/dashboard/AutoSync'
import {
  formatPrice, formatSignedPrice, priceOf, sumPriced, combinePriced,
  unpricedNote, totalOrUnknown, UNPRICED_DASH,
} from '@/lib/billing/unpriced'
import {
  reconcile, combineReconciled, reconciledOrUnknown, marginPct, exclusionNote,
  excludedCount, invoiceableRevenue, otherIncome,
} from '@/lib/billing/profit-rollup'
import { read, readErrors, type Read } from '@/lib/db/read'
import { readAllPages } from '@/lib/db/page'
import { ViewUnreadable } from '@/components/ui/ViewUnreadable'

// The three shapes the paged shipment reads return. Needed explicitly because
// readAllPages is generic and cannot infer a row shape from the query the way
// a bare `.select()` could.
interface PeriodRow {
  actual_cost: number | null
  client_rate: number | null
  profit_loss: number | null
}
interface ShipmentTotalsRow extends PeriodRow {
  is_loss: boolean | null
}
interface ClientMonthRow extends ShipmentTotalsRow {
  client_id: string | null
  clients: { name: string } | { name: string }[] | null
}

// ─────────────────────────────────────────────────────────────────────────────
// This page makes fifteen reads and used to check the error on NONE of them.
// Every one was `res.data ?? []` or `res.data?.length ?? 0`, which maps a
// FAILED read onto the same value as an empty one. On the first screen anybody
// opens, that produced three distinct classes of false claim:
//
//   1. A number somebody can act on. `clientsRes.data?.length ?? 0` rendered
//      "Active Clients: 0" when the clients table could not be read.
//   2. A money figure that is short by an unknown amount. Revenue for a week
//      is shipments + warehouse lines + approved manual charges; if the
//      warehouse read timed out, the week did not have LOW revenue, it had no
//      known revenue -- and it published the shipments-only figure as if it
//      were the whole number.
//   3. Worst: an affirmative all-clear. The loss panel printed
//      "✓ No loss shipments · All shipments are profitable" and the
//      adjustments panel printed "✓ No pending adjustments · No carrier price
//      changes detected", both straight out of `?? []`. A wrong figure at
//      least invites a question. A green tick closes it, and these two panels
//      are the only places on the dashboard where a loss or a carrier reweigh
//      surfaces at all.
//
// So: every read goes through `read()` from lib/db/read, which never hands
// back rows alongside an error, and every figure derived from a failed read is
// null (UNKNOWN) rather than a number. null renders as a dash with the reason
// beside it, never as $0.00 and never as a tick.
//
// Same doctrine as the rest of this branch, one level up: there it was "a
// stored null is not a price of zero", here it is "a failed read is not an
// empty table".
// ─────────────────────────────────────────────────────────────────────────────

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

/**
 * One period's figures as the card needs them.
 *
 * Declared rather than inferred from `period()`'s return, and the money fields
 * are `number | null` rather than `number`, for the same reason PeriodCard's
 * props are: a period whose reads did not all come back has no revenue figure,
 * not a low one, and the type is the thing that makes `?? 0` a compile error
 * here instead of a quiet reappearance of the defect this page was rewritten
 * to remove.
 *
 * `revenue`, `cost` and `profit` are the RECONCILING triple -- all three summed
 * over the same shipment rows, so `revenue - cost === profit` to the cent. They
 * are narrower than `billable` on purpose; see lib/billing/profit-rollup.ts.
 */
type PeriodFigures = {
  unreadable: string | null
  revenue: number | null
  cost: number | null
  profit: number | null
  marginPct: number | null
  shipments: number | null
  reconciled: number
  excluded: number
  exclusions: string
  stale: number
  billable: number | null
  billableUnpriced: number
  otherIncome: number | null
  otherIncomeUnpriced: number
  otherMeasured: boolean
}

// Per client, on EXACTLY the basis the period cards use.
//
// This table and the "This Month" card above it describe the same month, so
// they have to be computed the same way or they contradict each other on one
// screen. It used to fold warehouse revenue into the client's shipping revenue
// while costing and profiting only the shipments -- so every client with a
// warehouse line had a revenue figure its own cost and profit columns could
// not account for, and the row did not subtract either.
//
// Warehouse income now has its own column. It is income; it is just not part
// of a shipping margin, and a column is how you say that without hiding it.
function buildClientBreakdown(clients: any[], shipments: any[], warehouse: any[], adjustments: any[]) {
  return clients.map(client => {
    const cs = shipments.filter(s => s.client_id === client.id)
    const cw = warehouse.filter(w => w.client_id === client.id)
    const ca = adjustments.filter(a => a.client_id === client.id)
    const rollup = reconcile(cs)
    const known = reconciledOrUnknown(rollup)
    const warehouseRev = sumPriced(cw, 'total')
    const pendingAdj = sumPriced(ca, 'adjustment_amount')
    const lossCount = cs.filter(s => s.is_loss).length
    return {
      id: client.id, name: client.name, shipments: cs.length,
      // All three null together, or all three numbers together -- they are one
      // reconciliation, not three figures that happen to be adjacent. null is
      // the ordinary state of a client whose carrier invoices have not landed
      // yet: `profit` was 0 there before, and 0 was painted green with a '+'
      // and a ✓, so the row said "break-even, nothing to see" about a client
      // whose margin is entirely unmeasured.
      revenue: known.revenue, cost: known.cost, profit: known.profit,
      marginPct: marginPct(rollup),
      // The reconciliation itself, kept so the footer can combine the clients
      // instead of reducing over the collapsed numbers above -- which would
      // need a `?? 0` the moment a row's margin is UNKNOWN. Carrying the whole
      // object rather than a scalar beside it is deliberate: a count sitting
      // next to a number is how the two drift apart.
      rollup,
      // Counted per client, so the row says WHOSE rate card has the gap. A
      // page-level total can only say the figure is incomplete; this says
      // where to go and fix it. Kept as two buckets rather than one, because
      // `unrated` is work going out unbilled and `uncosted` resolves itself.
      excluded: excludedCount(rollup),
      unrated: rollup.unrated,
      uncosted: rollup.uncosted,
      warehouse: totalOrUnknown(warehouseRev),
      warehouseUnpriced: warehouseRev.unpriced,
      // Carried for the footer, same reason as `rollup` above: the total is
      // combined from the parts, never re-derived by re-filtering the rows.
      warehouseSum: warehouseRev,
      pendingAdj: pendingAdj.total, lossCount,
    }
    // Sorted on the raw reconciled revenue, which is always a number, rather
    // than on the nullable figure the row renders. `(b.revenue ?? 0) - ...`
    // would be a `??` on money in the file that exists to have none, even
    // though a sort key is not a published figure.
  }).sort((a, b) => b.rollup.revenue - a.rollup.revenue)
}

// Without this line Next prerendered this page at build time -- fifteen reads
// baked into static HTML and frozen until the next deploy. See the long note on
// the same line in src/app/reports/page.tsx for how it was found and how to
// check it stayed fixed.
//
// This page is the worst of the four to freeze, because it is the first screen
// anyone opens and because it computes `weekStart` from `new Date()`. Prerendered,
// that Date was the BUILD's clock: the headline said "this week" and showed the
// week the last deploy happened in, which stops being this week on the following
// Monday whether or not anyone deploys again.
export const dynamic = 'force-dynamic'

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
    // PAGED, all four of the period reads below, and the reason is measured
    // rather than precautionary. PostgREST caps a select at `db-max-rows`
    // (1000) and reports the cap NOWHERE -- a 200, `error: null`, and a
    // full-looking page. On 2026-10-23 the year read returned 1000 of 1823
    // shipments, so this screen showed $18,256.87 of revenue against an
    // actual $35,155.66 and a margin of $7,497.91 against $14,849.33. Half
    // the business, in the headline figures, with nothing on screen saying
    // so. The `of 1000` in exclusionNote's own caption was the only clue.
    //
    // The week and month reads were under the cap on that date and so were
    // correct -- which is exactly how this arrives: it is not a defect until
    // the window crosses 1000 rows, and then it appears with nothing in the
    // code having changed. See the header of src/lib/db/page.ts.
    readAllPages<ShipmentTotalsRow>((from, to) =>
      supabaseAdmin.from('shipments')
        .select('actual_cost, client_rate, profit_loss, is_loss')
        .order('id').range(from, to)),
    // NOT paged, deliberately: this is the worst-50 list, and `.limit(50)` is
    // the answer rather than a truncation of it.
    supabaseAdmin.from('shipments')
      .select('order_number, client_id, actual_cost, client_rate, profit_loss, clients(name), ship_date, carrier, service, tracking_number')
      .eq('is_loss', true).order('profit_loss', { ascending: true }).limit(50),
    readAllPages<PeriodRow>((from, to) =>
      supabaseAdmin.from('shipments').select('actual_cost, client_rate, profit_loss')
        .gte('ship_date', weekStart.toISOString()).order('id').range(from, to)),
    readAllPages<PeriodRow>((from, to) =>
      supabaseAdmin.from('shipments').select('actual_cost, client_rate, profit_loss')
        .gte('ship_date', monthStart.toISOString()).order('id').range(from, to)),
    readAllPages<PeriodRow>((from, to) =>
      supabaseAdmin.from('shipments').select('actual_cost, client_rate, profit_loss')
        .gte('ship_date', yearStart.toISOString()).order('id').range(from, to)),
    supabaseAdmin.from('rate_adjustments')
      .select('id, order_number, adjustment_amount, reason, adjustment_date, client_id, clients(name)')
      .eq('status', 'pending').order('adjustment_amount', { ascending: false }),
    supabaseAdmin.from('warehouse_daily_log').select('total').gte('log_date', weekStart.toISOString().split('T')[0]),
    supabaseAdmin.from('warehouse_daily_log').select('total').gte('log_date', monthStart.toISOString().split('T')[0]),
    supabaseAdmin.from('manual_charges').select('amount').eq('approved', true).gte('charge_date', weekStart.toISOString().split('T')[0]),
    supabaseAdmin.from('manual_charges').select('amount').eq('approved', true).gte('charge_date', monthStart.toISOString().split('T')[0]),
    supabaseAdmin.from('bills').select('grand_total, status, week_start, week_end, client_id, clients(name)').order('week_start', { ascending: false }).limit(10),
    // The per-client table. 617 rows this month, so under the cap today --
    // and that is precisely why it is paged now rather than when it breaks.
    readAllPages<ClientMonthRow>((from, to) =>
      supabaseAdmin.from('shipments')
        .select('client_id, actual_cost, client_rate, profit_loss, is_loss, clients(name)')
        .gte('ship_date', monthStart.toISOString()).order('id').range(from, to)),
    supabaseAdmin.from('warehouse_daily_log').select('client_id, total').gte('log_date', monthStart.toISOString().split('T')[0]),
    supabaseAdmin.from('rate_adjustments').select('client_id, adjustment_amount').eq('status', 'pending'),
  ])

  // Named per read, not per table: four of these hit `shipments` with
  // different windows, and "shipments: fetch failed" on a screen with four
  // shipment reads does not tell an operator which section went blind.
  const clients = read('clients', clientsRes)
  const allShipments = read('shipments (all time)', allShipmentsRes)
  const lossShipments = read('shipments (losses)', lossShipmentsRes)
  const weekShipments = read('shipments (this week)', weekShipmentsRes)
  const monthShipments = read('shipments (this month)', monthShipmentsRes)
  const yearShipments = read('shipments (this year)', yearShipmentsRes)
  const pendingAdj = read('rate_adjustments (pending)', pendingAdjRes)
  const weekWarehouse = read('warehouse_daily_log (this week)', weekWarehouseRes)
  const monthWarehouse = read('warehouse_daily_log (this month)', monthWarehouseRes)
  const weekManual = read('manual_charges (this week)', weekManualRes)
  const monthManual = read('manual_charges (this month)', monthManualRes)
  const bills = read('bills', billsRes)
  const clientShipments = read('shipments (per client)', clientShipmentsRes)
  const clientWarehouse = read('warehouse_daily_log (per client)', clientWarehouseRes)
  const clientAdj = read('rate_adjustments (per client)', clientAdjRes)

  // One period's figures, or the reason they are UNKNOWN.
  //
  // `unreadable` is non-null when ANY of the reads behind the period failed,
  // and then EVERY figure goes null rather than being published short. This is
  // the case the old code got wrong in the most expensive direction: revenue
  // is shipments + warehouse + manual charges, so a timed-out warehouse read
  // left a confident revenue figure missing an unknown number of billable
  // lines, on the screen the week's performance is judged from.
  //
  // The three sources are named parameters rather than the previous
  // `...extra: any[][]` keyed by position (`i === 0 ? 'total' : 'amount'`),
  // because that form summed the WRONG COLUMN if a caller ever passed manual
  // charges first -- silently, since both columns hold money.
  //
  // THE FIGURES NOW SUBTRACT, WHICH THEY DID NOT.
  //
  // This used to be three `sumPriced` calls over three DIFFERENT row subsets --
  // `client_rate`, `actual_cost` and `profit_loss` each skipping their own
  // unreadable rows, with warehouse and manual charges folded into revenue
  // only. Each figure was individually honest and the column of three was not
  // a subtraction. On 2026-10-13 all three cards showed a negative
  // revenue-minus-cost and printed a profit in green; This Year was out by
  // $10,225. See the header of lib/billing/profit-rollup.ts for the numbers.
  //
  // `reconcile` sums revenue and cost over the SAME rows and derives the
  // margin from them, so the three figures on the card reconcile to the cent
  // by construction. The rows it had to leave out are counted and attributed
  // to a reason, and the card renders that rather than quietly narrowing.
  const period = (
    shipments: Read<any>, warehouse?: Read<any>, manual?: Read<any>,
  ): PeriodFigures => {
    const unreadable = readErrors(shipments, warehouse, manual)
    const r = reconcile(shipments.rows)
    const known = reconciledOrUnknown(r)
    const billable = invoiceableRevenue(shipments.rows)
    const other = otherIncome(warehouse?.rows, manual?.rows)
    // Whether this period HAS a warehouse/manual figure at all, as against
    // having one that came to zero. `period(yearShipments)` is called with
    // neither source, because no year-windowed warehouse or manual read is
    // made, and `otherIncome` of nothing is a legitimate $0.00 -- the sum over
    // an empty set. Printing that $0.00 on the year card would assert the year
    // had no warehouse income, which is not a thing this page read.
    const otherMeasured = warehouse !== undefined || manual !== undefined
    return {
      unreadable,
      revenue: unreadable ? null : known.revenue,
      cost: unreadable ? null : known.cost,
      profit: unreadable ? null : known.profit,
      // Derived from the same reconciled set, so the percentage describes the
      // two figures printed above it. null when there is no revenue to be a
      // percentage of -- `profit / 0` renders as 'Infinity%' through toFixed.
      marginPct: unreadable ? null : marginPct(r),
      shipments: unreadable ? null : r.counted,
      // Zeroed when the period is unreadable, because these counts describe
      // rows that were successfully read and found to be incomplete. Carrying
      // a count over from a partial read would put an amber "3 shipments not
      // in these figures" note under a figure that is not a figure.
      reconciled: unreadable ? 0 : r.reconciled,
      excluded: unreadable ? 0 : excludedCount(r),
      exclusions: unreadable ? '' : exclusionNote(r),
      // Rows whose stored `profit_loss` disagrees with rate minus cost. The
      // old profit line WAS that column, so this count is a measure of how
      // wrong the figure this change replaces actually was.
      stale: unreadable ? 0 : r.stale,
      // The wide revenue figure -- every agreed rate, including shipments the
      // carrier has not billed us for yet. Different question from the
      // reconciled revenue above and labelled differently on the card. This is
      // the number to invoice from.
      billable: unreadable ? null : totalOrUnknown(billable),
      billableUnpriced: unreadable ? 0 : billable.unpriced,
      // Income with no carrier cost, so it has no place inside a margin. It
      // used to be added into revenue, where it widened the
      // revenue-minus-cost gap by its own full value.
      otherIncome: unreadable || !otherMeasured ? null : totalOrUnknown(other),
      otherIncomeUnpriced: unreadable ? 0 : other.unpriced,
      otherMeasured,
    }
  }

  // The breakdown joins four reads in memory, so a failure in any one of them
  // silently drops rows from a per-client table -- which reads as "this client
  // shipped nothing this month", a sentence somebody acts on.
  const breakdownError = readErrors(
    clients, clientShipments, clientWarehouse, clientAdj)

  const clientBreakdown = breakdownError ? [] : buildClientBreakdown(
    clients.rows, clientShipments.rows, clientWarehouse.rows, clientAdj.rows)

  // The footer's totals, combined from the clients' own reconciliations rather
  // than added up from the numbers in the rows above them. Two reasons: adding
  // the rendered numbers would need `?? 0` now that a row's margin can be
  // UNKNOWN -- the exact coercion this page was rewritten to remove -- and
  // combining the reconciliations carries the exclusion buckets through the
  // addition, so the total can say how many shipments it is blind to.
  //
  // Because combineReconciled is additive in every field and re-derives the
  // margin, the footer is identical to reconciling every client's rows at once
  // (pinned by a test in profit-rollup.test.ts). So the total cannot disagree
  // with the "This Month" card beside it, which is the whole point of doing it
  // this way rather than summing three columns.
  const breakdownTotal = combineReconciled(
    ...clientBreakdown.map(c => c.rollup))
  const breakdownKnown = reconciledOrUnknown(breakdownTotal)
  // combinePriced() of nothing is a counted-nothing, which totalOrUnknown
  // correctly calls a real 0 -- a month with no warehouse lines billed none.
  const breakdownWarehouse = combinePriced(
    ...clientBreakdown.map(c => c.warehouseSum))

  return {
    // null, not 0. "Active Clients: 0" on a failed read is a number somebody
    // can act on, and the action is to go looking for deleted clients.
    activeClients: clients.error ? null : clients.rows.length,
    activeClientsError: clients.error,
    allTime: period(allShipments),
    week: period(weekShipments, weekWarehouse, weekManual),
    month: period(monthShipments, monthWarehouse, monthManual),
    year: period(yearShipments),
    lossShipments: lossShipments.rows,
    lossError: lossShipments.error,
    lossTotal: lossShipments.error
      ? null : Math.abs(sumPriced(lossShipments.rows, 'profit_loss').total),
    pendingAdjustments: pendingAdj.rows,
    pendingAdjError: pendingAdj.error,
    pendingAdjustmentsTotal: pendingAdj.error
      ? null : sumPriced(pendingAdj.rows, 'adjustment_amount').total,
    recentBills: bills.rows,
    billsError: bills.error,
    breakdownError,
    clientBreakdown,
    breakdownRevenue: breakdownKnown.revenue,
    breakdownCost: breakdownKnown.cost,
    breakdownProfitTotal: breakdownKnown.profit,
    breakdownMarginPct: marginPct(breakdownTotal),
    breakdownExcluded: excludedCount(breakdownTotal),
    breakdownExclusions: exclusionNote(breakdownTotal),
    breakdownWarehouseTotal: totalOrUnknown(breakdownWarehouse),
    breakdownWarehouseUnpriced: breakdownWarehouse.unpriced,
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
              {!d.lossError && d.lossShipments.length > 0 && (
                <span className="bg-red-700 text-red-100 text-xs font-bold px-2 py-0.5 rounded-full">{d.lossShipments.length}</span>
              )}
            </a>
            <span className="text-red-400 font-bold text-sm">
              {!d.lossError && d.lossShipments.length > 0 ? `-${formatPrice(d.lossTotal)}` : ''}
            </span>
          </div>
          {/* Three-way, and the order matters: the error branch comes FIRST.
              This panel is the only place a loss surfaces on the dashboard, and
              it used to print "✓ No loss shipments · All shipments are
              profitable" out of `?? []` -- an affirmative all-clear generated
              by a dropped connection. A wrong number invites a question; a
              green tick closes it. */}
          {d.lossError ? (
            <div className="px-5 py-4">
              <ViewUnreadable message={d.lossError} />
            </div>
          ) : d.lossShipments.length === 0 ? (
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
                  {d.lossShipments.map((s: any) => {
                    // `profit_loss` is non-null on a loss row by construction
                    // -- is_loss is only set when the profit is known -- but it
                    // is read through priceOf anyway, because the OLD `?? 0`
                    // here disagreed with the Total Loss below it: this cell
                    // would print "-$0.00" for a row that sumPriced excludes
                    // from the total entirely. Two figures in one panel
                    // disagreeing in silence is the thing being removed.
                    const loss = priceOf(s.profit_loss)
                    return (
                      <tr key={s.order_number} className="border-b border-red-900/20 hover:bg-red-900/20">
                        <td className="px-4 py-2 font-mono text-gray-300">{s.order_number}</td>
                        <td className="px-2 py-2 text-gray-300">{s.clients?.name ?? '—'}</td>
                        <td className="px-2 py-2 text-right text-gray-400">{formatPrice(s.actual_cost)}</td>
                        <td className="px-2 py-2 text-right text-gray-400">{formatPrice(s.client_rate)}</td>
                        <td className="px-2 py-2 text-right font-bold text-red-400">
                          {loss === null ? UNPRICED_DASH : `-${formatPrice(Math.abs(loss))}`}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
                <tfoot>
                  <tr className="border-t border-red-800/40">
                    <td colSpan={4} className="px-4 py-2 text-red-400 text-xs font-semibold">Total Loss</td>
                    <td className="px-2 py-2 text-right font-bold text-red-400">-{formatPrice(d.lossTotal)}</td>
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
              {!d.pendingAdjError && d.pendingAdjustments.length > 0 && (
                <span className="bg-orange-700 text-orange-100 text-xs font-bold px-2 py-0.5 rounded-full">{d.pendingAdjustments.length}</span>
              )}
            </a>
            <span className="text-orange-400 font-bold text-sm">
              {!d.pendingAdjError && d.pendingAdjustments.length > 0 ? `+${formatPrice(d.pendingAdjustmentsTotal)}` : ''}
            </span>
          </div>
          {/* "No carrier price changes detected" is a claim about what the
              carrier did, and it was being made on a failed read. A reweigh
              nobody recovers is money already spent. */}
          {d.pendingAdjError ? (
            <div className="px-5 py-4">
              <ViewUnreadable message={d.pendingAdjError} />
            </div>
          ) : d.pendingAdjustments.length === 0 ? (
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
                      {/* `adjustment_amount` stays on the plain coercion by
                          standing decision: nothing in this codebase writes
                          null to that column, so dashing it would be a guess
                          dressed as a fix. formatPrice still dashes it if that
                          ever stops being true. */}
                      <td className="px-2 py-2 text-right font-bold text-orange-400">+{formatPrice(a.adjustment_amount)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-orange-800/40">
                    <td colSpan={4} className="px-4 py-2 text-orange-400 text-xs font-semibold">Total to Recover</td>
                    <td className="px-2 py-2 text-right font-bold text-orange-400">+{formatPrice(d.pendingAdjustmentsTotal)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Period Revenue Cards */}
      <div className="grid grid-cols-3 gap-4">
        <PeriodCard title="This Week" p={d.week} />
        <PeriodCard title="This Month" p={d.month} />
        <PeriodCard title="This Year" p={d.year} />
      </div>

      {/* All Time Summary */}
      <div className="grid grid-cols-4 gap-4">
        {/* These three are the same reconciling triple as the period cards --
            one row set, margin derived -- so the headline tiles subtract the
            same way the cards above them do. They used to be three independent
            sums, which is how "Total Revenue $5,699 / Total Carrier Cost
            $12,952 / Net Profit +$2,972" came to be printed side by side. */}
        <BigStat label="Revenue (reconciled)" value={formatPrice(d.allTime.revenue)} color="blue"
          note={d.allTime.exclusions} unreadable={d.allTime.unreadable} />
        <BigStat label="Carrier Cost" value={formatPrice(d.allTime.cost)} color="gray"
          unreadable={d.allTime.unreadable} />
        {/* `d.allTime.profit >= 0` was the colour test, and `null >= 0` is
            TRUE in JS -- null coerces to 0 -- so an unreadable profit would
            have been painted the same green as a real one. Same shape of trap
            as `is_loss` being false for an unpriced shipment: a two-way test
            on a three-state value silently picks the reassuring branch. */}
        <BigStat label="Margin" value={formatSignedPrice(d.allTime.profit)}
          color={d.allTime.profit === null ? 'gray' : d.allTime.profit >= 0 ? 'green' : 'red'}
          note={d.allTime.marginPct === null ? '' : `${d.allTime.marginPct.toFixed(1)}% of reconciled revenue`}
          noteTone="muted"
          unreadable={d.allTime.unreadable} />
        <BigStat label="Active Clients"
          value={d.activeClients === null ? '—' : d.activeClients.toString()}
          color="blue" unreadable={d.activeClientsError} />
      </div>

      {/* Client Breakdown */}
      <div className="bg-gray-800 rounded-xl p-6">
        <h3 className="text-lg font-semibold mb-1">Client Overview — This Month</h3>
        <p className="text-gray-400 text-sm mb-4">Revenue, cost and profit per client</p>
        {/* "No clients yet." is the single most misleading sentence this page
            could print, and it came out of `?? []`. The breakdown joins four
            reads, so any one of them failing also used to drop a client's rows
            silently -- which reads as "they shipped nothing this month". */}
        {d.breakdownError ? (
          <ViewUnreadable message={d.breakdownError} />
        ) : d.clientBreakdown.length === 0 ? (
          <p className="text-gray-500 text-center py-8">No clients yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-gray-400 text-left border-b border-gray-700">
                <th className="pb-3">Client</th>
                <th className="pb-3 text-right">Shipments</th>
                {/* "Revenue" alone would read as everything this client was
                    billed. It is shipping revenue over the rows whose cost is
                    also known -- the three columns after it subtract -- and
                    warehouse income has its own column rather than being
                    folded in here where it used to be. */}
                <th className="pb-3 text-right">Shipping Rev.</th>
                <th className="pb-3 text-right">Carrier Cost</th>
                <th className="pb-3 text-right">Margin</th>
                <th className="pb-3 text-right">Warehouse</th>
                <th className="pb-3 text-right">Pending Adj.</th>
                <th className="pb-3 text-center">Flags</th>
              </tr>
            </thead>
            <tbody>
              {d.clientBreakdown.map((c) => (
                <tr key={c.id} className="border-b border-gray-700/50 hover:bg-gray-700/30">
                  <td className="py-3 font-medium">
                    <a href={`/clients/${c.id}`} className="hover:text-[#00AAFF] transition">{c.name}</a>
                  </td>
                  <td className="py-3 text-right text-gray-300">
                    {c.shipments}
                    {/* The denominator, on the row, whenever the margin
                        columns are built from fewer rows than the count. The
                        count and the money used to disagree with nothing to
                        explain the gap. */}
                    {c.excluded > 0 && (
                      <span className="block text-gray-500 text-xs font-normal">
                        {c.rollup.reconciled} costed
                      </span>
                    )}
                  </td>
                  {/* formatPrice, not `.toFixed(2)`: these are nullable now
                      and `null.toFixed` throws, while `(c.revenue ?? 0)` would
                      print $0.00 for a client whose margin is unmeasured --
                      the coercion this page exists to be rid of. */}
                  <td className="py-3 text-right">{formatPrice(c.revenue)}</td>
                  <td className="py-3 text-right text-gray-300">
                    {c.cost === null ? UNPRICED_DASH : `−${formatPrice(c.cost)}`}
                  </td>
                  {/* Gray for UNKNOWN. `c.profit >= 0` was the colour test and
                      `null >= 0` is true, so a client with no known margin at
                      all was painted the same green as a profitable one -- the
                      third time this exact two-way-test-on-three-states trap
                      has been found on this page. formatSignedPrice renders
                      the same '+$12.34' / '$-12.34' as the hand-built string
                      it replaces, so no figure already on screen changes
                      shape; only the UNKNOWN case moves, from '+$0.00' to a
                      dash. */}
                  <td className={`py-3 text-right font-semibold ${
                    c.profit === null ? 'text-gray-500'
                      : c.profit >= 0 ? 'text-green-400' : 'text-red-400'
                  }`}>
                    {formatSignedPrice(c.profit)}
                    {c.marginPct !== null && (
                      <span className="block text-gray-500 text-xs font-normal">
                        {c.marginPct.toFixed(1)}%
                      </span>
                    )}
                  </td>
                  {/* Its own column rather than being added into Shipping Rev.
                      Warehouse work has no carrier cost, so a dollar of it
                      inside the revenue column widened the gap between that
                      column and the two beside it by a dollar. */}
                  <td className="py-3 text-right text-gray-300">
                    {c.warehouseSum.counted === 0 ? UNPRICED_DASH : formatPrice(c.warehouse)}
                  </td>
                  <td className={`py-3 text-right ${c.pendingAdj > 0 ? 'text-orange-400 font-semibold' : 'text-gray-500'}`}>
                    {c.pendingAdj > 0 ? `+$${c.pendingAdj.toFixed(2)}` : '—'}
                  </td>
                  <td className="py-3 text-center">
                    {c.lossCount > 0 && (
                      <span className="bg-red-900/60 text-red-300 px-2 py-0.5 rounded text-xs mr-1">⚠ {c.lossCount} loss</span>
                    )}
                    {/* Two badges and not one combined "incomplete" count,
                        because they send you to different places and only one
                        of them is yours to fix: an unrated shipment needs this
                        client's rate card edited, an uncosted one needs a
                        carrier invoice that has not arrived yet. The unrated
                        badge is on this row because this client's rate card is
                        the thing to go and edit. */}
                    {c.unrated > 0 && (
                      <span className="bg-amber-900/60 text-amber-300 px-2 py-0.5 rounded text-xs mr-1"
                        title="We paid a carrier for these and no rate was agreed, so they are in none of the figures on this row. They are not $0.">
                        ⚠ {c.unrated} no rate
                      </span>
                    )}
                    {c.uncosted > 0 && (
                      <span className="bg-gray-700/70 text-gray-300 px-2 py-0.5 rounded text-xs mr-1"
                        title="Priced, but the carrier has not billed us yet, so these are left out of the margin. They are not break-even. See Billable revenue on the period card.">
                        {c.uncosted} awaiting cost
                      </span>
                    )}
                    {c.warehouseUnpriced > 0 && (
                      <span className="bg-amber-900/60 text-amber-300 px-2 py-0.5 rounded text-xs mr-1"
                        title="Warehouse lines with no agreed rate. Excluded from the Warehouse column -- they are not $0.">
                        ⚠ {c.warehouseUnpriced} unpriced wh.
                      </span>
                    )}
                    {c.pendingAdj > 0 && (
                      <span className="bg-orange-900/60 text-orange-300 px-2 py-0.5 rounded text-xs">🔔 adj</span>
                    )}
                    {/* The green tick requires EVERY row of this client's to
                        have reconciled. `lossCount` cannot stand in for that:
                        `is_loss` is false for a shipment whose profit is
                        unknown, so a client with nothing but un-invoiced
                        shipments satisfied all of the old conditions and got a
                        ✓ -- an affirmative all-clear about margin nobody has
                        measured. `excluded === 0` is the one condition that
                        covers all three exclusion buckets at once, so a new
                        bucket cannot be added upstream without this tightening
                        with it. */}
                    {c.lossCount === 0 && c.pendingAdj === 0
                      && c.excluded === 0 && c.warehouseUnpriced === 0 && (
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
                {/* All three of these come from combineReconciled in
                    getDashboardData, not from reducing over the rendered
                    numbers: `s + c.revenue` would need a `?? 0` now that a row
                    can be UNKNOWN, and that is the coercion this page exists
                    to be rid of. Combining also means this row subtracts and
                    agrees with the "This Month" card above -- the test in
                    profit-rollup.test.ts pins that splitting rows by client
                    and recombining gives the same figures as not splitting. */}
                <td className="pt-3 text-right">
                  {formatPrice(d.breakdownRevenue)}
                  {/* The shipment count to the left includes the excluded
                      rows; these figures do not. Saying so is the whole point
                      -- otherwise the two disagree in silence. */}
                  {d.breakdownExcluded > 0 && (
                    <span className="block text-amber-400/90 text-xs font-normal">
                      ⚠ {d.breakdownExclusions}
                    </span>
                  )}
                </td>
                <td className="pt-3 text-right">
                  {d.breakdownCost === null ? UNPRICED_DASH : `−${formatPrice(d.breakdownCost)}`}
                </td>
                <td className={`pt-3 text-right ${
                  d.breakdownProfitTotal === null ? 'text-gray-500'
                    : d.breakdownProfitTotal >= 0 ? 'text-green-400' : 'text-red-400'
                }`}>
                  {formatSignedPrice(d.breakdownProfitTotal)}
                  {d.breakdownMarginPct !== null && (
                    <span className="block text-gray-500 text-xs font-normal">
                      {d.breakdownMarginPct.toFixed(1)}%
                    </span>
                  )}
                </td>
                <td className="pt-3 text-right text-gray-300">
                  {formatPrice(d.breakdownWarehouseTotal)}
                  {d.breakdownWarehouseUnpriced > 0 && (
                    <span className="block text-amber-400/90 text-xs font-normal">
                      ⚠ {unpricedNote(d.breakdownWarehouseUnpriced, 'line')}
                    </span>
                  )}
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
        {/* "No bills generated yet" invites generating them again. */}
        {d.billsError ? (
          <ViewUnreadable message={d.billsError} />
        ) : d.recentBills.length === 0 ? (
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
                  {/* A bill with no readable total is not a $0.00 bill. */}
                  <td className="py-3 text-right font-semibold">{formatPrice(b.grand_total)}</td>
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

function PeriodCard({ title, p }: { title: string; p: PeriodFigures }) {
  // The whole card goes dark rather than showing a dash per row. Three dashes
  // in a row invite the reader to assume a quiet period; one stated reason
  // does not.
  if (p.unreadable) {
    return (
      <div className="bg-gray-800 rounded-xl p-5">
        <p className="text-gray-400 text-sm font-medium mb-4">{title}</p>
        <ViewUnreadable message={p.unreadable} />
      </div>
    )
  }

  // Shown only when it differs from the reconciled revenue, which is exactly
  // when the difference means something: the gap IS the agreed revenue on
  // shipments the carrier has not billed us for. Rendering it unconditionally
  // would put two numbers labelled Revenue on every card and invite the reader
  // to pick one.
  const showBillable = p.billable !== null && p.revenue !== null
    && Math.round(p.billable * 100) !== Math.round(p.revenue * 100)

  return (
    <div className="bg-gray-800 rounded-xl p-5">
      <p className="text-gray-400 text-sm font-medium mb-4">{title}</p>
      <div className="space-y-2">
        <div className="flex justify-between text-sm">
          <span className="text-gray-400">Revenue</span>
          <span className="text-white font-semibold">{formatPrice(p.revenue)}</span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-gray-400">Carrier Cost</span>
          {/* Printed with a leading minus so the column reads as the
              subtraction it now actually is. Before this change the three
              figures did not reconcile, and a minus sign in front of the
              middle one would have been an assertion the page could not
              support. */}
          <span className="text-white">
            {p.cost === null ? UNPRICED_DASH : `−${formatPrice(p.cost)}`}
          </span>
        </div>
        <div className="border-t border-gray-700 pt-2 flex justify-between text-sm">
          <span className="text-gray-400">Margin</span>
          {/* Gray for UNKNOWN, because `null >= 0` is true and would otherwise
              paint it green. */}
          <span className={`font-bold ${
            p.profit === null ? 'text-gray-500'
              : p.profit >= 0 ? 'text-green-400' : 'text-red-400'
          }`}>
            {formatSignedPrice(p.profit)}
            {p.marginPct !== null && (
              <span className="text-gray-500 font-normal ml-1.5">
                ({p.marginPct.toFixed(1)}%)
              </span>
            )}
          </span>
        </div>

        {/* The row set the three figures above are built from, stated whenever
            it is not all of them. "Margin +$2,469 over 1,203 of 1,425
            shipments" is a figure somebody can judge; the same margin with the
            denominator hidden is the one they would quote. */}
        {p.excluded > 0 && (
          <>
            <p className="text-gray-500 text-xs pt-1">
              Over {p.reconciled} of {p.shipments} shipments
            </p>
            <p className="text-amber-400/90 text-xs">⚠ {p.exclusions}</p>
          </>
        )}

        {showBillable && (
          <div className="flex justify-between text-xs pt-1 border-t border-gray-700/50">
            <span className="text-gray-500">
              Billable revenue
              <span className="text-gray-600"> (incl. awaiting cost)</span>
            </span>
            <span className="text-gray-300">{formatPrice(p.billable)}</span>
          </div>
        )}
        {p.billableUnpriced > 0 && (
          <p className="text-amber-400/90 text-xs">⚠ {unpricedNote(p.billableUnpriced)}</p>
        )}

        {/* Below the rule and outside the margin, which is the entire point of
            this line. Folded into revenue -- where it used to live -- every
            warehouse dollar widened the gap between the revenue and cost
            figures by a dollar while appearing in no cost and no profit. */}
        {p.otherMeasured ? (
          <div className="flex justify-between text-xs">
            <span className="text-gray-500">
              Warehouse &amp; manual
              <span className="text-gray-600"> (not in margin)</span>
            </span>
            <span className="text-gray-300">{formatPrice(p.otherIncome)}</span>
          </div>
        ) : (
          /* Not $0.00. No warehouse or manual read is windowed to this period,
             so the page has nothing to say about it -- and a $0.00 here would
             say the period had none, which would also make this card's revenue
             look comparable to the cards that do include it. */
          <p className="text-gray-600 text-xs">
            Warehouse &amp; manual charges not counted in this period
          </p>
        )}
        {p.otherIncomeUnpriced > 0 && (
          <p className="text-amber-400/90 text-xs">
            ⚠ {unpricedNote(p.otherIncomeUnpriced, 'line')}
          </p>
        )}

        {/* Only ever a diagnostic, and it describes the figure this change
            replaced: `profit_loss` is the column the old profit line was summed
            from, so a non-zero count here is a count of rows that line was
            wrong about. Nothing above is derived from it. */}
        {p.stale > 0 && (
          <p className="text-gray-600 text-xs">
            {p.stale} stored profit value{p.stale === 1 ? '' : 's'} disagree
            {p.stale === 1 ? 's' : ''} with rate − cost
          </p>
        )}
      </div>
    </div>
  )
}

function BigStat(
  { label, value, color, note, noteTone = 'warn', unreadable = null }:
  {
    label: string; value: string; color: string; note?: string
    // Two kinds of thing go under a figure and they must not look alike. A
    // withheld-rows note is something to go and fix; a margin percentage is
    // just more of the figure. Rendering both in amber behind a ⚠ would train
    // the reader to ignore the warning, which is the same reasoning as
    // `unpricedNote` returning '' rather than an all-clear.
    noteTone?: 'warn' | 'muted'
    unreadable?: string | null
  },
) {
  const colors: Record<string, string> = {
    blue: 'border-[#00AAFF]/30 bg-[#00AAFF]/5',
    green: 'border-green-700/50 bg-green-950/50',
    red: 'border-red-700/50 bg-red-950/50',
    gray: 'border-gray-700 bg-gray-800',
  }
  // An unreadable stat keeps its tile and its label but loses its colour and
  // its figure. The caller already passes a dash as `value`; the red border is
  // what stops the dash reading as "zero, rendered tidily".
  if (unreadable) {
    return (
      <div className="rounded-xl p-5 border border-red-800/50 bg-red-950/20">
        <p className="text-gray-400 text-xs uppercase tracking-wider">{label}</p>
        <p className="text-2xl font-bold mt-2 text-gray-500">—</p>
        <p className="mt-1.5 text-xs font-medium text-red-300">Could not read this</p>
        <p className="mt-0.5 font-mono text-[10px] leading-tight text-red-400">{unreadable}</p>
      </div>
    )
  }
  return (
    <div className={`rounded-xl p-5 border ${colors[color]}`}>
      <p className="text-gray-400 text-xs uppercase tracking-wider">{label}</p>
      <p className="text-2xl font-bold mt-2 text-white">{value}</p>
      {/* Amber rather than red: the figure is incomplete, which is a thing to
          go and fix, not a failure. `note` is '' when nothing was withheld, so
          nothing renders in the ordinary case -- a permanent all-clear under
          every figure is how a real one stops being read. */}
      {note ? (
        noteTone === 'muted'
          ? <p className="text-gray-500 text-xs mt-1.5">{note}</p>
          : <p className="text-amber-400/90 text-xs mt-1.5">⚠ {note}</p>
      ) : null}
    </div>
  )
}
