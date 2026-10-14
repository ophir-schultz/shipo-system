// ============================================================
// Referral payout economics — single source of truth.
//
// Shipo's partner-referral deal, as published at
// shipousa.com/partner-program/ and as written in the Referral
// Partner Agreement. These three must never disagree.
//
//   • $300 one-time bonus, ADDITIVE, owed after the referred
//     client's first payment.
//   • 5% of NET PROFIT on the referred client's whole account,
//     paid monthly for 12 months from the client's FIRST PAID
//     INVOICE.
//   • "Net profit" = amount invoiced to the client for the month
//     LESS the direct costs of serving that account: freight and
//     carrier charges, packaging and prep materials, storage, and
//     payment-processing fees. Warehouse labor is NOT deducted.
//   • A balance under $50 rolls into the following month.
//   • NO qualification threshold and NO waiting period. The bonus
//     is owed once the referred client signs and pays its first
//     invoice, whatever the amount. (Until 2026-10-12 this read
//     "$500 or more billed in a calendar month" plus "60 days
//     active"; both were dropped.)
//
// Nothing here moves money. It computes what is OWED so Ophir can
// review each line and approve it. Every payout stays `pending`
// until approved.
//
// TWO SERVICE LINES, ONE PROGRAM
// -------------------------------
// Shipo sells FBA prep (billed per unit) and DTC fulfillment (not).
// The commission half of the deal never cared about the difference —
// it is 5% of net profit on whatever was invoiced, so it works for
// both without knowing which is which.
//
// The bonus half used to care, because a qualification written in units
// is an FBA-only qualification: `units_shipped` is typed by hand on
// the invoice form and defaults to 0, so a DTC referral would sit at
// "not yet owed" forever with nothing on screen to explain why.
//
// The STANDING programme no longer has any bar, so that whole hazard is
// gone for it: FBA and DTC referrals are both owed on the first paid
// invoice. The machinery below stays because a signed partner may still
// hold a BESPOKE bar on their own row, and a client held to one
// qualifies on WHICHEVER of its bars it clears in a calendar month —
// units, orders, or revenue, whichever comes first.
// ============================================================

export const REFERRAL_TERMS = {
  SIGNUP_BONUS: 300, // one-time, additive, after first payment
  COMMISSION_RATE: 0.05, // 5% of net profit on the account
  COMMISSION_MONTHS: 12, // window length, from first paid invoice
  MIN_PAYOUT: 50, // below this a balance rolls to the next month

  // ---- NO QUALIFICATION THRESHOLD -------------------------------
  //
  // All three bars are null, and all three being null on the STANDING
  // programme means "every referred client qualifies on its first
  // invoice, whatever the amount". Agreement clause 3.1.
  //
  // Dropped by Ophir on 2026-10-12. This used to be
  // QUALIFY_MIN_REVENUE: 500 — "a client counts once they're billing
  // $500 or more in a calendar month", published on
  // shipousa.com/partner-program/ and written into agreement 3.1. The
  // website copy and the agreement were changed on the same day; if you
  // find one of them still saying $500, that one is the stale copy, not
  // this file. `src/lib/referral-agreement-terms.test.ts` asserts the
  // agreement agrees with these constants.
  //
  // ⚠️ null here is NOT the same as a partner row storing 0. See
  // `QualifyBars.unbarred` — the two shapes are identical in the data
  // and opposite in meaning, which is why the answer is carried as a
  // flag rather than inferred from the nulls.
  //
  // A partner row may still carry its own revenue, unit or order bar
  // (bonus_min_revenue / bonus_min_units / bonus_min_orders), which is a
  // bespoke contracted term for one signed partner, not a program-wide
  // offer. Those columns stay, and a row that carries one is still held
  // to it even though the standing programme no longer has any.
  QUALIFY_MIN_REVENUE: null as number | null,
  QUALIFY_MIN_UNITS: null as number | null,
  QUALIFY_MIN_ORDERS: null as number | null,

  // ---- NO WAITING PERIOD ----------------------------------------
  //
  // Was 60: "60 days active", published and written into agreement 3.2.
  // The bonus was not released until the client had been on the books
  // that long, so a bonus was not paid on an account that signed and
  // churned in week two. Dropped by Ophir on 2026-10-12 alongside the
  // revenue bar; the exposure was put to him and he chose to proceed.
  //
  // 0 means the gate does not apply at all, and the code says so by
  // name rather than by arithmetic — a "0-day wait" that still computes
  // a release date would put "releases after 0 days active" on a
  // partner's statement.
  QUALIFY_MIN_DAYS_ACTIVE: 0,
} as const

