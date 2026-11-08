import type { ClientReportRow } from './client-report'

// The SERIAL NUMBER column on the client report. A serial already stored
// on the billing line stays as it was imported. A blank cell is filled
// from scanned_serials for that client and order, joined with newlines
// the way the Nayax workbook stacks several serials in one cell.
//
// When the scan recorded a SKU and that SKU is one of the lines in the
// report cell, only those serials are used. Otherwise every serial for
// the order is used, because the workbook often keeps one row per order.

export interface StoredScanSerial {
  clientId: string
  orderRef: string
  sku: string | null
  serial: string
  position: number | null
}

export interface RawScanSerial {
  serial: string | null
  position: number | null
  scan_events: {
    client_id?: string | null
    order_ref?: string | null
    sku?: string | null
  } | Array<{
    client_id?: string | null
    order_ref?: string | null
    sku?: string | null
  }> | null
}

export function mapStoredScans(rows: RawScanSerial[]): StoredScanSerial[] {
  const scans: StoredScanSerial[] = []
  for (const row of rows) {
    const event = Array.isArray(row.scan_events) ? row.scan_events[0] : row.scan_events
    const serial = row.serial?.trim() ?? ''
    if (!event?.client_id || !event.order_ref || !serial) continue
    scans.push({
      clientId: event.client_id,
      orderRef: event.order_ref,
      sku: event.sku ?? null,
      serial,
      position: row.position,
    })
  }
  return scans
}

function skuLines(sku: string): string[] {
  return sku.split('\n').map((line) => line.trim()).filter((line) => line !== '')
}

function orderedSerials(scans: StoredScanSerial[]): string {
  const sorted = [...scans].sort((a, b) => {
    const position = (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER)
    if (position !== 0) return position
    return a.serial.localeCompare(b.serial)
  })
  const seen = new Set<string>()
  const serials: string[] = []
  for (const scan of sorted) {
    if (seen.has(scan.serial)) continue
    seen.add(scan.serial)
    serials.push(scan.serial)
  }
  return serials.join('\n')
}

export function fillReportSerials<T extends ClientReportRow>(rows: T[], scans: StoredScanSerial[]): T[] {
  const byOrder = new Map<string, StoredScanSerial[]>()
  for (const scan of scans) {
    const key = `${scan.clientId}\n${scan.orderRef.trim()}`
    const list = byOrder.get(key) ?? []
    list.push(scan)
    byOrder.set(key, list)
  }
  return rows.map((row) => {
    if (row.serialNumber.trim() !== '') return row
    if (!row.clientId) return row
    const list = byOrder.get(`${row.clientId}\n${row.orderNumber.trim()}`)
    if (!list || list.length === 0) return row
    const lines = skuLines(row.sku)
    const matched = lines.length === 0
      ? []
      : list.filter((scan) => {
        const sku = (scan.sku ?? '').trim()
        return sku !== '' && lines.includes(sku)
      })
    const serialNumber = orderedSerials(matched.length > 0 ? matched : list)
    if (!serialNumber) return row
    return { ...row, serialNumber }
  })
}

export function withStoredSerials<T extends ClientReportRow>(rows: T[], raw: RawScanSerial[]): T[] {
  return fillReportSerials(rows, mapStoredScans(raw))
}
