import * as XLSX from 'xlsx'

// The serial history report. One row per stored scan. Date range and
// client narrow it. CSV, Excel and PDF use the same columns.

export const SERIAL_REPORT_COLUMNS = [
  'Scanned at',
  'Client',
  'Client id',
  'Order',
  'SKU',
  'Serial',
  'Scanned by',
  'Zenventory status',
  'Zenventory sent at',
  'Zenventory response',
  'Nayax status',
  'Nayax sent at',
  'Nayax response',
] as const

const ISO = /^\d{4}-\d{2}-\d{2}$/

export interface SerialReportFilters {
  clientId: string
  dateFrom: string
  dateTo: string
  order: string
  serial: string
}

export function parseSerialReportFilters(params: { get(name: string): string | null }): {
  filters: SerialReportFilters
  error: string | null
} {
  const filters: SerialReportFilters = {
    clientId: (params.get('clientId') ?? '').trim(),
    dateFrom: (params.get('dateFrom') ?? '').trim(),
    dateTo: (params.get('dateTo') ?? '').trim(),
    order: (params.get('order') ?? '').trim(),
    serial: (params.get('serial') ?? '').trim(),
  }
  if (filters.dateFrom && !ISO.test(filters.dateFrom)) return { filters, error: 'dateFrom must be YYYY-MM-DD' }
  if (filters.dateTo && !ISO.test(filters.dateTo)) return { filters, error: 'dateTo must be YYYY-MM-DD' }
  if (filters.dateFrom && filters.dateTo && filters.dateFrom > filters.dateTo) {
    return { filters, error: 'dateFrom is after dateTo' }
  }
  if ((filters.dateFrom && !filters.dateTo) || (!filters.dateFrom && filters.dateTo)) {
    return { filters, error: 'Choose both dates, or leave both empty' }
  }
  return { filters, error: null }
}

export interface SerialReportRow {
  id: string
  scannedAt: string
  clientName: string
  clientId: string
  orderRef: string
  sku: string
  serial: string
  scannedBy: string
  zenventoryStatus: string
  zenventorySentAt: string
  zenventoryResponse: string
  nayaxStatus: string
  nayaxSentAt: string
  nayaxResponse: string
}

export interface RawSerialReport {
  id: string
  serial: string | null
  zenventory_status?: string | null
  zenventory_sent_at?: string | null
  zenventory_response?: string | null
  nayax_status?: string | null
  nayax_sent_at?: string | null
  nayax_response?: string | null
  scan_events: {
    client_id?: string | null
    order_ref?: string | null
    sku?: string | null
    scanned_at?: string | null
    scanned_by?: string | null
    clients?: { name?: string | null } | Array<{ name?: string | null }> | null
  } | Array<{
    client_id?: string | null
    order_ref?: string | null
    sku?: string | null
    scanned_at?: string | null
    scanned_by?: string | null
    clients?: { name?: string | null } | Array<{ name?: string | null }> | null
  }> | null
}

function text(value: unknown): string {
  if (value === null || value === undefined) return ''
  return String(value)
}

function one<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null
  return value ?? null
}

export function mapSerialReportRow(raw: RawSerialReport): SerialReportRow {
  const event = one(raw.scan_events)
  const client = one(event?.clients ?? null)
  return {
    id: raw.id,
    scannedAt: text(event?.scanned_at),
    clientName: text(client?.name),
    clientId: text(event?.client_id),
    orderRef: text(event?.order_ref),
    sku: text(event?.sku),
    serial: text(raw.serial),
    scannedBy: text(event?.scanned_by),
    zenventoryStatus: text(raw.zenventory_status),
    zenventorySentAt: text(raw.zenventory_sent_at),
    zenventoryResponse: text(raw.zenventory_response),
    nayaxStatus: text(raw.nayax_status),
    nayaxSentAt: text(raw.nayax_sent_at),
    nayaxResponse: text(raw.nayax_response),
  }
}

