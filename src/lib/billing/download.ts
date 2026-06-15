import * as XLSX from 'xlsx'

export function downloadBillingExcel({
  clientName, dateFrom, dateTo, shipments, warehouse, adjustments, bills,
  shippingRevenue, shippingCost, warehouseTotal, pendingAdj, grandTotal,
}: any) {
  const wb = XLSX.utils.book_new()

  // Summary sheet
  const summaryRows = [
    ['Billing Summary — ' + clientName],
    ['Period', `${dateFrom} to ${dateTo}`],
    [],
    ['Category', 'Amount'],
    ['Shipping Revenue', shippingRevenue.toFixed(2)],
    ['Shipping Cost (Carrier)', shippingCost.toFixed(2)],
    ['Warehouse Charges', warehouseTotal.toFixed(2)],
    ['Pending Adjustments', pendingAdj.toFixed(2)],
    ['TOTAL TO BILL', grandTotal.toFixed(2)],
  ]
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summaryRows), 'Summary')

  // Shipments sheet
  const shipRows = [
    ['Order #', 'Ship Date', 'Carrier', 'Service', 'We Paid', 'Charged', 'P/L'],
    ...shipments.map((s: any) => [
      s.order_number,
      s.ship_date ? new Date(s.ship_date).toLocaleDateString() : '',
      s.carrier ?? '',
      s.service ?? '',
      s.actual_cost ?? 0,
      s.client_rate ?? 0,
      s.profit_loss ?? 0,
    ]),
    [],
    ['', '', '', 'TOTAL', shipments.reduce((s: number, r: any) => s + (r.actual_cost ?? 0), 0), shippingRevenue],
  ]
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(shipRows), 'Shipments')

  // Warehouse sheet
  const whRows = [
    ['Date', 'Service', 'Qty', 'Rate', 'Total', 'Notes'],
    ...warehouse.map((w: any) => [
      w.log_date,
      w.service_type?.replace(/_/g, ' ') ?? '',
      w.quantity,
      w.rate ?? 0,
      w.total ?? 0,
      w.notes ?? '',
    ]),
    [],
    ['', '', '', 'TOTAL', '', warehouseTotal],
  ]
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(whRows), 'Warehouse')

  // Adjustments sheet
  const adjRows = [
    ['Order #', 'Reason', 'Date', 'Amount', 'Status'],
    ...adjustments.map((a: any) => [
      a.order_number,
      a.reason ?? 'Carrier reweigh',
      a.adjustment_date ? new Date(a.adjustment_date).toLocaleDateString() : '',
      a.adjustment_amount ?? 0,
      a.status,
    ]),
  ]
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(adjRows), 'Adjustments')

  XLSX.writeFile(wb, `billing-${clientName.replace(/\s+/g, '-')}-${dateFrom}-${dateTo}.xlsx`)
}

