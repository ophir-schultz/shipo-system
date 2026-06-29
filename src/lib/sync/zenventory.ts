import { supabaseAdmin } from '@/lib/supabase'
import { getCustomerOrders } from '@/lib/api/zenventory'

/**
 * Builds a map of orderNumber → clientId by pulling orders from each
 * client's own Zenventory account using their stored API credentials.
 */
export async function buildOrderClientMap(daysBack = 30): Promise<Map<string, string>> {
  const map = new Map<string, string>()

  const modifiedFrom = new Date()
  modifiedFrom.setDate(modifiedFrom.getDate() - daysBack)
  const modifiedFromISO = modifiedFrom.toISOString()

  // Load all active clients that have Zenventory credentials
  const { data: clients } = await supabaseAdmin
    .from('clients')
    .select('id, name, zenventory_api_key, zenventory_api_secret')
    .eq('active', true)
    .not('zenventory_api_key', 'is', null)

  if (!clients?.length) {
    throw new Error('No active clients have Zenventory credentials configured. Add credentials on the client page.')
  }

  const clientErrors: string[] = []

  for (const client of clients) {
    if (!client.zenventory_api_key || !client.zenventory_api_secret) continue

    let page = 1
    let hasMore = true
    let clientOrderCount = 0

    while (hasMore) {
      let data: any
      try {
        data = await getCustomerOrders(client.zenventory_api_key, client.zenventory_api_secret, {
          page,
          perPage: 100,
          modifiedFrom: modifiedFromISO,
        })
      } catch (err: any) {
        clientErrors.push(`${client.name}: ${err.message}`)
        hasMore = false
        break
      }

      const orders = data.customerOrders ?? data.orders ?? []
      const meta = data.meta ?? {}

      for (const order of orders) {
        const orderNumber = String(order.orderNumber ?? order.order_number ?? '')
        if (!orderNumber) continue
        map.set(orderNumber, client.id)
        clientOrderCount++
      }

      hasMore = page < (meta.totalPages ?? meta.total_pages ?? 1)
      page++
    }
  }

  // If every client failed, surface the errors
  if (clientErrors.length > 0 && map.size === 0) {
    throw new Error(`Zenventory API failed for all clients:\n${clientErrors.join('\n')}`)
  }

  return map
}

/** Sync Zenventory orders → update client assignments on shipments */
export async function syncClientAssignments(daysBack = 30) {
  const orderClientMap = await buildOrderClientMap(daysBack)
  let updated = 0
  let skipped = 0

  for (const [orderNumber, clientId] of orderClientMap.entries()) {
    const { data: shipment } = await supabaseAdmin
      .from('shipments')
      .select('id, client_id, actual_cost, weight, dim_weight, billed_weight, carrier, service')
      .eq('order_number', orderNumber)
      .maybeSingle()

    if (!shipment) { skipped++; continue }
    if (shipment.client_id === clientId) { skipped++; continue }

    await supabaseAdmin
      .from('shipments')
      .update({ client_id: clientId })
      .eq('id', shipment.id)

    updated++
  }

  return { mapped: orderClientMap.size, updated, skipped }
}
