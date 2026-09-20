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
// month — units or revenue. No service-line flag on the client, no
// field for anyone to forget to set.
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

  // There is no standing UNIT bar — the published qualification is
  // stated in dollars only. null means "revenue is the only standing
  // path"; a partner row may still carry its own unit bar, which is
  // what the Founding Partner offer uses.
  QUALIFY_MIN_UNITS: null as number | null,
} as const

/**
 * The Founding Partner launch offer, approved by Ophir 2026-09-20.
 *
 * These three numbers are stamped onto the partner row at the moment
 * they are admitted, and never read from here again — so changing or
 * ending the offer later cannot rewrite what an existing Founding
 * Partner was promised.
 *
 * CAP is the whole of the downside: 10 × ($500 − $300) = $2,000 of
 * extra exposure, and not a dollar more. It is enforced in
 * /api/referrals/partners, not merely documented here.
 */
export const FOUNDING_PARTNER_TERMS = {
  BONUS: 500, // instead of the standing $300
  MIN_UNITS: 2000, // FBA prep path: MORE THAN 2,000 units in a month
  MIN_REVENUE: 2500, // DTC path: the dollar equivalent at ~$1.25/unit
  CAP: 10, // first 10 partners only
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
  bonus_min_units?: number | null // e.g. 2000 prep units in a month
  bonus_min_revenue?: number | null // e.g. 2500 billed in a month
  founding_partner?: boolean | null
}

export interface ReferredClient {
  id: string
  name: string
  referral_partner_id: string | null
  referral_signup_date: string | null // YYYY-MM-DD — record only
  referral_first_payment_date: string | null // YYYY-MM-DD — starts the 12-month window
}

export interface FbaInvoice {
  id: string
  client_id: string
  period: string // YYYY-MM-DD (first of month)
  amount: number // TOTAL invoiced to the client that month, before deductions
  units_shipped?: number | null
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
}

/**
 * The bars this partner's referrals have to clear, resolved from the
 * partner row first and the standing terms second.
 *
 * `?? ` and not `||` on purpose: a deliberate 0 on the partner row
 * means "no bar", and `||` would throw that away and silently
 * reinstate the standing $500.
 */
export function qualifyBars(partner: ReferralPartner): QualifyBars {
  return {
    minRevenue: partner.bonus_min_revenue ?? REFERRAL_TERMS.QUALIFY_MIN_REVENUE,
    minUnits: partner.bonus_min_units ?? REFERRAL_TERMS.QUALIFY_MIN_UNITS,
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
 * more". Units are STRICTLY ABOVE theirs — the Founding Partner offer
 * says "more than 2,000 units", and 2,000 exactly does not clear it.
 * The two comparators differ because the two promises differ; do not
 * "tidy" them into the same one.
 *
 * Either path is enough. An FBA account clears on units, a DTC
 * account clears on revenue, and an account doing both clears on
 * whichever comes first.
 */
export function qualifiesInMonth(inv: FbaInvoice, bars: QualifyBars): boolean {
  if (bars.minRevenue !== null && num(inv.amount) >= bars.minRevenue) return true
  if (bars.minUnits !== null && num(inv.units_shipped) > bars.minUnits) return true
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

/** Human sentence for why a bonus is or is not owed yet. */
function qualifyNote(bars: QualifyBars): string {
  const parts: string[] = []
  if (bars.minRevenue !== null) parts.push(`$${bars.minRevenue.toLocaleString()} billed`)
  if (bars.minUnits !== null) parts.push(`more than ${bars.minUnits.toLocaleString()} units`)
  if (parts.length === 0) return 'No qualification set for this partner'
  return `Not yet owed — needs ${parts.join(' or ')} in one calendar month`
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
export function computeOwed(
  partners: ReferralPartner[],
  clients: ReferredClient[],
  invoices: FbaInvoice[],
  payouts: PayoutRecord[],
): OwedLine[] {
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
    //   2. the client has QUALIFIED (cleared the revenue or unit bar
    //      in some calendar month)
    //
    // A client can pay $200/month forever and never qualify. Before
    // this gate existed the bonus was released on payment alone, which
    // does not match what is published on the partner page.
    {
      const bars = qualifyBars(partner)
      const qualifier = qualifyingInvoice(clientInvoices, bars)

      // Period is the month they qualified, not the month they paid —
      // that is the month the bonus was actually earned.
      const period = qualifier ? monthLabel(qualifier.period) : 'awaiting'
      const key = dedupeKey(client.id, 'signup_bonus', period)
      const { status, recordId } = statusFor(key)

      let note: string
      if (!qualifier) note = qualifyNote(bars)
      else if (!anchor) note = 'Qualified — set the first-payment date to release'
      else {
        const why =
          bars.minUnits !== null && num(qualifier.units_shipped) > bars.minUnits
            ? `${num(qualifier.units_shipped).toLocaleString()} units`
            : `$${num(qualifier.amount).toLocaleString()} billed`
        note = `Owed — qualified on ${why} in ${monthLabel(qualifier.period)}`
      }

      lines.push({
        dedupeKey: key,
        partnerId: partner.id,
        partnerName: partner.name,
        clientId: client.id,
        clientName: client.name,
        kind: 'signup_bonus',
        period,
        amount: bonusAmount(partner),
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
  units: number
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
        units: inv ? Math.max(0, Math.round(num(inv.units_shipped))) : 0,
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
