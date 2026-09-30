// The five ledger views, read once, shared by the two things that read them:
// the /ledger screen (a Server Component, which imports this function directly)
// and GET /api/ledger/summary (kept because a later piece of this programme
// mails a daily digest from it).
//
// DO NOT go back to having the page fetch() its own API route over HTTP. The
// first version of the page built the URL from the incoming request's own
// `Host` header, which is attacker-controlled: a request carrying
// `Host: evil.com` made the server fetch https://evil.com/api/ledger/summary
// and render whatever JSON came back as the owner's profit and loss. The
// justification offered for the fetch -- "so the service-role key never reaches
// the browser" -- was false. A Server Component's imports are never sent to the
// browser; that is precisely why the twelve other server pages in this app
// (src/app/pnl, clients, billing, dashboard, losses, ...) import supabaseAdmin
// and query it directly. This module restores that pattern.
//
// Governing principle throughout: cost = null means UNKNOWN; cost = 0 means
// FREE. Nothing here coalesces one into the other, and the row counts below
// exist so the screen can never present a truncated table as a complete one.

import { supabaseAdmin } from '@/lib/supabase'
import { labourVariance } from '@/lib/ledger/variance'

/**
 * How many pick_days rows we ask for. Explicit, so the screen can say "capped
 * at 200" truthfully instead of printing that caption unconditionally.
 */
export const PICK_ROW_LIMIT = 200

// ---------------------------------------------------------------------------
// Types matching the view columns in supabase/ledger_04_views.sql
// ---------------------------------------------------------------------------

export interface LeakRow {
  /**
   * NULL for leak 3 (`unpriced_shipments`) when `shipments.ship_date` is null:
   * `date_trunc('month', null)` is null, so those rows sit in a bucket no
   * date filter can reach. See ledger_04_views.sql:190-198.
   */
  period_month: string | null
  client_id: string | null
  leak: string
  detail: string
  records: number
  /** null = "picked_never_billed": no dollar figure by design, never $0.00. */
  amount: number | null
}

export interface MonthlyRow {
  period_month: string
  /** null on an overhead-only row from the FULL OUTER JOIN: no charges that month. */
  revenue: number | null
  direct_cost: number | null
  revenue_unknown_charges: number | null
  cost_unknown_charges: number | null
  gross_margin: number | null
  overhead: number | null
  direct_labor: number | null
  direct_storage: number | null
  /** null = no operating_costs rows AT ALL for the month; 0 = rows exist, none in this allocation. */
  overhead_rows: number | null
  direct_labor_rows: number | null
  direct_storage_rows: number | null
  net_profit: number | null
  has_estimates: boolean | null
}