export async function downloadBillingPDF({
  clientName, dateFrom, dateTo, shipments, warehouse, adjustments,
  shippingRevenue, shippingCost, warehouseTotal, pendingAdj, grandTotal,
}: any) {
  const { jsPDF } = await import('jspdf')
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })

  const blue = [0, 170, 255] as [number, number, number]
  const dark = [15, 23, 42] as [number, number, number]
  const gray = [100, 116, 139] as [number, number, number]
  const light = [248, 250, 252] as [number, number, number]

  const W = 210
  let y = 0

  // Header bar
  doc.setFillColor(...blue)
  doc.rect(0, 0, W, 28, 'F')
  doc.setTextColor(255, 255, 255)
  doc.setFontSize(22)
  doc.setFont('helvetica', 'bold')
  doc.text('Shipo', 14, 16)
  doc.setFontSize(9)
  doc.setFont('helvetica', 'normal')
  doc.text('Operations & Fulfillment Platform', 14, 22)
  doc.setFontSize(11)
  doc.setFont('helvetica', 'bold')
  doc.text('BILLING STATEMENT', W - 14, 12, { align: 'right' })
  doc.setFontSize(9)
  doc.setFont('helvetica', 'normal')
  doc.text(`Period: ${dateFrom} – ${dateTo}`, W - 14, 18, { align: 'right' })
  doc.text(`Generated: ${new Date().toLocaleDateString()}`, W - 14, 23, { align: 'right' })

  y = 36
  doc.setTextColor(...dark)
  doc.setFontSize(14)
  doc.setFont('helvetica', 'bold')
  doc.text(`Client: ${clientName}`, 14, y)

  // Summary box
  y += 8
  doc.setFillColor(...light)
  doc.setDrawColor(220, 220, 220)
  doc.roundedRect(14, y, W - 28, 38, 2, 2, 'FD')
  doc.setFontSize(9)
  doc.setFont('helvetica', 'bold')
  doc.setTextColor(...gray)
  doc.text('SUMMARY', 20, y + 8)

  const summaryItems = [
    ['Shipping Revenue', `$${shippingRevenue.toFixed(2)}`],
    ['Carrier Cost', `$${shippingCost.toFixed(2)}`],
    ['Warehouse Charges', `$${warehouseTotal.toFixed(2)}`],
    ['Pending Adjustments', `$${pendingAdj.toFixed(2)}`],
  ]
  const colW = (W - 28) / 4
  summaryItems.forEach(([label, val], i) => {
    const x = 20 + i * colW
    doc.setFont('helvetica', 'normal')
    doc.setTextColor(...gray)
    doc.setFontSize(8)
    doc.text(label, x, y + 16)
    doc.setFont('helvetica', 'bold')
    doc.setTextColor(...dark)
    doc.setFontSize(13)
    doc.text(val, x, y + 26)
  })

  // Total
  doc.setFillColor(...blue)
  doc.roundedRect(W - 60, y + 4, 46, 28, 2, 2, 'F')
  doc.setTextColor(255, 255, 255)
  doc.setFontSize(8)
  doc.setFont('helvetica', 'normal')
  doc.text('TOTAL TO BILL', W - 37, y + 13, { align: 'center' })
  doc.setFontSize(16)
  doc.setFont('helvetica', 'bold')
  doc.text(`$${grandTotal.toFixed(2)}`, W - 37, y + 25, { align: 'center' })

  y += 48

  function sectionHeader(title: string) {
    doc.setFillColor(...blue)
    doc.rect(14, y, W - 28, 7, 'F')
    doc.setTextColor(255, 255, 255)
    doc.setFontSize(9)
    doc.setFont('helvetica', 'bold')
    doc.text(title, 17, y + 5)
    y += 10
  }

  function tableRow(cols: string[], widths: number[], isHeader = false, isAlt = false) {
    if (isHeader) {
      doc.setFillColor(240, 244, 248)
      doc.rect(14, y - 4, W - 28, 7, 'F')
      doc.setTextColor(...gray)
      doc.setFont('helvetica', 'bold')
      doc.setFontSize(7.5)
    } else {
      if (isAlt) {
        doc.setFillColor(250, 252, 255)
        doc.rect(14, y - 4, W - 28, 6, 'F')
      }
      doc.setTextColor(...dark)
      doc.setFont('helvetica', 'normal')
      doc.setFontSize(7.5)
    }
    let x = 16
    cols.forEach((col, i) => {
      doc.text(String(col ?? ''), x, y, { maxWidth: widths[i] - 2 })
      x += widths[i]
    })
    y += isHeader ? 5 : 5
  }

  // Shipments section
  if (shipments.length > 0) {
    if (y > 230) { doc.addPage(); y = 20 }
    sectionHeader(`Shipments (${shipments.length})`)
    tableRow(['Order #', 'Date', 'Carrier / Service', 'We Paid', 'Charged', 'P/L'], [35, 22, 60, 22, 22, 22], true)
    shipments.forEach((s: any, i: number) => {
      if (y > 270) { doc.addPage(); y = 20 }
      tableRow([
        s.order_number ?? '',
        s.ship_date ? new Date(s.ship_date).toLocaleDateString() : '',
        [s.carrier, s.service].filter(Boolean).join(' '),
        `$${(s.actual_cost ?? 0).toFixed(2)}`,
        `$${(s.client_rate ?? 0).toFixed(2)}`,
        `${(s.profit_loss ?? 0) >= 0 ? '+' : ''}$${(s.profit_loss ?? 0).toFixed(2)}`,
      ], [35, 22, 60, 22, 22, 22], false, i % 2 === 0)
    })
    doc.setDrawColor(...blue)
    doc.line(14, y, W - 14, y)
    doc.setFont('helvetica', 'bold')
    doc.setTextColor(...blue)
    doc.setFontSize(8)
    doc.text(`Total: $${shippingRevenue.toFixed(2)}`, W - 14, y + 5, { align: 'right' })
    y += 10
  }

  // Warehouse section
  if (warehouse.length > 0) {
    if (y > 230) { doc.addPage(); y = 20 }
    sectionHeader(`Warehouse Activity (${warehouse.length})`)
    tableRow(['Date', 'Service', 'Qty', 'Rate', 'Total', 'Notes'], [25, 50, 15, 20, 22, 50], true)
    warehouse.forEach((w: any, i: number) => {
      if (y > 270) { doc.addPage(); y = 20 }
      tableRow([
        w.log_date ?? '',
        (w.service_type ?? '').replace(/_/g, ' '),
        String(w.quantity ?? ''),
        `$${(w.rate ?? 0).toFixed(2)}`,
        `$${(w.total ?? 0).toFixed(2)}`,
        w.notes ?? '',
      ], [25, 50, 15, 20, 22, 50], false, i % 2 === 0)
    })
    doc.setDrawColor(...blue)
    doc.line(14, y, W - 14, y)
    doc.setFont('helvetica', 'bold')
    doc.setTextColor(...blue)
    doc.setFontSize(8)
    doc.text(`Total: $${warehouseTotal.toFixed(2)}`, W - 14, y + 5, { align: 'right' })
    y += 10
  }

  // Adjustments section
  if (adjustments.length > 0) {
    if (y > 230) { doc.addPage(); y = 20 }
    sectionHeader(`Carrier Adjustments (${adjustments.length})`)
    tableRow(['Order #', 'Reason', 'Date', 'Amount', 'Status'], [40, 60, 25, 25, 25], true)
    adjustments.forEach((a: any, i: number) => {
      if (y > 270) { doc.addPage(); y = 20 }
      tableRow([
        a.order_number ?? '',
        a.reason ?? 'Carrier reweigh',
        a.adjustment_date ? new Date(a.adjustment_date).toLocaleDateString() : '',
        `+$${(a.adjustment_amount ?? 0).toFixed(2)}`,
        a.status ?? '',
      ], [40, 60, 25, 25, 25], false, i % 2 === 0)
    })
    doc.setDrawColor(...blue)
    doc.line(14, y, W - 14, y)
    doc.setFont('helvetica', 'bold')
    doc.setTextColor(...blue)
    doc.setFontSize(8)
    doc.text(`Total: +$${pendingAdj.toFixed(2)}`, W - 14, y + 5, { align: 'right' })
    y += 10
  }

  // Footer
  const pages = doc.getNumberOfPages()
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p)
    doc.setFillColor(...blue)
    doc.rect(0, 287, W, 10, 'F')
    doc.setTextColor(255, 255, 255)
    doc.setFontSize(7)
    doc.setFont('helvetica', 'normal')
    doc.text('ShipoLLC Operations Platform', 14, 293)
    doc.text(`Page ${p} of ${pages}`, W - 14, 293, { align: 'right' })
  }

  doc.save(`invoice-${clientName.replace(/\s+/g, '-')}-${dateFrom}-${dateTo}.pdf`)
}
