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

export async function recordsToPdf(rows: Array<Record<string, unknown>>, title: string): Promise<Buffer> {
  const { jsPDF } = await import('jspdf')
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' })
  const keys = Object.keys(rows[0] ?? { Note: 'No rows' })
  const width = 297
  doc.setFillColor(11, 51, 97)
  doc.rect(0, 0, width, 14, 'F')
  doc.setTextColor(255, 255, 255)
  doc.setFontSize(11)
  doc.text('Shipo', 8, 9)
  doc.setFontSize(8)
  doc.text(title, width - 8, 9, { align: 'right' })
  doc.setTextColor(11, 18, 32)
  doc.setFontSize(6)
  const colW = (width - 16) / keys.length
  let y = 20
  const header = () => {
    doc.setFont('helvetica', 'bold')
    keys.forEach((key, i) => doc.text(key, 8 + i * colW, y, { maxWidth: colW - 1 }))
    y += 6
    doc.setFont('helvetica', 'normal')
  }
  header()
  for (const row of rows) {
    if (y > 200) {
      doc.addPage()
      y = 12
      header()
    }
    keys.forEach((key, i) => {
      doc.text(cell(row[key]).replace(/\n/g, ' ').slice(0, 80), 8 + i * colW, y, { maxWidth: colW - 1 })
    })
    y += 5
  }
  if (rows.length === 0) doc.text('No rows in this range.', 8, y)
  return Buffer.from(doc.output('arraybuffer'))
}
