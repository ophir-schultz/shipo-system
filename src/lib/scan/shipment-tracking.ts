import { supabaseAdmin } from '@/lib/supabase'
import { readAllPages } from '@/lib/db/page'

// Tracking lives on shipments, written by the ShipStation sync. The
// Zenventory customer-order pick does not carry a label number, and this
// read does not write one back.

export async function shipmentTrackingByOrder(): Promise<{
  byOrder: Record<string, string[]>
  error: string | null
}> {
  const loaded = await readAllPages<{ order_number: string | null; tracking_number: string | null }>((from, to) => supabaseAdmin
    .from('shipments')
    .select('order_number, tracking_number')
    .order('id')
    .range(from, to))
  if (loaded.error) return { byOrder: {}, error: loaded.error.message }
  const byOrder: Record<string, string[]> = {}
  for (const row of loaded.data ?? []) {
    const order = (row.order_number ?? '').trim()
    const tracking = (row.tracking_number ?? '').trim()
    if (!order || !tracking) continue
    const list = byOrder[order] ?? []
    if (!list.includes(tracking)) list.push(tracking)
    byOrder[order] = list
  }
  return { byOrder, error: null }
}
