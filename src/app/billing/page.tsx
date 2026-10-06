import { supabaseAdmin } from '@/lib/supabase'
import { read, readErrors, loaded, type LoadedData } from '@/lib/db/read'
import ViewUnreadable from '@/components/ui/ViewUnreadable'
import BillingView from '@/components/billing/BillingView'

// This screen's output is an invoice. BillingView composes all five reads into
// one per-client grand total -- shipments + warehouse lines + adjustments,
// checked against the bills already generated -- so a read that failed and came
// back `[]` does not make the page emptier, it makes the invoice SHORTER by an
// unknown amount, with nothing on screen to say so.
//
// So the whole page refuses rather than degrading section by section. A partial
// render is defensible on a dashboard; it is not defensible here. Composing a
// bill from a database that is answering some questions and not others produces
// a number that looks finished and is under-billed, and it gets sent.

async function getBillingData() {
  const now = new Date()
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0]
  const today = now.toISOString().split('T')[0]

  const [clientsRes, shipmentsRes, warehouseRes, adjustmentsRes, billsRes] = await Promise.all([
    supabaseAdmin.from('clients').select('id, name').eq('active', true).order('name'),
    supabaseAdmin.from('shipments')
      .select('client_id, order_number, ship_date, carrier, service, actual_cost, client_rate, profit_loss, is_loss')
      .order('ship_date', { ascending: false }),
    supabaseAdmin.from('warehouse_daily_log')
      .select('client_id, log_date, service_type, quantity, rate, total, notes')
      .order('log_date', { ascending: false }),
    supabaseAdmin.from('rate_adjustments')
      .select('client_id, order_number, adjustment_amount, reason, adjustment_date, status')
      .order('adjustment_date', { ascending: false }),
    supabaseAdmin.from('bills')
      .select('client_id, week_start, week_end, shipping_total, warehouse_total, adjustments_total, manual_total, grand_total, status')
      .order('week_start', { ascending: false }),
  ])

  const clients = read('clients', clientsRes)
  const shipments = read('shipments', shipmentsRes)
  const warehouse = read('warehouse_daily_log', warehouseRes)
  const adjustments = read('rate_adjustments', adjustmentsRes)
  const bills = read('bills', billsRes)

  return loaded(
    readErrors(clients, shipments, warehouse, adjustments, bills),
    () => ({
      clients: clients.rows,
      shipments: shipments.rows,
      warehouse: warehouse.rows,
      adjustments: adjustments.rows,
      bills: bills.rows,
      defaultFrom: monthStart,
      defaultTo: today,
    }),
  )
}

function Header() {
  return (
    <div>
      <h2 className="text-2xl font-bold text-white">Billing</h2>
      <p className="text-gray-400 text-sm mt-1">Full billing breakdown per client — shipments, warehouse, adjustments</p>
    </div>
  )
}

export default async function BillingPage() {
  const billing = await getBillingData()

  if (!billing.ok) {
    return (
      <div className="space-y-6">
        <Header />
        <ViewUnreadable message={billing.error} />
      </div>
    )
  }

  // Annotated, not inferred. BillingView's prop used to be `data: any`, which
  // accepted `BillingData | undefined` silently, so the refusal above was not a
  // gate on its own -- this local was. The prop is now typed, so there are two
  // independent gates; the annotation stays because it fails nearer the cause
  // (TS2322 here, naming this read) and because it keeps holding if the
  // component's prop ever loosens again.
  const data: LoadedData<typeof billing> = billing.data

  return (
    <div className="space-y-6">
      <Header />
      <BillingView data={data} />
    </div>
  )
}
