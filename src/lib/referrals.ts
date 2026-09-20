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
//   • The client must QUALIFY before the bonus is owed: $500 or
//     more billed in a calendar month.
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
// The bonus half does care, because a qualification written in units
// is an FBA-only qualification: `units_shipped` is typed by hand on
// the invoice form and defaults to 0, so a DTC referral would sit at
// "not yet owed" forever with nothing on screen to explain why.
//
// So a client qualifies on WHICHEVER bar it clears in a calendar
// month — units, orders, or revenue. No service-line flag on the
// client, no field for anyone to forget to set. An FBA account clears
// on units, a DTC account clears on orders, and an account doing both
// clears on whichever comes first.
// ============================================================

export const REFERRAL_TERMS = {
  SIGNUP_BONUS: 300, // one-time, additive, after first payment
  COMMISSION_RATE: 0.05, // 5% of net profit on the account
  COMMISSION_MONTHS: 12, // window length, from first paid invoice
  MIN_PAYOUT: 50, // below this a balance rolls to the next month

  // Qualification, as published at shipousa.com/partner-program/:
  // "A client counts once they're billing $500 or more in a calendar
  // month." At-or-above, not strictly above.
  QUALIFY_MIN_REVENUE: 500,

  // There is no standing UNIT or ORDER bar — the published
  // qualification is stated in dollars only. null means "revenue is the
  // only standing path"; a partner row may still carry its own unit or
  // order bar, which is what the Founding Partner offer uses.
  QUALIFY_MIN_UNITS: null as number | null,
  QUALIFY_MIN_ORDERS: null as number | null,

  // "60 days active", as published. The bonus is not released until
  // the client has been on the books this long, even if they cleared
  // the money bar in their very first month. It exists to stop a
  // bonus being paid on an account that churns immediately.
  QUALIFY_MIN_DAYS_ACTIVE: 60,
} as const

/**
 * The launch offer, approved by Ophir 2026-09-20.
 *
 * ⚠️ THE CAP COUNTS CLIENTS, NOT PARTNERS. Read this before changing it.
 *
 * An earlier version of this file capped at 10 admitted PARTNERS and
 * carried a comment claiming the downside was "10 × ($500 − $300) =
 * $2,000". That arithmetic was wrong, and wrong in the expensive
 * direction: 10 partners each referring an unlimited number of
 * clients, each client paying $500 instead of $300, is an UNBOUNDED
 * liability. The $2,000 figure was only ever true if every partner
 * brought exactly one client.
 *
 * Counting clients makes the sentence true. The first 10 referred
 * clients that clear the launch bar earn $500; every client after
 * them earns the standing $300. Maximum extra exposure is 10 × $200 =
 * $2,000, full stop, no matter how the referrals are distributed.
 *
 * The place is recorded on the CLIENT row (`founding_bonus_seq`) at
 * the moment the bonus is approved, so a backdated invoice entered
 * later can never retroactively bump a client out of a place they
 * have already been paid for.
 */
export const FOUNDING_CLIENT_TERMS = {
  BONUS: 500, // instead of the standing $300
  MIN_UNITS: 1500, // FBA prep path: MORE THAN 1,500 units in a month
  MIN_ORDERS: 500, // DTC path: MORE THAN 500 orders in a month
  CAP: 10, // first 10 qualifying CLIENTS, across all partners

  // NO revenue path, deliberately. Ophir's approved wording is
  // "more than 500 orders per month or in the FBA more than 1500
  // units per month" — two physical-volume bars and no dollar bar.
  // An earlier draft carried MIN_REVENUE: 2500 as a DTC stand-in;
  // that was my invention, not the offer.
} as const

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
  signup_bonus_amount?: number | null // e.g. 500 for a Founding Partner
  bonus_min_units?: number | null // e.g. 1500 prep units in a month
  bonus_min_orders?: number | null // e.g. 500 DTC orders in a month
  bonus_min_revenue?: number | null // e.g. 2500 billed in a month
  founding_partner?: boolean | null
}

export interface ReferredClient {
  id: string
  name: string
  referral_partner_id: string | null
  referral_signup_date: string | null // YYYY-MM-DD — record only
  referral_first_payment_date: string | null // YYYY-MM-DD — starts the 12-month window

  // 1..CAP if this client holds one of the launch-offer places, null
  // otherwise. Written once, when the bonus is approved, and never
  // recomputed — a place already paid for cannot be taken back by a
  // backdated invoice for some other client.
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