export interface ClientRow {
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

export interface PickRow {
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

/** One variant's contribution to a month, straight off the view's jsonb column. */
export interface VarianceVariant {
  /** null = pick charges whose rate_id resolved to no rate-card variant. */
  variant: string | null
  units: number | null
  /** null = no cost_rates row covers this variant in this month. */
  standard_rate: number | null
  /**
   * Same domain as standard_rate_basis on VarianceInputRow: the CHECK constraint
   * cost_rates_basis_valid on the cost_rates table restricts the column to this
   * set. Narrowed to match rather than left as string | null.
   */
  basis: 'measured' | 'derived' | 'estimated' | null
}

/** A row of labour_variance_inputs, as the view emits it. */
export interface VarianceInputRow {
  period_month: string
  units_picked: number | null
  /** Pick charges with no resolvable rate-card variant. > 0 nulls standard_rate. */
  unattributable_pick_charges: number | null
  /** null = payroll for this month has not been entered. NEVER read as zero. */
  direct_labor: number | null
  /**
   * The UNITS-WEIGHTED standard rate across the variants picked this month, or
   * null if any variant picked has no rate in effect. See the long comment on
   * the view: an average over only the covered subset understates absorbed and
   * invents an unfavourable variance.
   */
  standard_rate: number | null
  /**
   * The weakest basis among the contributing rates. Read this, NOT
   * VarianceResult.basis, to decide whether to caveat the figure as estimated:
   * variance.ts:39 returns 'measured' whenever both inputs are present, because
   * it cannot know the rate it was handed is a placeholder. Every pick rate is
   * 'estimated' today (ledger_06_seed_cost_rates.sql).
   */
  standard_rate_basis: 'measured' | 'derived' | 'estimated' | null
  implied_actual_rate: number | null
  variant_breakdown: VarianceVariant[] | null
}

/** A view row with labourVariance() applied. */
export interface VarianceRow extends VarianceInputRow {
  /**
   * 0 means a measured zero — the view coalesces a month with no pick charges
   * to it. null means the view handed back something that is not a usable
   * count, which is UNKNOWN and is not silently read as "nothing was picked".
   */
  units_picked: number | null
  unattributable_pick_charges: number
  absorbed: number | null
  /**
   * actualCost - absorbed, so POSITIVE IS UNFAVOURABLE: we spent more than
   * standard. Do not colour it with the margin palette, which paints positive
   * green.
   */
  variance: number | null
  basis: 'measured' | 'estimated' | 'unavailable'
}

/**
 * Total rows matching each query on the server, independent of how many came
 * back. `null` means the count itself failed. Where a count exceeds the rows
 * returned, the table was truncated -- by our own explicit limit for picks, or
 * by Supabase's project-level max-rows cap for the other three -- and the
 * screen must say so. A silently truncated table is a lie about the data.
 */
export interface LedgerCounts {
  leaks: number | null
  leaksUndated: number | null
  monthly: number | null
  clients: number | null
  picks: number | null
  variance: number | null
}

export interface LedgerSummary {
  leaks: LeakRow[]
  /**
   * leaks_monthly rows with `period_month is null`: undated shipments that
   * carry a carrier cost and no shipping charge. Kept in their own array and
   * NEVER merged into a month -- they have no month, and inventing one would
   * move real spend into a period it did not happen in.
   */
  leaksUndated: LeakRow[]
  monthly: MonthlyRow[]
  clients: ClientRow[]
  picks: PickRow[]
  /**
   * The §5.3.2 held-standard labour variance, one row per month, with the
   * components it was computed from. A SECONDARY signal: the standard rate it
   * rests on is itself an estimate until piece 2 reconciles against actual bills.
   */
  variance: VarianceRow[]
  counts: LedgerCounts
  errors: string[]
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

/**
 * First day of the month three months back, as "YYYY-MM-01".
 *
 * Built arithmetically on purpose. Do NOT use setMonth() -- on long-month days
 * (e.g. 31 May) `since.setMonth(getMonth() - 3)` produces 31 February, which
 * normalises to 3 March and silently narrows the window to two months on those
 * days.
 */
export function threeMonthWindowStart(now: Date = new Date()): string {
  const y = now.getFullYear()
  const m = now.getMonth() + 1 // 1-based
  const fromMonth = m - 3 <= 0 ? m - 3 + 12 : m - 3
  const fromYear = m - 3 <= 0 ? y - 1 : y
  return `${fromYear}-${String(fromMonth).padStart(2, '0')}-01`
}

// ---------------------------------------------------------------------------
// Display helpers that depend on what the view columns MEAN, and so live
// beside the types rather than in the page. Being plain .ts also makes them
// reachable by vitest, which only collects src/**/*.test.ts.
// ---------------------------------------------------------------------------

/** "2026-08-01" -> "Aug 2026". Null is the undated bucket, not a month. */
export function fmtMonth(s: string | null): string {
  if (s === null) return 'undated'
  const d = new Date(s + 'T00:00:00')
  if (Number.isNaN(d.getTime())) return s
  return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
}

/**
 * Why `net_profit` is null on a pnl_monthly row, in words that are TRUE on
 * every path that can produce the null. Call only when `row.net_profit` is
 * null; it never returns null, because the screen prints this immediately
 * after the word "unknown" and a null would leave a dangling "unknown — ".
 *
 * ledger_04_views.sql:390-391 computes
 *
 *     r.revenue - coalesce(r.direct_cost, 0)
 *               - o.overhead - o.direct_labor - o.direct_storage
 *
 * over a FULL OUTER JOIN, so there are two independent families of cause and
 * the earlier version of this helper knew only about the second:
 *
 *  (a) `r.revenue` is null. Either the join emitted an overhead-only row --
 *      operating_costs has a month that order_charges does not, which is what
 *      you get the moment September's rent is entered before the charge
 *      calculator has run for September -- or every charge in the month has a
 *      null `amount` (at-cost freight whose carrier has not reported yet).
 *      In the first case all three *_rows counts are > 0, so the "missing
 *      category" branch below finds nothing to name.
 *  (b) one or more of o.overhead / o.direct_labor / o.direct_storage is null,
 *      each being a `sum(...) filter (...)` that matched no row.
 *
 * `direct_cost` can never cause it: it is wrapped in coalesce.
 */
export function netProfitUnavailableReason(row: MonthlyRow): string {
  const month = fmtMonth(row.period_month)

  const missing: string[] = []
  if (!row.overhead_rows) missing.push('overhead')
  if (!row.direct_labor_rows) missing.push('direct labor')
  if (!row.direct_storage_rows) missing.push('direct storage')

  const noCostsAtAll =
    row.overhead_rows === null &&
    row.direct_labor_rows === null &&
    row.direct_storage_rows === null

  // (a) first: on an overhead-only row every r.* column is null, and blaming a
  // cost category there would state a false cause beside a row of em-dashes.
  if (row.revenue === null) {
    if (noCostsAtAll) {
      return `no billed revenue and no operating costs recorded for ${month}`
    }
    if (missing.length > 0) {
      return `no billed revenue recorded for ${month}, and no ${missing.join(', ')} cost either`
    }
    return `no billed revenue recorded for ${month}`
  }

  // (b)
  if (noCostsAtAll) return `no operating costs entered for ${month}`
  if (missing.length > 0) return `no ${missing.join(', ')} cost recorded for ${month}`

  // Unreachable against the view as written -- revenue is present, all three
  // categories have rows, and direct_cost is coalesced. Kept, and kept
  // truthful, because the alternative is returning null and printing
  // "unknown — " with nothing after it.
  return `net profit could not be computed for ${month}; the cause is not one this screen can name`
}

/** Confidence label for a pick_days row. */
export function confidenceLabel(n: number | null): string {
  if (n === null || n === 0) return 'unknown'
  if (n >= 3) return 'high'
  if (n >= 2) return 'medium'
  return 'low'
}

// ---------------------------------------------------------------------------
// The labour variance mapping. Pure, exported and kept in this .ts module on
// purpose: vitest only collects src/**/*.test.ts, so nothing inside the .tsx
// page is reachable by a test. The one thing this feature must never get wrong
// -- rendering a missing payroll figure as $0.00 -- is therefore only provable
// if the decision lives here.
// ---------------------------------------------------------------------------

/**
 * `numeric` columns arrive from PostgREST as JSON numbers, but the conversion
 * is asserted rather than assumed. null and undefined stay null: this is the
 * one function in the chain where coalescing to 0 would turn UNKNOWN into FREE.
 */
function num(v: unknown): number | null {
  if (v === null || v === undefined) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * Run each view row through labourVariance(). The subtraction itself is NOT
 * duplicated here -- variance.ts stays the only implementation of it.
 *
 * Total, never throws. labourVariance() raises a RangeError on a negative or
 * non-finite quantity, and this runs inside a Server Component's render: an
 * uncaught throw would take the whole /ledger screen down, losing the leaks
 * table over one malformed charge. A bad quantity becomes 'unavailable' with a
 * named cause instead.
 */
export function mapVarianceRows(rows: VarianceInputRow[]): VarianceRow[] {
  return (rows ?? []).map((r) => {
    const standardRate = num(r.standard_rate)
    const actualCost = num(r.direct_labor)

    // An ABSENT units_picked becomes 0, because the view emits a measured zero
    // for a month with no pick charges (`coalesce(p.units_picked, 0)`) and a
    // null can only arrive if every pick charge in the month carried a null
    // quantity, which no writer in this codebase produces. A PRESENT but
    // unusable value -- NaN, Infinity, negative -- is a different thing and
    // must not collapse to the same 0: that would claim nothing was picked and
    // report the whole payroll as unabsorbed.
    const raw = r.units_picked
    const parsed = raw === null || raw === undefined ? 0 : Number(raw)
    const quantity = Number.isFinite(parsed) && parsed >= 0 ? parsed : null

    const v =
      quantity === null
        ? { absorbed: null, variance: null, basis: 'unavailable' as const }
        : labourVariance({ actualCost, standardRate, quantity })

    return {
      ...r,
      units_picked: quantity,
      unattributable_pick_charges: num(r.unattributable_pick_charges) ?? 0,
      direct_labor: actualCost,
      standard_rate: standardRate,
      implied_actual_rate: num(r.implied_actual_rate),
      // variant_breakdown is exempt from num(): PostgREST deserialises jsonb
      // columns as plain JS objects/arrays before the response reaches this
      // code, so the numeric fields inside arrive already typed as numbers.
      // The breakdown is display-only — no arithmetic touches it — so the
      // asymmetry with the top-level num() calls is deliberate, not an oversight.
      variant_breakdown: r.variant_breakdown ?? null,
      absorbed: v.absorbed,
      variance: v.variance,
      basis: v.basis,
    }
  })
}

/**
 * Why the variance could not be computed, in words that are TRUE on every path
 * that produces `basis: 'unavailable'`. Same contract as
 * netProfitUnavailableReason: call only when the variance is unavailable, and
 * it never returns empty, because the screen prints it after "not computable —"
 * and a blank would leave a dangling dash.
 *
 * There are two independent families of cause and they can co-occur, so both
 * are named rather than the first one found. The previous generation of this
 * mistake on this screen was a tooltip asserting a cause the row contradicted.
 */
export function varianceUnavailableReason(row: VarianceRow): string {
  const causes: string[] = []

  if (row.direct_labor === null) causes.push('payroll not entered')

  if (row.units_picked === null) {
    causes.push('the units picked figure for this month is not a usable count')
  }

  if (row.standard_rate === null) {
    if (row.unattributable_pick_charges > 0) {
      const n = row.unattributable_pick_charges
      causes.push(
        `${n} pick ${n === 1 ? 'charge carries' : 'charges carry'} no rate-card variant, `
        + 'so no standard rate can be chosen',
      )
    } else if (row.units_picked === 0) {
      // After the COMMIT 1 change: when units_picked is 0 and direct_labor is
      // present, labourVariance returns basis:'measured' (absorbed=0,
      // variance=payroll), so varianceUnavailableReason is never called for
      // that combination. This branch is therefore only reachable when
      // direct_labor is also null — the first causes.push() above has already
      // named the missing payroll, and this clause adds the rate context.
      // Both causes are printed together, so the reader sees the full picture.
      // The view cannot distinguish "nothing was picked" from "the charge
      // calculator has not run yet" — both produce zero order_charges rows —
      // so the conclusion is softened to a prompt rather than an assertion.
      causes.push(
        'no pick charges recorded this month, so nothing absorbs the payroll; '
        + 'confirm the charge calculator has run for this month before treating '
        + 'the whole amount as unfavourable',
      )
    } else {
      causes.push('no standard pick rate in effect for every variant picked')
    }
  }

  if (causes.length === 0) {
    // Unreachable against the view as written: every path to 'unavailable' runs
    // through a null payroll, a null standard rate or an unusable unit count,
    // all three of which are named above. Kept, and kept truthful, because the
    // alternative is printing "not computable — " with nothing after it.
    return 'the cause is not one this screen can name'
  }

  return causes.join('; ')
}

/**
 * The full text for a variance cell that has no figure, or null when a figure
 * should be rendered instead. Composed here rather than in the page so the
 * exact string a reader sees is covered by a test — a zero variance and an
 * unknown variance look identical on a screen and mean opposite things.
 */
export function varianceUnavailableText(row: VarianceRow): string | null {
  if (row.basis !== 'unavailable') return null
  return `not computable — ${varianceUnavailableReason(row)}`
}

// ---------------------------------------------------------------------------
// The query
// ---------------------------------------------------------------------------

/**
 * Read the five views for the last three months, plus the undated leak bucket.
 *
 * Every query asks for an exact count so the caller can tell a short table from
 * a truncated one. Every query carries a stable secondary sort: ordering on the
 * month alone leaves rows within a month in whatever order the plan emits, so
 * the page could reorder between loads on unchanged data -- and that order is
 * also what decides which rows survive a truncation.
 *
 * Errors are collected, never thrown. A view that fails to load must not render
 * as an empty table: empty and broken look identical otherwise.
 */
export async function getLedgerSummary(now: Date = new Date()): Promise<LedgerSummary> {
  const from = threeMonthWindowStart(now)

  const [leaks, leaksUndated, monthly, clients, picks, variance] = await Promise.all([
    // leaks_monthly, dated. Grouped by (period_month, client_id, leak), so
    // those three together are a stable total order.
    supabaseAdmin.from('leaks_monthly').select('*', { count: 'exact' })
      .gte('period_month', from)
      .order('period_month', { ascending: false })
      .order('leak', { ascending: true })
      .order('client_id', { ascending: true, nullsFirst: false }),

    // leaks_monthly, UNDATED. `null >= from` is null, so the query above drops
    // these without trace. A row lands here whenever the column it groups on is
    // null and `date_trunc` therefore returns null. The case the view calls out
    // by name (ledger_04_views.sql:190-198) is leak 3, `unpriced_shipments`:
    // shipments.ship_date is nullable, and such a shipment is money we paid a
    // carrier and will never bill, because calculate-charges.ts:188 skips
    // undated shipments outright so no shipping charge can ever be keyed for
    // it. Leak 1 (unattributed_label_spend) reads the same nullable column, and
    // leaks 5-6 read rate_adjustments.adjustment_date, so they can appear here
    // too. No date floor is applied: these rows have no date to floor.
    supabaseAdmin.from('leaks_monthly').select('*', { count: 'exact' })
      .is('period_month', null)
      .order('leak', { ascending: true })
      .order('client_id', { ascending: true, nullsFirst: false }),

    // pnl_monthly is one row per period_month (the full outer join groups on
    // it), so period_month alone is already a total order. No tiebreaker
    // exists to add.
    supabaseAdmin.from('pnl_monthly').select('*', { count: 'exact' })
      .gte('period_month', from)
      .order('period_month', { ascending: false }),

    // pnl_client_monthly is grouped by (period_month, client_id, client_name,
    // charge_type). client_name is sorted on first because that is the order a
    // reader expects; client_id breaks ties between two clients sharing a name
    // and orders the null-name rows against each other.
    supabaseAdmin.from('pnl_client_monthly').select('*', { count: 'exact' })
      .gte('period_month', from)
      .order('period_month', { ascending: false })
      .order('client_name', { ascending: true, nullsFirst: false })
      .order('client_id', { ascending: true, nullsFirst: false })
      .order('charge_type', { ascending: true }),

    // pick_days is grouped by (client_id, pick_date, sku).
    supabaseAdmin.from('pick_days').select('*', { count: 'exact' })
      .gte('pick_date', from)
      .order('pick_date', { ascending: false })
      .order('sku', { ascending: true })
      .order('client_id', { ascending: true, nullsFirst: false })
      .limit(PICK_ROW_LIMIT),

    // labour_variance_inputs is one row per period_month (the `months` union it
    // joins onto is distinct), so period_month alone is already a total order.
    //
    // NO UNDATED COMPANION ARRAY IS NEEDED HERE, and that is a checked claim
    // rather than an oversight -- contrast leaksUndated above, which exists
    // because `null >= from` is null and a gte filter silently drops a whole
    // null bucket. Both sides of this view are NOT NULL at the source:
    // order_charges.charge_date is `date not null` (ledger_03_charges.sql:74)
    // and operating_costs.period_month is `date not null`
    // (ledger_02_cost.sql:81). date_trunc of a non-null date is non-null, and
    // the `months` union draws from nothing else, so no row of this view can
    // carry a null period_month for the filter to drop.
    supabaseAdmin.from('labour_variance_inputs').select('*', { count: 'exact' })
      .gte('period_month', from)
      .order('period_month', { ascending: false }),
  ])

  // Name the view beside the message. With six queries, a bare Postgres error
  // string does not say which table went missing.
  const errors: string[] = []
  const named: Array<[string, { error: { message: string } | null }]> = [
    ['leaks_monthly', leaks],
    ['leaks_monthly (undated)', leaksUndated],
    ['pnl_monthly', monthly],
    ['pnl_client_monthly', clients],
    ['pick_days', picks],
    ['labour_variance_inputs', variance],
  ]
  for (const [name, res] of named) {
    if (res.error) errors.push(`${name}: ${res.error.message}`)
  }

  return {
    leaks: (leaks.data ?? []) as LeakRow[],
    leaksUndated: (leaksUndated.data ?? []) as LeakRow[],
    monthly: (monthly.data ?? []) as MonthlyRow[],
    clients: (clients.data ?? []) as ClientRow[],
    picks: (picks.data ?? []) as PickRow[],
    variance: mapVarianceRows((variance.data ?? []) as VarianceInputRow[]),
    counts: {
      leaks: leaks.count ?? null,
      leaksUndated: leaksUndated.count ?? null,
      monthly: monthly.count ?? null,
      clients: clients.count ?? null,
      picks: picks.count ?? null,
      variance: variance.count ?? null,
    },
    errors,
  }
}
