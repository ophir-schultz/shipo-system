import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { requireStaff } from '@/lib/require-staff'
import { readAllPages, type PageResult } from '@/lib/db/page'
import { isMigrationMissing } from '@/lib/db/read'
import {
  applySerialReportFilters,
  applyReportTracking,
  mapSerialReportRow,
  parseSerialReportFilters,
  SERIAL_REPORT_SELECT,
  SERIAL_REPORT_SELECT_BASE,
  serialColumnsMissing,
  serialReportToCsv,
  serialReportToPdf,
  serialReportToXlsx,
  type RawSerialReport,
} from '@/lib/reports/serial-history'
import { shipmentTrackingByOrder } from '@/lib/scan/shipment-tracking'

export const dynamic = 'force-dynamic'

// Staff download of stored serials. This route does not send email.

function load(withStatus: boolean, filters: ReturnType<typeof parseSerialReportFilters>['filters']) {
  const columns = withStatus ? SERIAL_REPORT_SELECT : SERIAL_REPORT_SELECT_BASE
  return readAllPages<RawSerialReport>((from, to) => {
    const query = supabaseAdmin
      .from('scanned_serials')
      .select(columns)
      .order('id')
      .range(from, to)
    return applySerialReportFilters(query, filters) as unknown as PromiseLike<PageResult<RawSerialReport>>
  })
}

export async function GET(req: Request) {
  const denied = await requireStaff()
  if (denied) return denied

  const url = new URL(req.url)
  const format = url.searchParams.get('format')
  if (format !== 'csv' && format !== 'xlsx' && format !== 'pdf') {
    return NextResponse.json({ error: 'format must be csv, xlsx or pdf' }, { status: 400 })
  }
  const parsed = parseSerialReportFilters(url.searchParams)
  if (parsed.error) return NextResponse.json({ error: parsed.error }, { status: 400 })

  let loaded = await load(true, parsed.filters)
  if (serialColumnsMissing(loaded.error)) loaded = await load(false, parsed.filters)
  if (loaded.error) {
    const missing = isMigrationMissing(loaded)
    return NextResponse.json({
      error: missing
        ? 'Scanned serials are not in the database yet. Run supabase/serialization_scans.sql.'
        : loaded.error.message,
    }, { status: missing ? 409 : 500 })
  }

  const tracking = await shipmentTrackingByOrder()
  if (tracking.error) return NextResponse.json({ error: tracking.error }, { status: 500 })
  const rows = applyReportTracking((loaded.data ?? []).map(mapSerialReportRow), tracking.byOrder)
  const filename = `serial-report-${parsed.filters.dateFrom || 'all'}-${parsed.filters.dateTo || 'all'}`
  if (format === 'csv') {
    return new NextResponse(serialReportToCsv(rows), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}.csv"`,
      },
    })
  }
  if (format === 'pdf') {
    const pdf = await serialReportToPdf(rows, `Serial history ${parsed.filters.dateFrom || 'all'} to ${parsed.filters.dateTo || 'all'}`)
    return new NextResponse(new Uint8Array(pdf), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}.pdf"`,
      },
    })
  }
  const body = serialReportToXlsx(rows)
  return new NextResponse(new Uint8Array(body), {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${filename}.xlsx"`,
    },
  })
}
