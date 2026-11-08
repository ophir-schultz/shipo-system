// One row per order for the client activity sheet.
//
// The 16 columns are the workbook columns. This is not the imported
// workbook. A pick amount is the price list applied to that order: whole
// cartons at the carton rate, leftover device units at the remainder rate,
// other units at the accessory rate. Charging every device unit at the
// remainder rate is a different number, and this file does not use it.
//
// Shipping is placed on the row only when one parcel has one client price.
// A stored rate and a ledger amount that differ are not a client price.
// A ledger amount with no stored rate is not used. Material stays blank
// until a box code is known. A blank is unknown, not zero.

import { priceOf } from '@/lib/billing/unpriced'
import { isVoidedShipment } from '@/lib/billing/voided-shipment'
import { rawShipDate, shipCalendarDay } from '@/lib/ledger/eastern-day'
import { money, normalizeSku, peakOmissionNote, pricePick } from '@/lib/pricing/engine'
import type { ClientReportRow } from '@/lib/pricing/client-report'
import type { PriceListDocument, SkuQty } from '@/lib/pricing/types'

export interface ActivityLine {
  sku: string
  qty: number
}

export interface ActivityOrder {
  id: string
  orderNumber: string
  lines: ActivityLine[]
}

export interface ActivityParcel {
  id: string
  orderNumber: string
  shipDate: string | null
  raw?: unknown
  recipientName: string
  trackingNumber: string
  zone: string
  zipcode: string
  weight: string
  volumeWeight: string
  storedRate: number | null
  shipmentKey: string | null
}

export interface ActivityShippingCharge {
  chargeKey: string
  amount: number | null
  unitRate: number | null
}

export interface ActivitySerial {
  orderNumber: string
  sku: string | null
  serial: string
}

export interface OrderPickParts {
  deviceUnits: number
  accessoryUnits: number
  cartons: number
  remainder: number
  amount: number | null
  reasons: string[]
}

export interface ActivityOrderPick {
  orderNumber: string
  deviceUnits: number
  cartons: number
  remainder: number
  accessoryUnits: number
  amount: number | null
}

export interface ActivityCoverage {
  datedOrders: number
  undatedOrders: string[]
  unmatchedParcels: string[]
  shippingConflicts: string[]
  shippingAmbiguous: string[]
  pickKnown: number | null
  pickUnknownOrders: number
  picks: ActivityOrderPick[]
  peakNote: string
}

export interface OrderActivity {
  rows: ClientReportRow[]
  coverage: ActivityCoverage
}

function sameCents(a: number, b: number): boolean {
  return Math.round(a * 100) === Math.round(b * 100)
}

function dayOf(parcel: ActivityParcel): string {
  if (isVoidedShipment(parcel.raw)) return ''
  return shipCalendarDay(parcel.shipDate, rawShipDate(parcel.raw))
}

/** Device and accessory units the price list would split, plus carton counts. */
export function orderPickParts(list: PriceListDocument | null, lines: readonly SkuQty[]): OrderPickParts {
  if (!list) {
    return { deviceUnits: 0, accessoryUnits: 0, cartons: 0, remainder: 0, amount: null, reasons: ['no price list'] }
  }
  const priced = pricePick(list, [...lines])
  const prefixes = list.devicePick?.skuPrefixes ?? []
  let deviceUnits = 0
  let accessoryUnits = 0
  for (const line of lines) {
    if (!Number.isFinite(line.qty)) continue
    const sku = normalizeSku(line.sku)
    if (list.devicePick && prefixes.some((prefix) => sku.startsWith(normalizeSku(prefix)))) {
      deviceUnits += line.qty
    } else accessoryUnits += line.qty
  }
  const size = list.devicePick?.cartonSize ?? 0
  const cartons = size > 0 ? Math.floor(deviceUnits / size) : 0
  const remainder = size > 0 ? deviceUnits % size : deviceUnits
  return {
    deviceUnits,
    accessoryUnits,
    cartons,
    remainder,
    amount: priced.amount,
    reasons: priced.reasons,
  }
}

/**
 * Every device unit at the remainder rate, plus accessories.
 * The statement does not bill this way. One full carton is the carton rate.
 */
export function remainderReading(
  deviceUnits: number,
  accessoryUnits: number,
  remainderRate: number,
  accessoryRate: number,
): number {
  return money(deviceUnits * remainderRate + accessoryUnits * accessoryRate)
}

export function clientShippingPrice(
  storedRate: number | null,
  charge: ActivityShippingCharge | undefined,
): { amount: number | null; status: 'agreed' | 'stored-rate' | 'conflict' | 'unknown' } {
  const ledger = charge ? priceOf(charge.amount) : null
  const unit = charge ? priceOf(charge.unitRate) : null
  if (storedRate != null && ledger != null) {
    if (sameCents(storedRate, ledger)) return { amount: storedRate, status: 'agreed' }
    return { amount: null, status: 'conflict' }
  }
  if (storedRate != null && ledger == null) return { amount: storedRate, status: 'stored-rate' }
  if (storedRate == null && ledger != null && unit != null && sameCents(unit, ledger)) {
    return { amount: ledger, status: 'agreed' }
  }
  return { amount: null, status: 'unknown' }
}

