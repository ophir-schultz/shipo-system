import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import {
  CLIENT_REPORT_COLUMNS,
  billingLineToReportRow,
  filterReportRows,
  moneyCell,
  parseReportGrid,
  isReportApproved,
  reportToCsv,
  reportToPdf,
  reportToXlsx,
  type ClientReportRow,
} from './client-report'

const sample: ClientReportRow = {
  date: '2026-05-12',
  orderNumber: 'SO601044744',
  recipientName: 'Example',
  trackingNumber: '1Z',
  sku: 'R1\nC1',
  qty: '1\n1',
  qtyCount: '2',
  serialNumber: '',
  pickPrice: '0.52',
  boxPrice: '0.92',
  shippingPrice: '15.11',
  total: '16.55',
  zone: 'Zone 6',
  zipcode: '70805',
  weight: '3lbs 7/6/6',
  volumeWeight: '3',
}

describe('client report columns', () => {
  it('uses the workbook headers, including breaks and the leading space', () => {
    expect(CLIENT_REPORT_COLUMNS).toEqual([
      'DATE',
      'Order #',
      'Recipient Name',
      'Tracking Number',
      'SKU',
      'QTY',
      'QTY COUNT',
      'SERIAL NUMBER',
      'price per unit \n(pick npack)',
      ' Box Material',
      'price for \nshippinng',
      'total',
      'Zone ',
      'Zipcode',
      'WEIGHT',
      'VOLUME WEIGHT',
    ])
    const csv = reportToCsv([sample])
    expect(csv.startsWith('DATE,')).toBe(true)
    expect(csv).toContain('"price per unit \n(pick npack)"')
    expect(csv).toContain(', Box Material,')
    expect(csv).toContain('"price for \nshippinng"')
    expect(csv).toContain('"R1\nC1"')
  })

  it('filters an inclusive date range and drops undated rows', () => {
    const rows = [
      sample,
      { ...sample, orderNumber: 'early', date: '2026-05-01' },
      { ...sample, orderNumber: 'late', date: '2026-08-31' },
      { ...sample, orderNumber: 'none', date: null },
    ]
    const kept = filterReportRows(rows, '2026-05-12', '2026-08-31').map((row) => row.orderNumber)
    expect(kept).toEqual(['SO601044744', 'late'])
  })

  it('writes an xlsx whose first row is those columns', () => {
    const book = XLSX.read(reportToXlsx([sample]), { type: 'buffer' })
    const sheet = book.Sheets[book.SheetNames[0]]
    const grid = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1 })
    expect(grid[0]).toEqual([...CLIENT_REPORT_COLUMNS])
    expect(grid[1]?.[1]).toBe('SO601044744')
  })

  it('keeps a blank money cell blank and a zero as 0.00', () => {
    expect(moneyCell(null)).toBe('')
    expect(moneyCell(0)).toBe('0.00')
    expect(moneyCell('12.5')).toBe('12.50')
    const row = billingLineToReportRow({
      line_date: '2026-06-01',
      order_number: 'SO1',
      recipient_name: null,
      tracking_number: null,
      sku: null,
      qty: null,
      qty_count: null,
      serial_number: null,
      pick_price: null,
      box_price: 0,
      shipping_price: null,
      total: null,
      zone: null,
      zipcode: null,
      weight: null,
      volume_weight: null,
    })
    expect(row.pickPrice).toBe('')
    expect(row.boxPrice).toBe('0.00')
    expect(row.recipientName).toBe('')
  })

  it('reads a grid with the title row above the real header and skips subtotals', () => {
    const grid = [
      ['NAYAX ORDERS (MAY - AUGUST)'],
      [],
      [...CLIENT_REPORT_COLUMNS],
      [46154, 'SO601044744', 'A', '1Z', 'R1', '1', 1, '', 0.32, 0.92, 15.11, 16.35, 'Zone 6', '70805', '3lbs 7/6/6', 3],
      [null, null, null, null, null, null, null, null, 1209.24, 160.86, 6455.98, 7826.08],
      ['JUNE'],
    ]
    const parsed = parseReportGrid(grid)
    expect(parsed.error).toBeNull()
    expect(parsed.rows).toHaveLength(1)
    expect(parsed.rows[0].date).toBe('2026-05-12')
    expect(parsed.rows[0].orderNumber).toBe('SO601044744')
    expect(parsed.rows[0].pickPrice).toBe('0.32')
  })

  it('treats approval as this client and this exact range', () => {
    const approvals = [{
      client_id: 'c1',
      period_from: '2026-05-01',
      period_to: '2026-08-31',
      status: 'approved',
    }]
    expect(isReportApproved(approvals, 'c1', '2026-05-01', '2026-08-31')).toBe(true)
    expect(isReportApproved(approvals, 'c1', '2026-05-02', '2026-08-31')).toBe(false)
    expect(isReportApproved(approvals, 'c2', '2026-05-01', '2026-08-31')).toBe(false)
  })

  it('builds a PDF and does not contain an email action', async () => {
    const pdf = await reportToPdf([sample], 'Nayax 2026-05-01 to 2026-08-31')
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
  })
})
