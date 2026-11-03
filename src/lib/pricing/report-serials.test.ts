import { describe, expect, it } from 'vitest'
import { reportToCsv, reportToPdf, reportToXlsx, type ClientReportRow } from './client-report'
import { fillReportSerials, type StoredScanSerial } from './report-serials'
import * as XLSX from 'xlsx'

function row(overrides: Partial<ClientReportRow> = {}): ClientReportRow {
  return {
    clientId: 'client-1',
    date: '2026-05-12',
    orderNumber: 'SO1',
    recipientName: 'A',
    trackingNumber: '1Z',
    sku: 'R1',
    qty: '2',
    qtyCount: '2',
    serialNumber: '',
    pickPrice: '0.64',
    boxPrice: '0.92',
    shippingPrice: '1.00',
    total: '2.56',
    zone: 'Zone 1',
    zipcode: '10001',
    weight: '1',
    volumeWeight: '1',
    ...overrides,
  }
}

const scans: StoredScanSerial[] = [
  { clientId: 'client-1', orderRef: 'SO1', sku: 'R1', serial: 'BBB', position: 2 },
  { clientId: 'client-1', orderRef: 'SO1', sku: 'R1', serial: 'AAA', position: 1 },
  { clientId: 'client-1', orderRef: 'SO1', sku: 'ACC', serial: 'CCC', position: 1 },
  { clientId: 'other', orderRef: 'SO1', sku: 'R1', serial: 'ZZZ', position: 1 },
]

describe('fillReportSerials', () => {
  it('joins the order serials that match the line SKU, in scan order', () => {
    const [filled] = fillReportSerials([row()], scans)
    expect(filled.serialNumber).toBe('AAA\nBBB')
  })

  it('uses every serial on the order when the SKU does not match a scan', () => {
    const [filled] = fillReportSerials([row({ sku: 'UNKNOWN' })], scans)
    expect(filled.serialNumber).toBe('AAA\nCCC\nBBB')
  })

  it('leaves a serial that was already stored on the billing line', () => {
    const [filled] = fillReportSerials([row({ serialNumber: 'IMPORTED' })], scans)
    expect(filled.serialNumber).toBe('IMPORTED')
  })

  it('puts the joined serials in the CSV and the Excel column', () => {
    const filled = fillReportSerials([row()], scans)
    const csv = reportToCsv(filled)
    expect(csv).toContain('"AAA\nBBB"')
    const book = XLSX.read(reportToXlsx(filled), { type: 'buffer' })
    const grid = XLSX.utils.sheet_to_json<string[]>(book.Sheets[book.SheetNames[0]], { header: 1 })
    expect(grid[1]?.[7]).toBe('AAA\nBBB')
  })

  it('keeps both serials in the PDF', async () => {
    const pdf = await reportToPdf(fillReportSerials([row()], scans), 'May')
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
    const text = pdf.toString('latin1')
    expect(text).toContain('AAA')
    expect(text).toContain('BBB')
  })
})
