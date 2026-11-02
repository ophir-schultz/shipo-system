// The client billing report. Column titles are the workbook's own, including
// the line breaks, the leading space and the spelling, so a download lines
// up with the sheet finance already sends.

import * as XLSX from 'xlsx'

export const CLIENT_REPORT_COLUMNS = [
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
] as const

export interface ClientReportRow {
  date: string | null
  orderNumber: string
  recipientName: string
  trackingNumber: string
  sku: string
  qty: string
  qtyCount: string
  serialNumber: string
  pickPrice: string
  boxPrice: string
  shippingPrice: string
  total: string
  zone: string
  zipcode: string
  weight: string
  volumeWeight: string
}

export function reportCells(row: ClientReportRow): string[] {
  return [
    row.date ?? '',
    row.orderNumber,
    row.recipientName,
    row.trackingNumber,
    row.sku,
    row.qty,
    row.qtyCount,
    row.serialNumber,
    row.pickPrice,
    row.boxPrice,
    row.shippingPrice,
    row.total,
    row.zone,
    row.zipcode,
    row.weight,
    row.volumeWeight,
  ]
}

/** Inclusive. A row with no date is outside every range. */
export function inReportRange(date: string | null, dateFrom: string, dateTo: string): boolean {
  if (!date) return false
  return date >= dateFrom && date <= dateTo
}

export function filterReportRows(
  rows: ClientReportRow[],
  dateFrom: string,
  dateTo: string,
): ClientReportRow[] {
  return rows.filter((row) => inReportRange(row.date, dateFrom, dateTo))
}

