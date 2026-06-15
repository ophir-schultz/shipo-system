import { supabaseAdmin } from '@/lib/supabase'
import { getCustomerOrders } from '@/lib/api/zenventory'

// Builds a map of orderNumber -> clientId by pulling Zenventory orders
// and matching customer.company to clients table
export async function buildOrderClientMap(daysBack = 30): Promise<Map<string, string>> {
  const map = new Map<string, string>()

  const modifiedFrom = new Date()
  modifiedFrom.setDate(modifiedFrom.getDate() - daysBack)

  // Get all active clients from DB
  const { data: clients } = await supabaseAdmin
    .from('clients')
    .select('id, name')
    .eq('active', true)

  if (!clients?.length) return map

  let page = 1
  let hasMore = true

  while (hasMore) {
    const data = await getCustomerOrders({
      page,
      perPage: 100,
      modifiedFrom: modifiedFrom.toISOString(),
    })

    const orders = data.customerOrders ?? data.orders ?? []
    const meta = data.meta ?? {}

    for (const order of orders) {
      const orderNumber = String(order.orderNumber)
      const company = order.customer?.company || order.customer?.name || ''

      if (!company || !orderNumber) continue

      // Match company name to client (case insensitive, partial match)
      const matched = clients.find(c =>
        c.name.toLowerCase() === company.toLowerCase() ||
        company.toLowerCase().includes(c.name.toLowerCase()) ||
        c.name.toLowerCase().includes(company.toLowerCase())
      )

      if (matched) {
        map.set(orderNumber, matched.id)
      }
    }

    hasMore = page < (meta.totalPages ?? 1)
    page++
  }

  return map
}

// Look up the correct client rate based on billed weight, carrier, and service
async function lookupClientRate(clientId: string, shipment: any): Promise<number> {
  const billedWeightOz = shipment.billed_weight ?? shipment.weight ?? 0

  // Try to match on carrier + service + weight bracket
  const { data: rates } = await supabaseAdmin
    .from('client_shipping_rates')
    .select('rate, weight_min, weight_max, carrier, service')
    .eq('client_id', clientId)

  if (!rates?.length) return 0

  // Match by carrier+service+weight bracket first
  const carrier = (shipment.carrier ?? '').toLowerCase().replace('stamps_com', 'stamps').replace('stamps com', 'stamps')
  const service = (shipment.service ?? '').toLowerCase()

  // Find best matching rate: carrier+service+weight > weight only > first rate
  const byCarrierService = rates.filter(r =>
    (!r.carrier || r.carrier.toLowerCase().includes(carrier) || carrier.includes(r.carrier.toLowerCase())) &&
    (!r.service || r.service.toLowerCase().includes(service) || service.includes(r.service.toLowerCase()))
  )

  const pool = byCarrierService.length > 0 ? byCarrierService : rates

  // Find rate where billed weight falls within weight bracket
  const byWeight = pool.find(r =>
    (r.weight_min == null || billedWeightOz >= r.weight_min) &&
    (r.weight_max == null || billedWeightOz <= r.weight_max)
  )

  if (byWeight) return byWeight.rate

  // Fallback: closest weight bracket
  const sorted = [...pool].sort((a, b) => (a.weight_min ?? 0) - (b.weight_min ?? 0))
  return sorted[sorted.length - 1]?.rate ?? pool[0]?.rate ?? 0
}

// Sync Zenventory orders to update client assignments on shipments
export async function syncClientAssignments(daysBack = 30) {
  const orderClientMap = await buildOrderClientMap(daysBack)
  let updated = 0

  for (const [orderNumber, clientId] of orderClientMap.entries()) {
    const { data: shipment } = await supabaseAdmin
      .from('shipments')
      .select('id, client_id, actual_cost, client_rate, weight, dim_weight, billed_weight, carrier, service')
      .eq('order_number', orderNumber)
      .single()

    if (!shipment) continue
    if (shipment.client_id === clientId) continue

    const clientRate = await lookupClientRate(clientId, shipment)
    const profitLoss = parseFloat((clientRate - (shipment.actual_cost ?? 0)).toFixed(2))

    await supabaseAdmin
      .from('shipments')
      .update({
        client_id: clientId,
        client_rate: clientRate,
        profit_loss: profitLoss,
        is_loss: profitLoss < 0,
      })
      .eq('id', shipment.id)

    updated++
  }

  return { mapped: orderClientMap.size, updated }
}
