import { MONTHLY_MINIMUM } from '@/lib/rate-sheets'
import { periodRange } from '@/lib/billing/statement'
import { priceOf } from '@/lib/billing/unpriced'

// The published fulfillment floor. Pick and pack stays $2.50 on the rate
// card. This module does not change that price and does not write a charge.

export const STANDARD_MONTHLY_MINIMUM = MONTHLY_MINIMUM

export interface MinimumCharge {
  amount: unknown
  voided?: boolean
  label?: string | null
}

export interface MonthlyMinimum {
  /** True only for a full calendar month whose charges are all priced. */
  applies: boolean
  reason: string
  subtotalCents: number | null
  minimumCents: number | null
  topUpCents: number | null
  totalCents: number | null
}

export interface AgreedMinimum {
  status: 'standard' | 'custom' | 'ambiguous' | 'unreadable'
  dollars: number | null
  reason: string
}

function cents(dollars: number): number {
  return Math.round(dollars * 100)
}

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}

/** A statement range that is exactly one calendar month, inclusive. */
export function isFullCalendarMonth(from: string, to: string): boolean {
  const month = periodRange('month', from)
  return from === month.from && to === month.to
}

function voided(row: MinimumCharge): boolean {
  if (row.voided === true) return true
  return typeof row.label === 'string' && /\(voided\)/i.test(row.label)
}

/**
 * Known subtotal of billable rows, in cents.
 * Voided rows are left out. An unpriced amount is counted, not treated as $0.
 */
export function billableSubtotal(rows: readonly MinimumCharge[]): {
  subtotalCents: number
  unpriced: number
  billable: number
} {
  let subtotalCents = 0
  let unpriced = 0
  let billable = 0
  for (const row of rows) {
    if (voided(row)) continue
    billable += 1
    const amount = priceOf(row.amount)
    if (amount === null) {
      unpriced += 1
      continue
    }
    subtotalCents += cents(amount)
  }
  return { subtotalCents, unpriced, billable }
}

export function monthlyMinimumBill(input: {
  from: string
  to: string
  rows: readonly MinimumCharge[]
  agreed: AgreedMinimum
}): MonthlyMinimum {
  const sub = billableSubtotal(input.rows)
  const base = {
    subtotalCents: sub.unpriced > 0 ? null : sub.subtotalCents,
    minimumCents: null as number | null,
    topUpCents: null as number | null,
    totalCents: sub.unpriced > 0 ? null : sub.subtotalCents,
  }
  if (!isFullCalendarMonth(input.from, input.to)) {
    return {
      applies: false,
      reason: 'The $395 floor is a full calendar month. This period is not one, so no top-up is added.',
      ...base,
    }
  }
  if (input.agreed.status === 'unreadable') {
    return {
      applies: false,
      reason: 'Rate sheets could not be read, so a monthly minimum was not applied.',
      ...base,
    }
  }
  if (input.agreed.status === 'ambiguous') {
    return {
      applies: false,
      reason: 'This client has rate sheets with different monthly minimums. No top-up was chosen.',
      ...base,
    }
  }
  if (sub.billable === 0) {
    return {
      applies: false,
      reason: 'No billable charges in this month. Voided lines are not counted as $0, so the minimum is not added.',
      subtotalCents: null,
      minimumCents: null,
      topUpCents: null,
      totalCents: null,
    }
  }
  if (sub.unpriced > 0) {
    return {
      applies: false,
      reason: 'A charge amount is unknown. It is not treated as $0, so the minimum is not added.',
      subtotalCents: null,
      minimumCents: null,
      topUpCents: null,
      totalCents: null,
    }
  }
  const dollars = input.agreed.dollars ?? STANDARD_MONTHLY_MINIMUM
  const minimumCents = cents(dollars)
  const topUpCents = Math.max(0, minimumCents - sub.subtotalCents)
  const whose = input.agreed.status === 'custom'
    ? `This client's rate sheet minimum is ${money(minimumCents)}.`
    : `Standard monthly minimum ${money(minimumCents)}.`
  return {
    applies: true,
    reason: topUpCents === 0
      ? `${whose} The subtotal already meets it, so the top-up is $0.00.`
      : `${whose} Top-up ${money(topUpCents)} brings the month to ${money(minimumCents)}.`,
    subtotalCents: sub.subtotalCents,
    minimumCents,
    topUpCents,
    totalCents: sub.subtotalCents + topUpCents,
  }
}

function norm(name: string): string {
  return name.trim().toLowerCase()
}

export function agreedMinimumFromSheets(
  clientName: string,
  sheets: readonly { companyName: string; monthlyMinimum: number }[],
): AgreedMinimum {
  const want = norm(clientName)
  const matched = sheets.filter((sheet) => norm(sheet.companyName) === want)
  if (matched.length === 0) {
    return {
      status: 'standard',
      dollars: STANDARD_MONTHLY_MINIMUM,
      reason: 'No rate sheet matches this client name. The standard monthly minimum applies.',
    }
  }
  const amounts = [...new Set(matched.map((sheet) => sheet.monthlyMinimum))]
  if (amounts.length > 1) {
    return {
      status: 'ambiguous',
      dollars: null,
      reason: 'This client has rate sheets with different monthly minimums.',
    }
  }
  const dollars = amounts[0]
  if (dollars === STANDARD_MONTHLY_MINIMUM) {
    return {
      status: 'standard',
      dollars,
      reason: 'The matching rate sheet uses the standard monthly minimum.',
    }
  }
  return {
    status: 'custom',
    dollars,
    reason: 'The matching rate sheet carries its own monthly minimum.',
  }
}
