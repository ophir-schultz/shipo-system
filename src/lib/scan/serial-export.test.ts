import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import {
  mapSerialRow,
  parseSerialFilters,
  serialFilterSteps,
  serialsToCsv,
  serialsToXlsx,
} from './serial-export'

describe('serial history export', () => {
  const row = mapSerialRow({
    id: 's1',
    serial: 'ABC',
    zenventory_status: 'sent',
    zenventory_sent_at: '2026-11-03T12:00:00.000Z',
    zenventory_response: '[]',
    scan_events: {
      client_id: 'c1',
      order_ref: 'SO1',
      sku: 'R1',
      scanned_at: '2026-11-03T11:00:00.000Z',
      scanned_by: 'user-1',
      clients: { name: 'Nayax' },
    },
  })

  it('keeps the scan, the order and the Zenventory status', () => {
    expect(row).toMatchObject({
      clientName: 'Nayax',
      clientId: 'c1',
      orderRef: 'SO1',
      sku: 'R1',
      serial: 'ABC',
      scannedBy: 'user-1',
      zenventoryStatus: 'sent',
    })
  })

  it('writes the same columns to CSV and Excel', () => {
    const csv = serialsToCsv([row])
    expect(csv.split('\n')[0]).toContain('Serial')
    expect(csv).toContain('ABC')
    expect(csv).toContain('sent')
    expect(csv).not.toContain('Nayax status')
    const book = XLSX.read(serialsToXlsx([row]))
    const grid = XLSX.utils.sheet_to_json<(string | number)[]>(book.Sheets.Serials, { header: 1 })
    expect(grid[0]).toContain('Zenventory status')
    expect(grid[0]).not.toContain('Nayax response')
    expect(grid[1]).toContain('ABC')
  })

  it('filters by client, order, serial, dates and status', () => {
    const parsed = parseSerialFilters(new URLSearchParams({
      clientId: 'c1',
      order: 'SO1',
      serial: 'ABC',
      dateFrom: '2026-11-01',
      dateTo: '2026-11-03',
      status: 'sent',
    }))
    expect(parsed.error).toBeNull()
    expect(serialFilterSteps(parsed.filters)).toEqual([
      { op: 'eq', column: 'scan_events.client_id', value: 'c1' },
      { op: 'eq', column: 'scan_events.order_ref', value: 'SO1' },
      { op: 'eq', column: 'serial', value: 'ABC' },
      { op: 'gte', column: 'scan_events.scanned_at', value: '2026-11-01T00:00:00.000Z' },
      { op: 'lte', column: 'scan_events.scanned_at', value: '2026-11-03T23:59:59.999Z' },
      { op: 'eq', column: 'zenventory_status', value: 'sent' },
    ])
  })

  it('rejects a status that is not one of the stored ones', () => {
    const parsed = parseSerialFilters(new URLSearchParams({ status: 'drop table' }))
    expect(parsed.error).toContain('status')
  })
})
