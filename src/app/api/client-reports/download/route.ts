import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { requireStaff } from '@/lib/require-staff'
import { readAllPages } from '@/lib/db/page'
import {
  billingLineToReportRow,
  isReportApproved,
  reportToCsv,
  reportToPdf,
  reportToXlsx,
  type BillingLineRecord,
  type ReportApproval,
} from '@/lib/pricing/client-report'
import { withStoredSerials, type RawScanSerial } from '@/lib/pricing/report-serials'
import { isMigrationMissing } from '@/lib/db/read'

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

  if (format !== 'csv' && format !== 'xlsx' && format !== 'pdf') {
    return NextResponse.json({ error: 'format must be csv, xlsx or pdf' }, { status: 400 })
  }
  if (!ISO.test(dateFrom) || !ISO.test(dateTo) || dateFrom > dateTo) {
    return NextResponse.json({ error: 'dateFrom and dateTo must be YYYY-MM-DD, from before to' }, { status: 400 })
  }
  if (!clientId) {
    return NextResponse.json({ error: 'Choose a client. A report is approved for one client at a time.' }, { status: 400 })
  }

  const approvalsRes = await supabaseAdmin
    .from('client_report_approvals')
    .select('client_id, period_from, period_to, status')
    .eq('client_id', clientId)
    .eq('period_from', dateFrom)
    .eq('period_to', dateTo)
    .limit(20)
  if (approvalsRes.error) {
    return NextResponse.json({ error: approvalsRes.error.message }, { status: 500 })
  }
  if (!isReportApproved((approvalsRes.data ?? []) as ReportApproval[], clientId, dateFrom, dateTo)) {
    return NextResponse.json({
      error: 'Finance has not approved this client and date range. Approve it in the system, then download. It is not emailed.',
    }, { status: 403 })
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

  const scans = await readAllPages<RawScanSerial>((from, to) => supabaseAdmin
    .from('scanned_serials')
    .select('serial, position, scan_events!inner(client_id, order_ref, sku)')
    .eq('scan_events.client_id', clientId)
    .order('id')
    .range(from, to))
  if (scans.error && !isMigrationMissing(scans)) {
    return NextResponse.json({ error: scans.error.message }, { status: 500 })
  }

  const rows = withStoredSerials(
    (data ?? []).map((line) => billingLineToReportRow({ ...line, client_id: clientId })),
    scans.error ? [] : (scans.data ?? []),
  )
  const filename = `client-report-${dateFrom}-${dateTo}.${format === 'csv' ? 'csv' : 'xlsx'}`

  if (format === 'csv') {
    return new NextResponse(reportToCsv(rows), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    })
  }

  if (format === 'pdf') {
    const pdf = await reportToPdf(rows, `Client report ${dateFrom} to ${dateTo}`)
    return new NextResponse(new Uint8Array(pdf), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="client-report-${dateFrom}-${dateTo}.pdf"`,
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