// ---- the withdrawn launch offer ----------------------------------
//
// ⚠️ THERE IS NO FOUNDING / LAUNCH / PROMOTIONAL TIER. Do not re-add
// one here without a decision from Ophir and a matching clause in the
// agreement — see 3.11, which now states in terms that none exists.
//
// A `FOUNDING_CLIENT_TERMS` constant used to live at this spot: a $500
// bonus instead of $300 for the first 10 referred clients that shipped
// more than 1,500 prep units or more than 500 orders in a month, plus a
// revenue-share window shifted to the client's second month. Withdrawn
// by Ophir on 2026-10-12, before any partner was signed and before any
// bonus was paid, so nothing was restated and nobody was underpaid.
//
// It was also never published: shipousa.com/partner-program/ has only
// ever advertised "$300 + 5% for 12 months", and the $500 on that page
// is the QUALIFICATION threshold (REFERRAL_TERMS.QUALIFY_MIN_REVENUE),
// not a bonus. The offer was a promise the website never made, which is
// why removing it moves the code toward the published deal rather than
// away from it.
//
// `clients.founding_bonus_seq` still exists in the database and is
// still refused by the client write-guard (src/lib/clients/
// editable-fields.ts). Nothing reads it to price anything any more.

export type PayoutKind = 'signup_bonus' | 'commission'
export type PayoutStatus = 'computed' | 'pending' | 'approved' | 'paid'

export interface ReferralPartner {
  id: string
  name: string
  company: string | null
  status: string | null

  // The offer this partner was ADMITTED under, frozen on their row.
  // All null = the standing terms apply, whatever REFERRAL_TERMS says
  // today. A value = this partner's own figure, which changing the
  // standing offer later must never rewrite.
  //
  // ⚠️ These are BESPOKE terms for one signed partner, not a program
  // offer. They survive the withdrawal of the launch offer on purpose:
  // if a partner was admitted on a contracted figure, paying them the
  // standing $300 instead would underpay a signed agreement — a quieter
  // and worse failure than overpaying, because nobody would query it.
  signup_bonus_amount?: number | null // a contracted bonus for this partner
  bonus_min_units?: number | null // a contracted prep-unit bar
  bonus_min_orders?: number | null // a contracted DTC-order bar
  bonus_min_revenue?: number | null // a contracted revenue bar
  founding_partner?: boolean | null // legacy flag; prices nothing
}

export interface ReferredClient {
  id: string
  name: string
  referral_partner_id: string | null
  referral_signup_date: string | null // YYYY-MM-DD — record only
  referral_first_payment_date: string | null // YYYY-MM-DD — starts the 12-month window

  // DEAD FIELD, kept because the column and its partial UNIQUE index
  // still exist in the database. The launch offer it numbered was
  // withdrawn on 2026-10-12 and no place was ever approved, so every
  // row is null. Nothing prices anything from it; the client
  // write-guard still refuses writes to it.
  founding_bonus_seq?: number | null
}

export interface FbaInvoice {
  id: string
  client_id: string
  period: string // YYYY-MM-DD (first of month)
  amount: number // TOTAL invoiced to the client that month, before deductions

  // Volume, by service line. Both are NULLABLE with no default on
  // purpose: null means "not recorded", 0 means "recorded, and it was
  // genuinely zero". A column defaulting to 0 cannot tell those apart,
  // and the difference decides whether a bonus is owed.
  units_shipped?: number | null // FBA prep
  orders_shipped?: number | null // DTC
  cost_freight?: number | null
  cost_materials?: number | null
  cost_storage?: number | null
  cost_processing?: number | null

  /**
   * True when a figure this month depends on is not known yet — a
   * charge in a DEDUCTED bucket with no cost, or a charge with no
   * amount. Set by the ledger loader from
   * partner_client_monthly.payable; a hand-typed fba_invoices row
   * leaves it undefined, which reads as "nothing says otherwise".
   *
   * It does not change what is owed. It says the inputs are not final
   * yet, and a commission line on such a month is reported at 0 rather
   * than at a figure derived from costs we have not finished pricing.
   * Unpriced costs read as FREE, which overstates net profit, and 5% of
   * a margin we never earned is cash that does not come back.
   *
   * Deliberately does NOT suppress the month for qualification or
   * tenure: revenue on a provisional month reads LOW, never high, so a
   * client that already cleared $500 cleared it, and dropping the month
   * would delay a bonus that is genuinely earned.
   */
  provisional?: boolean | null
}

