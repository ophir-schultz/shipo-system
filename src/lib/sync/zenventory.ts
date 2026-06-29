import { supabaseAdmin } from '@/lib/supabase'
import { getCustomerOrders } from '@/lib/api/zenventory'

/**
 * Each client has their own Zenventory account.
 * We pull orders from each client's API key — every order returned belongs to that client.
 * No name-matching needed.
 */
export async function syncClientAssignments(daysBack = 30) {
  // Load all active clients that have Zenventory credentials
  const { data: clients } = await supabaseAdmin
    .from('clients')
    .select('id, name, zenventory_api_key, zenventory_api_secret')
    .eq('active', true)
    .not('zenventory_api_key', 'is', null)
    .not('zenventory_api_secret', 'is', null)

  if (!clients?.length) {
    throw new Error('No active clients have Zenventory credentials. Add API keys on each client\'s page.')
  }

  const modifiedFrom = new Date()
  modifiedFrom.setDate(modifiedFrom.getDate() - daysBack)
  const modifiedFromISO = modifiedFrom.toISOString()

  let totalMapped = 0
  let totalUpdated = 0
  let totalSkipped = 0
  const clientErrors: string[] = []

  for (const client of clients) {
    let page = 1
    let hasMore = true
    const orderNumbers: string[] = []

    // Pull all orders from this client's Zenventory account
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
        if (orderNumber) orderNumbers.push(orderNumber)
      }

      hasMore = page < (meta.totalPages ?? meta.total_pages ?? 1)
      page++
    }

    totalMapped += orderNumbers.length

    // Assign each order's shipment to this client
    for (const orderNumber of orderNumbers) {
      const { data: shipment } = await supabaseAdmin
        .from('shipments')
        .select('id, client_id')
        .eq('order_number', orderNumber)
        .maybeSingle()

      if (!shipment) { totalSkipped++; continue }
      if (shipment.client_id === client.id) { totalSkipped++; continue }

      await supabaseAdmin
        .from('shipments')
        .update({ client_id: client.id })
        .eq('id', shipment.id)

      totalUpdated++
    }
  }

  // If every client with credentials failed, surface errors
  if (clientErrors.length === clients.length) {
    throw new Error(`Zenventory sync failed for all clients:\n${clientErrors.join('\n')}`)
  }

  return {
    clients_synced: clients.length - clientErrors.length,
    mapped: totalMapped,
    updated: totalUpdated,
    skipped: totalSkipped,
    errors: clientErrors,
  }
}
