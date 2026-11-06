import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// September 2026 bank activity, loaded from a committed file. Nothing here
// writes to Supabase. September is not copied onto any other month.

export const BANK_OPEX_PERIOD = '2026-09'

export const BANK_OPEX_LABEL =
  'Unreviewed bank-derived classifications. Cash basis. Not complete accrual accounting. September 2026 only, not annualized.'

export const BANK_OPEX_SEPARATE_FROM_DIRECT =
  'September bank operating costs are not fulfillment direct costs. Postage on that statement is kept out of the operating subtotal so it is not counted again with carrier cost.'

const CATEGORIES = ['software', 'contractors', 'communications', 'postage', 'bank_fees'] as const

export type BankCostCategory = (typeof CATEGORIES)[number]

export interface BankCostLine {
  n: number
  posted: string
  payee: string
  amountCents: number
  category: BankCostCategory
}

export interface BankOperatingView {
  period: '2026-09'
  label: 'Sep 2026'
  annualized: false
  lines: number
  expendituresCents: number
  postageExcludedCents: number
  operatingSubtotalCents: number
  softwareCents: number
  contractorsCents: number
  communicationsCents: number
  bankFeesCents: number
  /** Rent, payroll, and ledger charges are not in this file. */
  netProfit: null
}

export type BankOperatingAnswer =
  | { status: 'provisional'; view: BankOperatingView }
  | { status: 'unknown'; reason: string }

function centsOf(amount: string): number {
  const n = Number(amount)
  if (!Number.isFinite(n)) throw new Error(`Unreadable bank amount ${amount}`)
  return Math.round(n * 100)
}

export function parseBankCostCsv(text: string): BankCostLine[] {
  const rows = text.trim().split(/\r?\n/).slice(1)
  return rows.map((line) => {
    const [n, posted, payee, amount, category] = line.split(',')
    if (!CATEGORIES.includes(category as BankCostCategory)) {
      throw new Error(`Unknown bank category ${category}`)
    }
    if (!posted.startsWith('2026-09-')) {
      throw new Error(`Bank row ${n} is not September 2026`)
    }
    return {
      n: Number(n),
      posted,
      payee,
      amountCents: centsOf(amount),
      category: category as BankCostCategory,
    }
  })
}

export function loadSeptember2026BankLines(): BankCostLine[] {
  const path = join(process.cwd(), 'data/operating-costs/2026-09-bank.csv')
  return parseBankCostCsv(readFileSync(path, 'utf8'))
}

function sumCategory(lines: readonly BankCostLine[], category: BankCostCategory): number {
  return lines.filter((line) => line.category === category).reduce((sum, line) => sum + line.amountCents, 0)
}

/**
 * September only. Any other month is unknown, even when the September
 * lines are in hand. Those lines are not the answer for June or November.
 */
export function bankOperatingFor(period: string, lines: readonly BankCostLine[]): BankOperatingAnswer {
  const month = period.slice(0, 7)
  if (month !== BANK_OPEX_PERIOD) {
    const direction = month < BANK_OPEX_PERIOD ? 'before' : 'after'
    return {
      status: 'unknown',
      reason: `No bank operating sample for ${month}. September 2026 is not applied ${direction} that month, and a missing month is unknown, not zero.`,
    }
  }
  const softwareCents = sumCategory(lines, 'software')
  const contractorsCents = sumCategory(lines, 'contractors')
  const communicationsCents = sumCategory(lines, 'communications')
  const bankFeesCents = sumCategory(lines, 'bank_fees')
  const postageExcludedCents = sumCategory(lines, 'postage')
  const operatingSubtotalCents = softwareCents + contractorsCents + communicationsCents + bankFeesCents
  return {
    status: 'provisional',
    view: {
      period: '2026-09',
      label: 'Sep 2026',
      annualized: false,
      lines: lines.length,
      expendituresCents: operatingSubtotalCents + postageExcludedCents,
      postageExcludedCents,
      operatingSubtotalCents,
      softwareCents,
      contractorsCents,
      communicationsCents,
      bankFeesCents,
      netProfit: null,
    },
  }
}

export function dollars(cents: number): string {
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(cents)
  return `${sign}$${(abs / 100).toFixed(2)}`
}
