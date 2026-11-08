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

  it('keeps a long coverage note, including the part past the old 80-character cut', async () => {
    const note = 'No charge for this client is recorded before 2026-10-07, so the figures above cover 2026-10-07 to 2026-10-31 and not the whole period.'
    const marker = 'NOTE-CONTINUES-ON-NEXT-PAGE'
    const longNote = `${note} ${'Further coverage detail. '.repeat(80)}${marker}`
    const pdf = await recordsToPdf([
      { Charge: 'pick', Line: 'Pick & pack', Units: 1, Rate: 'see amount', 'Amount ($)': 1 },
      { Charge: 'NOTE', Line: longNote, Units: '', Rate: '', 'Amount ($)': '' },
    ], 'Statement Nayax 2026-10-01 to 2026-10-31')
    const text = pdfText(pdf)
    expect(text).toContain('cover 2026-10-07 to 2026-10-31')
    expect(text).toContain('not the whole period')
    expect(text).toContain(marker)
    expect(text).not.toMatch(/figures above co(?!ver)/)
  })
})

function pdfText(pdf: Buffer): string {
  const parts = pdf.toString('latin1').match(/\((?:\\.|[^\\)])*\)/g) ?? []
  return parts.map((part) => part.slice(1, -1)
    .replace(/\\([()\\])/g, '$1')
    .replace(/\\(\d{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)))).join(' ')
}
