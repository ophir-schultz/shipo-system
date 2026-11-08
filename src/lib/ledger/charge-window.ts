import { rawShipDate, shipCalendarDay } from '@/lib/ledger/eastern-day'
import { isVoidedShipment } from '@/lib/billing/voided-shipment'

// The charge run loads orders with order_date on or after its window, plus
// orders with no order date. charge_date itself is the pick date or the ship
// day, not the order date. An order placed the day before the window, with a
// label whose carrier day is inside the window, was never loaded, so the
// label was never charged.
//
// This does not move a pick onto the ship day. A pick stays dated by its
// pick date. A shipment stays dated by its ship day.

export interface WindowOrder {
  id: string
  orderDate: string | null
}

export interface WindowShipment {
  orderNumber: string | null
  shipDate: string | null
  raw?: unknown
}

export function carrierShipDay(shipment: WindowShipment): string {
  return shipCalendarDay(shipment.shipDate, rawShipDate(shipment.raw))
}

export function shipmentInChargeWindow(
  shipment: WindowShipment,
  windowStart: string,
): boolean {
  if (isVoidedShipment(shipment.raw)) return false
  const day = carrierShipDay(shipment)
  return day !== '' && day >= windowStart
}

/**
 * Orders the charge run must see.
 *
 * An order already inside the order-date window stays in. An older order is
 * added only when one of its shipments has a carrier day inside the window.
 * A voided label does not add it. Two labels on one order add it once.
 */
export function lateOrderNumbers(
  windowStart: string,
  already: readonly string[],
  shipments: readonly WindowShipment[],
): string[] {
  const known = new Set(already.map((value) => value.trim().toUpperCase()).filter(Boolean))
  const found = new Set<string>()
  for (const shipment of shipments) {
    if (!shipmentInChargeWindow(shipment, windowStart)) continue
    const number = shipment.orderNumber?.trim().toUpperCase() ?? ''
    if (!number || known.has(number)) continue
    found.add(number)
  }
  return [...found]
}
