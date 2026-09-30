// Read-only ledger screen. Five tables: leaks, monthly P&L, per-client P&L,
// pick days, and the §5.3.2 labour variance (a secondary signal, last and
// labelled). No charts, no filters, no drill-through. Server Component — it
// imports getLedgerSummary() and queries Supabase directly, exactly as the
// twelve other server pages in this app do. It does NOT fetch its own API
// route; see the header of src/lib/ledger/summary.ts for why that was removed.
//
// Governing principle: cost = null means UNKNOWN; cost = 0 means FREE.
// Every margin figure on this screen shows its caveat (unknown-cost count)
// beside it. A number without its caveat is worse than no number.

import {
  getLedgerSummary,
  fmtMonth,
  confidenceLabel,
  netProfitUnavailableReason,
  varianceUnavailableText,
  PICK_ROW_LIMIT,
  type MonthlyRow,
  type LeakRow,
  type VarianceRow,
} from '@/lib/ledger/summary'

export const dynamic = 'force-dynamic'

// ------------------------------------------------------------------
// Formatting
// ------------------------------------------------------------------
function fmt(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—'
  return `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/** Counts get thousands separators too — 1200 picks should not read as 1200 cents. */
function int(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—'
  return n.toLocaleString('en-US')
}

/**
 * Colour for a margin or profit figure. Null is UNKNOWN and gets its own
 * neutral colour: defaulting it to the positive green paints a missing number
 * as a good one.
 */
function marginClass(n: number | null): string {
  if (n === null) return 'text-slate-400'
  return n < 0 ? 'text-red-400' : 'text-green-400'
}

/**
 * Per-unit rates, at the four decimals cost_rates and client_warehouse_rates
 * actually store. `fmt` would round $0.2300 to $0.23 and make a 0.2300/0.2000
 * spread look like 0.23/0.20 — close enough to read as the same number.
 */
function fmtRate(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—'
  return `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 })}`
}

/**
 * Colour for a VARIANCE, which is NOT a margin and must not use marginClass.
 * labourVariance returns actualCost - absorbed, so a POSITIVE number is an
 * overspend against standard — the bad direction. marginClass paints positive
 * green, which would show an overspend as a gain.
 */
function varianceClass(n: number | null): string {
  if (n === null) return 'text-slate-400'
  if (n > 0) return 'text-red-400'
  if (n < 0) return 'text-green-400'
  return 'text-slate-300'
}

// ------------------------------------------------------------------
// Small presentational pieces
// ------------------------------------------------------------------

/**
 * "N rows", or "showing N of M" when the server had more than it returned.
 * Three of these queries carry no explicit limit, so the only thing that can
 * cut them is Supabase's project-level max-rows cap — which is silent. A
 * truncated table that does not say it is truncated is a lie about the data.
 */
function RowCount({ shown, total, cap }: { shown: number; total: number | null; cap?: number }) {
  if (total === null) {
    return <span className="text-xs text-slate-500">{int(shown)} rows (total not counted)</span>
  }
  if (total <= shown) {
    return <span className="text-xs text-slate-500">{int(shown)} rows</span>
  }
  const why =
    cap !== undefined
      ? `capped at the ${int(cap)} most recent`
      : 'the rest were cut by the server row limit'
  return (
    <span
      className="text-xs text-orange-500"
      title="This table does not show every matching row. Totals you compute by eye from it will be short."
    >
      showing {int(shown)} of {int(total)} rows — {why}
    </span>
  )
}

/** A leak amount. Null means "no dollar figure by design", never $0.00. */
function LeakAmount({ amount }: { amount: number | null }) {
  if (amount === null) {
    return (
      <span
        className="text-orange-500"
        title="This leak has no dollar figure by design — it is revenue that does not exist, not money that left."
      >
        not quantified
      </span>
    )
  }
  return <span className="text-red-400">{fmt(amount)}</span>
}

/**
 * The null-net_profit cell. Both the visible text and the tooltip come from the
 * same helper, so the tooltip cannot assert a cause the text contradicts — the
 * previous hard-coded title claimed a missing operating-cost category even on
 * rows where every category was present and it was revenue that was missing.
 */
function NetProfitUnknown({ row }: { row: MonthlyRow }) {
  const reason = netProfitUnavailableReason(row)
  return (
    <span className="text-xs text-orange-500" title={`Net profit cannot be computed: ${reason}.`}>
      unknown — {reason}
    </span>
  )
}

/**
 * One of overhead / direct_labor / direct_storage. These are the cost side of
 * net_profit; without them the headline figure cannot be audited from the
 * screen. A null is UNKNOWN — it says so rather than rendering a bare dash that
 * could be read as zero.
 */
function AllocationCell({ value, rows, label }: { value: number | null; rows: number | null; label: string }) {
  if (value !== null) return <span className="text-slate-400">{fmt(value)}</span>
  return (
    <span
      className="text-xs text-orange-500"
      title={
        rows === null
          ? `No operating-cost rows at all for this month, so ${label} is UNKNOWN — not zero.`
          : `This month has operating-cost rows but none allocated to ${label}, so ${label} is UNKNOWN — not zero.`
      }
    >
      unknown
    </span>
  )
}

/**
 * The variance cell. Either the figure, or the reason there is no figure —
 * never $0.00 for an unknown. A zero variance ("we spent exactly standard") and
 * an unknown variance ("nobody has entered payroll") look identical on a screen
 * and mean opposite things. The text and the tooltip come from the same helper
 * so the tooltip cannot assert a cause the text contradicts.
 */
function VarianceCell({ row }: { row: VarianceRow }) {
  const unavailable = varianceUnavailableText(row)
  if (unavailable !== null) {
    return (
      <span className="text-xs text-orange-500" title={unavailable}>
        {unavailable}
      </span>
    )
  }
  return (
    <span
      className={varianceClass(row.variance)}
      title="Actual payroll minus the standard cost of the units picked. Positive means we spent MORE than standard."
    >
      {row.variance !== null && row.variance > 0 ? '+' : ''}
      {fmt(row.variance)}
    </span>
  )
}

/**
 * The per-variant components §5.3.2 asks for, "so the cause is visible rather
 * than inferred from one number". The month's standard rate is the units-
 * weighted blend of these; without them a rate of $0.2150 looks like a rate
 * somebody chose rather than a mix of 0.2300 and 0.2000.
 */
function VariantBreakdown({ row }: { row: VarianceRow }) {
  const parts = row.variant_breakdown
  if (parts === null || parts.length === 0) {
    return <span className="text-xs text-slate-600">—</span>
  }
  return (
    <div className="space-y-0.5">
      {parts.map((p, i) => (
        <div key={i} className="whitespace-nowrap text-xs">
          <span className="font-mono text-sky-300">{p.variant ?? 'no variant'}</span>
          <span className="ml-1.5 text-slate-400">{int(p.units)} u</span>
          <span className="ml-1.5 text-slate-500">@</span>
          {p.standard_rate === null ? (
            <span
              className="ml-1 text-orange-500"
              title={
                p.variant === null
                  ? 'These pick charges carry no rate-card variant, so no standard rate can be chosen for them — which is why the whole month has no standard rate.'
                  : 'No cost rate is in effect for this variant in this month, so the whole month has no standard rate. Averaging over the covered variants only would invent an unfavourable variance.'
              }
            >
              no rate
            </span>
          ) : (
            <span className="ml-1 text-slate-300">{fmtRate(p.standard_rate)}</span>
          )}
          {p.basis === 'estimated' && (
            <span className="ml-1.5 text-amber-400/80">est</span>
          )}
        </div>
      ))}
    </div>
  )
}

/** Shared cells for a leak row, minus the month column. */
function LeakCells({ row }: { row: LeakRow }) {
  return (
    <>
      <td className="py-2.5 pr-3 font-mono text-xs text-sky-300">{row.leak}</td>
      <td className="py-2.5 pr-3 text-slate-300">{row.detail}</td>
      <td className="py-2.5 pr-3 text-right text-slate-400">{int(row.records)}</td>
      <td className="py-2.5 text-right font-medium">
        <LeakAmount amount={row.amount} />
      </td>
    </>
  )
}

// ------------------------------------------------------------------
// Page
// ------------------------------------------------------------------
export default async function LedgerPage() {
  const { leaks, leaksUndated, monthly, clients, picks, variance, counts, errors } =
    await getLedgerSummary()

  // Any month resting on a placeholder rate caveats the whole section. Read
  // from the VIEW's basis, not from VarianceResult.basis: labourVariance
  // returns 'measured' whenever both inputs are present, so it would label a
  // placeholder-derived figure measured.
  const varianceIsEstimated = variance.some((r) => r.standard_rate_basis === 'estimated')

  return (
    <div className="space-y-6 font-sans text-slate-200">

      {/* Header */}
      <div>
        <h2 className="text-2xl font-bold text-white">Ledger</h2>
        <p className="mt-1 text-sm text-slate-400">
          Read-only view of leaks, monthly P&amp;L, per-client margins, and pick activity — last three months.
        </p>
      </div>

      {/* Error banner — errors surface here, not as empty tables */}
      {errors.length > 0 && (
        <div className="rounded-xl border border-red-700/50 bg-red-950/30 p-4">
          <p className="text-sm font-medium text-red-300">One or more views failed to load:</p>
          <ul className="mt-2 space-y-1">
            {errors.map((e, i) => (
              <li key={i} className="font-mono text-xs text-red-400">{e}</li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-red-500/70">
            Empty tables on this page may mean a view error, not an absence of data.
          </p>
        </div>
      )}

      {/* ----------------------------------------------------------------
          1. LEAKS TABLE
          Rows are symptoms, not addends — the same dollar can appear in
          multiple leak rows. There is no correct total; see SQL comment
          at ledger_04_views.sql:99-107.
          ---------------------------------------------------------------- */}
      <div className="rounded-xl bg-slate-800 p-5">
        <div className="mb-1 flex items-start justify-between">
          <h3 className="font-semibold text-white">Leaks</h3>
          <RowCount shown={leaks.length} total={counts.leaks} />
        </div>
        <p className="mb-4 text-xs text-slate-500">
          Each row is a symptom. The same dollar can appear under more than one leak — a shipment with
          no client and a carrier cost satisfies both &quot;unattributed label spend&quot; and
          &quot;unpriced shipments&quot;. There is no correct total row.
        </p>
        {leaks.length === 0 ? (
          <p className="text-sm text-slate-500">No dated leaks in the last three months.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-700 text-left text-xs uppercase text-slate-500">
                  <th className="pb-2 pr-3">Month</th>
                  <th className="pb-2 pr-3">Leak</th>
                  <th className="pb-2 pr-3">Detail</th>
                  <th className="pb-2 pr-3 text-right">Records</th>
                  <th className="pb-2 text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {leaks.map((r, i) => (
                  <tr key={i} className="border-b border-slate-800 hover:bg-white/5">
                    <td className="py-2.5 pr-3 text-slate-400">{fmtMonth(r.period_month)}</td>
                    <LeakCells row={r} />
                  </tr>
                ))}
              </tbody>
              {/* No total row: the rows are symptoms, not addends.
                  sum(amount) would be inflated by an unknown amount. */}
            </table>
          </div>
        )}

        {/* --------------------------------------------------------------
            UNDATED LEAKS. Separate on purpose, and never merged into a
            month: shipments.ship_date is nullable, date_trunc of null is
            null, and `null >= <window start>` is null — so every
            date-filtered read of leaks_monthly drops these silently. The
            calculator skips undated shipments too, so no charge can ever
            be keyed for them and they can never leave this bucket.
            ledger_04_views.sql:190-198 says to query them separately.
            -------------------------------------------------------------- */}
        {leaksUndated.length > 0 && (
          <div className="mt-5 rounded-lg border border-orange-800/40 bg-orange-950/20 p-4">
            <div className="mb-1 flex items-start justify-between">
              <h4 className="text-sm font-medium text-orange-300">Undated — outside every month above</h4>
              <RowCount shown={leaksUndated.length} total={counts.leaksUndated} />
            </div>
            <p className="mb-3 text-xs text-orange-300/80">
              The records behind these rows carry no date, so they fall into no month and every dated figure
              on this screen — including the table above — leaves them out. The usual case is a shipment
              with a carrier cost, no shipping charge and no ship date: money already paid that will never
              be billed, because the charge calculator skips undated shipments and so no charge can ever be
              raised for them. They cannot be dated from here; the dates have to be repaired at the source.
              Shown on their own, and <span className="font-medium">not</span> added into any month above.
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-orange-800/40 text-left text-xs uppercase text-orange-400/70">
                    <th className="pb-2 pr-3">Leak</th>
                    <th className="pb-2 pr-3">Detail</th>
                    <th className="pb-2 pr-3 text-right">Records</th>
                    <th className="pb-2 text-right">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {leaksUndated.map((r, i) => (
                    <tr key={i} className="border-b border-orange-900/30 hover:bg-white/5">
                      <LeakCells row={r} />
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* ----------------------------------------------------------------
          2. MONTHLY P&L
          gross_margin is revenue minus coalesce(cost, 0) — it treats
          every unpriced charge as FREE and reads HIGH. cost_unknown_charges
          carries the caveat. net_profit propagates null from any missing
          input, including a missing revenue side.
          ---------------------------------------------------------------- */}
      <div className="rounded-xl bg-slate-800 p-5">
        <div className="mb-1 flex items-start justify-between">
          <h3 className="font-semibold text-white">Monthly P&amp;L</h3>
          <RowCount shown={monthly.length} total={counts.monthly} />
        </div>
        <p className="mb-4 text-xs text-slate-500">
          Gross margin treats every unpriced charge as free — it reads high when costs are unknown.
          The &quot;? charges&quot; column shows how many lines have unknown cost or revenue. Overhead,
          direct labor and direct storage are the operating costs subtracted from gross margin to reach
          net profit; an &quot;unknown&quot; there is a category with no row for the month, not a zero.
        </p>
        {monthly.length === 0 ? (
          <p className="text-sm text-slate-500">No monthly P&amp;L data found in the last three months.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-700 text-left text-xs uppercase text-slate-500">
                  <th className="pb-2 pr-3">Month</th>
                  <th className="pb-2 pr-3 text-right">Revenue</th>
                  <th className="pb-2 pr-3 text-right">Direct Cost</th>
                  <th className="pb-2 pr-3 text-right">Gross Margin</th>
                  <th className="pb-2 pr-3 text-right">Overhead</th>
                  <th className="pb-2 pr-3 text-right">Direct Labor</th>
                  <th className="pb-2 pr-3 text-right">Direct Storage</th>
                  <th className="pb-2 pr-3 text-right">Net Profit</th>
                  <th className="pb-2 text-right">Flags</th>
                </tr>
              </thead>
              <tbody>
                {monthly.map((r, i) => (
                  <tr key={i} className="border-b border-slate-700 hover:bg-white/5">
                    <td className="py-2.5 pr-3 text-slate-400">{fmtMonth(r.period_month)}</td>
                    {/* Revenue — show unknown-revenue count beside it */}
                    <td className="py-2.5 pr-3 text-right">
                      <span className="text-slate-200">{fmt(r.revenue)}</span>
                      {(r.revenue_unknown_charges ?? 0) > 0 && (
                        <span
                          className="ml-1 text-xs text-orange-500"
                          title="Revenue for these charges is not yet known — at-cost freight lines where the carrier has not reported."
                        >
                          +{int(r.revenue_unknown_charges)}?
                        </span>
                      )}
                    </td>
                    {/* Direct cost */}
                    <td className="py-2.5 pr-3 text-right text-slate-400">{fmt(r.direct_cost)}</td>
                    {/* Gross margin — ALWAYS show cost_unknown_charges beside it */}
                    <td className="py-2.5 pr-3 text-right">
                      <span className={marginClass(r.gross_margin)}>{fmt(r.gross_margin)}</span>
                      {(r.cost_unknown_charges ?? 0) > 0 && (
                        <span
                          className="ml-1 text-xs text-orange-500"
                          title="This many charges have no cost loaded — gross margin is overstated by whatever those costs turn out to be."
                        >
                          +{int(r.cost_unknown_charges)}?
                        </span>
                      )}
                    </td>
                    {/* The three operating-cost categories that make up net_profit */}
                    <td className="py-2.5 pr-3 text-right">
                      <AllocationCell value={r.overhead} rows={r.overhead_rows} label="overhead" />
                    </td>
                    <td className="py-2.5 pr-3 text-right">
                      <AllocationCell value={r.direct_labor} rows={r.direct_labor_rows} label="direct labor" />
                    </td>
                    <td className="py-2.5 pr-3 text-right">
                      <AllocationCell value={r.direct_storage} rows={r.direct_storage_rows} label="direct storage" />
                    </td>
                    {/* Net profit — null names its own cause */}
                    <td className="py-2.5 pr-3 text-right">
                      {r.net_profit !== null ? (
                        <span className={marginClass(r.net_profit)}>{fmt(r.net_profit)}</span>
                      ) : (
                        <NetProfitUnknown row={r} />
                      )}
                    </td>
                    {/* Flags */}
                    <td className="py-2.5 text-right">
                      {r.has_estimates && (
                        <span className="rounded bg-amber-900/30 px-1.5 py-0.5 text-xs text-amber-400">
                          estimate
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ----------------------------------------------------------------
          3. PER-CLIENT P&L
          Gross margin only — overheads are not allocated to clients.
          gross_margin = revenue - coalesce(cost, 0): reads HIGH when
          costs unknown. cost_unknown_charges is the caveat.
          revenue_unknown_charges: at-cost freight lines not yet reported.
          ---------------------------------------------------------------- */}
      <div className="rounded-xl bg-slate-800 p-5">
        <div className="mb-1 flex items-start justify-between">
          <h3 className="font-semibold text-white">Per-Client P&amp;L</h3>
          <RowCount shown={clients.length} total={counts.clients} />
        </div>
        <p className="mb-4 text-xs text-slate-500">
          Gross margin only — overheads are not allocated to individual clients. Margin treats unpriced charges as free; &quot;? charges&quot; shows how many are unknown.
        </p>
        {clients.length === 0 ? (
          <p className="text-sm text-slate-500">No per-client data found in the last three months.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-700 text-left text-xs uppercase text-slate-500">
                  <th className="pb-2 pr-3">Month</th>
                  <th className="pb-2 pr-3">Client</th>
                  <th className="pb-2 pr-3">Charge Type</th>
                  <th className="pb-2 pr-3 text-right">Charges</th>
                  <th className="pb-2 pr-3 text-right">Revenue</th>
                  <th className="pb-2 pr-3 text-right">Cost (known)</th>
                  <th className="pb-2 pr-3 text-right">Gross Margin</th>
                  <th className="pb-2 text-right">Flags</th>
                </tr>
              </thead>
              <tbody>
                {clients.map((r, i) => (
                  <tr key={i} className="border-b border-slate-700 hover:bg-white/5">
                    <td className="py-2.5 pr-3 text-slate-400">{fmtMonth(r.period_month)}</td>
                    <td className="py-2.5 pr-3 text-slate-300">
                      {r.client_name ?? <span className="italic text-slate-600">unassigned</span>}
                    </td>
                    <td className="py-2.5 pr-3 font-mono text-xs text-sky-300">{r.charge_type}</td>
                    <td className="py-2.5 pr-3 text-right text-slate-400">{int(r.charges)}</td>
                    {/* Revenue — show revenue_unknown_charges beside it */}
                    <td className="py-2.5 pr-3 text-right">
                      <span className="text-slate-200">{fmt(r.revenue)}</span>
                      {r.revenue_unknown_charges > 0 && (
                        <span
                          className="ml-1 text-xs text-orange-500"
                          title="Revenue for these charges is not yet known — at-cost freight lines where the carrier has not reported."
                        >
                          +{int(r.revenue_unknown_charges)}?
                        </span>
                      )}
                    </td>
                    {/* Cost (known) — nulls are NOT coalesced here; column is cost_known */}
                    <td className="py-2.5 pr-3 text-right">
                      <span className="text-slate-400">{fmt(r.cost_known)}</span>
                      {r.cost_unknown_charges > 0 && (
                        <span className="ml-1 text-xs text-orange-500" title="This many charges have no cost loaded.">
                          +{int(r.cost_unknown_charges)}?
                        </span>
                      )}
                    </td>
                    {/* Gross margin — ALWAYS show cost_unknown_charges beside it */}
                    <td className="py-2.5 pr-3 text-right">
                      <span className={marginClass(r.gross_margin)}>{fmt(r.gross_margin)}</span>
                      {r.cost_unknown_charges > 0 && (
                        <span className="ml-1 text-xs text-orange-500">
                          +{int(r.cost_unknown_charges)}?
                        </span>
                      )}
                    </td>
                    {/* Flags */}
                    <td className="py-2.5 text-right">
                      {r.has_estimates && (
                        <span className="rounded bg-amber-900/30 px-1.5 py-0.5 text-xs text-amber-400">
                          estimate
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ----------------------------------------------------------------
          4. PICK DAYS
          Units picked per client per day per SKU. confidence reflects
          the pick_date_source in the underlying order_items rows.
          ---------------------------------------------------------------- */}
      <div className="rounded-xl bg-slate-800 p-5">
        <div className="mb-1 flex items-start justify-between">
          <h3 className="font-semibold text-white">Pick Activity</h3>
          <RowCount shown={picks.length} total={counts.picks} cap={PICK_ROW_LIMIT} />
        </div>
        <p className="mb-4 text-xs text-slate-500">
          Units picked per SKU per day. Confidence reflects the quality of the pick-date source:
          high = printdate, medium = watermark, low = modified_date, unknown = no reliable source.
        </p>
        {picks.length === 0 ? (
          <p className="text-sm text-slate-500">No pick activity found in the last three months.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-700 text-left text-xs uppercase text-slate-500">
                  <th className="pb-2 pr-3">Date</th>
                  <th className="pb-2 pr-3">SKU</th>
                  <th className="pb-2 pr-3">Description</th>
                  <th className="pb-2 pr-3 text-right">Orders</th>
                  <th className="pb-2 pr-3 text-right">Units</th>
                  <th className="pb-2 text-right">Confidence</th>
                </tr>
              </thead>
              <tbody>
                {picks.map((r, i) => {
                  const conf = confidenceLabel(r.confidence)
                  const confClass =
                    conf === 'high' ? 'text-green-400' : conf === 'medium' ? 'text-amber-400' : 'text-orange-500'
                  return (
                    <tr key={i} className="border-b border-slate-700 hover:bg-white/5">
                      <td className="py-2.5 pr-3 text-slate-400">{r.pick_date}</td>
                      <td className="py-2.5 pr-3 font-mono text-xs text-sky-300">
                        {r.sku}
                        {r.is_component && (
                          <span className="ml-1 rounded bg-[#1e3a5f] px-1 text-[0.65rem] text-blue-300">
                            component
                          </span>
                        )}
                      </td>
                      <td className="py-2.5 pr-3 text-slate-300">{r.description ?? '—'}</td>
                      <td className="py-2.5 pr-3 text-right text-slate-400">{int(r.orders)}</td>
                      <td className="py-2.5 pr-3 text-right font-medium text-slate-200">{int(r.units_picked)}</td>
                      <td className="py-2.5 text-right">
                        <span className={confClass}>{conf}</span>
                        {r.has_estimates && (
                          <span className="ml-1 rounded bg-amber-900/30 px-1.5 py-0.5 text-xs text-amber-400">
                            est
                          </span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ----------------------------------------------------------------
          5. LABOUR VARIANCE — §5.3.2. A SECONDARY signal, and last on the
          page for that reason. Positive is UNFAVOURABLE (we spent more
          than standard), so it does NOT use marginClass. Every component
          is shown beside the figure because §5.3.2 requires the cause to
          be visible rather than inferred from one number. An unavailable
          variance prints why, never $0.00.
          ---------------------------------------------------------------- */}
      <div className="rounded-xl border border-slate-700/60 bg-slate-800 p-5">
        <div className="mb-1 flex items-start justify-between">
          <h3 className="font-semibold text-white">
            Labour Variance
            <span className="ml-2 rounded bg-slate-700 px-1.5 py-0.5 align-middle text-xs font-normal uppercase tracking-wide text-slate-300">
              secondary signal
            </span>
          </h3>
          <RowCount shown={variance.length} total={counts.variance} />
        </div>
        <p className="mb-2 text-xs text-slate-500">
          Actual direct-labor payroll against the standard cost of the units picked:
          <span className="mx-1 font-mono text-slate-400">variance = payroll − units × standard rate</span>.
          A <span className="font-medium text-red-400">positive</span> figure is an overspend against
          standard; a <span className="font-medium text-green-400">negative</span> one is an underspend.
          The standard rate is the units-weighted blend of the per-variant rates shown on the right,
          and it is null — so the variance is not computable — unless every variant picked that month
          has a rate in effect. The one exception is a month in which nothing was picked at all:
          absorbed is then zero whatever the rate, so the whole payroll is the variance and the
          standard rate column reads <span className="font-mono text-slate-400">—</span>.
        </p>
        <p className="mb-4 text-xs text-amber-400/90">
          This is a secondary signal. Until piece 2 reconciles against actual bills, the labour
          variance rests on a standard rate whose own accuracy is unproven.
          {varianceIsEstimated && (
            <>
              {' '}One or more of the standard rates behind the figures below is currently marked{' '}
              <span className="font-medium">estimated</span> — a placeholder, not a measured cost.
            </>
          )}
        </p>
        {variance.length === 0 ? (
          <p className="text-sm text-slate-500">
            No pick charges and no direct-labor cost recorded in the last three months, so there is
            nothing to compare. This is an absence of inputs, not a variance of zero.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-700 text-left text-xs uppercase text-slate-500">
                  <th className="pb-2 pr-3">Month</th>
                  <th className="pb-2 pr-3 text-right">Payroll (direct labor)</th>
                  <th className="pb-2 pr-3 text-right">Units Picked</th>
                  <th className="pb-2 pr-3 text-right">Implied Actual Rate</th>
                  <th className="pb-2 pr-3 text-right">Standard Rate</th>
                  <th className="pb-2 pr-3 text-right">Absorbed</th>
                  <th className="pb-2 pr-3 text-right">Variance (+ = overspend)</th>
                  <th className="pb-2">Per-Variant Breakdown</th>
                </tr>
              </thead>
              <tbody>
                {variance.map((r, i) => (
                  <tr key={i} className="border-b border-slate-700 align-top hover:bg-white/5">
                    <td className="py-2.5 pr-3 text-slate-400">{fmtMonth(r.period_month)}</td>
                    {/* Payroll — null is UNKNOWN and says so. Never $0.00: a zero
                        here would report the whole standard cost as a saving. */}
                    <td className="py-2.5 pr-3 text-right">
                      {r.direct_labor !== null ? (
                        <span className="text-slate-200">{fmt(r.direct_labor)}</span>
                      ) : (
                        <span
                          className="text-xs text-orange-500"
                          title="No direct_labor row in operating_costs for this month, so payroll is UNKNOWN — not zero."
                        >
                          not entered
                        </span>
                      )}
                    </td>
                    {/* Units picked, with the unattributable count beside it.
                        A null here is a value the view returned that is not a
                        usable count — not a month in which nothing was picked. */}
                    <td className="py-2.5 pr-3 text-right">
                      {r.units_picked !== null ? (
                        <span className="text-slate-300">{int(r.units_picked)}</span>
                      ) : (
                        <span
                          className="text-xs text-orange-500"
                          title="The view returned a units figure that is not a usable count, so the picked volume is UNKNOWN — not zero."
                        >
                          unreadable
                        </span>
                      )}
                      {r.unattributable_pick_charges > 0 && (
                        <span
                          className="ml-1 text-xs text-orange-500"
                          title="This many pick charges carry no rate-card variant, so no standard rate can be chosen for them. They are counted in the units above and they null this month's standard rate rather than being dropped."
                        >
                          +{int(r.unattributable_pick_charges)}?
                        </span>
                      )}
                      {/* A bare 0 here reads as a fact, and on the payroll-only
                          month it drives a confident red variance equal to the
                          whole payroll. The view cannot tell "nothing was
                          picked" from "the calculator has not run", so the one
                          case where that distinction changes the number gets
                          the caveat the prose gives every other case. */}
                      {r.units_picked === 0 && (
                        <span
                          className="ml-1 cursor-help text-xs text-amber-400"
                          title="Zero pick charges recorded. The ledger cannot tell a month in which nothing was picked from one the charge calculator has not run for yet — confirm which before treating the whole payroll as an overspend."
                        >
                          ?
                        </span>
                      )}
                    </td>
                    <td className="py-2.5 pr-3 text-right text-slate-400">
                      {fmtRate(r.implied_actual_rate)}
                    </td>
                    {/* Standard rate, with its provenance */}
                    <td className="py-2.5 pr-3 text-right">
                      <span className="text-slate-300">{fmtRate(r.standard_rate)}</span>
                      {r.standard_rate_basis !== null && r.standard_rate_basis !== 'measured' && (
                        <span
                          className="ml-1 rounded bg-amber-900/30 px-1.5 py-0.5 text-xs text-amber-400"
                          title={`The held standard rate for this month is ${r.standard_rate_basis}, not measured. The variance is only as good as it is.`}
                        >
                          {r.standard_rate_basis}
                        </span>
                      )}
                    </td>
                    <td className="py-2.5 pr-3 text-right text-slate-400">{fmt(r.absorbed)}</td>
                    <td className="py-2.5 pr-3 text-right font-medium">
                      <VarianceCell row={r} />
                    </td>
                    <td className="py-2.5">
                      <VariantBreakdown row={r} />
                    </td>
                  </tr>
                ))}
              </tbody>
              {/* No total row. Summing variances across months with different
                  standard rates produces a number nothing in §5.3.2 defines. */}
            </table>
          </div>
        )}
      </div>

    </div>
  )
}