export interface PayoutRecord {
  id: string
  dedupe_key: string | null
  status: string
  amount: number
  approved_at: string | null
  paid_at: string | null
}

export interface OwedLine {
  dedupeKey: string
  partnerId: string
  partnerName: string
  clientId: string
  clientName: string
  kind: PayoutKind
  period: string // 'YYYY-MM'
  amount: number
  status: PayoutStatus
  // for commission lines, the invoice it derives from
  fbaInvoiceId?: string
  // human note explaining timing / gating
  note?: string
  recordId?: string

  /**
   * commission lines only. The month's inputs are not final — see
   * FbaInvoice.provisional. This is about the FIGURES, not about any
   * status of the client.
   *
   * `amount` is 0 on such a line unless a payout record already exists
   * for it, so a provisional month cannot inflate a total. Render the
   * flag; never render the amount alone.
   */
  provisional?: boolean
}

const round2 = (n: number) => Math.round(n * 100) / 100

const num = (v: number | null | undefined) => (Number.isFinite(Number(v)) ? Number(v) : 0)

/** The four deductible direct costs, broken out. Labor is NOT one of them. */
export function costBreakdown(inv: FbaInvoice) {
  return {
    freight: round2(num(inv.cost_freight)),
    materials: round2(num(inv.cost_materials)),
    storage: round2(num(inv.cost_storage)),
    processing: round2(num(inv.cost_processing)),
  }
}

export function totalCosts(inv: FbaInvoice): number {
  const c = costBreakdown(inv)
  return round2(c.freight + c.materials + c.storage + c.processing)
}

/** Amount invoiced less the four direct costs. Never negative for payout purposes. */
export function netProfit(inv: FbaInvoice): number {
  return round2(Math.max(0, num(inv.amount) - totalCosts(inv)))
}

export function commissionOn(inv: FbaInvoice): number {
  return round2(netProfit(inv) * REFERRAL_TERMS.COMMISSION_RATE)
}

// ---- qualification -------------------------------------------------

export interface QualifyBars {
  minRevenue: number | null
  minUnits: number | null
  minOrders: number | null

  /**
   * True only for the STANDING programme when the standing programme has
   * no bar at all: every referred client qualifies on its first invoice,
   * whatever the amount.
   *
   * ⚠️ This flag exists because "no bars" is ambiguous and the two meanings
   * are opposites. Three nulls can arrive here two ways:
   *
   *   1. the standing programme sets no threshold  -> qualify on invoice 1
   *   2. a partner's bespoke row zeroes its bars   -> qualify on nothing
   *
   * `bar()` maps 0 to null, deliberately, because `amount >= 0` is true of
   * every invoice ever written and a live 0 bar would release a bonus on
   * every client instantly. So case 2 MUST stay fail-closed. Reading the
   * nulls alone cannot tell the cases apart, which is why the answer is
   * carried as a flag set at the branch that knows, instead of inferred
   * downstream from the shape of the data.
   */
  unbarred: boolean
}

/** A stored bar, normalised. null or <= 0 means "this path is closed". */
function bar(v: number | null | undefined): number | null {
  if (v === null || v === undefined) return null
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return null
  return n
}

/**
 * The bars this partner's referrals have to clear.
 *
 * ALL-OR-NOTHING, not per-column fallback. If the partner row carries
 * any bar of its own, that row IS the whole offer and the standing
 * terms are not consulted for the columns it leaves null.
 *
 * This matters for real money. A Founding Partner is admitted on
 * "more than 1,500 units OR more than 500 orders" and deliberately has
 * NO revenue path. Under per-column `??` fallback their null revenue
 * column would have resolved to the standing $500, and a client billing
 * $500 would have collected a $500 bonus through a route Ophir never
 * approved. A frozen offer is a complete offer, not a patch over the
 * standing one.
 *
 * A stored 0 CLOSES a path rather than opening it. `amount >= 0` is
 * true of every invoice ever written, so reading 0 as a live bar would
 * qualify everyone instantly — the opposite of what typing a 0 looks
 * like it means.
 */
