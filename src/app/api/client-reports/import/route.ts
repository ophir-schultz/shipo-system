import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { requireStaff } from '@/lib/require-staff'
import { parseReportGrid } from '@/lib/pricing/client-report'

export const dynamic = 'force-dynamic'

// Adds billing lines. Does not delete existing lines and does not email.

export async function POST(req: Request) {
  const denied = await requireStaff()
  if (denied) return denied

  const body = await req.json().catch(() => null) as {
    clientId?: unknown
    filename?: unknown
    grid?: unknown
  } | null
  const clientId = typeof body?.clientId === 'string' ? body.clientId : ''
  if (!clientId) return NextResponse.json({ error: 'clientId is required' }, { status: 400 })
  if (!Array.isArray(body?.grid)) {
    return NextResponse.json({ error: 'grid must be the workbook rows' }, { status: 400 })
  }

  const parsed = parseReportGrid(body.grid as unknown[][])
  if (parsed.error) return NextResponse.json({ error: parsed.error }, { status: 400 })
  if (parsed.rows.length === 0) {
    return NextResponse.json({ error: 'The workbook has a header and no orders.' }, { status: 400 })
  }

  const source = typeof body.filename === 'string' && body.filename ? body.filename : 'import'
  const finiteOrNull = (value: string) => {
    if (value.trim() === '' || /[\n\r]/.test(value)) return null
    const n = Number(value.replace(/,/g, ''))
    return Number.isFinite(n) ? n : null
  }
  const records = parsed.rows.map((row) => ({
    client_id: clientId,
    order_number: row.orderNumber,
    line_date: row.date,
    recipient_name: row.recipientName || null,
    tracking_number: row.trackingNumber || null,
    sku: row.sku || null,
    qty: row.qty || null,
    qty_count: finiteOrNull(row.qtyCount),
    serial_number: row.serialNumber || null,
    pick_price: row.pickPrice === '' ? null : Number(row.pickPrice),
    box_price: row.boxPrice === '' ? null : Number(row.boxPrice),
    shipping_price: row.shippingPrice === '' ? null : Number(row.shippingPrice),
    total: row.total === '' ? null : Number(row.total),
    zone: row.zone || null,
    zipcode: row.zipcode || null,
    weight: row.weight || null,
    volume_weight: row.volumeWeight || null,
    source,
  }))

  const { error } = await supabaseAdmin.from('client_billing_lines').insert(records)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, count: records.length })
}
