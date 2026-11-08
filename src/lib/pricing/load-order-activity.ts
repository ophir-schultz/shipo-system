import { supabaseAdmin } from '@/lib/supabase'
import { readAllPages } from '@/lib/db/page'
import { priceOf } from '@/lib/billing/unpriced'
import { parsePriceList } from '@/lib/pricing/parse-price-list'
import { loadRepoPriceList } from '@/lib/pricing/repo-price-lists'
import {
  buildOrderActivity,
  type ActivityLine,
  type ActivityOrder,
  type ActivityParcel,
  type ActivitySerial,
  type ActivityShippingCharge,
  type OrderActivity,
} from '@/lib/pricing/order-activity'
import type { PriceListDocument } from '@/lib/pricing/types'
import { assignScanFlags } from '@/lib/pricing/scan-catalog'
import { loadScanCatalog } from '@/lib/pricing/load-scan-catalog'

const CHUNK = 150

async function priceListFor(clientId: string, clientName: string): Promise<PriceListDocument | null> {
  const uploaded = await supabaseAdmin
    .from('client_price_lists')
    .select('document')
    .eq('client_id', clientId)
    .order('created_at', { ascending: false })
    .limit(1)
  if (!uploaded.error) {
    const document = uploaded.data?.[0]?.document
    if (document) {
      const parsed = parsePriceList(document)
      if (parsed.ok) return parsed.list
    }
  }
  return loadRepoPriceList(clientName).list
}

export async function loadOrderActivity(
  clientId: string,
  clientName: string,
  from: string,
  to: string,
): Promise<{ activity: OrderActivity | null; error: string | null }> {
  const [ordersRes, parcelsRes, chargesRes, serialRes] = await Promise.all([
    readAllPages<{ id: string; order_number: string | null }>((start, end) => supabaseAdmin
      .from('orders')
      .select('id, order_number')
      .eq('client_id', clientId)
      .order('id')
      .range(start, end)),
    readAllPages<{
      id: string
      order_number: string | null
      ship_date: string | null
      raw_data: unknown
      recipient_name: string | null
      tracking_number: string | null
      zone: string | number | null
      recipient_zip: string | null
      weight: number | string | null
      billed_weight: number | string | null
      client_rate: number | string | null
      shipstation_shipment_id: number | string | null
    }>((start, end) => supabaseAdmin
      .from('shipments')
      .select('id, order_number, ship_date, raw_data, recipient_name, tracking_number, zone, recipient_zip, weight, billed_weight, client_rate, shipstation_shipment_id')
      .eq('client_id', clientId)
      .order('id')
      .range(start, end)),
    readAllPages<{ charge_key: string | null; amount: unknown; unit_rate: unknown }>((start, end) => supabaseAdmin
      .from('order_charges')
      .select('charge_key, amount, unit_rate')
      .eq('client_id', clientId)
      .eq('charge_type', 'shipping')
      .order('id')
      .range(start, end)),
    readAllPages<{ serial: string | null; scan_events: { order_ref?: string | null; sku?: string | null } | { order_ref?: string | null; sku?: string | null }[] | null }>((start, end) => supabaseAdmin
      .from('scanned_serials')
      .select('serial, scan_events!inner(order_ref, sku)')
      .eq('scan_events.client_id', clientId)
      .order('id')
      .range(start, end)),
  ])
  const failed = [ordersRes.error, parcelsRes.error, chargesRes.error].find(Boolean)
  if (failed) return { activity: null, error: failed.message }

  const orderRows = ordersRes.data ?? []
  const items: { order_id: string | null; sku: string | null; quantity_ordered: unknown; quantity_picked: unknown }[] = []
  for (let i = 0; i < orderRows.length; i += CHUNK) {
    const ids = orderRows.slice(i, i + CHUNK).map((order) => order.id)
    const page = await readAllPages<typeof items[number]>((start, end) => supabaseAdmin
      .from('order_items')
      .select('order_id, sku, quantity_ordered, quantity_picked')
      .in('order_id', ids)
      .order('id')
      .range(start, end))
    if (page.error) return { activity: null, error: page.error.message }
    items.push(...(page.data ?? []))
  }

  const linesByOrder = new Map<string, ActivityLine[]>()
  for (const item of items) {
    if (!item.order_id) continue
    const picked = priceOf(item.quantity_picked)
    const ordered = priceOf(item.quantity_ordered)
    const qty = picked != null && picked > 0 ? picked : ordered
    if (qty == null || qty <= 0) continue
    const list = linesByOrder.get(item.order_id) ?? []
    list.push({ sku: item.sku ?? '', qty, scannable: null })
    linesByOrder.set(item.order_id, list)
  }

  const orders: ActivityOrder[] = orderRows.map((order) => ({
    id: order.id,
    orderNumber: order.order_number ?? '',
    lines: linesByOrder.get(order.id) ?? [],
  }))

  const parcels: ActivityParcel[] = (parcelsRes.data ?? []).map((row) => ({
    id: row.id,
    orderNumber: row.order_number ?? '',
    shipDate: row.ship_date,
    raw: row.raw_data,
    recipientName: row.recipient_name ?? '',
    trackingNumber: row.tracking_number ?? '',
    zone: row.zone == null ? '' : String(row.zone),
    zipcode: row.recipient_zip ?? '',
    weight: row.weight == null ? '' : String(row.weight),
    volumeWeight: row.billed_weight == null ? '' : String(row.billed_weight),
    storedRate: priceOf(row.client_rate),
    shipmentKey: row.shipstation_shipment_id == null || row.shipstation_shipment_id === ''
      ? null
      : `shipment:${row.shipstation_shipment_id}`,
  }))

  const charges: ActivityShippingCharge[] = (chargesRes.data ?? []).flatMap((row) => {
    const key = row.charge_key ?? ''
    if (!key) return []
    return [{ chargeKey: key, amount: priceOf(row.amount), unitRate: priceOf(row.unit_rate) }]
  })

  const serials: ActivitySerial[] = []
  if (!serialRes.error) {
    for (const row of serialRes.data ?? []) {
      const event = Array.isArray(row.scan_events) ? row.scan_events[0] : row.scan_events
      const serial = row.serial?.trim() ?? ''
      if (!event?.order_ref || !serial) continue
      serials.push({ orderNumber: event.order_ref, sku: event.sku ?? null, serial })
    }
  }

  const list = await priceListFor(clientId, clientName)
  let scanNote = ''
  if (list?.devicePick && list.accessoryPick && !list.orderPick) {
    const scan = await loadScanCatalog(clientName)
    scanNote = scan.note
    if (scan.ok) {
      for (const order of orders) assignScanFlags(order.lines, scan.bySku)
    }
  }
  return {
    activity: buildOrderActivity({ clientId, from, to, list, orders, parcels, charges, serials, scanNote }),
    error: null,
  }
}