export function qualifyBars(partner: ReferralPartner): QualifyBars {
  const own =
    partner.bonus_min_revenue !== null && partner.bonus_min_revenue !== undefined
      ? true
      : partner.bonus_min_units !== null && partner.bonus_min_units !== undefined
        ? true
        : partner.bonus_min_orders !== null && partner.bonus_min_orders !== undefined

  if (own) {
    // A bespoke row is the WHOLE offer, and a bespoke row that resolves
    // to no bars at all is fail-closed on purpose: `unbarred` is false
    // here unconditionally. Typing 0 into a contracted bar looks like
    // "nothing required" and must not become it, because `amount >= 0`
    // is true of every invoice ever written. If a signed partner is
    // genuinely meant to have no threshold, the fix is to NULL their
    // bespoke columns so they fall to the standing programme — not to
    // zero them.
    return {
      minRevenue: bar(partner.bonus_min_revenue),
      minUnits: bar(partner.bonus_min_units),
      minOrders: bar(partner.bonus_min_orders),
      unbarred: false,
    }
  }
  const minRevenue = bar(REFERRAL_TERMS.QUALIFY_MIN_REVENUE)
  const minUnits = bar(REFERRAL_TERMS.QUALIFY_MIN_UNITS)
  const minOrders = bar(REFERRAL_TERMS.QUALIFY_MIN_ORDERS)
  return {
    minRevenue,
    minUnits,
    minOrders,
    // Computed, not hardcoded true. Re-introducing a standing threshold
    // is one edit to REFERRAL_TERMS and this follows it; writing `true`
    // here would leave a programme-wide bar silently unenforced.
    unbarred: minRevenue === null && minUnits === null && minOrders === null,
  }
}

/** What this partner is owed per referred client that qualifies. */
export function bonusAmount(partner: ReferralPartner): number {
  return round2(partner.signup_bonus_amount ?? REFERRAL_TERMS.SIGNUP_BONUS)
}

/**
 * Does one month's invoice clear either bar?
 *
 * Revenue is AT OR ABOVE its bar — the published wording is "$500 or
 * more". Units and orders are STRICTLY ABOVE theirs — the Founding
 * Partner offer says "more than 1,500 units" and "more than 500
 * orders", so 1,500 and 500 exactly do not clear them. The comparators
 * differ because the promises differ; do not "tidy" them into one.
 *
 * Any single path is enough. An FBA account clears on units, a DTC
 * account clears on orders, and an account doing both clears on
 * whichever comes first.
 *
 * A null volume figure is NOT a zero here. `num()` would turn it into
 * 0 and quietly answer "does not qualify" for a month nobody has
 * entered volume for yet — a wrong answer dressed as a real one. Only
 * a recorded number is compared.
 */
export function qualifiesInMonth(inv: FbaInvoice, bars: QualifyBars): boolean {
  // The standing programme has no bar: any invoice qualifies. Checked
  // FIRST and off the flag, never off "all three are null" — a bespoke
  // row whose bars resolved away has the same nulls and the opposite
  // answer.
  if (bars.unbarred) return true
  if (bars.minRevenue !== null && num(inv.amount) >= bars.minRevenue) return true
  if (bars.minUnits !== null && inv.units_shipped != null && num(inv.units_shipped) > bars.minUnits)
    return true
  if (bars.minOrders !== null && inv.orders_shipped != null && num(inv.orders_shipped) > bars.minOrders)
    return true
  return false
}

/**
 * The EARLIEST invoice that qualifies, or null if none has yet.
 *
 * Earliest and not latest: the bonus is owed from the moment the
 * client first clears the bar, and a later dip back below it does not
 * un-owe a bonus that was already earned.
 */
export function qualifyingInvoice(
  invoices: FbaInvoice[],
  bars: QualifyBars,
): FbaInvoice | null {
  const sorted = invoices.slice().sort((a, b) => a.period.localeCompare(b.period))
  for (const inv of sorted) {
    if (qualifiesInMonth(inv, bars)) return inv
  }
  return null
}

// ---- "60 days active" --------------------------------------------

/**
 * The client's first invoiced month is the best start date available —
 * `clients` carries no start date, and adding one would be another
 * hand-typed field that defaults to wrong.
 */
function firstPeriodOf(invoices: FbaInvoice[]): string | null {
  let first: string | null = null
  for (const inv of invoices) if (!first || inv.period < first) first = inv.period
  return first
}

/** The date the 60-day clock runs out, or null if they have no invoices. */
export function tenureReleaseDate(invoices: FbaInvoice[], minDays: number): Date | null {
  const first = firstPeriodOf(invoices)
  if (!first) return null
  const [y, m, d] = first.slice(0, 10).split('-').map(Number)
  const start = new Date(Date.UTC(y, m - 1, d || 1))
  start.setUTCDate(start.getUTCDate() + minDays)
  return start
}

/**
 * A Date as 'YYYY-MM-DD', in UTC.
 *
 * Exported alongside monthIndex so that a caller holding a Date can reach
 * the same month arithmetic without writing its own getMonth() — a local
 * one would put a 1st-of-the-month Date in the previous month west of
 * Greenwich, and the window boundary is a month.
 */