export function buildOrderActivity(input: {
  clientId: string
  from: string
  to: string
  list: PriceListDocument | null
  orders: readonly ActivityOrder[]
  parcels: readonly ActivityParcel[]
  charges: readonly ActivityShippingCharge[]
  serials: readonly ActivitySerial[]
}): OrderActivity {
  const chargeByKey = new Map(input.charges.map((charge) => [charge.chargeKey, charge]))
  const parcelsByOrder = new Map<string, ActivityParcel[]>()
  for (const parcel of input.parcels) {
    if (isVoidedShipment(parcel.raw)) continue
    const key = parcel.orderNumber.trim()
    if (!key) continue
    const list = parcelsByOrder.get(key) ?? []
    list.push(parcel)
    parcelsByOrder.set(key, list)
  }

  const orderNumbers = new Set(input.orders.map((order) => order.orderNumber.trim()).filter(Boolean))
  const undatedOrders: string[] = []
  const shippingConflicts: string[] = []
  const shippingAmbiguous: string[] = []
  const unmatchedParcels: string[] = []
  const rows: ClientReportRow[] = []
  const picks: ActivityOrderPick[] = []
  let pickCents = 0
  let pickKnown = 0
  let pickUnknownOrders = 0

  for (const parcel of input.parcels) {
    if (isVoidedShipment(parcel.raw)) continue
    const day = dayOf(parcel)
    const number = parcel.orderNumber.trim()
    if (!day || day < input.from || day > input.to) continue
    if (!number || !orderNumbers.has(number)) unmatchedParcels.push(number || parcel.id)
  }

  for (const order of input.orders) {
    const number = order.orderNumber.trim()
    if (!number) continue
    const parcels = parcelsByOrder.get(number) ?? []
    const days = [...new Set(parcels.map(dayOf).filter(Boolean))]
    const date = days.length === 1 ? days[0] : null
    if (!date) {
      undatedOrders.push(number)
      continue
    }
    if (date < input.from || date > input.to) continue

    const parts = orderPickParts(input.list, order.lines.map((line) => ({ sku: line.sku, qty: line.qty })))
    picks.push({
      orderNumber: number,
      deviceUnits: parts.deviceUnits,
      cartons: parts.cartons,
      remainder: parts.remainder,
      accessoryUnits: parts.accessoryUnits,
      amount: parts.amount,
    })
    if (parts.amount == null) pickUnknownOrders += 1
    else {
      pickKnown += 1
      pickCents += Math.round(parts.amount * 100)
    }

    let shipping: number | null = null
    if (parcels.length === 1) {
      const parcel = parcels[0]
      const charge = parcel.shipmentKey ? chargeByKey.get(parcel.shipmentKey) : undefined
      const priced = clientShippingPrice(parcel.storedRate, charge)
      if (priced.status === 'conflict') shippingConflicts.push(number)
      shipping = priced.amount
    } else if (parcels.length > 1) {
      shippingAmbiguous.push(number)
    }

    const serials = input.serials
      .filter((serial) => serial.orderNumber.trim() === number)
      .map((serial) => serial.serial)
    const parcel = parcels.length === 1 ? parcels[0] : null
    const pickText = parts.amount == null ? '' : parts.amount.toFixed(2)
    const shipText = shipping == null ? '' : shipping.toFixed(2)
    const total = parts.amount != null && shipping != null
      ? (Math.round(parts.amount * 100) + Math.round(shipping * 100)) / 100
      : null

    rows.push({
      clientId: input.clientId,
      date,
      orderNumber: number,
      recipientName: parcel?.recipientName ?? '',
      trackingNumber: parcel?.trackingNumber ?? '',
      sku: order.lines.map((line) => line.sku).join('\n'),
      qty: order.lines.map((line) => String(line.qty)).join('\n'),
      qtyCount: String(order.lines.reduce((sum, line) => sum + line.qty, 0)),
      serialNumber: serials.join('\n'),
      pickPrice: pickText,
      boxPrice: '',
      shippingPrice: shipText,
      total: total == null ? '' : total.toFixed(2),
      zone: parcel?.zone ?? '',
      zipcode: parcel?.zipcode ?? '',
      weight: parcel?.weight ?? '',
      volumeWeight: parcel?.volumeWeight ?? '',
    })
  }

  return {
    rows,
    coverage: {
      datedOrders: rows.length,
      undatedOrders,
      unmatchedParcels,
      shippingConflicts,
      shippingAmbiguous,
      pickKnown: pickKnown === 0 ? null : pickCents / 100,
      pickUnknownOrders,
      picks,
      peakNote: peakOmissionNote(input.list, rows.map((row) => row.date ?? '')),
    },
  }
}
