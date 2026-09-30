// Read-only ledger screen. Four tables: leaks, monthly P&L, per-client P&L,
// pick days. No charts, no filters, no drill-through. Server Component — all
// data is fetched server-side via the API route so the service-role key never
// reaches the browser.
//
// Governing principle: cost = null means UNKNOWN; cost = 0 means FREE.
// Every margin figure on this screen shows its caveat (unknown-cost count)
// beside it. A number without its caveat is worse than no number.

import { headers } from 'next/headers'

export const dynamic = 'force-dynamic'

// ------------------------------------------------------------------
// Types matching the view columns confirmed in ledger_04_views.sql
// ------------------------------------------------------------------
interface LeakRow {
  period_month: string
  client_id: string | null
  leak: string
  detail: string
  records: number
  amount: number | null  // null = "picked_never_billed": no dollar figure by design
}

interface MonthlyRow {
  period_month: string
  revenue: number | null
  direct_cost: number | null
  revenue_unknown_charges: number
  cost_unknown_charges: number
  gross_margin: number | null
  overhead: number | null
  direct_labor: number | null
  direct_storage: number | null
  overhead_rows: number | null        // null = no operating_costs rows for month
  direct_labor_rows: number | null
  direct_storage_rows: number | null
  net_profit: number | null
  has_estimates: boolean
}

interface ClientRow {
  period_month: string
  client_id: string | null
  client_name: string | null
  charge_type: string
  charges: number
  revenue: number | null
  revenue_unknown_charges: number
  cost_known: number | null
  cost_unknown_charges: number
  gross_margin: number | null
  has_estimates: boolean
}

interface PickRow {
  client_id: string | null
  pick_date: string
  sku: string
  description: string | null
  is_component: boolean
  orders: number
  units_picked: number
  has_estimates: boolean
  confidence: number | null
}

interface SummaryPayload {
  leaks:   LeakRow[]
  monthly: MonthlyRow[]
  clients: ClientRow[]
  picks:   PickRow[]
  errors:  string[]
}

