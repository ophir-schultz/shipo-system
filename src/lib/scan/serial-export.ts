import * as XLSX from 'xlsx'

// One stored serial, as the history screen and its downloads show it.
// Status columns stay blank until supabase/serial_delivery_status.sql
// has been applied; the scan itself still comes from scan_events.

export const SERIAL_EXPORT_COLUMNS = [
  'Scanned at',
  'Client',
  'Client id',
  'Order',
  'Tracking',
  'SKU',
  'Serial',
  'Scanned by',
  'Zenventory status',
  'Zenventory sent at',
  'Zenventory response',
] as const

export const SERIAL_STATUSES = ['sent', 'failed', 'skipped', 'unconfirmed', 'scan incomplete'] as const

export interface SerialFilters {
  clientId: string
  order: string
  serial: string
  dateFrom: string
  dateTo: string
  status: string
}

export interface SerialHistoryRow {
  id: string
  scannedAt: string
  clientName: string
  clientId: string
  orderRef: string
  trackingNumber: string
  sku: string
  serial: string
  scannedBy: string
  zenventoryStatus: string
  zenventorySentAt: string
  zenventoryResponse: string
}

const ISO = /^\d{4}-\d{2}-\d{2}$/

export function parseSerialFilters(params: { get(name: string): string | null }): { filters: SerialFilters; error: string | null } {
  const filters: SerialFilters = {
    clientId: (params.get('clientId') ?? '').trim(),
    order: (params.get('order') ?? '').trim(),
    serial: (params.get('serial') ?? '').trim(),
    dateFrom: (params.get('dateFrom') ?? '').trim(),
    dateTo: (params.get('dateTo') ?? '').trim(),
    status: (params.get('status') ?? '').trim(),
  }
  if (filters.dateFrom && !ISO.test(filters.dateFrom)) return { filters, error: 'dateFrom must be YYYY-MM-DD' }
  if (filters.dateTo && !ISO.test(filters.dateTo)) return { filters, error: 'dateTo must be YYYY-MM-DD' }
  if (filters.dateFrom && filters.dateTo && filters.dateFrom > filters.dateTo) {
    return { filters, error: 'dateFrom is after dateTo' }
  }
  if (filters.status && !SERIAL_STATUSES.includes(filters.status as typeof SERIAL_STATUSES[number])) {
    return { filters, error: 'status is not a known delivery status' }
  }
  if (/[%_,]/.test(filters.order) || /[%_,]/.test(filters.serial)) {
    return { filters, error: 'Order and serial filters are plain text' }
  }
  return { filters, error: null }
}

export type SerialFilterStep =
  | { op: 'eq'; column: string; value: string }
  | { op: 'gte'; column: string; value: string }
  | { op: 'lte'; column: string; value: string }

export function serialFilterSteps(filters: SerialFilters): SerialFilterStep[] {
  const steps: SerialFilterStep[] = []
  if (filters.clientId) steps.push({ op: 'eq', column: 'scan_events.client_id', value: filters.clientId })
  if (filters.order) steps.push({ op: 'eq', column: 'scan_events.order_ref', value: filters.order })
  if (filters.serial) steps.push({ op: 'eq', column: 'serial', value: filters.serial })
  if (filters.dateFrom) steps.push({ op: 'gte', column: 'scan_events.scanned_at', value: `${filters.dateFrom}T00:00:00.000Z` })
  if (filters.dateTo) steps.push({ op: 'lte', column: 'scan_events.scanned_at', value: `${filters.dateTo}T23:59:59.999Z` })
  if (filters.status) steps.push({ op: 'eq', column: 'zenventory_status', value: filters.status })
  return steps
}

export interface FilterableQuery {
  eq(column: string, value: string): this
  gte(column: string, value: string): this
  lte(column: string, value: string): this
  or(filters: string): this
}

export function applySerialFilters<Q extends FilterableQuery>(query: Q, filters: SerialFilters): Q {
  let next = query
  for (const step of serialFilterSteps(filters)) {
    next = next[step.op](step.column, step.value)
  }
  return next
}

function text(value: unknown): string {
  if (value === null || value === undefined) return ''
  return String(value)
}

function one<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null
  return value ?? null
}

export interface RawSerialJoin {
  id: string
  serial: string | null
  zenventory_status?: string | null
  zenventory_sent_at?: string | null
  zenventory_response?: string | null
  tracking_number?: string | null
  scan_events: {
    client_id?: string | null
    order_ref?: string | null
    sku?: string | null
    scanned_at?: string | null
    scanned_by?: string | null
    clients?: { name?: string | null } | { name?: string | null }[] | null
  } | Array<{
    client_id?: string | null
    order_ref?: string | null
    sku?: string | null
    scanned_at?: string | null
    scanned_by?: string | null
    clients?: { name?: string | null } | { name?: string | null }[] | null
  }> | null
}

/** Stored tracking wins. A blank snapshot is filled from the shipment rows for that order. */
export function applyShipmentTracking(
  rows: SerialHistoryRow[],
  byOrder: Record<string, string[]>,
): SerialHistoryRow[] {
  return rows.map((row) => {
    if (row.trackingNumber.trim()) return row
    const numbers = (byOrder[row.orderRef] ?? []).map((number) => number.trim()).filter((number) => number !== '')
    if (numbers.length === 0) return row
    return { ...row, trackingNumber: [...new Set(numbers)].join('\n') }
  })
}

export function mapSerialRow(raw: RawSerialJoin): SerialHistoryRow {
  const event = one(raw.scan_events)
  const client = one(event?.clients ?? null)
  return {
    id: raw.id,
    scannedAt: text(event?.scanned_at),
    clientName: text(client?.name),
    clientId: text(event?.client_id),
    orderRef: text(event?.order_ref),
    trackingNumber: text(raw.tracking_number),
    sku: text(event?.sku),
    serial: text(raw.serial),
    scannedBy: text(event?.scanned_by),
    zenventoryStatus: text(raw.zenventory_status),
    zenventorySentAt: text(raw.zenventory_sent_at),
    zenventoryResponse: text(raw.zenventory_response),
  }
}

export function serialCells(row: SerialHistoryRow): string[] {
  return [
    row.scannedAt,
    row.clientName,
    row.clientId,
    row.orderRef,
    row.trackingNumber,
    row.sku,
    row.serial,
    row.scannedBy,
    row.zenventoryStatus,
    row.zenventorySentAt,
    row.zenventoryResponse,
  ]
}

function csvCell(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`
  return value
}

export function serialsToCsv(rows: SerialHistoryRow[]): string {
  const header = SERIAL_EXPORT_COLUMNS.map(csvCell).join(',')
  const body = rows.map((row) => serialCells(row).map(csvCell).join(','))
  return [header, ...body].join('\n') + '\n'
}

export function serialsToXlsx(rows: SerialHistoryRow[]): Buffer {
  const sheet = XLSX.utils.aoa_to_sheet([
    [...SERIAL_EXPORT_COLUMNS],
    ...rows.map((row) => serialCells(row)),
  ])
  const book = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(book, sheet, 'Serials')
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer
}

export const SERIAL_SCHEMA_MESSAGE =
  'Serial history is not in the database yet. Run supabase/serialization_scans.sql, then supabase/serial_delivery_status.sql. Nothing is shown as an empty history.'
