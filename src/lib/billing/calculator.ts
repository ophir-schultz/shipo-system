import { supabaseAdmin } from '@/lib/supabase'
import { resolveZone, resolveZoneRate } from '@/lib/billing/zones'

export async function calculateShipmentProfitLoss(
  clientId: string,
  carrier: string,
  service: string,
  weight: number,
  actualCost: number,
  shipment?: { recipient_zip?: string | null; raw_data?: unknown; zone?: number | null },
  originZip?: string | null
): Promise<{ clientRate: number; profitLoss: number; isLoss: boolean; zone: number | null }> {
  let clientRate = 0
  let zone: number | null = null

  // 1. Prefer the zone-based rate matrix when a zone can be resolved
  if (shipment) {
    zone = await resolveZone(shipment, originZip)
    if (zone != null) {
      const zoneRate = await resolveZoneRate(clientId, carrier, service, weight, zone)
      if (zoneRate != null) clientRate = zoneRate
    }
  }

  // 2. Fall back to the legacy carrier/service weight-range rate card
  if (clientRate === 0) {
    const { data: rate } = await supabaseAdmin
      .from('client_shipping_rates')
      .select('rate')
      .eq('client_id', clientId)
      .eq('carrier', carrier)
      .eq('service', service)
      .lte('weight_min', weight)
      .or(`weight_max.is.null,weight_max.gte.${weight}`)
      .maybeSingle()
    if (rate?.rate != null) clientRate = Number(rate.rate)
  }

  const profitLoss = clientRate - actualCost
  return { clientRate, profitLoss, isLoss: profitLoss < 0, zone }
}

export async function generateWeeklyBill(clientId: string, weekStart: string, weekEnd: string) {
  const [shipmentsRes, warehouseRes, adjustmentsRes, manualRes] = await Promise.all([
    supabaseAdmin
      .from('shipments')
      .select('client_rate, profit_loss')
      .eq('client_id', clientId)
      .gte('ship_date', weekStart)
      .lte('ship_date', weekEnd),
    supabaseAdmin
      .from('warehouse_daily_log')
      .select('total')
      .eq('client_id', clientId)
      .gte('log_date', weekStart)
      .lte('log_date', weekEnd),
    supabaseAdmin
      .from('rate_adjustments')
      .select('adjustment_amount')
      .eq('client_id', clientId)
      .eq('status', 'approved')
      .gte('adjustment_date', weekStart)
      .lte('adjustment_date', weekEnd),
    supabaseAdmin
      .from('manual_charges')
      .select('amount')
      .eq('client_id', clientId)
      .eq('approved', true)
      .gte('charge_date', weekStart)
      .lte('charge_date', weekEnd),
  ])

  const shippingTotal = (shipmentsRes.data ?? []).reduce((s, r) => s + (r.client_rate ?? 0), 0)
  const warehouseTotal = (warehouseRes.data ?? []).reduce((s, r) => s + (r.total ?? 0), 0)
  const adjustmentsTotal = (adjustmentsRes.data ?? []).reduce((s, r) => s + (r.adjustment_amount ?? 0), 0)
  const manualTotal = (manualRes.data ?? []).reduce((s, r) => s + (r.amount ?? 0), 0)
  const grandTotal = shippingTotal + warehouseTotal + adjustmentsTotal + manualTotal

  const { data: bill } = await supabaseAdmin
    .from('bills')
    .insert({
      client_id: clientId,
      week_start: weekStart,
      week_end: weekEnd,
      shipping_total: shippingTotal,
      warehouse_total: warehouseTotal,
      adjustments_total: adjustmentsTotal,
      manual_charges_total: manualTotal,
      grand_total: grandTotal,
      status: 'draft',
    })
    .select()
    .single()

  return bill
}
