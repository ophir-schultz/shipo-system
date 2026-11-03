import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { reportToCsv, type ClientReportRow } from '@/lib/pricing/client-report'
import { PASS_THROUGH_RATE, rateText } from '@/lib/billing/statement-view'
import { config } from '../../proxy'

// A client statement, client report, or prospect rate sheet must not show
// what Shipo paid, what Shipo made, or that a line is our carrier cost.
// Staff profit screens stay on the other side of the password proxy.

const ROOT = process.cwd()

const CLIENT_FACING = [
  'src/lib/billing/statement-view.ts',
  'src/lib/billing/statement-detail.ts',
  'src/app/statements/page.tsx',
  'src/app/api/statements/download/route.ts',
  'src/app/api/statements/data/route.ts',
  'src/lib/billing/statement-source.ts',
  'src/lib/pricing/client-report.ts',
  'src/app/api/client-reports/download/route.ts',
  'src/app/client-report/page.tsx',
  'src/components/client-report/ClientReportView.tsx',
  'src/app/rate-sheets/[slug]/[id]/[token]/page.tsx',
  'src/components/rate-sheets/Estimator.tsx',
]

// `shipstation_shipment_id` is the parcel join key, not the carrier's price.
// The price Shipo paid is `actual_cost`. That column is the one that must
// stay out of these files.
const FORBIDDEN = [
  'actual_cost',
  'profit_loss',
  'profit/loss',
  'margin',
  'at cost',
  'carrier cost',
]

function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
}

const MATCHER = config.matcher[0]

function guarded(path: string): boolean {
  return new RegExp(`^${MATCHER}$`).test(path)
}

describe('client-facing documents hide Shipo profit and cost', () => {
  it('keeps those words out of the client-facing source', () => {
    const hits: string[] = []
    for (const file of CLIENT_FACING) {
      const code = codeOnly(readFileSync(join(ROOT, file), 'utf8')).toLowerCase()
      for (const word of FORBIDDEN) {
        if (code.includes(word)) hits.push(`${file} contains ${word}`)
      }
    }
    expect(hits).toEqual([])
  })

  it('prints a pass-through rate without naming our cost', () => {
    expect(rateText({ unit_rate: null, rates: 0 })).toBe(PASS_THROUGH_RATE)
    const rendered = rateText({ unit_rate: null, rates: 0 }).toLowerCase()
    for (const word of FORBIDDEN) expect(rendered).not.toContain(word)
  })

  it('keeps the client report columns to what the client is billed', () => {
    const row: ClientReportRow = {
      clientId: 'c1',
      date: '2026-06-01',
      orderNumber: 'SO1',
      recipientName: 'A Person',
      trackingNumber: '1Z',
      sku: 'R1',
      qty: '1',
      qtyCount: '1',
      serialNumber: '',
      pickPrice: '0.32',
      boxPrice: '0.92',
      shippingPrice: '17.23',
      total: '18.47',
      zone: '8',
      zipcode: '10001',
      weight: '3',
      volumeWeight: '3',
    }
    const csv = reportToCsv([row]).toLowerCase()
    for (const word of FORBIDDEN) expect(csv).not.toContain(word)
    expect(csv).toContain('price for')
    expect(csv).toContain('17.23')
  })

  it('keeps profit screens behind staff login and the statement download staff-gated', () => {
    for (const path of ['/reports', '/order-pnl', '/pnl', '/profit', '/dashboard', '/losses', '/billing', '/statements']) {
      expect(guarded(path), path).toBe(true)
    }
    const statementDownload = readFileSync(join(ROOT, 'src/app/api/statements/download/route.ts'), 'utf8')
    const reportDownload = readFileSync(join(ROOT, 'src/app/api/reports/download/route.ts'), 'utf8')
    const profitDownload = readFileSync(join(ROOT, 'src/app/api/profit/download/route.ts'), 'utf8')
    expect(statementDownload).toContain('requireStaff()')
    expect(reportDownload).toContain('requireStaff()')
    expect(profitDownload).toContain('requireStaff()')
    expect(codeOnly(statementDownload).toLowerCase()).not.toContain('profit_loss')
    expect(codeOnly(profitDownload)).toContain('actual_cost')
    expect(reportDownload).toContain('profit_loss')
    for (const file of CLIENT_FACING) {
      const code = codeOnly(readFileSync(join(ROOT, file), 'utf8'))
      expect(code, file).not.toContain('/api/profit')
      expect(code, file).not.toContain("'/profit'")
    }
  })
})
