import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { requireStaff } from '@/lib/require-staff'
import { easternAddDays, easternCalendarDay, easternMidnightIso } from '@/lib/ledger/eastern-day'
import { priceOf } from '@/lib/billing/unpriced'
import { freightColumnMissing } from '@/lib/billing/manual-freight'

// Staff picker. One shipment, not a day's freight rolled together.
// Carrier cost is not returned.

export async function GET(req: Request) {
  const denied = await requireStaff()
  if (denied) return denied
  const url = new URL(req.url)
  const clientId = url.searchParams.get('client_id')?.trim() ?? ''
  const date = url.searchParams.get('date')?.trim() ?? ''
  if (!clientId || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: 'client_id and date are required' }, { status: 400 })
  }
  const probe = await supabaseAdmin.from('warehouse_daily_log').select('shipment_ref').limit(1)
  const linkReady = !probe.error
  const linkError = freightColumnMissing(probe.error) ? null : probe.error
  if (linkError) {
    return NextResponse.json({ error: linkError.message }, { status: 503 })
  }
  const from = easternMidnightIso(easternAddDays(date, -1))
  const to = easternMidnightIso(easternAddDays(date, 2))
  const shipped = await supabaseAdmin
    .from('shipments')
    .select('shipstation_shipment_id, order_number, ship_date, carrier, client_id, client_rate')
    .eq('client_id', clientId)
    .gte('ship_date', from)
    .lt('ship_date', to)
    .order('ship_date')
    .limit(200)
  if (shipped.error) {
    return NextResponse.json({ error: shipped.error.message }, { status: 503 })
  }
  const shipments = (shipped.data ?? []).flatMap((row) => {
    const record = row as {
      shipstation_shipment_id: number | string | null
      order_number: string | null
      ship_date: string | null
      carrier: string | null
      client_rate: unknown
    }
    if (record.shipstation_shipment_id == null) return []
    if (easternCalendarDay(record.ship_date) !== date) return []
    return [{
      shipmentRef: String(record.shipstation_shipment_id),
      orderNumber: record.order_number ?? '',
      carrier: record.carrier ?? '',
      zonePriced: priceOf(record.client_rate) !== null,
    }]
  })
  return NextResponse.json({
    linkReady,
    date,
    shipments,
  })
}
