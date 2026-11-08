import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { requireStaff } from '@/lib/require-staff'
import { readAllPages } from '@/lib/db/page'
import { isMigrationMissing } from '@/lib/db/read'
import {
  applySerialFilters,
  applyShipmentTracking,
  mapSerialRow,
  parseSerialFilters,
  SERIAL_SCHEMA_MESSAGE,
  serialsToCsv,
  serialsToXlsx,
  type RawSerialJoin,
} from '@/lib/scan/serial-export'
import { shipmentTrackingByOrder } from '@/lib/scan/shipment-tracking'

export const dynamic = 'force-dynamic'

const SELECT = 'id, serial, tracking_number, zenventory_status, zenventory_sent_at, zenventory_response, scan_events!inner(client_id, order_ref, sku, scanned_at, scanned_by, clients(name))'

export async function GET(req: Request) {
  const denied = await requireStaff()
  if (denied) return denied

  const url = new URL(req.url)
  const format = url.searchParams.get('format')
  if (format !== 'csv' && format !== 'xlsx') {
    return NextResponse.json({ error: 'format must be csv or xlsx' }, { status: 400 })
  }
  const parsed = parseSerialFilters(url.searchParams)
  if (parsed.error) return NextResponse.json({ error: parsed.error }, { status: 400 })

  const loaded = await readAllPages<RawSerialJoin>((from, to) => {
    const query = supabaseAdmin
      .from('scanned_serials')
      .select(SELECT)
      .order('id')
      .range(from, to)
    return applySerialFilters(query, parsed.filters)
  })

  if (loaded.error) {
    const message = isMigrationMissing(loaded) ? SERIAL_SCHEMA_MESSAGE : loaded.error.message
    return NextResponse.json({ error: message }, { status: isMigrationMissing(loaded) ? 409 : 500 })
  }

  const tracking = await shipmentTrackingByOrder()
  if (tracking.error) return NextResponse.json({ error: tracking.error }, { status: 500 })
  const rows = applyShipmentTracking((loaded.data ?? []).map(mapSerialRow), tracking.byOrder)
  if (format === 'csv') {
    return new NextResponse(serialsToCsv(rows), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="serials.csv"',
      },
    })
  }
  const body = serialsToXlsx(rows)
  return new NextResponse(new Uint8Array(body), {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': 'attachment; filename="serials.xlsx"',
    },
  })
}
