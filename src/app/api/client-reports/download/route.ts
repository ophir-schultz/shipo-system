import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { requireStaff } from '@/lib/require-staff'
import { readAllPages } from '@/lib/db/page'
import {
  billingLineToReportRow,
  reportToCsv,
  reportToXlsx,
  type BillingLineRecord,
} from '@/lib/pricing/client-report'

export const dynamic = 'force-dynamic'

// Staff download of the client billing report. This route does not send email.

const ISO = /^\d{4}-\d{2}-\d{2}$/

export async function GET(req: Request) {
  const denied = await requireStaff()
  if (denied) return denied

  const url = new URL(req.url)
  const format = url.searchParams.get('format')
  const dateFrom = url.searchParams.get('dateFrom') ?? ''
  const dateTo = url.searchParams.get('dateTo') ?? ''
  const clientId = url.searchParams.get('clientId') ?? ''

  if (format !== 'csv' && format !== 'xlsx') {
    return NextResponse.json({ error: 'format must be csv or xlsx' }, { status: 400 })
  }
  if (!ISO.test(dateFrom) || !ISO.test(dateTo) || dateFrom > dateTo) {
    return NextResponse.json({ error: 'dateFrom and dateTo must be YYYY-MM-DD, from before to' }, { status: 400 })
  }

  const { data, error } = await readAllPages<BillingLineRecord>((from, to) => {
    let query = supabaseAdmin
      .from('client_billing_lines')
      .select('line_date, order_number, recipient_name, tracking_number, sku, qty, qty_count, serial_number, pick_price, box_price, shipping_price, total, zone, zipcode, weight, volume_weight')
      .gte('line_date', dateFrom)
      .lte('line_date', dateTo)
      .order('line_date', { ascending: true })
      .order('id')
      .range(from, to)
    if (clientId) query = query.eq('client_id', clientId)
    return query
  })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  const rows = (data ?? []).map(billingLineToReportRow)
  const filename = `client-report-${dateFrom}-${dateTo}.${format === 'csv' ? 'csv' : 'xlsx'}`

  if (format === 'csv') {
    return new NextResponse(reportToCsv(rows), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    })
  }

  const body = reportToXlsx(rows)
  return new NextResponse(new Uint8Array(body), {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  })
}