export const isoDay = (d: Date) => d.toISOString().slice(0, 10)

/**
 * Human sentence for why a bonus is or is not owed yet. Only ever
 * reached when NO invoice qualified.
 *
 * Which makes the unbarred case a different sentence, not a shorter
 * one. Under the standing programme every invoice qualifies, so "no
 * invoice qualified" can now only mean there is no invoice — and saying
 * anything about a threshold would send the reader looking for a bar
 * that does not exist.
 */
function qualifyNote(bars: QualifyBars): string {
  if (bars.unbarred) return 'Not yet owed — the client has not been invoiced yet'

  const parts: string[] = []
  if (bars.minRevenue !== null) parts.push(`$${bars.minRevenue.toLocaleString()} billed`)
  if (bars.minUnits !== null) parts.push(`more than ${bars.minUnits.toLocaleString()} units`)
  if (bars.minOrders !== null) parts.push(`more than ${bars.minOrders.toLocaleString()} orders`)

  // Not unbarred, yet no bar survived: a bespoke partner row carrying
  // 0s, which `bar()` closes rather than opens. Nothing will ever
  // qualify this partner's referrals, so the note has to say that out
  // loud and say what to do about it — the old wording ("no
  // qualification set") read like the opposite, as though there was
  // nothing to clear.
  if (parts.length === 0) {
    return (
      'Never owed — this partner row sets its contracted thresholds to 0, which closes ' +
      'every path. Clear those columns to put them on the standing terms.'
    )
  }
  return `Not yet owed — needs ${parts.join(' or ')} in one calendar month`
}

/**
 * Which bar actually cleared it, for the note on the owed line.
 * Checked in the same order `qualifiesInMonth` checks them, so the
 * sentence can never name a bar that was not the one that fired.
 */
function clearedBy(inv: FbaInvoice, bars: QualifyBars): string {
  // No bar to name. `qualifyingInvoice` returns the EARLIEST invoice, so
  // under an unbarred offer the one handed in here is the first one —
  // which is exactly the event agreement 3.1 now turns on.
  if (bars.unbarred) return `its first invoice ($${num(inv.amount).toLocaleString()})`
  if (bars.minRevenue !== null && num(inv.amount) >= bars.minRevenue) {
    return `$${num(inv.amount).toLocaleString()} billed`
  }
  if (bars.minUnits !== null && inv.units_shipped != null && num(inv.units_shipped) > bars.minUnits) {
    return `${num(inv.units_shipped).toLocaleString()} units`
  }
  if (bars.minOrders !== null && inv.orders_shipped != null && num(inv.orders_shipped) > bars.minOrders) {
    return `${num(inv.orders_shipped).toLocaleString()} orders`
  }
  return 'qualifying volume'
}

/** 'YYYY-MM' label for a YYYY-MM-DD date string (UTC-safe, no tz drift). */
export function monthLabel(dateStr: string): string {
  return dateStr.slice(0, 7)
}

/**
 * Whole-month index (year*12+month) for range math.
 *
 * Exported because the partner's client roster (partner-roster.ts) has to
 * answer "where in the 12-month window is this client" and that answer must
 * come out of the SAME arithmetic that decides whether a month's commission
 * is owed. Two implementations would disagree on a boundary month, and the
 * screen would then name a window the payout does not honour.
 */
export function monthIndex(dateStr: string): number {
  const [y, m] = dateStr.slice(0, 10).split('-').map(Number)
  return y * 12 + (m - 1)
}

export function dedupeKey(clientId: string, kind: PayoutKind, period: string): string {
  return `${clientId}:${kind}:${period}`
}

/**
 * Compute every payout line OWED across all referred clients.
 * Merges in the persisted ledger status (pending/approved/paid);
 * lines with no ledger row yet are marked 'computed'.
 */
export interface ComputeOwedOptions {
  /** Injectable clock, so the 60-day gate is testable. */
  now?: Date
}