  // signup_bonus lines only: the launch place this client holds, and
  // whether it is still provisional (not yet written to the DB, so it
  // can still move if an earlier qualifier turns up).
  foundingSeq?: number | null
  foundingProvisional?: boolean
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
    return {
      minRevenue: bar(partner.bonus_min_revenue),
      minUnits: bar(partner.bonus_min_units),
      minOrders: bar(partner.bonus_min_orders),
    }
  }
  return {
    minRevenue: bar(REFERRAL_TERMS.QUALIFY_MIN_REVENUE),
    minUnits: bar(REFERRAL_TERMS.QUALIFY_MIN_UNITS),
    minOrders: bar(REFERRAL_TERMS.QUALIFY_MIN_ORDERS),
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

// ---- the launch offer, per CLIENT --------------------------------

/** The launch bar: more than 1,500 prep units OR more than 500 orders. */
export function clearsLaunchBar(inv: FbaInvoice): boolean {
  return qualifiesInMonth(inv, {
    minRevenue: null,
    minUnits: FOUNDING_CLIENT_TERMS.MIN_UNITS,
    minOrders: FOUNDING_CLIENT_TERMS.MIN_ORDERS,
  })
}

/** Earliest invoice that clears the launch bar, or null. */
export function launchQualifyingInvoice(invoices: FbaInvoice[]): FbaInvoice | null {
  const sorted = invoices.slice().sort((a, b) => a.period.localeCompare(b.period))
  for (const inv of sorted) if (clearsLaunchBar(inv)) return inv
  return null
}

export interface FoundingPlaces {
  /** clientId -> place number. Includes both taken and provisional. */
  place: Map<string, number>
  /** Places not yet written to the DB — they can still move. */
  provisional: Set<string>
  taken: number
  left: number
}

/**
 * Who holds the 10 launch places.
 *
 * Places already written to `clients.founding_bonus_seq` are FIXED and
 * are honoured exactly as stored, even if a client that qualified
 * earlier turns up later — the money is already out the door and a
 * spreadsheet cannot un-pay it.
 *
 * Remaining places are handed to the earliest qualifiers, ordered by
 * the month they cleared the bar and then by client id. The id
 * tiebreak is arbitrary but DETERMINISTIC, which is the property that
 * matters: without it, two clients qualifying in the same month could
 * swap places between one page load and the next, and the $500 would
 * appear to move from one partner to another for no visible reason.
 */
export function foundingPlaces(
  clients: ReferredClient[],
  invoices: FbaInvoice[],
  assignProvisional: boolean = true,
): FoundingPlaces {
  const byClient = new Map<string, FbaInvoice[]>()
  for (const inv of invoices) {
    const arr = byClient.get(inv.client_id) ?? []
    arr.push(inv)
    byClient.set(inv.client_id, arr)
  }

  const place = new Map<string, number>()
  const used = new Set<number>()
  for (const c of clients) {
    const seq = c.founding_bonus_seq
    if (seq != null && Number.isFinite(Number(seq))) {
      place.set(c.id, Number(seq))
      used.add(Number(seq))
    }
  }

  // ⚠️ Provisional assignment needs EVERY client in the system, because
  // the ordering is global. Handed a partial list — the partner
  // statement loads only its own partner's clients — it would number
  // places 1..10 inside that slice and promise a $500 that the client
  // has not got. A caller that cannot supply the whole table passes
  // false and gets stored places only, which are true from any angle.
  const candidates = !assignProvisional
    ? []
    : clients
    .filter((c) => c.referral_partner_id && !place.has(c.id))
    .map((c) => ({ c, q: launchQualifyingInvoice(byClient.get(c.id) ?? []) }))
    .filter((x) => x.q !== null)
    .sort((a, b) => a.q!.period.localeCompare(b.q!.period) || a.c.id.localeCompare(b.c.id))

  const provisional = new Set<string>()
  let next = 1
  for (const { c } of candidates) {
    while (used.has(next)) next++
    if (next > FOUNDING_CLIENT_TERMS.CAP) break
    place.set(c.id, next)
    provisional.add(c.id)
    used.add(next)
  }

  const taken = place.size
  return { place, provisional, taken, left: Math.max(0, FOUNDING_CLIENT_TERMS.CAP - taken) }
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

const isoDay = (d: Date) => d.toISOString().slice(0, 10)

/** Human sentence for why a bonus is or is not owed yet. */
function qualifyNote(bars: QualifyBars): string {
  const parts: string[] = []
  if (bars.minRevenue !== null) parts.push(`$${bars.minRevenue.toLocaleString()} billed`)
  if (bars.minUnits !== null) parts.push(`more than ${bars.minUnits.toLocaleString()} units`)
  if (bars.minOrders !== null) parts.push(`more than ${bars.minOrders.toLocaleString()} orders`)
  if (parts.length === 0) return 'No qualification set for this partner'
  return `Not yet owed — needs ${parts.join(' or ')} in one calendar month`
}

/**
 * Which bar actually cleared it, for the note on the owed line.
 * Checked in the same order `qualifiesInMonth` checks them, so the
 * sentence can never name a bar that was not the one that fired.
 */
function clearedBy(inv: FbaInvoice, bars: QualifyBars): string {
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

/** Whole-month index (year*12+month) for range math. */
function monthIndex(dateStr: string): number {
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
  /**
   * False when `clients` is only part of the table. The partner
   * statement loads one partner's clients, and provisional launch
   * places cannot be ranked from a slice — see foundingPlaces().
   */
  provisionalPlaces?: boolean
}

export function computeOwed(
  partners: ReferralPartner[],
  clients: ReferredClient[],
  invoices: FbaInvoice[],
  payouts: PayoutRecord[],
  opts: ComputeOwedOptions = {},
): OwedLine[] {
  const now = opts.now ?? new Date()

  // Who holds the 10 launch places. Computed once, across ALL clients,
  // because the cap is global — a per-client loop cannot see it.
  const founding = foundingPlaces(clients, invoices, opts.provisionalPlaces !== false)

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
    //   2. the client has QUALIFIED (cleared the revenue, unit or
    //      order bar in some calendar month)
    //
    // A client can pay $200/month forever and never qualify. Before
    // this gate existed the bonus was released on payment alone, which
    // does not match what is published on the partner page.
    {
      const bars = qualifyBars(partner)
      const qualifier = qualifyingInvoice(clientInvoices, bars)

      // "60 days active", the third published condition. A client can
      // clear the money bar in month one and still not be released —
      // the wait is there so a bonus is not paid on an account that
      // churns immediately.
      const releaseOn = tenureReleaseDate(clientInvoices, REFERRAL_TERMS.QUALIFY_MIN_DAYS_ACTIVE)
      const tenureMet = releaseOn !== null && now >= releaseOn

      // The launch place, if this client holds one.
      const seq = founding.place.get(client.id)
      const isFounding = seq !== undefined
      const amount = isFounding ? FOUNDING_CLIENT_TERMS.BONUS : bonusAmount(partner)

      const releasable = !!qualifier && !!anchor && tenureMet

      // 'awaiting' keeps an unreleased bonus OUT of the owed totals and
      // off the partner's statement. Only a bonus that has cleared all
      // three published conditions carries a real month, and that month
      // is the one they QUALIFIED in — not the one they paid in.
      const period = releasable ? monthLabel(qualifier!.period) : 'awaiting'
      const key = dedupeKey(client.id, 'signup_bonus', period)
      const { status, recordId } = statusFor(key)

      let note: string
      if (!qualifier) note = qualifyNote(bars)
      else if (!anchor) note = 'Qualified — set the first-payment date to release'
      else if (!tenureMet) {
        note =
          `Qualified on ${clearedBy(qualifier, bars)} in ${monthLabel(qualifier.period)} — ` +
          `releases after ${REFERRAL_TERMS.QUALIFY_MIN_DAYS_ACTIVE} days active` +
          (releaseOn ? `, on ${isoDay(releaseOn)}` : '')
      } else {
        note = `Owed — qualified on ${clearedBy(qualifier, bars)} in ${monthLabel(qualifier.period)}`
      }

      if (isFounding) {
        note +=
          ` · launch place ${seq} of ${FOUNDING_CLIENT_TERMS.CAP}` +
          (founding.provisional.has(client.id) ? ' (not locked in until approved)' : '')
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
        foundingSeq: seq ?? null,
        foundingProvisional: founding.provisional.has(client.id),
      })
    }

    // --- 5% of net profit, 12-month window from the FIRST PAID INVOICE ---
    for (const inv of clientInvoices) {
      let inWindow = true
      let note: string | undefined
      if (anchor) {
        const start = monthIndex(anchor)
        const idx = monthIndex(inv.period)
        inWindow = idx >= start && idx < start + REFERRAL_TERMS.COMMISSION_MONTHS
        if (!inWindow) note = 'Outside the 12-month window — not owed'
      } else {
        note = 'No first-payment date set — window has not started'
        inWindow = false
      }
      if (!inWindow) continue

      const period = monthLabel(inv.period)
      const key = dedupeKey(client.id, 'commission', period)
      const { status, recordId } = statusFor(key)
      lines.push({
        dedupeKey: key,
        partnerId: partner.id,
        partnerName: partner.name,
        clientId: client.id,
        clientName: client.name,
        kind: 'commission',
        period,
        amount: commissionOn(inv),
        status,
        fbaInvoiceId: inv.id,
        recordId,
        note,
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
// What a partner is allowed to see, decided by Ophir:
//   units shipped, total billed, the four cost CATEGORIES,
//   net profit, and their 5%.
//
// NOT shown, ever: the rate card, per-unit prices, invoice line
// items, or any other client's account. This matches §4.6 of the
// agreement — the partner has no right to inspect Shipo's books.
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
