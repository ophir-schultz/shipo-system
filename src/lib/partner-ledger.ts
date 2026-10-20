import { supabaseAdmin } from '@/lib/supabase'
import type { FbaInvoice, ReferredClient } from '@/lib/referrals'
import { ORDER_UNITS_LIMIT, type OrderUnitsRow } from '@/lib/partner-activity'

// Partner statement inputs, read from the ledger.
//
// Spec: docs/superpowers/specs/2026-10-11-partner-ledger-statements-design.md
// SQL:  supabase/partner_ledger.sql
//
// ONE loader, used by both the partner statement and /pnl. That is the entire
// point of the design: the two screens cannot disagree about what we owe if
// they cannot reach different numbers. If you need a figure on one screen that
// is not here, add it here.
//
// What this module does NOT do is decide anything. The deal lives in
// src/lib/referrals.ts (REFERRAL_TERMS, computeOwed, buildStatement) and stays
// there. This file loads rows and shapes them into the FbaInvoice the
// economics already take, so none of that code had to change to read from a
// different source.

/** A row of public.partner_client_monthly. */
export interface LedgerMonth {
  period_month: string // 'YYYY-MM-DD', first of month
  client_id: string
  client_name: string
  referral_partner_id: string | null
  revenue: number | null
  cost_freight: number
  cost_materials: number
  cost_storage: number

  /**
   * Reported, never deducted. The agreement deducts freight, materials,
   * storage and processing — not warehouse labour. So partner net profit is
   * structurally HIGHER than our real gross margin by exactly this figure.
   * That is the signed deal, not a bug. /pnl renders it beside our margin so
   * nobody misreads one for the other.
   */
  cost_labour_not_deducted: number

  net_profit_before_processing: number | null
  revenue_unknown_charges: number
  cost_unknown_charges: number
  payable: boolean
  has_estimates: boolean
}

export interface PartnerLedger {
  /** This partner's clients, from the clients table — the authoritative list. */
  clients: ReferredClient[]

  months: LedgerMonth[]

  /**
   * Per-order ACTIVITY — units, never money. See supabase/partner_order_units.sql.
   *
   * This replaced a read of partner_order_transactions, which carries
   * amount_billed per order. `amount / quantity` on one order IS the rate card,
   * and several referral partners are agencies who also resell fulfilment, so
   * the shipped statement handed a competitor our pricing one order at a time.
   *
   * The amount is gone from the LOADER and not merely from the render, which is
   * the only version of that fix that holds: a component cannot leak a figure
   * this function never fetched. /pnl lost nothing — it reads order_charges
   * directly for its own drilldown and only ever used this array's length.
   */
  orderUnits: OrderUnitsRow[]
  orderUnitsTruncated: boolean

  /**
   * Ready for computeOwed() / buildStatement(). The ledger is authoritative
   * for revenue and the three ledger-known cost buckets; fba_invoices supplies
   * processing (the ledger has no such charge type), the hand-recorded volume
   * figures, and any month the ledger does not cover at all.
   */
  invoices: FbaInvoice[]

  /**
   * The hand-typed fba_invoices rows AS READ — not merged, not overwritten.
   *
   * This exists for reconcile() and nothing else, and it has to exist
   * separately because `invoices` above cannot answer the question. A merged
   * row keeps the hand-typed row's `id` but carries the LEDGER's amount, so
   * comparing it to the ledger compares the ledger to itself and reports a
   * delta of 0 on every month — a reassuring green on exactly the figures
   * nobody has ever checked. That was live on /pnl until 2026-10-12.
   */
  manualInvoices: FbaInvoice[]

  /** 'clientId:YYYY-MM-DD' for every month the ledger could not finish pricing. */
  provisionalKeys: Set<string>

  /**
   * Set when any of the four reads below returned an error.
   *
   * This is not defensive padding. Every read here ends in `.data ?? []`, so a
   * failed query is INDISTINGUISHABLE from a partner who is genuinely owed
   * nothing — and the statement answers that case with "No statement yet.
   * Nothing is missing — there is simply nothing to report yet." A database
   * error would therefore render as a written assurance to a partner that they
   * have earned nothing, which is the worst sentence this page could produce.
   *
   * It is reachable TODAY: supabase/partner_ledger.sql has never been applied,
   * so both views are absent and both reads fail 42P01 on every request.
   * Verified by injecting that error into the double — the loader returned a
   * clean, empty, entirely plausible ledger.
   *
   * Callers must check this BEFORE presenting any figure derived from it.
   */
  readFailed: string | null
}

/** Key for joining a month row to a transaction row, or to an invoice. */
export function monthKey(clientId: string, periodMonth: string): string {
  return `${clientId}:${periodMonth}`
}

const LEDGER_ID_PREFIX = 'ledger:'

