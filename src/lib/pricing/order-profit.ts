// Profit per order and per client.
//
// Client price is what we bill. ShipStation cost is shipments.actual_cost,
// which the existing ShipStation sync writes and this module only reads.
// A missing rate or a missing cost is null. It is not zero, and it is not
// dropped into a sum that then looks finished.

import { money } from './engine'

export interface ShipmentMoney {
  id: string
  clientId: string | null
  clientName: string | null
  orderNumber: string
  shipDate: string | null
  trackingNumber: string | null
  /** What the client is charged for this label. Null when it has not been priced. */
  clientRate: number | null
  /** What ShipStation charged us. Null when the cost has not been recorded. */
  actualCost: number | null
}

export interface OrderProfit {
  key: string
  orderNumber: string
  clientId: string | null
  clientName: string
  shipDate: string | null
  shipments: number
  clientPrice: number | null
  shipstationCost: number | null
  profit: number | null
}

export interface ClientProfit {
  clientId: string | null
  clientName: string
  orders: number
  pricedOrders: number
  unpricedOrders: number
  clientPrice: number | null
  shipstationCost: number | null
  profit: number | null
}

function num(value: number | null): number | null {
  if (value === null || value === undefined) return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

export function rollupOrders(rows: ShipmentMoney[]): OrderProfit[] {
  const groups = new Map<string, ShipmentMoney[]>()
  for (const row of rows) {
    const key = `${row.clientId ?? 'unassigned'}\0${row.orderNumber}`
    const list = groups.get(key)
    if (list) list.push(row)
    else groups.set(key, [row])
  }

  const orders: OrderProfit[] = []
  for (const [key, shipments] of groups) {
    let priceCents = 0
    let costCents = 0
    let priceKnown = true
    let costKnown = true
    let shipDate: string | null = null
    for (const shipment of shipments) {
      const price = num(shipment.clientRate)
      const cost = num(shipment.actualCost)
      if (price === null) priceKnown = false
      else priceCents += Math.round(price * 100)
      if (cost === null) costKnown = false
      else costCents += Math.round(cost * 100)
      if (shipment.shipDate && (shipDate === null || shipment.shipDate < shipDate)) {
        shipDate = shipment.shipDate
      }
    }
    const clientPrice = priceKnown ? money(priceCents / 100) : null
    const shipstationCost = costKnown ? money(costCents / 100) : null
    const first = shipments[0]
    orders.push({
      key,
      orderNumber: first.orderNumber,
      clientId: first.clientId,
      clientName: first.clientName ?? 'Unassigned',
      shipDate: shipDate?.slice(0, 10) ?? null,
      shipments: shipments.length,
      clientPrice,
      shipstationCost,
      profit: clientPrice === null || shipstationCost === null
        ? null
        : money(clientPrice - shipstationCost),
    })
  }

  orders.sort((a, b) => (b.shipDate ?? '').localeCompare(a.shipDate ?? '') || a.orderNumber.localeCompare(b.orderNumber))
  return orders
}

export function rollupClients(orders: OrderProfit[]): ClientProfit[] {
  const groups = new Map<string, OrderProfit[]>()
  for (const order of orders) {
    const key = order.clientId ?? 'unassigned'
    const list = groups.get(key)
    if (list) list.push(order)
    else groups.set(key, [order])
  }

  const clients: ClientProfit[] = []
  for (const group of groups.values()) {
    const priced = group.filter((order) => order.profit !== null)
    let priceCents = 0
    let costCents = 0
    for (const order of priced) {
      priceCents += Math.round((order.clientPrice ?? 0) * 100)
      costCents += Math.round((order.shipstationCost ?? 0) * 100)
    }
    const first = group[0]
    const clientPrice = priced.length === 0 ? null : money(priceCents / 100)
    const shipstationCost = priced.length === 0 ? null : money(costCents / 100)
    clients.push({
      clientId: first.clientId,
      clientName: first.clientName,
      orders: group.length,
      pricedOrders: priced.length,
      unpricedOrders: group.length - priced.length,
      clientPrice,
      shipstationCost,
      profit: clientPrice === null || shipstationCost === null
        ? null
        : money(clientPrice - shipstationCost),
    })
  }

  clients.sort((a, b) => (b.profit ?? Number.NEGATIVE_INFINITY) - (a.profit ?? Number.NEGATIVE_INFINITY))
  return clients
}
