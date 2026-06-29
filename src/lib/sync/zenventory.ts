import { supabaseAdmin } from '@/lib/supabase'
import { getCustomerOrders } from '@/lib/api/zenventory'

/**
 * Uses ONE global Zenventory account (ZENVENTORY_API_KEY / ZENVENTORY_API_SECRET)
 * that contains all client orders. Matches orders to clients by company name.
 */
export async function buildOrderClientMap(daysBack = 30): Promise<Map<string, string>> {
  const map = new Map<string, string>()

  const apiKey    = process.env.ZENVENTORY_API_KEY    ?? ''
  const apiSecret = process.env.ZENVENTORY_API_SECRET ?? ''

  if (!apiKey || !apiSecret) {
    throw new Error(
      'ZENVENTORY_API_KEY and ZENVENTORY_API_SECRET are not set. ' +
      'Add them to your Vercel environment variables.'
    )
  }

  const modifiedFrom = new Date()
  modifiedFrom.setDate(modifiedFrom.getDate() - daysBack)
  const modifiedFromISO = modifiedFrom.toISOString()

  // Load all active clients for name-matching
  const { data: clients } = await supabaseAdmin
    .from('clients')
    .select('id, name')
    .eq('active', true)

  if (!clients?.length) throw new Error('No active clients found in the database')

  let page = 1
  let hasMore = true

  while (hasMore) {
    const data = await getCustomerOrders(apiKey, apiSecret, {
      page,
      perPage: 100,
      modifiedFrom: modifiedFromISO,
    })

    const orders = data.customerOrders ?? data.orders ?? []
    const meta   = data.meta ?? {}

    for (const order of orders) {
      const orderNumber = String(order.orderNumber ?? order.order_number ?? '')
      const company     = order.customer?.company || order.customer?.name || ''
      if (!orderNumber || !company) continue

      // Match company name to a client (case-insensitive, partial match)
      const matched = clients.find(c =>
        c.name.toLowerCase() === company.toLowerCase() ||
        company.toLowerCase().includes(c.name.toLowerCase()) ||
        c.name.toLowerCase().includes(company.toLowerCase())
      )
      if (matched) map.set(orderNumber, matched.id)
    }

    hasMore = page < (meta.totalPages ?? meta.total_pages ?? 1)
    page++
  }

  return map
}

/** Sync Zenventory orders → update client_id on matching shipments */
export async function syncClientAssignments(daysBack = 30) {
  const orderClientMap = await buildOrderClientMap(daysBack)
  let updated = 0
  let skipped = 0

  for (const [orderNumber, clientId] of orderClientMap.entries()) {
    const { data: shipment } = await supabaseAdmin
      .from('shipments')
      .select('id, client_id')
      .eq('order_number', orderNumber)
      .maybeSingle()

    if (!shipment)                          { skipped++; continue }
    if (shipment.client_id === clientId)    { skipped++; continue }

    await supabaseAdmin
      .from('shipments')
      .update({ client_id: clientId })
      .eq('id', shipment.id)

    updated++
  }

  return { mapped: orderClientMap.size, updated, skipped }
}
