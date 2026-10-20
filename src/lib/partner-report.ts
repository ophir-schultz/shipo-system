// The partner's downloadable report. Spec §5.
//
// ============================================================
// WHY THIS IS A PURE FUNCTION IN ITS OWN FILE
//
// A CSV is the easiest place in this system to leak a figure. On a screen
// a number has to be written into JSX by hand, one element at a time. In
// a serialiser, anything reachable from the input object is one careless
// `Object.values` or one spread away from a column — and nobody reviews a
// download the way they review a page.
//
// So the rule here is the same one the statement's order list now
// follows: the figure we must not disclose is ABSENT FROM THE INPUT, not
// merely unprinted. `ReportInput` below takes a PartnerStatement, a
// roster, unit rows and FBA rows. It does not take LedgerMonth, which is
// where `cost_labour_not_deducted` lives, and it does not take anything
// with a per-order amount — partner_order_units has no amount column at
// all. Both of §5's named exclusions are therefore unreachable from this
// function, and the two absence tests over the rendered string are the
// second line, not the first.
//
// THE MONEY GATE TRAVELS WITH THE MONEY. The statement screen gates every
// dollar on holdsW9(partner). `statement: null` is how the caller says
// "withheld", and this module answers it with a sentence rather than with
// zeros: a monthly section built from an empty statement renders a
// perfectly plausible 0.00 and tells a partner he earned nothing, when
// what is actually happening is that we are holding his figures pending a
// tax form.
//
// NUMBERS ARE WRITTEN BARE — no `$`, no thousands separator. §5's whole
// point is that this reconciles against a P&L, and `$1,000.00` imports as
// text, which sums to zero in the column the accountant totals.
// ============================================================

import { REFERRAL_TERMS, type PartnerStatement, type StatementClientLine, type StatementMonth } from './referrals'
import type { RosterRow } from './partner-roster'
import { BONUS_STATE_TEXT, type BonusState } from './partner-bonus-state'
import { ORDER_UNITS_LIMIT, fbaUnitsLabel, type FbaActivityRow, type OrderUnitsRow } from './partner-activity'

export interface ReportInput {
  /**
   * Null means money is WITHHELD, not that there is none.
   *
   * The distinction is the whole reason this is nullable rather than an
   * empty statement: an empty statement is a real answer ("no months
   * yet") and renders as such, while null renders the W-9 sentence.
   */
  statement: PartnerStatement | null

  /** His clients, from the authoritative clients table — the same rows the roster table shows. */
  roster: readonly RosterRow[]

  /** Per-client sign-up bonus state, or null when money is withheld. */
  bonuses: ReadonlyMap<string, BonusState> | null

  /** Per-order ACTIVITY. Units, never money — see partner_order_units.sql. */
  orders: readonly OrderUnitsRow[]
  ordersTruncated: boolean

  fba: readonly FbaActivityRow[]
}

/**
 * A cell the formula guard must NOT touch.
 *
 * The guard below neutralises a leading `-`, because `-1+1` is a formula
 * to Excel. Applied to a money cell that would mangle every negative
 * figure in the file into text — defeating the one property §5 asks for.
 * So numbers and dates, which this module formats itself and which can
 * never be partner-supplied, are passed as `raw`.
 */
type Cell = string | { readonly raw: string }

const raw = (s: string): Cell => ({ raw: s })

const WITHHELD = 'Withheld until your W-9 is on file. Sign in to the portal to complete it.'
const EMPTY = 'Nothing to report yet.'

/** Two decimals, unformatted, so a spreadsheet reads the cell as a number. */
const money = (n: number): Cell => raw((Number.isFinite(n) ? n : 0).toFixed(2))

const unitsFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 })

/** 'YYYY-MM-DD', or '' — never a substituted date. See RosterRow.referred. */
const day = (d: string | null | undefined): Cell => raw(d ? String(d).slice(0, 10) : '')

/**
 * Escape one cell.
 *
 * TEXT cells get the CSV-injection guard first. A client name is
 * partner-supplied (§2 lets him paste a whole roster), Excel executes a
 * cell beginning `=`, `+`, `-`, `@`, tab or CR, and the person opening
 * this file is very often the accountant rather than the partner. The
 * guard is the leading apostrophe Excel reads as "this is text".
 */
