import { describe, expect, it } from 'vitest'
import { recordsToCsv, recordsToPdf } from './tabular-file'

describe('tabular downloads', () => {
  const rows = [{ Order: 'SO1', Note: 'a, b' }]

  it('writes a CSV with the same columns', () => {
    const csv = recordsToCsv(rows)
    expect(csv.startsWith('Order,Note\n')).toBe(true)
    expect(csv).toContain('"a, b"')
  })

  it('writes a PDF', async () => {
    const pdf = await recordsToPdf(rows, 'Shipments 2026-11-01 to 2026-11-03')
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
    expect(pdf.toString('latin1')).toContain('SO1')
  })
})
