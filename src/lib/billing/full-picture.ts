import type { BankOperatingAnswer } from '@/lib/ledger/bank-operating-costs'

// Staff period picture. It does not invent invoices, and it does not turn a
// bank sample into recognized operating cost. Genuine net profit stays null
// until every required source for that period is actually known.

export interface PeriodMeasures {
  /** Null when this period's shipping revenue was not supplied. */
  shippingRevenueCents: number | null
  /** Null when this period's fulfillment direct costs were not supplied. */
  fulfillmentDirectCents: number | null
  /** True only when rate coverage and cost coverage for the period are complete. */
  fulfillmentCoverageComplete: boolean
}

/** Used for Sep and Oct until a period-scoped fulfillment read is supplied. */
export const NO_PERIOD_FULFILLMENT: PeriodMeasures = {
  shippingRevenueCents: null,
  fulfillmentDirectCents: null,
  fulfillmentCoverageComplete: false,
}

export interface FullPicture {
  period: string
  label: string
  shippingRevenueCents: number | null
  fulfillmentDirectCents: number | null
  /** Provisional bank sample. Not fully recognized operating cost. */
  bankOperatingSampleCents: number | null
  /** Postage left off the operating subtotal. Zero means the statement had none. */
  bankPostageCents: number | null
  /** Null when no off-account invoice file has been supplied. Not zero. */
  invoiceCostsCents: number | null
  /**
   * Shipping revenue minus fulfillment direct costs, only when both are
   * measured and coverage is complete. Bank costs and invoices are not
   * subtracted here.
   */
  observedContributionCents: number | null
  genuineNetCents: null
  unknownRemainder: readonly string[]
}

const LABELS: Record<string, string> = {
  '2026-09': 'Sep 2026',
  '2026-10': 'Oct 2026',
}

export function fullPicture(
  period: string,
  bank: BankOperatingAnswer,
  measures: PeriodMeasures,
  invoiceCostsCents: number | null,
): FullPicture {
  const month = period.slice(0, 7)
  const unknown: string[] = []
  if (measures.shippingRevenueCents === null) unknown.push('shipping revenue for this period')
  if (measures.fulfillmentDirectCents === null || !measures.fulfillmentCoverageComplete) {
    unknown.push('fulfillment direct costs with complete rate and cost coverage')
  }
  let bankOperatingSampleCents: number | null = null
  let bankPostageCents: number | null = null
  if (bank.status !== 'provisional') {
    unknown.push('bank operating sample')
  } else {
    bankOperatingSampleCents = bank.view.operatingSubtotalCents
    bankPostageCents = bank.view.postageExcludedCents
    unknown.push('bank sample is unreviewed cash activity, not fully recognized operating cost')
  }
  if (invoiceCostsCents === null) {
    unknown.push('off-account invoices for rent, payroll, insurance, and other cards')
  }
  const observed = measures.shippingRevenueCents !== null
    && measures.fulfillmentDirectCents !== null
    && measures.fulfillmentCoverageComplete
    ? measures.shippingRevenueCents - measures.fulfillmentDirectCents
    : null
  return {
    period: month,
    label: LABELS[month] ?? month,
    shippingRevenueCents: measures.shippingRevenueCents,
    fulfillmentDirectCents: measures.fulfillmentDirectCents,
    bankOperatingSampleCents,
    bankPostageCents,
    invoiceCostsCents,
    observedContributionCents: observed,
    genuineNetCents: null,
    unknownRemainder: unknown,
  }
}

/**
 * Placeholder for a future invoice file at data/operating-invoices/YYYY-MM.csv.
 * No file is shipped, and an absent file is unknown rather than zero.
 */
export function parseInvoiceCostCsv(text: string): number | null {
  const rows = text.trim().split(/\r?\n/).slice(1).filter((line) => line.trim() !== '')
  if (rows.length === 0) return null
  let total = 0
  for (const line of rows) {
    const amount = line.split(',').at(-1)?.trim() ?? ''
    const n = Number(amount)
    if (!Number.isFinite(n)) return null
    total += Math.round(n * 100)
  }
  return total
}