export function computeOwed(
  partners: ReferralPartner[],
  clients: ReferredClient[],
  invoices: FbaInvoice[],
  payouts: PayoutRecord[],
  opts: ComputeOwedOptions = {},
): OwedLine[] {
  const now = opts.now ?? new Date()

  const partnerById = new Map(partners.map((p) => [p.id, p]))
  const payoutByKey = new Map(payouts.filter((p) => p.dedupe_key).map((p) => [p.dedupe_key as string, p]))
  const invoicesByClient = new Map<string, FbaInvoice[]>()
  for (const inv of invoices) {
    const arr = invoicesByClient.get(inv.client_id) ?? []
    arr.push(inv)
    invoicesByClient.set(inv.client_id, arr)
  }

  const lines: OwedLine[] = []

  for (const client of clients) {
    if (!client.referral_partner_id) continue
    const partner = partnerById.get(client.referral_partner_id)
    if (!partner) continue

    const statusFor = (key: string): { status: PayoutStatus; recordId?: string } => {
      const rec = payoutByKey.get(key)
      if (!rec) return { status: 'computed' }
      return { status: (rec.status as PayoutStatus) ?? 'pending', recordId: rec.id }
    }

    const anchor = client.referral_first_payment_date
    const clientInvoices = (invoicesByClient.get(client.id) ?? []).slice().sort((a, b) => a.period.localeCompare(b.period))

    // --- one-time signup bonus, at this partner's admitted amount ---
    //
    // TWO conditions, both required, and they are not the same thing:
    //   1. the client has PAID  (referral_first_payment_date is set)
    //   2. the client has QUALIFIED (cleared whatever bar applies in
    //      some calendar month — and under the standing programme, as
    //      of 2026-10-12, there is no bar, so any invoice does it)
    //
    // Both survive the dropped threshold, and the pair is not redundant.
    // (2) is "Shipo has invoiced this client at all"; (1) is "the money
    // arrived", which nothing in the invoice table knows and a human
    // sets by hand. Agreement 3.1 turns on BOTH — "signs … and pays its
    // first invoice" — so a client invoiced but not yet paid is
    // correctly not owed.
    //
    // A partner still holding a BESPOKE bar on their row is held to it,
    // and for them (2) is the real gate it always was.
    {
      const bars = qualifyBars(partner)
      const qualifier = qualifyingInvoice(clientInvoices, bars)

      // The waiting period, if there is one. There is NOT one today
      // (QUALIFY_MIN_DAYS_ACTIVE is 0, dropped 2026-10-12), and 0 is
      // handled by switching the gate OFF rather than by computing a
      // zero-length wait.
      //
      // Arithmetic alone would very nearly work — `tenureReleaseDate`
      // with 0 returns the first invoice's own date, which `now` is
      // past — but "very nearly" is the problem. A client invoiced for a
      // FUTURE period (a prepaid or post-dated month, which the invoice
      // form accepts) would have a release date in the future and sit
      // at "not yet owed" for a wait that does not exist, under a note
      // reading "releases after 0 days active". The gate is off, so it
      // is off.
      const minDays = REFERRAL_TERMS.QUALIFY_MIN_DAYS_ACTIVE
      const releaseOn = minDays > 0 ? tenureReleaseDate(clientInvoices, minDays) : null
      const tenureMet = minDays <= 0 || (releaseOn !== null && now >= releaseOn)

      const amount = bonusAmount(partner)

      const releasable = !!qualifier && !!anchor && tenureMet

      // 'awaiting' keeps an unreleased bonus OUT of the owed totals and
      // off the partner's statement. Only a bonus that has cleared every
      // condition that applies carries a real month, and that month is
      // the one they QUALIFIED in — not the one they paid in.
      const period = releasable ? monthLabel(qualifier!.period) : 'awaiting'
      const key = dedupeKey(client.id, 'signup_bonus', period)
      const { status, recordId } = statusFor(key)

      let note: string
      if (!qualifier) note = qualifyNote(bars)
      else if (!anchor) note = 'Qualified — set the first-payment date to release'
      else if (!tenureMet) {
        // Unreachable while minDays is 0, and deliberately kept rather
        // than deleted: it reads off the constant, so restoring a
        // waiting period is one edit to REFERRAL_TERMS and this sentence
        // comes back correct. It can never print "after 0 days" because
        // `tenureMet` is unconditionally true at 0.
        note =
          `Qualified on ${clearedBy(qualifier, bars)} in ${monthLabel(qualifier.period)} — ` +
          `releases after ${minDays} days active` +
          (releaseOn ? `, on ${isoDay(releaseOn)}` : '')
      } else {
        note = `Owed — qualified on ${clearedBy(qualifier, bars)} in ${monthLabel(qualifier.period)}`
      }

      lines.push({
        dedupeKey: key,
        partnerId: partner.id,
        partnerName: partner.name,
        clientId: client.id,
        clientName: client.name,
        kind: 'signup_bonus',
        period,
        amount,
        status,
        recordId,
        note,
      })
    }

    // --- 5% of net profit, 12-month window from the FIRST PAID INVOICE ---
    for (const inv of clientInvoices) {
      let inWindow = true
      let note: string | undefined
      if (anchor) {
        // The window runs from the client's FIRST PAID INVOICE for
        // COMMISSION_MONTHS months. There is no shifted variant any
        // more — the launch offer that moved the start to month 2 was
        // withdrawn on 2026-10-12.
        const start = monthIndex(anchor)
        const idx = monthIndex(inv.period)
        inWindow = idx >= start && idx < start + REFERRAL_TERMS.COMMISSION_MONTHS
        if (!inWindow) {
          // `idx < start` is still reachable, and it is not a window
          // problem: it is an invoice dated BEFORE the recorded
          // first-payment date. Saying "outside the 12-month window"
          // for that would send someone looking at the wrong field.
          note =
            idx < start
              ? `Invoiced ${monthLabel(inv.period)}, before the recorded first payment ` +
                `(${monthLabel(anchor)}) — check the first-payment date`
              : `Outside the ${REFERRAL_TERMS.COMMISSION_MONTHS}-month window — not owed`
        }
      } else {
        note = 'No first-payment date set — window has not started'
        inWindow = false
      }
      if (!inWindow) continue

      const period = monthLabel(inv.period)
      const key = dedupeKey(client.id, 'commission', period)
      const { status, recordId } = statusFor(key)

      // The money rule. A month whose inputs are not final is reported
      // at 0 so it cannot enter any total, and flagged so the screen
      // can say why.
      //
      // `&& !recordId` is the whole subtlety. Once a payout row exists,
      // a human has already looked at this line and committed to a
      // figure. A charge arriving afterwards must not silently rewrite
      // what they approved — it must show up as a provisional flag on a
      // line that still reads what it read when they approved it. Same
      // principle as a later dip below the bonus bar not un-owing a
      // bonus already earned.
      const provisional = inv.provisional === true
      const gated = provisional && !recordId

      lines.push({
        dedupeKey: key,
        partnerId: partner.id,
        partnerName: partner.name,
        clientId: client.id,
        clientName: client.name,
        kind: 'commission',
        period,
        amount: gated ? 0 : commissionOn(inv),
        status,
        fbaInvoiceId: inv.id,
        recordId,
        note:
          note ??
          (provisional
            ? 'Provisional — a charge this month is not priced yet, so the ' +
              'figures are not final' + (gated ? ' and nothing is owed on it yet' : '')
            : undefined),
        provisional: provisional || undefined,
      })
    }
  }

  // Sort: partner, then client, then period
  lines.sort(
    (a, b) =>
      a.partnerName.localeCompare(b.partnerName) ||
      a.clientName.localeCompare(b.clientName) ||
      a.period.localeCompare(b.period),
  )
  return lines
}

