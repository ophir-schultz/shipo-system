// CSV and PDF of the same rows an Excel report already builds.
// Excel stays. These two are the other downloads the spec asks for.

function cell(value: unknown): string {
  if (value === null || value === undefined) return ''
  return String(value)
}

function csvCell(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`
  return value
}

export function recordsToCsv(rows: Array<Record<string, unknown>>): string {
  const keys = Object.keys(rows[0] ?? {})
  const header = keys.map(csvCell).join(',')
  const body = rows.map((row) => keys.map((key) => csvCell(cell(row[key]))).join(','))
  return [header, ...body].join('\n') + '\n'
}

const PDF_WIDTH = 297
const PDF_HEIGHT = 210
const PDF_LEFT = 8
const PDF_RIGHT = PDF_WIDTH - 8
const PDF_BOTTOM = 12
const PDF_LINE = 3.4

function wrapLines(doc: { splitTextToSize: (text: string, width: number) => string[] }, text: string, width: number): string[] {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (!clean) return ['']
  const lines = doc.splitTextToSize(clean, Math.max(width, 8))
  return lines.length > 0 ? lines : ['']
}

export async function recordsToPdf(
  rows: Array<Record<string, unknown>>,
  title: string,
  banner?: string | null,
): Promise<Buffer> {
  const { jsPDF } = await import('jspdf')
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' })
  const keys = Object.keys(rows[0] ?? { Note: 'No rows' })
  doc.setFillColor(11, 51, 97)
  doc.rect(0, 0, PDF_WIDTH, 14, 'F')
  doc.setTextColor(255, 255, 255)
  doc.setFontSize(11)
  doc.text('Shipo', 8, 9)
  doc.setFontSize(8)
  doc.text(title, PDF_WIDTH - 8, 9, { align: 'right' })
  doc.setTextColor(11, 18, 32)
  doc.setFontSize(6)
  const colW = (PDF_WIDTH - 16) / keys.length
  let y = 20
  if (banner) {
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(9)
    doc.setTextColor(153, 27, 27)
    const bannerLines = wrapLines(doc, banner, PDF_RIGHT - PDF_LEFT)
    doc.text(bannerLines, PDF_LEFT, y)
    y += bannerLines.length * 5 + 2
    doc.setTextColor(11, 18, 32)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(6)
  }
  const header = (top: number) => {
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(6)
    keys.forEach((key, i) => doc.text(key, PDF_LEFT + i * colW, top, { maxWidth: colW - 1 }))
    doc.setFont('helvetica', 'normal')
    return top + 6
  }
  y = header(y)
  const room = () => Math.floor((PDF_HEIGHT - PDF_BOTTOM - y) / PDF_LINE)
  const newPage = () => {
    doc.addPage()
    y = header(12)
  }
  const drawLines = (lines: string[], x: number) => {
    let index = 0
    while (index < lines.length) {
      let fit = room()
      if (fit < 1) {
        newPage()
        fit = room()
      }
      const chunk = lines.slice(index, index + fit)
      doc.text(chunk, x, y)
      y += chunk.length * PDF_LINE
      index += chunk.length
    }
  }
  for (const row of rows) {
    if (String(row.Charge ?? '') === 'NOTE') {
      const note = cell(row.Line ?? row.Note ?? '')
      if (y > PDF_HEIGHT - PDF_BOTTOM) newPage()
      doc.setFont('helvetica', 'italic')
      drawLines(wrapLines(doc, note, PDF_RIGHT - PDF_LEFT), PDF_LEFT)
      doc.setFont('helvetica', 'normal')
      y += 1
      continue
    }
    const columns = keys.map((key) => wrapLines(doc, cell(row[key]), colW - 1))
    const height = Math.max(...columns.map((lines) => lines.length), 1)
    let drawn = 0
    while (drawn < height) {
      let fit = room()
      if (fit < 1) {
        newPage()
        fit = room()
      }
      const slice = columns.map((lines) => lines.slice(drawn, drawn + fit))
      const used = Math.max(...slice.map((lines) => lines.length), 1)
      slice.forEach((lines, i) => {
        if (lines.length > 0) doc.text(lines, PDF_LEFT + i * colW, y)
      })
      y += used * PDF_LINE
      drawn += fit
    }
    y += 1
  }
  if (rows.length === 0) doc.text('No rows in this range.', 8, y)
  return Buffer.from(doc.output('arraybuffer'))
}
