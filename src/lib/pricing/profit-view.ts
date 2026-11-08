import { periodRange } from '@/lib/billing/statement'
import { easternAddDays, easternMidnightIso } from '@/lib/ledger/eastern-day'
import { shipmentDateColumns } from '@/lib/billing/ship-day-label'
import { money } from './engine'
import {
  rollupClients,
  rollupOrders,
  type ClientProfit,
  type OrderProfit,
  type ShipmentMoney,
} from './order-profit'

// Staff profit. Price is what the client is charged. ShipStation cost is
// shipments.actual_cost. Profit is price minus that cost, and it stays
// blank when either figure is missing. This is not a client document.

export type ProfitGrain = 'day' | 'week' | 'month' | 'custom'
export type ProfitLevel = 'shipment' | 'order' | 'client'

const ISO = /^\d{4}-\d{2}-\d{2}$/

export function profitPeriod(input: {
  grain: string
  today: string
  from: string
  to: string
}): { from: string; to: string; error: string | null } {
  const from = input.from.trim()
  const to = input.to.trim()
  // The form always sends grain and the two date fields. A week left on the
  // default while the operator typed Oct 26–Nov 1 was answering "this week"
  // and ignoring the dates, so the same orders came back as 5 or as 15
  // depending on which control they had touched last. Dates that were typed
  // win. Grain is only the period when both date fields are empty.
  if (from !== '' || to !== '' || input.grain === 'custom') {
    if (!ISO.test(from) || !ISO.test(to) || from > to) {
      return { from: '', to: '', error: 'A custom range needs two dates, with from on or before to.' }
    }
    return { from, to, error: null }
  }
  if (input.grain !== 'day' && input.grain !== 'week' && input.grain !== 'month') {
    return { from: '', to: '', error: 'Period must be day, week, month, or custom.' }
  }
  const range = periodRange(input.grain, input.today)
  return { from: range.from, to: range.to, error: null }
}

/** Inclusive Eastern dates as a timestamptz window. The end is the next midnight. */
export function profitInstants(from: string, to: string): { start: string; end: string } {
  return {
    start: easternMidnightIso(from),
    end: easternMidnightIso(easternAddDays(to, 1)),
  }
}

function moneyText(value: number | null): string {
  return value === null ? '' : value.toFixed(2)
}

function lineProfit(price: number | null, cost: number | null): number | null {
  if (price === null || cost === null) return null
  return money(price - cost)
}

export function shipmentProfitRows(rows: ShipmentMoney[]): Array<Record<string, string>> {
  return rows.map((row) => {
    const dates = shipmentDateColumns(row.shipDate, row.raw)
    return {
      Date: dates['Ship Date'],
      'Stored ship day': dates['Stored ship day'],
      Client: row.clientName ?? '',
      Order: row.orderNumber,
      Tracking: row.trackingNumber ?? '',
      'Price ($)': moneyText(row.clientRate),
      'ShipStation cost ($)': moneyText(row.actualCost),
      'Profit ($)': moneyText(lineProfit(row.clientRate, row.actualCost)),
    }
  })
}

export function orderProfitRows(orders: OrderProfit[]): Array<Record<string, string>> {
  return orders.map((order) => ({
    Date: order.carrierShipDate ?? '',
    'Stored ship day': order.carrierShipDate && order.shipDate && order.carrierShipDate !== order.shipDate
      ? order.shipDate
      : '',
    Client: order.clientName,
    Order: order.orderNumber,
    Shipments: String(order.shipments),
    'Price ($)': moneyText(order.clientPrice),
    'ShipStation cost ($)': moneyText(order.shipstationCost),
    'Profit ($)': moneyText(order.profit),
  }))
}

export function clientProfitRows(clients: ClientProfit[]): Array<Record<string, string>> {
  return clients.map((client) => ({
    Client: client.clientName,
    Orders: String(client.orders),
    'Priced orders': String(client.pricedOrders),
    'Unpriced orders': String(client.unpricedOrders),
    'Price ($)': moneyText(client.clientPrice),
    'ShipStation cost ($)': moneyText(client.shipstationCost),
    'Profit ($)': moneyText(client.profit),
  }))
}

export function profitRows(level: ProfitLevel, shipments: ShipmentMoney[]): Array<Record<string, string>> {
  if (level === 'order') return orderProfitRows(rollupOrders(shipments))
  if (level === 'client') return clientProfitRows(rollupClients(rollupOrders(shipments)))
  return shipmentProfitRows(shipments)
}
