import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { requireStaff } from '@/lib/require-staff'
import { readAllPages } from '@/lib/db/page'
import { recordsToCsv, recordsToPdf } from '@/lib/billing/tabular-file'
import { easternToday } from '@/lib/ledger/eastern-day'
import { profitInstants, profitPeriod, profitRows, type ProfitLevel } from '@/lib/pricing/profit-view'
import type { ShipmentMoney } from '@/lib/pricing/order-profit'
import { withoutVoided } from '@/lib/billing/voided-shipment'

export const dynamic = 'force-dynamic'

// Staff only. This file names ShipStation cost and profit. It is not a
// statement and it is not emailed to a client.

interface ShipmentRow {
  id: string
  client_id: string | null
  order_number: string | null
  ship_date: string | null
  tracking_number: string | null
  client_rate: number | null
  actual_cost: number | null
  raw_data?: unknown
  clients: { name: string | null } | { name: string | null }[] | null
}

function clientName(value: ShipmentRow['clients']): string | null {
  if (!value) return null
  return Array.isArray(value) ? value[0]?.name ?? null : value.name
}

export async function loadProfitShipments(from: string, to: string): Promise<{
  rows: ShipmentMoney[]
  error: string | null
}> {
  const window = profitInstants(from, to)
  const loaded = await readAllPages<ShipmentRow>((start, end) => supabaseAdmin
    .from('shipments')
    .select('id, client_id, order_number, ship_date, tracking_number, client_rate, actual_cost, raw_data, clients(name)')
    .gte('ship_date', window.start)
    .lt('ship_date', window.end)
    .order('ship_date')
    .order('id')
    .range(start, end))
  if (loaded.error) return { rows: [], error: loaded.error.message }
  return {
    rows: withoutVoided(loaded.data ?? []).map((row) => ({
      id: row.id,
      clientId: row.client_id,
      clientName: clientName(row.clients),
      orderNumber: row.order_number ?? '',
      shipDate: row.ship_date,
      trackingNumber: row.tracking_number,
      clientRate: row.client_rate,
      actualCost: row.actual_cost,
    })),
    error: null,
  }
}

export async function GET(req: Request) {
  const denied = await requireStaff()
  if (denied) return denied

  const url = new URL(req.url)
  const format = url.searchParams.get('format')
  const level = url.searchParams.get('level') ?? 'shipment'
  if (format !== 'csv' && format !== 'pdf') {
    return NextResponse.json({ error: 'format must be csv or pdf' }, { status: 400 })
  }
  if (level !== 'shipment' && level !== 'order' && level !== 'client') {
    return NextResponse.json({ error: 'level must be shipment, order, or client' }, { status: 400 })
  }
  const period = profitPeriod({
    grain: url.searchParams.get('grain') ?? 'week',
    today: easternToday(),
    from: url.searchParams.get('from') ?? '',
    to: url.searchParams.get('to') ?? '',
  })
  if (period.error) return NextResponse.json({ error: period.error }, { status: 400 })

  const loaded = await loadProfitShipments(period.from, period.to)
  if (loaded.error) return NextResponse.json({ error: loaded.error }, { status: 500 })
  const rows = profitRows(level as ProfitLevel, loaded.rows)
  const title = `Profit ${level} ${period.from} to ${period.to}`
  if (format === 'csv') {
    return new NextResponse(recordsToCsv(rows.length ? rows : [{ Note: 'No shipments in this period' }]), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="profit-${level}-${period.from}-to-${period.to}.csv"`,
      },
    })
  }
  const pdf = await recordsToPdf(rows.length ? rows : [{ Note: 'No shipments in this period' }], title)
  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="profit-${level}-${period.from}-to-${period.to}.pdf"`,
    },
  })
}