// ------------------------------------------------------------------
// Data fetch — calls the API route so the service-role key stays on
// the server. Headers are forwarded so Next.js can pass cookies if
// they are ever added later.
// ------------------------------------------------------------------
async function getSummary(): Promise<SummaryPayload> {
  const host = (await headers()).get('host') ?? 'localhost:3000'
  const proto = process.env.NODE_ENV === 'production' ? 'https' : 'http'
  const res = await fetch(`${proto}://${host}/api/ledger/summary`, {
    cache: 'no-store',
  })
  if (!res.ok) {
    return { leaks: [], monthly: [], clients: [], picks: [], errors: [`HTTP ${res.status} from /api/ledger/summary`] }
  }
  return res.json()
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------
function fmt(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—'
  return `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

// Format a month string "2026-08-01" -> "Aug 2026"
function fmtMonth(s: string): string {
  const d = new Date(s + 'T00:00:00')
  return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
}

// Describe which operating-cost categories are missing from a pnl_monthly row.
// Returns null if net_profit is not null (no missing categories).
function missingCostCategories(row: MonthlyRow): string | null {
  if (row.net_profit !== null) return null

  // overhead_rows/direct_labor_rows/direct_storage_rows are:
  //   null  → no operating_costs rows AT ALL for this month
  //   0     → rows exist for the month but none carry this allocation
  //   > 0   → at least one row with this allocation
  //
  // net_profit is null whenever ANY ONE of o.overhead / o.direct_labor /
  // o.direct_storage is NULL (a sum()...filter() that matched nothing).
  // That happens when overhead_rows/direct_labor_rows/direct_storage_rows
  // is 0 or null.
  const month = fmtMonth(row.period_month)

  if (row.overhead_rows === null && row.direct_labor_rows === null && row.direct_storage_rows === null) {
    return `no operating costs entered for ${month}`
  }

  const missing: string[] = []
  if (!row.overhead_rows)       missing.push('overhead')
  if (!row.direct_labor_rows)   missing.push('direct_labor')
  if (!row.direct_storage_rows) missing.push('direct_storage')

  if (missing.length === 0) return null // shouldn't happen, but guard it
  return `no ${missing.join(', ')} cost recorded for ${month}`
}

// Confidence label for pick_days
function confidenceLabel(n: number | null): string {
  if (n === null || n === 0) return 'unknown'
  if (n >= 3) return 'high'
  if (n >= 2) return 'medium'
  return 'low'
}

// ------------------------------------------------------------------
// Page
// ------------------------------------------------------------------
export default async function LedgerPage() {
  const { leaks, monthly, clients, picks, errors } = await getSummary()

  return (
    <div className="space-y-6" style={{ color: '#e2e8f0', fontFamily: 'var(--font-geist-sans)' }}>

      {/* Header */}
      <div>
        <h2 className="text-2xl font-bold text-white">Ledger</h2>
        <p className="text-sm mt-1" style={{ color: '#94a3b8' }}>
          Read-only view of leaks, monthly P&amp;L, per-client margins, and pick activity — last three months.
        </p>
      </div>

      {/* Error banner — errors surface here, not as empty tables */}
      {errors.length > 0 && (
        <div className="rounded-xl p-4 border border-red-700/50 bg-red-950/30">
          <p className="text-red-300 text-sm font-medium">One or more views failed to load:</p>
          <ul className="mt-2 space-y-1">
            {errors.map((e, i) => (
              <li key={i} className="text-red-400 text-xs font-mono">{e}</li>
            ))}
          </ul>
          <p className="text-red-500/70 text-xs mt-2">
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
      <div className="rounded-xl p-5" style={{ background: '#1e293b' }}>
        <div className="flex items-start justify-between mb-1">
          <h3 className="font-semibold text-white">Leaks</h3>
        </div>
        <p className="text-xs mb-4" style={{ color: '#64748b' }}>
          Each row is a symptom. The same dollar can appear under more than one leak — a shipment with
          no client and a carrier cost satisfies both &quot;unattributed label spend&quot; and
          &quot;unpriced shipments&quot;. There is no correct total row.
        </p>
        {leaks.length === 0 ? (
          <p className="text-sm" style={{ color: '#64748b' }}>No leaks found in the last three months.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left border-b text-xs uppercase" style={{ color: '#64748b', borderColor: '#334155' }}>
                  <th className="pb-2 pr-3">Month</th>
                  <th className="pb-2 pr-3">Leak</th>
                  <th className="pb-2 pr-3">Detail</th>
                  <th className="pb-2 pr-3 text-right">Records</th>
                  <th className="pb-2 text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {leaks.map((r, i) => (
                  <tr key={i} className="border-b hover:bg-white/5" style={{ borderColor: '#1e293b' }}>
                    <td className="py-2.5 pr-3" style={{ color: '#94a3b8' }}>{fmtMonth(r.period_month)}</td>
                    <td className="py-2.5 pr-3 font-mono text-xs" style={{ color: '#7dd3fc' }}>{r.leak}</td>
                    <td className="py-2.5 pr-3" style={{ color: '#cbd5e1' }}>{r.detail}</td>
                    <td className="py-2.5 pr-3 text-right" style={{ color: '#94a3b8' }}>{r.records}</td>
                    <td className="py-2.5 text-right font-medium">
                      {r.amount === null
                        ? <span style={{ color: '#f97316' }} title="This leak has no dollar figure by design — it is revenue that does not exist, not money that left.">not quantified</span>
                        : <span style={{ color: '#f87171' }}>{fmt(r.amount)}</span>
                      }
                    </td>
                  </tr>
                ))}
              </tbody>
              {/* No total row: the rows are symptoms, not addends.
                  sum(amount) would be inflated by an unknown amount. */}
            </table>
          </div>
        )}
      </div>

      {/* ----------------------------------------------------------------
          2. MONTHLY P&L
          gross_margin is revenue minus coalesce(cost, 0) — it treats
          every unpriced charge as FREE and reads HIGH. cost_unknown_charges
          carries the caveat. net_profit propagates null from any missing
          operating-cost category.
          ---------------------------------------------------------------- */}
      <div className="rounded-xl p-5" style={{ background: '#1e293b' }}>
        <div className="flex items-start justify-between mb-1">
          <h3 className="font-semibold text-white">Monthly P&amp;L</h3>
        </div>
        <p className="text-xs mb-4" style={{ color: '#64748b' }}>
          Gross margin treats every unpriced charge as free — it reads high when costs are unknown.
          The &quot;? charges&quot; column shows how many lines have unknown cost or revenue.
        </p>
        {monthly.length === 0 ? (
          <p className="text-sm" style={{ color: '#64748b' }}>No monthly P&amp;L data found in the last three months.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left border-b text-xs uppercase" style={{ color: '#64748b', borderColor: '#334155' }}>
                  <th className="pb-2 pr-3">Month</th>
                  <th className="pb-2 pr-3 text-right">Revenue</th>
                  <th className="pb-2 pr-3 text-right">Direct Cost</th>
                  <th className="pb-2 pr-3 text-right">Gross Margin</th>
                  <th className="pb-2 pr-3 text-right">Net Profit</th>
                  <th className="pb-2 text-right">Flags</th>
                </tr>
              </thead>
              <tbody>
                {monthly.map((r, i) => {
                  const netMsg = missingCostCategories(r)
                  return (
                    <tr key={i} className="border-b hover:bg-white/5" style={{ borderColor: '#334155' }}>
                      <td className="py-2.5 pr-3" style={{ color: '#94a3b8' }}>{fmtMonth(r.period_month)}</td>
                      {/* Revenue — show unknown-revenue count beside it */}
                      <td className="py-2.5 pr-3 text-right">
                        <span style={{ color: '#e2e8f0' }}>{fmt(r.revenue)}</span>
                        {r.revenue_unknown_charges > 0 && (
                          <span className="ml-1 text-xs" style={{ color: '#f97316' }}
                            title="Revenue for these charges is not yet known — at-cost freight lines where the carrier has not reported.">
                            +{r.revenue_unknown_charges}?
                          </span>
                        )}
                      </td>
                      {/* Direct cost */}
                      <td className="py-2.5 pr-3 text-right" style={{ color: '#94a3b8' }}>{fmt(r.direct_cost)}</td>
                      {/* Gross margin — ALWAYS show cost_unknown_charges beside it */}
                      <td className="py-2.5 pr-3 text-right">
                        <span style={{ color: r.gross_margin !== null && r.gross_margin < 0 ? '#f87171' : '#4ade80' }}>
                          {fmt(r.gross_margin)}
                        </span>
                        {r.cost_unknown_charges > 0 && (
                          <span className="ml-1 text-xs" style={{ color: '#f97316' }}
                            title="This many charges have no cost loaded — gross margin is overstated by whatever those costs turn out to be.">
                            +{r.cost_unknown_charges}?
                          </span>
                        )}
                      </td>
                      {/* Net profit — null means a cost category is missing */}
                      <td className="py-2.5 pr-3 text-right">
                        {r.net_profit !== null ? (
                          <span style={{ color: r.net_profit < 0 ? '#f87171' : '#4ade80' }}>
                            {fmt(r.net_profit)}
                          </span>
                        ) : (
                          <span className="text-xs" style={{ color: '#f97316' }}
                            title="net_profit is null because one or more operating-cost categories have no row for this month.">
                            unknown — {netMsg}
                          </span>
                        )}
                      </td>
                      {/* Flags */}
                      <td className="py-2.5 text-right">
                        {r.has_estimates && (
                          <span className="px-1.5 py-0.5 rounded text-xs" style={{ background: '#78350f55', color: '#fbbf24' }}>
                            estimate
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
          3. PER-CLIENT P&L
          Gross margin only — overheads are not allocated to clients.
          gross_margin = revenue - coalesce(cost, 0): reads HIGH when
          costs unknown. cost_unknown_charges is the caveat.
          revenue_unknown_charges: at-cost freight lines not yet reported.
          ---------------------------------------------------------------- */}
      <div className="rounded-xl p-5" style={{ background: '#1e293b' }}>
        <div className="flex items-start justify-between mb-1">
          <h3 className="font-semibold text-white">Per-Client P&amp;L</h3>
        </div>
        <p className="text-xs mb-4" style={{ color: '#64748b' }}>
          Gross margin only — overheads are not allocated to individual clients. Margin treats unpriced charges as free; &quot;? charges&quot; shows how many are unknown.
        </p>
        {clients.length === 0 ? (
          <p className="text-sm" style={{ color: '#64748b' }}>No per-client data found in the last three months.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left border-b text-xs uppercase" style={{ color: '#64748b', borderColor: '#334155' }}>
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
                  <tr key={i} className="border-b hover:bg-white/5" style={{ borderColor: '#334155' }}>
                    <td className="py-2.5 pr-3" style={{ color: '#94a3b8' }}>{fmtMonth(r.period_month)}</td>
                    <td className="py-2.5 pr-3" style={{ color: '#cbd5e1' }}>{r.client_name ?? <span style={{ color: '#475569', fontStyle: 'italic' }}>unassigned</span>}</td>
                    <td className="py-2.5 pr-3 font-mono text-xs" style={{ color: '#7dd3fc' }}>{r.charge_type}</td>
                    <td className="py-2.5 pr-3 text-right" style={{ color: '#94a3b8' }}>{r.charges}</td>
                    {/* Revenue — show revenue_unknown_charges beside it */}
                    <td className="py-2.5 pr-3 text-right">
                      <span style={{ color: '#e2e8f0' }}>{fmt(r.revenue)}</span>
                      {r.revenue_unknown_charges > 0 && (
                        <span className="ml-1 text-xs" style={{ color: '#f97316' }}
                          title="Revenue for these charges is not yet known — at-cost freight lines where the carrier has not reported.">
                          +{r.revenue_unknown_charges}?
                        </span>
                      )}
                    </td>
                    {/* Cost (known) — nulls are NOT coalesced here; column is cost_known */}
                    <td className="py-2.5 pr-3 text-right">
                      <span style={{ color: '#94a3b8' }}>{fmt(r.cost_known)}</span>
                      {r.cost_unknown_charges > 0 && (
                        <span className="ml-1 text-xs" style={{ color: '#f97316' }}
                          title="This many charges have no cost loaded.">
                          +{r.cost_unknown_charges}?
                        </span>
                      )}
                    </td>
                    {/* Gross margin — ALWAYS show cost_unknown_charges beside it */}
                    <td className="py-2.5 pr-3 text-right">
                      <span style={{ color: r.gross_margin !== null && r.gross_margin < 0 ? '#f87171' : '#4ade80' }}>
                        {fmt(r.gross_margin)}
                      </span>
                      {r.cost_unknown_charges > 0 && (
                        <span className="ml-1 text-xs" style={{ color: '#f97316' }}>
                          +{r.cost_unknown_charges}?
                        </span>
                      )}
                    </td>
                    {/* Flags */}
                    <td className="py-2.5 text-right">
                      {r.has_estimates && (
                        <span className="px-1.5 py-0.5 rounded text-xs" style={{ background: '#78350f55', color: '#fbbf24' }}>
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
      <div className="rounded-xl p-5" style={{ background: '#1e293b' }}>
        <div className="flex items-start justify-between mb-1">
          <h3 className="font-semibold text-white">Pick Activity</h3>
          <span className="text-xs" style={{ color: '#64748b' }}>200 most recent rows</span>
        </div>
        <p className="text-xs mb-4" style={{ color: '#64748b' }}>
          Units picked per SKU per day. Confidence reflects the quality of the pick-date source:
          high = printdate, medium = watermark, low = modified_date, unknown = no reliable source.
        </p>
        {picks.length === 0 ? (
          <p className="text-sm" style={{ color: '#64748b' }}>No pick activity found in the last three months.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left border-b text-xs uppercase" style={{ color: '#64748b', borderColor: '#334155' }}>
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
                  const confColor = conf === 'high' ? '#4ade80' : conf === 'medium' ? '#fbbf24' : '#f97316'
                  return (
                    <tr key={i} className="border-b hover:bg-white/5" style={{ borderColor: '#334155' }}>
                      <td className="py-2.5 pr-3" style={{ color: '#94a3b8' }}>{r.pick_date}</td>
                      <td className="py-2.5 pr-3 font-mono text-xs" style={{ color: '#7dd3fc' }}>
                        {r.sku}
                        {r.is_component && (
                          <span className="ml-1 px-1 rounded" style={{ background: '#1e3a5f', color: '#93c5fd', fontSize: '0.65rem' }}>
                            component
                          </span>
                        )}
                      </td>
                      <td className="py-2.5 pr-3" style={{ color: '#cbd5e1' }}>{r.description ?? '—'}</td>
                      <td className="py-2.5 pr-3 text-right" style={{ color: '#94a3b8' }}>{r.orders}</td>
                      <td className="py-2.5 pr-3 text-right font-medium" style={{ color: '#e2e8f0' }}>{r.units_picked}</td>
                      <td className="py-2.5 text-right">
                        <span style={{ color: confColor }}>{conf}</span>
                        {r.has_estimates && (
                          <span className="ml-1 px-1.5 py-0.5 rounded text-xs" style={{ background: '#78350f55', color: '#fbbf24' }}>
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

    </div>
  )
}