export function serialReportCells(row: SerialReportRow): string[] {
  return [
    row.scannedAt,
    row.clientName,
    row.clientId,
    row.orderRef,
    row.sku,
    row.serial,
    row.scannedBy,
    row.zenventoryStatus,
    row.zenventorySentAt,
    row.zenventoryResponse,
    row.nayaxStatus,
    row.nayaxSentAt,
    row.nayaxResponse,
  ]
}

function csvCell(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`
  return value
}

export function serialReportToCsv(rows: SerialReportRow[]): string {
  const header = SERIAL_REPORT_COLUMNS.map(csvCell).join(',')
  const body = rows.map((row) => serialReportCells(row).map(csvCell).join(','))
  return [header, ...body].join('\n') + '\n'
}

export function serialReportToXlsx(rows: SerialReportRow[]): Buffer {
  const sheet = XLSX.utils.aoa_to_sheet([
    [...SERIAL_REPORT_COLUMNS],
    ...rows.map((row) => serialReportCells(row)),
  ])
  const book = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(book, sheet, 'Serials')
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer
}

export async function serialReportToPdf(rows: SerialReportRow[], title: string): Promise<Buffer> {
  const { jsPDF } = await import('jspdf')
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' })
  const width = 297
  doc.setFillColor(11, 51, 97)
  doc.rect(0, 0, width, 16, 'F')
  doc.setTextColor(255, 255, 255)
  doc.setFontSize(12)
  doc.text('Shipo serial history', 8, 10)
  doc.setFontSize(8)
  doc.text(title, width - 8, 10, { align: 'right' })
  doc.setTextColor(11, 18, 32)
  doc.setFontSize(6)
  const colW = (width - 16) / SERIAL_REPORT_COLUMNS.length
  let y = 22
  const drawHeader = () => {
    doc.setFont('helvetica', 'bold')
    SERIAL_REPORT_COLUMNS.forEach((column, i) => {
      doc.text(column, 8 + i * colW, y, { maxWidth: colW - 1 })
    })
    y += 8
    doc.setFont('helvetica', 'normal')
  }
  drawHeader()
  for (const row of rows) {
    const cells = serialReportCells(row).map((cell) => cell.replace(/\n/g, ' '))
    const wrapped = cells.map((cell) => doc.splitTextToSize(cell, colW - 1) as string[])
    const lines = Math.max(1, ...wrapped.map((parts) => parts.length))
    const rowHeight = lines * 3.2
    if (y + rowHeight > 200) {
      doc.addPage()
      y = 12
      drawHeader()
    }
    wrapped.forEach((parts, i) => {
      parts.forEach((part, index) => {
        doc.text(part, 8 + i * colW, y + index * 3.2)
      })
    })
    y += rowHeight + 1
  }
  if (rows.length === 0) doc.text('No scanned serials in this range.', 8, y)
  return Buffer.from(doc.output('arraybuffer'))
}

export interface FilterableQuery {
  eq(column: string, value: string): this
  gte(column: string, value: string): this
  lte(column: string, value: string): this
}

export function applySerialReportFilters<Q extends FilterableQuery>(query: Q, filters: SerialReportFilters): Q {
  let next = query
  if (filters.clientId) next = next.eq('scan_events.client_id', filters.clientId)
  if (filters.order) next = next.eq('scan_events.order_ref', filters.order)
  if (filters.serial) next = next.eq('serial', filters.serial)
  if (filters.dateFrom && filters.dateTo) {
    next = next.gte('scan_events.scanned_at', `${filters.dateFrom}T00:00:00.000Z`)
    next = next.lte('scan_events.scanned_at', `${filters.dateTo}T23:59:59.999Z`)
  }
  return next
}

export const SERIAL_REPORT_SELECT =
  'id, serial, zenventory_status, zenventory_sent_at, zenventory_response, nayax_status, nayax_sent_at, nayax_response, scan_events!inner(client_id, order_ref, sku, scanned_at, scanned_by, clients(name))'

export const SERIAL_REPORT_SELECT_BASE =
  'id, serial, scan_events!inner(client_id, order_ref, sku, scanned_at, scanned_by, clients(name))'

export function serialColumnsMissing(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false
  if (error.code === '42703' || error.code === 'PGRST204') return true
  return /zenventory_status|nayax_status/.test(error.message ?? '')
}
