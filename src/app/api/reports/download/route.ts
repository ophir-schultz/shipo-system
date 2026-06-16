import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import * as XLSX from 'xlsx'

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const type = searchParams.get('type')
  const dateFrom = searchParams.get('dateFrom')
  const dateTo = searchParams.get('dateTo')
  const clientId = searchParams.get('clientId')

  let rows: any[] = []
  let sheetName = 'Report'

  const clientFilter = (q: any) => clientId ? q.eq('client_id', clientId) : q

  if (type === 'shipments') {
    sheetName = 'Shipments'
    let q = supabaseAdmin
      .from('shipments')
      .select('order_number, clients(name), ship_date, carrier, service, tracking_number, recipient_name, recipient_city, recipient_state, weight, actual_cost, client_rate, profit_loss, is_loss, source')
      .gte('ship_date', dateFrom!)
      .lte('ship_date', dateTo!)
      .order('ship_date', { ascending: false })
    if (clientId) q = q.eq('client_id', clientId)
    const { data } = await q
    rows = (data ?? []).map((s: any) => ({
      'Order #': s.order_number,
      'Client': s.clients?.name ?? '',
      'Ship Date': s.ship_date,
      'Carrier': s.carrier,
      'Service': s.service,
      'Tracking': s.tracking_number,
      'Recipient': s.recipient_name,
      'City': s.recipient_city,
      'State': s.recipient_state,
      'Weight (oz)': s.weight,
      'Carrier Cost ($)': s.actual_cost,
      'Client Rate ($)': s.client_rate,
      'Profit/Loss ($)': s.profit_loss,
      'Loss?': s.is_loss ? 'YES' : 'No',
      'Source': s.source,
    }))
  }

  else if (type === 'profit-loss') {
    sheetName = 'Profit & Loss'
    let q = supabaseAdmin
      .from('shipments')
      .select('clients(name), ship_date, actual_cost, client_rate, profit_loss, is_loss')
      .gte('ship_date', dateFrom!)
      .lte('ship_date', dateTo!)
    if (clientId) q = q.eq('client_id', clientId)
    const { data } = await q
    const byClient: Record<string, any> = {}
    for (const s of data ?? []) {
      const name = (s.clients as any)?.name ?? 'Unknown'
      if (!byClient[name]) byClient[name] = { revenue: 0, cost: 0, profit: 0, shipments: 0, losses: 0 }
      byClient[name].revenue += s.client_rate ?? 0
      byClient[name].cost += s.actual_cost ?? 0
      byClient[name].profit += s.profit_loss ?? 0
      byClient[name].shipments++
      if (s.is_loss) byClient[name].losses++
    }
    rows = Object.entries(byClient).map(([name, d]) => ({
      'Client': name,
      'Total Shipments': d.shipments,
      'Loss Shipments': d.losses,
      'Total Revenue ($)': d.revenue.toFixed(2),
      'Total Carrier Cost ($)': d.cost.toFixed(2),
      'Net Profit/Loss ($)': d.profit.toFixed(2),
      'Margin %': d.revenue > 0 ? ((d.profit / d.revenue) * 100).toFixed(1) + '%' : '0%',
    }))
  }

  else if (type === 'loss-shipments') {
    sheetName = 'Loss Shipments'
    let q = supabaseAdmin
      .from('shipments')
      .select('order_number, clients(name), ship_date, carrier, service, tracking_number, recipient_name, actual_cost, client_rate, profit_loss')
      .eq('is_loss', true)
      .gte('ship_date', dateFrom!)
      .lte('ship_date', dateTo!)
      .order('profit_loss', { ascending: true })
    if (clientId) q = q.eq('client_id', clientId)
    const { data } = await q
    rows = (data ?? []).map((s: any) => ({
      'Order #': s.order_number,
      'Client': s.clients?.name ?? '',
      'Ship Date': s.ship_date,
      'Carrier': s.carrier,
      'Service': s.service,
      'Recipient': s.recipient_name,
      'Carrier Cost ($)': s.actual_cost,
      'Client Rate ($)': s.client_rate,
      'Loss Amount ($)': Math.abs(s.profit_loss ?? 0).toFixed(2),
    }))
  }

  else if (type === 'adjustments') {
    sheetName = 'Rate Adjustments'
    let q = supabaseAdmin
      .from('rate_adjustments')
      .select('order_number, clients(name), original_cost, adjusted_cost, adjustment_amount, reason, adjustment_date, status, billed_to_client')
      .gte('adjustment_date', dateFrom!)
      .lte('adjustment_date', dateTo!)
      .order('adjustment_date', { ascending: false })
    if (clientId) q = q.eq('client_id', clientId)
    const { data } = await q
    rows = (data ?? []).map((a: any) => ({
      'Order #': a.order_number,
      'Client': a.clients?.name ?? '',
      'Adjustment Date': a.adjustment_date,
      'Original Cost ($)': a.original_cost,
      'Adjusted Cost ($)': a.adjusted_cost,
      'Adjustment Amount ($)': a.adjustment_amount,
      'Reason': a.reason,
      'Status': a.status,
      'Billed to Client': a.billed_to_client ? 'Yes' : 'No',
    }))
  }

  else if (type === 'billing') {
    sheetName = 'Billing'
    let q = supabaseAdmin
      .from('bills')
      .select('clients(name), week_start, week_end, shipping_total, warehouse_total, adjustments_total, manual_charges_total, grand_total, status')
      .gte('week_start', dateFrom!)
      .lte('week_end', dateTo!)
      .order('week_start', { ascending: false })
    if (clientId) q = q.eq('client_id', clientId)
    const { data } = await q
    rows = (data ?? []).map((b: any) => ({
      'Client': b.clients?.name ?? '',
      'Week Start': b.week_start,
      'Week End': b.week_end,
      'Shipping ($)': b.shipping_total,
      'Warehouse ($)': b.warehouse_total,
      'Adjustments ($)': b.adjustments_total,
      'Manual Charges ($)': b.manual_charges_total,
      'Grand Total ($)': b.grand_total,
      'Status': b.status,
    }))
  }

  else if (type === 'warehouse') {
    sheetName = 'Warehouse Activity'
    let q = supabaseAdmin
      .from('warehouse_daily_log')
      .select('clients(name), log_date, service_type, quantity, rate, total, notes')
      .gte('log_date', dateFrom!)
      .lte('log_date', dateTo!)
      .order('log_date', { ascending: false })
    if (clientId) q = q.eq('client_id', clientId)
    const { data } = await q
    rows = (data ?? []).map((w: any) => ({
      'Client': w.clients?.name ?? '',
      'Date': w.log_date,
      'Service': w.service_type?.replace(/_/g, ' '),
      'Quantity': w.quantity,
      'Rate ($)': w.rate,
      'Total ($)': w.total,
      'Notes': w.notes ?? '',
    }))
  }

  if (rows.length === 0) rows = [{ 'No Data': 'No records found for the selected period' }]

  const wb = XLSX.utils.book_new()
  const ws = XLSX.utils.json_to_sheet(rows)

  // Auto column widths
  const colWidths = Object.keys(rows[0]).map(k => ({ wch: Math.max(k.length, 15) }))
  ws['!cols'] = colWidths

  XLSX.utils.book_append_sheet(wb, ws, sheetName)
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })

  return new NextResponse(buf, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${type}-report.xlsx"`,
    },
  })
}