function csvCell(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`
  return value
}

export function reportToCsv(rows: ClientReportRow[]): string {
  const header = CLIENT_REPORT_COLUMNS.map(csvCell).join(',')
  const body = rows.map((row) => reportCells(row).map(csvCell).join(','))
  return [header, ...body].join('\n') + '\n'
}

export interface ReportApproval {
  client_id: string
  period_from: string
  period_to: string
  status: string | null
}

/** True when finance has approved this client and this exact date range. */
export function isReportApproved(
  approvals: ReportApproval[],
  clientId: string,
  dateFrom: string,
  dateTo: string,
): boolean {
  return approvals.some((row) =>
    row.status === 'approved'
    && row.client_id === clientId
    && row.period_from === dateFrom
    && row.period_to === dateTo)
}

export function reportToXlsx(rows: ClientReportRow[]): Buffer {
  const sheet = XLSX.utils.aoa_to_sheet([
    [...CLIENT_REPORT_COLUMNS],
    ...rows.map((row) => reportCells(row)),
  ])
  const book = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(book, sheet, 'Orders')
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer
}

/** PDF of the same columns. Stays in the system; nothing here sends it. */
export async function reportToPdf(rows: ClientReportRow[], title: string): Promise<Buffer> {
  const { jsPDF } = await import('jspdf')
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' })
  const width = 297
  doc.setFillColor(11, 51, 97)
  doc.rect(0, 0, width, 16, 'F')
  doc.setTextColor(255, 255, 255)
  doc.setFontSize(12)
  doc.text('Shipo client report', 8, 10)
  doc.setFontSize(8)
  doc.text(title, width - 8, 10, { align: 'right' })
  doc.setTextColor(11, 18, 32)
  doc.setFontSize(5.5)
  const colW = (width - 16) / CLIENT_REPORT_COLUMNS.length
  let y = 22
  const drawHeader = () => {
    doc.setFont('helvetica', 'bold')
    CLIENT_REPORT_COLUMNS.forEach((column, i) => {
      doc.text(column.replace(/\n/g, ' '), 8 + i * colW, y, { maxWidth: colW - 1 })
    })
    y += 8
    doc.setFont('helvetica', 'normal')
  }
  drawHeader()
  for (const row of rows) {
    if (y > 200) {
      doc.addPage()
      y = 12
      drawHeader()
    }
    reportCells(row).forEach((cell, i) => {
      doc.text(cell.replace(/\n/g, ' ').slice(0, 40), 8 + i * colW, y, { maxWidth: colW - 1 })
    })
    y += 5
  }
  if (rows.length === 0) doc.text('No orders in this range.', 8, y)
  return Buffer.from(doc.output('arraybuffer'))
}

/** Blank stays blank. A number is two decimal places. Zero stays "0.00". */
export function moneyCell(value: unknown): string {
  if (value === null || value === undefined || value === '') return ''
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return ''
  return n.toFixed(2)
}

export interface BillingLineRecord {
  line_date: string | null
  order_number: string | null
  recipient_name: string | null
  tracking_number: string | null
  sku: string | null
  qty: string | null
  qty_count: number | string | null
  serial_number: string | null
  pick_price: number | string | null
  box_price: number | string | null
  shipping_price: number | string | null
  total: number | string | null
  zone: string | null
  zipcode: string | null
  weight: string | null
  volume_weight: string | null
}

/**
 * Reads a grid whose header row is the workbook's column titles. Rows above
 * that header (the title, blanks, month labels) are ignored. A grid with no
 * header row is refused rather than mapped by position.
 */
export function parseReportGrid(grid: unknown[][]): { rows: ClientReportRow[]; error: string | null } {
  const headerIndex = grid.findIndex((row) => String(row?.[0] ?? '').trim() === 'DATE')
  if (headerIndex < 0) return { rows: [], error: 'No DATE header row. The columns have to match the billing workbook.' }
  const header = grid[headerIndex].map((cell) => (cell === null || cell === undefined ? '' : String(cell)))
  for (let i = 0; i < CLIENT_REPORT_COLUMNS.length; i++) {
    if (header[i] !== CLIENT_REPORT_COLUMNS[i]) {
      return {
        rows: [],
        error: `Column ${i + 1} is "${header[i] ?? ''}", the workbook has "${CLIENT_REPORT_COLUMNS[i]}"`,
      }
    }
  }
  const rows: ClientReportRow[] = []
  for (const raw of grid.slice(headerIndex + 1)) {
    const orderNumber = raw?.[1] === null || raw?.[1] === undefined ? '' : String(raw[1]).trim()
    if (!orderNumber || orderNumber === 'Order #') continue
    const cell = (index: number) => {
      const value = raw?.[index]
      if (value === null || value === undefined) return ''
      return String(value)
    }
    const date = excelDateCell(raw?.[0])
    rows.push({
      date,
      orderNumber,
      recipientName: cell(2),
      trackingNumber: cell(3),
      sku: cell(4),
      qty: cell(5),
      qtyCount: cell(6),
      serialNumber: cell(7),
      pickPrice: moneyCell(raw?.[8]),
      boxPrice: moneyCell(raw?.[9]),
      shippingPrice: moneyCell(raw?.[10]),
      total: moneyCell(raw?.[11]),
      zone: cell(12),
      zipcode: cell(13).replace(/\.0$/, ''),
      weight: cell(14),
      volumeWeight: cell(15),
    })
  }
  return { rows, error: null }
}

function excelDateCell(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10)
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Excel serial, 1900 date system, including the leap-year bug.
    const utc = new Date(Date.UTC(1899, 11, 30) + value * 86400000)
    return utc.toISOString().slice(0, 10)
  }
  const text = String(value).trim()
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10)
  return null
}

export function billingLineToReportRow(line: BillingLineRecord): ClientReportRow {
  return {
    date: line.line_date,
    orderNumber: line.order_number ?? '',
    recipientName: line.recipient_name ?? '',
    trackingNumber: line.tracking_number ?? '',
    sku: line.sku ?? '',
    qty: line.qty ?? '',
    qtyCount: line.qty_count === null || line.qty_count === undefined ? '' : String(line.qty_count),
    serialNumber: line.serial_number ?? '',
    pickPrice: moneyCell(line.pick_price),
    boxPrice: moneyCell(line.box_price),
    shippingPrice: moneyCell(line.shipping_price),
    total: moneyCell(line.total),
    zone: line.zone ?? '',
    zipcode: line.zipcode ?? '',
    weight: line.weight ?? '',
    volumeWeight: line.volume_weight ?? '',
  }
}
