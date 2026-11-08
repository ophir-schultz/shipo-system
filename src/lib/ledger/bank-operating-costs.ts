import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  BANK_OPEX_LABEL,
  BANK_OPEX_SEPARATE_FROM_DIRECT,
  CASH_APP_NOT_PAYROLL,
} from './bank-operating-labels'

export { BANK_OPEX_LABEL, BANK_OPEX_SEPARATE_FROM_DIRECT, CASH_APP_NOT_PAYROLL }

// Bank statements loaded from committed files. Nothing here writes to
// Supabase. A month is shown only from its own file. September is not
// added to October, and neither is copied onto June or November.

export const BANK_OPEX_MONTHS = ['2026-09', '2026-10'] as const

const CATEGORIES = ['software', 'contractors', 'communications', 'postage', 'bank_fees', 'other'] as const

const FILES: Record<string, string> = {
  '2026-09': '2026-09-bank.csv',
  '2026-10': '2026-10-bank.csv',
}

export type BankCostCategory = (typeof CATEGORIES)[number]

export interface BankCostLine {
  n: number
  posted: string
  payee: string
  amountCents: number
  category: BankCostCategory
  note: string
}

export interface BankOperatingView {
  period: '2026-09' | '2026-10'
  label: 'Sep 2026' | 'Oct 2026'
  annualized: false
  lines: number
  expendituresCents: number
  /** Withdrawals and other debits, before the statement's service fees. */
  withdrawalsCents: number
  postageExcludedCents: number
  operatingSubtotalCents: number
  softwareCents: number
  contractorsCents: number
  communicationsCents: number
  bankFeesCents: number
  otherCents: number
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
    const [n, posted, payee, amount, category, ...noteParts] = line.split(',')
    if (!CATEGORIES.includes(category as BankCostCategory)) {
      throw new Error(`Unknown bank category ${category}`)
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(posted)) {
      throw new Error(`Bank row ${n} has no posted date`)
    }
    return {
      n: Number(n),
      posted,
      payee,
      amountCents: centsOf(amount),
      category: category as BankCostCategory,
      note: noteParts.join(',').trim(),
    }
  })
}

export function loadBankLines(period: string): BankCostLine[] {
  const file = FILES[period.slice(0, 7)]
  if (!file) return []
  return parseBankCostCsv(readFileSync(join(process.cwd(), 'data', 'operating-costs', file), 'utf8'))
}

export function loadSeptember2026BankLines(): BankCostLine[] {
  return loadBankLines('2026-09')
}

export function loadOctober2026BankLines(): BankCostLine[] {
  return loadBankLines('2026-10')
}

function sumCategory(lines: readonly BankCostLine[], category: BankCostCategory): number {
  return lines.filter((line) => line.category === category).reduce((sum, line) => sum + line.amountCents, 0)
}

const LABELS = { '2026-09': 'Sep 2026', '2026-10': 'Oct 2026' } as const

/**
 * One statement, one month. Lines posted in another month are not used.
 * June and November have no file, so they stay unknown rather than an
 * average or a copy of a neighbor.
 */
export function bankOperatingFor(period: string, lines: readonly BankCostLine[]): BankOperatingAnswer {
  const month = period.slice(0, 7)
  const known = month === '2026-09' || month === '2026-10'
  const ownLines = lines.filter((line) => line.posted.startsWith(`${month}-`))
  if (!known || ownLines.length === 0 || ownLines.length !== lines.length) {
    return {
      status: 'unknown',
      reason: `No bank statement for ${month}. A missing month is unknown, not zero, and no other month is copied or averaged in.`,
    }
  }
  const softwareCents = sumCategory(ownLines, 'software')
  const contractorsCents = sumCategory(ownLines, 'contractors')
  const communicationsCents = sumCategory(ownLines, 'communications')
  const bankFeesCents = sumCategory(ownLines, 'bank_fees')
  const otherCents = sumCategory(ownLines, 'other')
  const postageExcludedCents = sumCategory(ownLines, 'postage')
  const operatingSubtotalCents = softwareCents + contractorsCents + communicationsCents + bankFeesCents + otherCents
  return {
    status: 'provisional',
    view: {
      period: month,
      label: LABELS[month],
      annualized: false,
      lines: ownLines.length,
      expendituresCents: operatingSubtotalCents + postageExcludedCents,
      withdrawalsCents: operatingSubtotalCents + postageExcludedCents - bankFeesCents,
      postageExcludedCents,
      operatingSubtotalCents,
      softwareCents,
      contractorsCents,
      communicationsCents,
      bankFeesCents,
      otherCents,
      netProfit: null,
    },
  }
}

export function dollars(cents: number): string {
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(cents)
  return `${sign}$${(abs / 100).toFixed(2)}`
}
