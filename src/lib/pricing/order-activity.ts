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
import { money, peakOmissionNote, priceClassifiedPick } from '@/lib/pricing/engine'
import { assessPickWork, type PickWorkStatus } from '@/lib/pricing/pick-work'
import type { ClientReportRow } from '@/lib/pricing/client-report'
import type { PriceListDocument } from '@/lib/pricing/types'

export interface ActivityLine {
  sku: string
  qty: number
  /** True when the SKU must be scanned. Null when the stored line does not say. */
  scannable: boolean | null
  /** Units picked. Undefined uses `qty`. Null means the picked count was not recorded. */
  picked?: number | null
  /** Pick day. Undefined or null means the day is not stored. */
  pickDate?: string | null
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
  /** Cartons times the carton rate, leftover times the remainder rate, other units times their rate. */
  rateLabel: string
  /** Current item-list reading on picked units. Not a period charge by itself. */
  amount: number | null
  /** Amount placed on the client row. Null is not zero. */
  billedAmount: number | null
  status: string
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
  /** How the scan requirement was read. Empty when this price list does not use it. */
  scanNote: string
  nothingPicked: string[]
  pickDateUnknown: string[]
  pickOutsidePeriod: string[]
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
export function orderPickParts(
  list: PriceListDocument | null,
  lines: readonly { sku: string; qty: number; scannable?: boolean | null }[],
): OrderPickParts {
  if (!list) {
    return { deviceUnits: 0, accessoryUnits: 0, cartons: 0, remainder: 0, amount: null, reasons: ['no price list'] }
  }
  const priced = priceClassifiedPick(list, lines.map((line) => ({
    sku: line.sku,
    qty: line.qty,
    scannable: line.scannable === undefined ? null : line.scannable,
  })))
  let deviceUnits = 0
  let accessoryUnits = 0
  for (const line of lines) {
    if (!Number.isFinite(line.qty) || line.scannable == null) continue
    if (line.scannable) deviceUnits += line.qty
    else accessoryUnits += line.qty
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
  scanNote?: string
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
  const nothingPicked: string[] = []
  const pickDateUnknown: string[] = []
  const pickOutsidePeriod: string[] = []
  let pickCents = 0
  let pickKnown = 0
  let pickUnknownOrders = 0
  const pickStatus: Record<PickWorkStatus, string> = {
    'nothing-picked': 'nothing picked',
    'qty-unknown': 'picked quantity unknown',
    unclassified: 'classification unknown',
    'date-unknown': 'pick date unknown',
    outside: 'outside this period',
    priced: 'included',
  }

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
      const idle = order.lines.map((line) => ({
        sku: line.sku,
        picked: line.picked !== undefined ? line.picked : line.qty,
        scannable: line.scannable ?? null,
        pickDate: null,
      }))
      const idleWork = assessPickWork(idle, input.list, null)
      if (idle.length > 0 && idleWork.status === 'nothing-picked') {
        nothingPicked.push(number)
        picks.push({
          orderNumber: number,
          deviceUnits: 0,
          cartons: 0,
          remainder: 0,
          accessoryUnits: 0,
          rateLabel: 'nothing picked',
          amount: 0,
          billedAmount: null,
          status: 'nothing picked',
        })
        rows.push({
          clientId: input.clientId,
          date: '',
          orderNumber: number,
          recipientName: '',
          trackingNumber: '',
          sku: order.lines.map((line) => line.sku).join('\n'),
          qty: idle.map((line) => String(line.picked ?? 0)).join('\n'),
          qtyCount: '0',
          serialNumber: '',
          pickPrice: '0.00',
          boxPrice: '',
          shippingPrice: '',
          total: '',
          zone: '',
          zipcode: '',
          weight: '',
          volumeWeight: '',
        })
      }
      continue
    }
    if (date < input.from || date > input.to) continue

    const worked = order.lines.map((line) => ({
      sku: line.sku,
      picked: line.picked !== undefined ? line.picked : line.qty,
      scannable: line.scannable ?? null,
      pickDate: line.pickDate ?? null,
    }))
    const parts = assessPickWork(worked, input.list, { from: input.from, to: input.to })
    const deviceRate = input.list?.devicePick
    const otherRate = input.list?.accessoryPick
    const rateLabel = parts.catalogAmount == null
      ? pickStatus[parts.status]
      : deviceRate
        ? `${parts.cartons} × ${deviceRate.cartonRate.toFixed(2)} + ${parts.remainder} × ${deviceRate.remainderRate.toFixed(2)}`
          + (otherRate ? ` + ${parts.accessoryUnits} × ${otherRate.unitRate.toFixed(2)}` : '')
        : ''
    if (parts.status === 'nothing-picked') nothingPicked.push(number)
    if (parts.status === 'date-unknown') pickDateUnknown.push(number)
    if (parts.status === 'outside') pickOutsidePeriod.push(number)
    picks.push({
      orderNumber: number,
      deviceUnits: parts.deviceUnits,
      cartons: parts.cartons,
      remainder: parts.remainder,
      accessoryUnits: parts.accessoryUnits,
      rateLabel,
      amount: parts.catalogAmount,
      billedAmount: parts.billedAmount,
      status: pickStatus[parts.status],
    })
    if (parts.billedAmount == null) pickUnknownOrders += 1
    else {
      pickKnown += 1
      pickCents += Math.round(parts.billedAmount * 100)
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
    const pickText = parts.billedAmount == null ? '' : parts.billedAmount.toFixed(2)
    const shipText = shipping == null ? '' : shipping.toFixed(2)
    const total = parts.billedAmount != null && shipping != null
      ? (Math.round(parts.billedAmount * 100) + Math.round(shipping * 100)) / 100
      : null

    rows.push({
      clientId: input.clientId,
      date,
      orderNumber: number,
      recipientName: parcel?.recipientName ?? '',
      trackingNumber: parcel?.trackingNumber ?? '',
      sku: order.lines.map((line) => line.sku).join('\n'),
      qty: worked.map((line) => line.picked == null ? '' : String(line.picked)).join('\n'),
      qtyCount: worked.some((line) => line.picked == null) ? '' : String(parts.units),
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
      datedOrders: rows.filter((row) => row.date).length,
      undatedOrders,
      unmatchedParcels,
      shippingConflicts,
      shippingAmbiguous,
      pickKnown: rows.length === 0 || pickUnknownOrders > 0 ? null : pickCents / 100,
      pickUnknownOrders,
      picks,
      peakNote: peakOmissionNote(input.list, rows.map((row) => row.date ?? '')),
      scanNote: input.scanNote ?? '',
      nothingPicked,
      pickDateUnknown,
      pickOutsidePeriod,
    },
  }
}