/** Roll-up totals for the summary cards. Excludes not-yet-owed lines. */
export function summarize(lines: OwedLine[]) {
  let owed = 0
  let pending = 0
  let approved = 0
  let paid = 0
  for (const l of lines) {
    const notYetOwed = l.kind === 'signup_bonus' && l.period === 'awaiting'
    if (l.status === 'paid') paid += l.amount
    else if (l.status === 'approved') approved += l.amount
    else if (!notYetOwed) {
      pending += l.amount
    }
    if (!notYetOwed && l.status !== 'paid') owed += l.amount
  }
  return { owed: round2(owed), pending: round2(pending), approved: round2(approved), paid: round2(paid) }
}

// ============================================================
// Partner-facing statement
//
// What a partner is allowed to see, decided by Ophir (2026-10-11):
//   volume shipped, total billed, the four cost CATEGORIES,
//   net profit, their 5%, and a transaction list carrying only
//   date, order number and amount billed.
//
// NOT shown, ever: the rate card, per-unit prices, per-order COST,
// or any other client's account. `amount / quantity` on a line item
// IS the rate card, and a partner who is also an agency can read it
// straight off.
//
// The authority for this is
// docs/superpowers/specs/2026-10-11-partner-ledger-statements-design.md,
// Decision 1. It previously cited "§4.6 of the partner agreement" —
// there is no such section, and no executed partner agreement exists
// at all; the only draft on file is marked NOT FOR SIGNATURE and omits
// the 5% term entirely. Do not re-cite the agreement here until one is
// signed.
// ============================================================

export interface StatementClientLine {
  clientId: string
  clientName: string

  // null, not 0, when the figure was never recorded. A DTC account has
  // no unit count and an FBA account has no order count; printing "0"
  // for the one that does not apply tells a partner their client did
  // nothing that month, which is a different and false statement.
  units: number | null
  orders: number | null

