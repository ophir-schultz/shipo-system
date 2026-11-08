import { supabaseAdmin } from '@/lib/supabase'
import { read, readErrors, loaded, type LoadedData } from '@/lib/db/read'
import { readAllPages } from '@/lib/db/page'
import ViewUnreadable from '@/components/ui/ViewUnreadable'
import OrderPnlView from '@/components/pnl/OrderPnlView'
import { rollupOrders, type ShipmentMoney } from '@/lib/pricing/order-profit'
import { withoutVoided } from '@/lib/billing/voided-shipment'

export const dynamic = 'force-dynamic'

interface ShipmentRow {
  id: string
  client_id: string | null
  order_number: string
  ship_date: string | null
  tracking_number: string | null
  client_rate: number | string | null
  actual_cost: number | string | null
  raw_data?: unknown
  clients: { name: string } | { name: string }[] | null
}

function clientName(value: ShipmentRow['clients']): string | null {
  if (!value) return null
  if (Array.isArray(value)) return value[0]?.name ?? null
  return value.name
}

function asNumber(value: number | string | null): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

async function getOrderPnl() {
  // Read-only. actual_cost is the ShipStation label cost the sync already
  // stored. This page does not call ShipStation and does not write a rate.
  const shipmentsRes = await readAllPages<ShipmentRow>((from, to) =>
    supabaseAdmin
      .from('shipments')
      .select('id, client_id, order_number, ship_date, tracking_number, client_rate, actual_cost, raw_data, clients(name)')
      .order('ship_date', { ascending: false })
      .order('id')
      .range(from, to))

  const shipmentsRead = read('shipments', shipmentsRes)
  return loaded(readErrors(shipmentsRead), () => {
    const rows: ShipmentMoney[] = withoutVoided(shipmentsRead.rows).map((row) => ({
      id: row.id,
      clientId: row.client_id,
      clientName: clientName(row.clients),
      orderNumber: row.order_number,
      shipDate: row.ship_date,
      raw: row.raw_data,
      trackingNumber: row.tracking_number,
      clientRate: asNumber(row.client_rate),
      actualCost: asNumber(row.actual_cost),
    }))
    return { orders: rollupOrders(rows) }
  })
}

function Header() {
  return (
    <div>
      <h2 className="text-2xl font-bold text-[#0B1220]">Order profit and loss</h2>
      <p className="text-[#4B4F58] text-sm mt-1">
        Stored rate-card price minus the stored ShipStation label cost, per order and per client. This is not company net profit: pick, warehouse, manual, and operating costs are not subtracted. A missing price or cost stays blank. This screen does not change a rate.
      </p>
    </div>
  )
}

export default async function OrderPnlPage() {
  const page = await getOrderPnl()
  if (!page.ok) {
    return (
      <div className="space-y-6">
        <Header />
        <ViewUnreadable message={page.error} />
      </div>
    )
  }
  const data: LoadedData<typeof page> = page.data
  return (
    <div className="space-y-6">
      <Header />
      <OrderPnlView orders={data.orders} />
    </div>
  )
}
