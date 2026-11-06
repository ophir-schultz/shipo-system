import { describe, expect, it } from 'vitest'
import { periodRange, statementToday } from '@/lib/billing/statement'
import { easternWeekStart, easternAddDays } from '@/lib/ledger/eastern-day'
import {
  agreedMinimumFromSheets,
  billableSubtotal,
  isFullCalendarMonth,
  monthlyMinimumBill,
  STANDARD_MONTHLY_MINIMUM,
} from '@/lib/billing/monthly-minimum'

const NOVEMBER = { from: '2026-11-01', to: '2026-11-30' }
const standard = agreedMinimumFromSheets('Nayax', [])

function bill(rows: { amount: number | null; voided?: boolean; label?: string }[], range = NOVEMBER, agreed = standard) {
  return monthlyMinimumBill({ from: range.from, to: range.to, rows, agreed })
}

describe('monthly minimum', () => {
  it('is the published $395 floor and does not change a custom sheet', () => {
    expect(STANDARD_MONTHLY_MINIMUM).toBe(395)
    expect(agreedMinimumFromSheets('Orcam', [
      { companyName: 'Orcam', monthlyMinimum: 500 },
    ])).toMatchObject({ status: 'custom', dollars: 500 })
    expect(agreedMinimumFromSheets('Nayax', [
      { companyName: 'Nayax', monthlyMinimum: 395 },
      { companyName: 'Other', monthlyMinimum: 900 },
    ])).toMatchObject({ status: 'standard', dollars: 395 })
    expect(agreedMinimumFromSheets('Nayax', [
      { companyName: 'Nayax', monthlyMinimum: 395 },
      { companyName: ' nayax ', monthlyMinimum: 450 },
    ]).status).toBe('ambiguous')
  })

  it('tops up a full month under the minimum and leaves a higher month alone', () => {
    const under = bill([
      { amount: 100, label: 'Pick & pack' },
      { amount: 50, label: 'Shipping' },
    ])
    expect(under.applies).toBe(true)
    expect(under.subtotalCents).toBe(15000)
    expect(under.topUpCents).toBe(24500)
    expect(under.totalCents).toBe(39500)
    expect(under.subtotalCents! + under.topUpCents!).toBe(under.totalCents)

    const over = bill([{ amount: 500, label: 'Pick & pack' }])
    expect(over.topUpCents).toBe(0)
    expect(over.totalCents).toBe(50000)

    const exact = bill([{ amount: 395, label: 'Storage' }])
    expect(exact.topUpCents).toBe(0)
    expect(exact.totalCents).toBe(39500)
  })

  it('does not treat a voided line or an unknown amount as zero', () => {
    const voidedOnly = bill([
      { amount: 80, voided: true, label: 'Shipping (voided)' },
      { amount: 0, label: 'Shipping (voided)' },
    ])
    expect(voidedOnly.applies).toBe(false)
    expect(voidedOnly.topUpCents).toBeNull()
    expect(billableSubtotal([
      { amount: 80, voided: true },
      { amount: 20, label: 'Pick & pack' },
    ])).toMatchObject({ subtotalCents: 2000, billable: 1 })

    const unknown = bill([
      { amount: 20, label: 'Pick & pack' },
      { amount: null, label: 'Shipping' },
    ])
    expect(unknown.applies).toBe(false)
    expect(unknown.subtotalCents).toBeNull()
    expect(unknown.topUpCents).toBeNull()
    expect(unknown.reason).toMatch(/not treated as \$0/)
  })

  it('does not add the monthly floor to a week or a partial month', () => {
    const today = '2026-11-04'
    const start = easternWeekStart(today)
    const week = { from: start, to: easternAddDays(start, 6) }
    expect(isFullCalendarMonth(week.from, week.to)).toBe(false)
    const partial = bill([{ amount: 10, label: 'Pick & pack' }], week)
    expect(partial.applies).toBe(false)
    expect(partial.topUpCents).toBeNull()
    expect(partial.totalCents).toBe(1000)

    const stub = { from: '2026-11-02', to: '2026-11-30' }
    expect(isFullCalendarMonth(stub.from, stub.to)).toBe(false)
    expect(bill([{ amount: 10 }], stub).applies).toBe(false)
  })

  it('uses the Eastern calendar month, including the Sunday before UTC Monday', () => {
    const at = new Date('2026-11-02T03:30:00.000Z')
    const day = statementToday(at)
    expect(day).toBe('2026-11-01')
    const month = periodRange('month', day)
    expect(month).toEqual({ from: '2026-11-01', to: '2026-11-30' })
    expect(isFullCalendarMonth(month.from, month.to)).toBe(true)
    const week = periodRange('week', day)
    expect(week.from).toBe('2026-10-26')
    expect(week.to).toBe('2026-11-01')
    expect(isFullCalendarMonth(week.from, week.to)).toBe(false)
  })

  it('uses a custom minimum and refuses to pick when sheets disagree', () => {
    const custom = bill(
      [{ amount: 100, label: 'Pick & pack' }],
      NOVEMBER,
      agreedMinimumFromSheets('Orcam', [{ companyName: 'Orcam', monthlyMinimum: 500 }]),
    )
    expect(custom.minimumCents).toBe(50000)
    expect(custom.topUpCents).toBe(40000)
    expect(custom.totalCents).toBe(50000)

    const disagreed = bill(
      [{ amount: 100, label: 'Shipping' }],
      NOVEMBER,
      agreedMinimumFromSheets('Nayax', [
        { companyName: 'Nayax', monthlyMinimum: 395 },
        { companyName: 'Nayax', monthlyMinimum: 450 },
      ]),
    )
    expect(disagreed.applies).toBe(false)
    expect(disagreed.topUpCents).toBeNull()
    expect(disagreed.totalCents).toBe(10000)
  })
})