/**
 * The synthetic id for a month that exists only in the ledger.
 *
 * referral_payouts.fba_invoice_id is `uuid references fba_invoices(id)`, so
 * writing one of these to it fails — 22P02 on the cast, or 23503 on the key.
 * That is the desired outcome: the column is nullable and informational, and a
 * ledger month has no invoice row to point at. Any write path that forwards
 * fbaInvoiceId must drop it when isLedgerInvoiceId() is true.
 */
export function ledgerInvoiceId(clientId: string, periodMonth: string): string {
  return `${LEDGER_ID_PREFIX}${clientId}:${periodMonth}`
}

export function isLedgerInvoiceId(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.startsWith(LEDGER_ID_PREFIX)
}

const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0)

/**
 * Load one partner's ledger.
 *
 * EVERY read is filtered server-side, and the clients query runs FIRST so the
 * other three have ids to filter on. That sequencing costs one round trip and
 * is the point of this function: the code it replaces selected every
 * fba_invoices row in the system and narrowed it by client in JS afterwards.
 * That was not a leak, because the filter ran before the render — but a filter
 * that lives in the render is one refactor away from being one, and a filter
 * that lives in the query is not.
 */
export async function loadPartnerLedger(partnerId: string): Promise<PartnerLedger> {
  const clientsRes = await supabaseAdmin
    .from('clients')
    .select(
      'id, name, referral_partner_id, referral_signup_date, referral_first_payment_date, founding_bonus_seq',
    )
    .eq('referral_partner_id', partnerId)

  const clients = (clientsRes.data ?? []) as ReferredClient[]
  const clientIds = clients.map((c) => c.id)

  // No clients, no statement. Returning early also avoids `.in('client_id',
  // [])`, which is a filter that matches nothing but still asks the question.
  //
  // A FAILED clients read also lands here, with clients = []. The two are not
  // the same thing and must not render the same way, hence readFailed.
  if (clientIds.length === 0) {
    return {
      clients,
      months: [],
      orderUnits: [],
      orderUnitsTruncated: false,
      invoices: [],
      manualInvoices: [],
      provisionalKeys: new Set(),
      readFailed: clientsRes.error ? `clients: ${clientsRes.error.message}` : null,
    }
  }

  const [monthsRes, unitsRes, invoicesRes] = await Promise.all([
    supabaseAdmin
      .from('partner_client_monthly')
      .select('*')
      .eq('referral_partner_id', partnerId)
      .order('period_month', { ascending: false }),
    // Newest-first so that the cap below can only ever hide the OLDEST orders,
    // which is the only truncation a reader can reason about. nullsFirst: false
    // keeps undated orders off the top of the list — order_date is nullable and
    // Postgres sorts nulls first on a descending sort by default.
    supabaseAdmin
      .from('partner_order_units')
      .select('*')
      .eq('referral_partner_id', partnerId)
      .order('period_month', { ascending: false })
      .order('order_date', { ascending: false, nullsFirst: false })
      .limit(ORDER_UNITS_LIMIT),
    // fba_invoices carries no partner column, so this one filters by client.
    supabaseAdmin
      .from('fba_invoices')
      .select(
        'id, client_id, period, amount, units_shipped, orders_shipped, cost_freight, cost_materials, cost_storage, cost_processing',
      )
      .in('client_id', clientIds),
  ])

  // Collect every failure, not just the first. "the views are missing" and
  // "the views are missing AND fba_invoices is unreadable" are different
  // problems, and whoever reads the log should not have to fix one to
  // discover the other.
  const failures = [
    clientsRes.error && `clients: ${clientsRes.error.message}`,
    monthsRes.error && `partner_client_monthly: ${monthsRes.error.message}`,
    unitsRes.error && `partner_order_units: ${unitsRes.error.message}`,
    invoicesRes.error && `fba_invoices: ${invoicesRes.error.message}`,
  ].filter(Boolean) as string[]

  const readFailed = failures.length > 0 ? failures.join('; ') : null
  if (readFailed) console.error('[partner-ledger] read failed:', readFailed)

  const months = (monthsRes.data ?? []) as LedgerMonth[]
  const orderUnits = (unitsRes.data ?? []) as OrderUnitsRow[]
  const allInvoices = (invoicesRes.data ?? []) as FbaInvoice[]

  const orderUnitsTruncated = orderUnits.length >= ORDER_UNITS_LIMIT

  const provisionalKeys = new Set<string>()
  for (const m of months) if (!m.payable) provisionalKeys.add(monthKey(m.client_id, m.period_month))

  // ---- the merge ---------------------------------------------------
  //
  // fba_invoices rows are the record of what was already PAID. They are not
  // replaced, for two reasons: they carry cost_processing, which the ledger has
  // no charge type for, and they may cover months from before the ledger
  // existed. Dropping those would make a partner's past statements vanish.
  //
  // So: ledger wins on revenue and the three buckets it knows, fba_invoices
  // supplies the rest, and a month present in only one source still appears.
  const invoiceByKey = new Map<string, FbaInvoice>()
  for (const inv of allInvoices) {
    invoiceByKey.set(monthKey(inv.client_id, inv.period), inv)
  }

  // Orders per (client, month). One row of partner_order_units IS one order —
  // the view groups by orders.id, not by order_number, precisely so that a
  // number two integrations both used cannot collapse two orders into one.
  //
  // MONTH BASIS: these months come from order_date, while the money months
  // below come from charge_date. An order placed on the 30th and charged on the
  // 1st therefore lands in different months in the two sources. That matters
  // only for the fallback on the next line — a volume figure used where no
  // staff member ever recorded one — and the alternative was deleting the
  // figure from every month that has no hand-typed count. The previous source
  // for it was partner_order_transactions, which carries the per-order amount
  // this loader must not fetch.
  const ledgerOrderCount = new Map<string, number>()
  for (const r of orderUnits) {
    const key = monthKey(r.client_id, r.period_month)
    ledgerOrderCount.set(key, (ledgerOrderCount.get(key) ?? 0) + 1)
  }

  const invoices: FbaInvoice[] = []
  const covered = new Set<string>()

  for (const m of months) {
    const key = monthKey(m.client_id, m.period_month)
    covered.add(key)
    const manual = invoiceByKey.get(key)

    // Prefer the hand-recorded order count: changing a number a partner has
    // already been shown invites a dispute we would lose. Fall back to the
    // ledger's count only where no figure was ever recorded.
    //
    // Both are wrong if the order read was truncated — the count would be of
    // the rows that survived the cap, not of the month. A month short of its
    // orders is still better than a wrong count presented as fact, so the
    // fallback is suppressed entirely in that case.
    const ledgerOrders = orderUnitsTruncated ? 0 : (ledgerOrderCount.get(key) ?? 0)

    invoices.push({
      id: manual?.id ?? ledgerInvoiceId(m.client_id, m.period_month),
      client_id: m.client_id,
      period: m.period_month,

      // `?? 0` and not num(): revenue is null only when EVERY amount in the
      // month is unknown, and such a month is provisional below, so the 0
      // never reaches a figure anyone is paid on.
      amount: m.revenue ?? 0,

      // The ledger cannot say how many prep UNITS moved — `pick` quantity is
      // not a unit count. Only the hand-recorded figure is used, and null
      // stays null so the statement omits the line rather than printing a 0
      // that reads as "your client shipped nothing".
      units_shipped: manual?.units_shipped ?? null,
      orders_shipped: manual?.orders_shipped ?? (ledgerOrders > 0 ? ledgerOrders : null),

      cost_freight: m.cost_freight,
      cost_materials: m.cost_materials,
      cost_storage: m.cost_storage,

      // Processing is the one deducted bucket the ledger has no charge type
      // for. It stays a manual monthly input until there is a payment-processor
      // integration, and there is no Stripe code anywhere in this repo.
      cost_processing: manual?.cost_processing ?? null,

      provisional: !m.payable,
    })
  }

  // Months the ledger does not cover: the already-paid record, untouched.
  // No client check needed — the query above was filtered by client.
  for (const inv of allInvoices) {
    if (covered.has(monthKey(inv.client_id, inv.period))) continue
    invoices.push(inv)
  }

  return {
    clients,
    months,
    orderUnits,
    orderUnitsTruncated,
    invoices,
    manualInvoices: allInvoices,
    provisionalKeys,
    readFailed,
  }
}

