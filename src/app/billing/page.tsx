import { supabaseAdmin } from '@/lib/supabase'
import BillingView from '@/components/billing/BillingView'

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

  return {
    clients: clientsRes.data ?? [],
    shipments: shipmentsRes.data ?? [],
    warehouse: warehouseRes.data ?? [],
    adjustments: adjustmentsRes.data ?? [],
    bills: billsRes.data ?? [],
    defaultFrom: monthStart,
    defaultTo: today,
  }
}

export default async function BillingPage() {
  const data = await getBillingData()
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-white">Billing</h2>
        <p className="text-gray-400 text-sm mt-1">Full billing breakdown per client — shipments, warehouse, adjustments</p>
      </div>
      <BillingView data={data} />
    </div>
  )
}