  billed: number
  costs: { freight: number; materials: number; storage: number; processing: number }
  totalCosts: number
  netProfit: number
  share: number
  status: PayoutStatus
  dedupeKey: string

  /** See OwedLine.provisional. `share` is 0 on a gated line. */
  provisional?: boolean
}

export interface StatementMonth {
  period: string // 'YYYY-MM'
  clients: StatementClientLine[]
  bonuses: { clientId: string; clientName: string; amount: number; status: PayoutStatus; dedupeKey: string }[]
  earned: number // commission + bonus for the month
  carriedIn: number
  payable: number // 0 if the running balance is still under MIN_PAYOUT
  carriedOut: number
}

export interface PartnerStatement {
  months: StatementMonth[] // newest first
  lifetimeEarned: number
  paidToDate: number
  awaitingPayment: number
  carryForward: number
  activeClients: number
}

/**
 * Build one partner's statement. Chronological pass applies the
 * $50 minimum: a month that earns less than $50 rolls forward and
 * is paid once the running balance clears $50.
 */
export function buildStatement(
  partnerId: string,
  clients: ReferredClient[],
  lines: OwedLine[],
  invoices: FbaInvoice[],
): PartnerStatement {
  const mine = lines.filter((l) => l.partnerId === partnerId)
  const invoiceById = new Map(invoices.map((i) => [i.id, i]))

  const byPeriod = new Map<string, { commissions: OwedLine[]; bonuses: OwedLine[] }>()
  for (const l of mine) {
    if (l.kind === 'signup_bonus' && l.period === 'awaiting') continue // not owed yet — don't show a number
    const bucket = byPeriod.get(l.period) ?? { commissions: [], bonuses: [] }
    if (l.kind === 'commission') bucket.commissions.push(l)
    else bucket.bonuses.push(l)
    byPeriod.set(l.period, bucket)
  }

  const periodsAsc = [...byPeriod.keys()].sort()
  const months: StatementMonth[] = []
  let carry = 0
  let lifetimeEarned = 0
  let paidToDate = 0
  let awaitingPayment = 0

  for (const period of periodsAsc) {
    const bucket = byPeriod.get(period)!
    const clientLines: StatementClientLine[] = []

    for (const l of bucket.commissions) {
      const inv = l.fbaInvoiceId ? invoiceById.get(l.fbaInvoiceId) : undefined
      const costs = inv ? costBreakdown(inv) : { freight: 0, materials: 0, storage: 0, processing: 0 }
      clientLines.push({
        clientId: l.clientId,
        clientName: l.clientName,
        units: inv && inv.units_shipped != null ? Math.max(0, Math.round(num(inv.units_shipped))) : null,
        orders: inv && inv.orders_shipped != null ? Math.max(0, Math.round(num(inv.orders_shipped))) : null,
        billed: inv ? round2(num(inv.amount)) : 0,
        costs,
        totalCosts: inv ? totalCosts(inv) : 0,
        netProfit: inv ? netProfit(inv) : 0,
        share: l.amount,
        status: l.status,
        dedupeKey: l.dedupeKey,
        provisional: l.provisional,
      })
    }
    clientLines.sort((a, b) => a.clientName.localeCompare(b.clientName))

    const bonuses = bucket.bonuses.map((b) => ({
      clientId: b.clientId,
      clientName: b.clientName,
      amount: b.amount,
      status: b.status,
      dedupeKey: b.dedupeKey,
    }))

    const earned = round2(
      clientLines.reduce((s, c) => s + c.share, 0) + bonuses.reduce((s, b) => s + b.amount, 0),
    )
    const carriedIn = carry
    const running = round2(carriedIn + earned)
    const clears = running >= REFERRAL_TERMS.MIN_PAYOUT
    const payable = clears ? running : 0
    carry = clears ? 0 : running

    lifetimeEarned = round2(lifetimeEarned + earned)

    const allLines = [...bucket.commissions, ...bucket.bonuses]
    for (const l of allLines) {
      if (l.status === 'paid') paidToDate = round2(paidToDate + l.amount)
      else awaitingPayment = round2(awaitingPayment + l.amount)
    }

    months.push({ period, clients: clientLines, bonuses, earned, carriedIn, payable, carriedOut: carry })
  }

  months.reverse() // newest first for display

  const activeClients = new Set(
    clients.filter((c) => c.referral_partner_id === partnerId).map((c) => c.id),
  ).size

  return {
    months,
    lifetimeEarned,
    paidToDate,
    awaitingPayment,
    carryForward: carry,
    activeClients,
  }
}