function csvCell(c: Cell): string {
  const text = typeof c === 'string' ? guard(c) : c.raw
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function guard(s: string): string {
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s
}

function csvRow(cells: readonly Cell[]): string {
  return cells.map(csvCell).join(',')
}

/**
 * One labelled block: a title line, a header row, then the body.
 *
 * A section with no body rows still gets the title, the header and a
 * sentence. A partner with no clients who downloads a zero-byte file
 * reads it as a broken button, not as an empty account (Review Focus 6).
 */
function sectionOf(title: string, header: readonly Cell[], body: readonly Cell[][]): string[] {
  const rows = body.length > 0 ? body : [[EMPTY]]
  return [csvRow([raw(title)]), csvRow(header), ...rows.map(csvRow), '']
}

/**
 * What the Payable column says about one client-month.
 *
 * Deliberately TEXT and not a second dollar figure. `payable` on a
 * StatementMonth is a month-level amount, and repeating it on every
 * client row of that month would make the column sum to a multiple of
 * the real figure — in a file whose purpose is to be summed.
 *
 * Order matters. `paid` is a fact and wins over everything. Provisional
 * comes next because a provisional line already carries share 0, and
 * "Payable" beside that 0 would assert the month is settled at nothing,
 * which is the one thing it is not.
 */
function payableLabel(line: StatementClientLine, month: StatementMonth): string {
  if (line.status === 'paid') return 'Paid'
  if (line.provisional) return 'Still being priced'
  if (month.payable <= 0) return `Carried forward — under the $${REFERRAL_TERMS.MIN_PAYOUT} minimum`
  return 'Payable'
}

/**
 * Build the whole report as one CSV.
 *
 * One file rather than four, or a zip — §5 leaves the shape to the
 * implementer and pins the contents. One file is what a person can
 * actually attach to an email to their bookkeeper.
 */
export function buildPartnerReport(input: ReportInput): string {
  const lines: string[] = []

  // ---- 1. Monthly ----
  const monthlyHeader: Cell[] = [
    raw('Period'),
    raw('Client'),
    raw('Revenue'),
    raw('Freight'),
    raw('Materials'),
    raw('Storage'),
    raw('Processing'),
    raw('Net profit'),
    raw(`Your share (${(REFERRAL_TERMS.COMMISSION_RATE * 100).toFixed(0)}%)`),
    raw('Payable'),
  ]

  if (input.statement === null) {
    lines.push(...sectionOf('Monthly', monthlyHeader, [[WITHHELD]]))
  } else {
    const body: Cell[][] = []
    for (const m of input.statement.months) {
      for (const l of m.clients) {
        body.push([
          raw(m.period),
          l.clientName,
          money(l.billed),
          money(l.costs.freight),
          money(l.costs.materials),
          money(l.costs.storage),
          money(l.costs.processing),
          money(l.netProfit),
          money(l.share),
          payableLabel(l, m),
        ])
      }
    }
    lines.push(...sectionOf('Monthly', monthlyHeader, body))
  }

  // ---- 2. DTC orders ----
  //
  // NOT gated on the statement. Units are not money, and a dashboard that
  // goes blank while a tax form is outstanding looks broken rather than
  // gated.
  const orderBody: Cell[][] = input.orders.map((o) => [
    day(o.order_date),
    o.client_name ?? '',
    o.order_number ?? '',
    // NULL IS NOT ZERO. `units` sums order_items.quantity and `sum` skips
    // nulls, so an order whose every line is unquantified comes back
    // null. A 0 here says the order shipped nothing — for an order that
    // shipped. fbaUnitsLabel is the one function allowed to say "not
    // recorded yet", so it says it here too.
    o.units === null || o.units === undefined ? raw(fbaUnitsLabel(null)) : raw(unitsFormat.format(o.units)),
    raw(o.units_estimated ? 'Yes' : 'No'),
  ])

  if (input.ordersTruncated) {
    // An accountant reconciling this against a P&L will treat the file as
    // complete unless it says otherwise, and a download has left the
    // on-screen notice behind.
    orderBody.push([
      `Not every order is listed: this export stops at the most recent ${unitsFormat.format(
        ORDER_UNITS_LIMIT,
      )} orders.`,
    ])
  }

  lines.push(
    ...sectionOf(
      'DTC orders',
      [raw('Order date'), raw('Client'), raw('Order number'), raw('Units'), raw('Units estimated')],
      orderBody,
    ),
  )

  // ---- 3. FBA ----
  lines.push(
    ...sectionOf(
      'FBA',
      [raw('Period'), raw('Client'), raw('Units prepped')],
      input.fba.map((f) => [raw(f.period), f.clientName, raw(fbaUnitsLabel(f.unitsShipped))]),
    ),
  )

  // ---- 4. Bonus and payouts ----
  //
  // The two DATES are his own facts and are not gated. The bonus STATE is
  // money and is: BONUS_STATE_TEXT names the $300.
  //
  // An absent entry prints nothing at all. `not_qualified` is a verdict
  // computeOwed reached; a client with no signup_bonus line is a verdict
  // it did not reach, and the screen prints a dash for exactly that case.
  lines.push(
    ...sectionOf(
      'Bonus and payouts',
      [raw('Client'), raw('Sign-up bonus'), raw('Referred'), raw('First payment')],
      input.roster.map((r) => [
        r.clientName,
        input.bonuses === null ? WITHHELD : (input.bonuses.get(r.clientId) ? BONUS_STATE_TEXT[input.bonuses.get(r.clientId)!] : ''),
        day(r.referred),
        day(r.firstPaid),
      ]),
    ),
  )

  return lines.join('\n')
}

/**
 * The download's filename.
 *
 * Falls back company → contact name → partner id, and never to a bare
 * date: a partner who downloads in two months wants to be able to tell
 * the two files apart, and so does whoever he forwards them to.
 *
 * Everything outside [a-z0-9] collapses to a hyphen, which is also what
 * keeps `"`, `/` and `\` out of the Content-Disposition header the value
 * lands in — a quote would end the quoted filename early.
 */
export function reportFilename(
  partner: { id: string; company?: string | null; name?: string | null },
  today: string,
): string {
  const label = slug(partner.company) || slug(partner.name) || slug(partner.id) || 'partner'
  return `shipo-partner-report-${label}-${slug(today)}.csv`
}

function slug(s: string | null | undefined): string {
  return (s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}