/**
 * Reconciliation against the hand-typed record, for a (client, month).
 *
 * Returns null when only one source has the month — that is not a
 * disagreement, it is coverage. A non-zero delta is the first real test of
 * whether the hand-typed figures were ever right, so it must be rendered, not
 * rounded away.
 *
 * TAKES THE LEDGER, not an invoice array, and that is the whole point of the
 * signature. The obvious call — passing `ledger.invoices`, the array every
 * other consumer wants — compares the ledger figure to itself and answers 0
 * for every month, because a merged row carries the hand-typed row's id and
 * the ledger's amount. It was written that way, it shipped, and no test could
 * see it because 0 is a plausible delta. Narrowing the parameter to the one
 * field that holds unmerged rows makes that call a type error instead of a
 * silent 0, which is the only version of this guard that works: the previous
 * attempt filtered on isLedgerInvoiceId(), and a merged row passes it.
 */
export function reconcile(
  month: LedgerMonth,
  ledger: Pick<PartnerLedger, 'manualInvoices'>,
): { manualAmount: number; ledgerAmount: number; delta: number } | null {
  const manual = ledger.manualInvoices.find(
    (i) => i.client_id === month.client_id && i.period === month.period_month,
  )
  if (!manual || month.revenue === null) return null
  const manualAmount = num(manual.amount)
  const ledgerAmount = num(month.revenue)
  return {
    manualAmount,
    ledgerAmount,
    delta: Math.round((ledgerAmount - manualAmount) * 100) / 100,
  }
}
