import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { bankOperatingFor, loadBankLines } from '@/lib/ledger/bank-operating-costs'
import { NO_PERIOD_FULFILLMENT, fullPicture, parseInvoiceCostCsv } from './full-picture'

function picture(period: '2026-09' | '2026-10') {
  return fullPicture(period, bankOperatingFor(period, loadBankLines(period)), NO_PERIOD_FULFILLMENT, null)
}

describe('full picture for the supplied bank months', () => {
  it('keeps September net unknown and postage out of the operating sample', () => {
    const view = picture('2026-09')
    expect(view.label).toBe('Sep 2026')
    expect(view.bankOperatingSampleCents).toBe(320038)
    expect(view.bankPostageCents).toBe(37075)
    expect(view.shippingRevenueCents).toBeNull()
    expect(view.fulfillmentDirectCents).toBeNull()
    expect(view.invoiceCostsCents).toBeNull()
    expect(view.observedContributionCents).toBeNull()
    expect(view.genuineNetCents).toBeNull()
    expect(view.unknownRemainder.join(' ')).toMatch(/not fully recognized operating cost/)
    expect(view.unknownRemainder.join(' ')).toMatch(/invoices/)
  })

  it('keeps October net unknown, with no postage and no invented invoices', () => {
    const view = picture('2026-10')
    expect(view.label).toBe('Oct 2026')
    expect(view.bankOperatingSampleCents).toBe(523706)
    expect(view.bankPostageCents).toBe(0)
    expect(view.invoiceCostsCents).toBeNull()
    expect(view.genuineNetCents).toBeNull()
    expect(view.observedContributionCents).toBeNull()
    expect(view.bankOperatingSampleCents).not.toBe(picture('2026-09').bankOperatingSampleCents)
  })

  it('does not turn a fulfillment margin minus the bank sample into genuine net', () => {
    const bank = bankOperatingFor('2026-09', loadBankLines('2026-09'))
    const view = fullPicture('2026-09', bank, {
      shippingRevenueCents: 1_774_580,
      fulfillmentDirectCents: 0,
      fulfillmentCoverageComplete: true,
    }, null)
    expect(view.observedContributionCents).toBe(1_774_580)
    expect(view.genuineNetCents).toBeNull()
    expect(view.observedContributionCents! - (view.bankOperatingSampleCents ?? 0)).not.toBe(view.genuineNetCents)
    expect(view.unknownRemainder.join(' ')).toMatch(/not fully recognized/)
  })

  it('withholds the observed contribution when coverage is incomplete', () => {
    const bank = bankOperatingFor('2026-10', loadBankLines('2026-10'))
    const view = fullPicture('2026-10', bank, {
      shippingRevenueCents: 100,
      fulfillmentDirectCents: 40,
      fulfillmentCoverageComplete: false,
    }, 0)
    expect(view.observedContributionCents).toBeNull()
    expect(view.genuineNetCents).toBeNull()
    expect(view.invoiceCostsCents).toBe(0)
  })

  it('parses a future invoice file and treats an empty one as unknown', () => {
    expect(parseInvoiceCostCsv('payee,amount\nRent,100.00\nPayroll,50.50\n')).toBe(15050)
    expect(parseInvoiceCostCsv('payee,amount\n')).toBeNull()
  })
})

describe('full picture stays off partner and client surfaces', () => {
  const roots = ['src/components/partner', 'src/app/partner', 'src/app/api/partner', 'src/app/api/statements']

  function files(dir: string): string[] {
    const abs = join(process.cwd(), dir)
    return readdirSync(abs, { recursive: true }).flatMap((name) => {
      const path = join(abs, String(name))
      return /\.(ts|tsx)$/.test(path) ? [path] : []
    })
  }

  it('does not import the staff picture or the bank sample into those routes', () => {
    const banned = ['full-picture', 'bank-operating', '3200.38', '5237.06', '370.75']
    const offenders: string[] = []
    for (const root of roots) {
      for (const path of files(root)) {
        const text = readFileSync(path, 'utf8')
        for (const word of banned) {
          if (text.includes(word)) offenders.push(`${path} ${word}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
