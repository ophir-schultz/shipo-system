import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import {
  mapSerialReportRow,
  parseSerialReportFilters,
  serialReportToCsv,
  serialReportToPdf,
  serialReportToXlsx,
} from './serial-history'

const row = mapSerialReportRow({
  id: 's1',
  serial: 'AAA',
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

describe('serial history report', () => {
  it('requires a whole date range when either date is set', () => {
    expect(parseSerialReportFilters(new URLSearchParams({ dateFrom: '2026-11-01' })).error).toContain('both')
    const parsed = parseSerialReportFilters(new URLSearchParams({
      clientId: 'c1',
      dateFrom: '2026-11-01',
      dateTo: '2026-11-03',
    }))
    expect(parsed.error).toBeNull()
    expect(parsed.filters.clientId).toBe('c1')
  })

  it('writes the serial, the order and the send status to CSV and Excel', () => {
    const csv = serialReportToCsv([row])
    expect(csv).toContain('Tracking')
    expect(csv).toContain('AAA')
    expect(csv).toContain('SO1')
    expect(csv).toContain('sent')
    expect(csv).not.toContain('Nayax status')
    const book = XLSX.read(serialReportToXlsx([row]), { type: 'buffer' })
    const grid = XLSX.utils.sheet_to_json<string[]>(book.Sheets.Serials, { header: 1 })
    expect(grid[0]).toContain('Serial')
    expect(grid[0]).toContain('Zenventory status')
    expect(grid[0]).not.toContain('Nayax status')
    expect(grid[1]).toContain('AAA')
  })

  it('builds a PDF that includes the serial', async () => {
    const pdf = await serialReportToPdf([row], '2026-11-01 to 2026-11-03')
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
    expect(pdf.toString('latin1')).toContain('AAA')
  })
})
