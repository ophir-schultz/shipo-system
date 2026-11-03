// Prices one order from a price-list document.
//
// Pure: no database, no clock, no Nayax rates. A rate that is not on the
// document is unknown, and unknown is null. Zero is a price someone put on
// the list (a box Shipo does not charge for). The two are not the same.

import type {
  BoxLine,
  PeakBasis,
  PriceListDocument,
  PricedPart,
  ShippingSchedule,
  SkuQty,
} from './types'

/** Cent rounding. Same half-cent rule as lib/ledger/calculate-charges.ts. */
export function money(n: number): number {
  return Math.round(Number((n * 100).toPrecision(12))) / 100 + 0
}

function cents(n: number): number {
  return Math.round(Number((n * 100).toPrecision(12)))
}

export function normalizeSku(raw: string): string {
  let s = raw.trim().replace(/^"+|"+$/g, '').trim().toUpperCase()
  if (/^\d+\.0$/.test(s)) s = s.slice(0, -2)
  return s
}

export function parseQty(raw: string): number | null {
  const n = Number(String(raw).replace(/,/g, '').trim())
  if (!Number.isFinite(n)) return null
  return n
}

function part(amount: number | null, reasons: string[] = []): PricedPart {
  return { amount, reasons }
}

function isDevice(sku: string, prefixes: string[]): boolean {
  const normalized = normalizeSku(sku)
  return prefixes.some((p) => normalized.startsWith(p.trim().toUpperCase()))
}

/**
 * Devices: floor(units / carton) × carton rate, plus the remainder × unit
 * rate. Units are the order total of device SKUs, not each line on its own.
 * Accessories: unit rate × units. A missing section is null, not zero.
 */
export function pricePick(list: PriceListDocument, lines: SkuQty[]): PricedPart {
  const reasons: string[] = []
  let deviceUnits = 0
  let accessoryUnits = 0
  for (const line of lines) {
    if (!Number.isFinite(line.qty)) {
      return part(null, [`quantity for ${line.sku || '(blank sku)'} is not a number`])
    }
    const prefixes = list.devicePick?.skuPrefixes ?? []
    if (list.devicePick && isDevice(line.sku, prefixes)) deviceUnits += line.qty
    else accessoryUnits += line.qty
  }

  let totalCents = 0
  if (deviceUnits !== 0) {
    if (!list.devicePick) {
      return part(null, ['device units are on the order and the price list has no device pick rate'])
    }
    if (!Number.isInteger(deviceUnits)) {
      return part(null, [`device units ${deviceUnits} are not a whole number`])
    }
    const { cartonSize, cartonRate, remainderRate } = list.devicePick
    if (!Number.isInteger(cartonSize) || cartonSize <= 0) {
      return part(null, ['device carton size must be a positive whole number'])
    }
    const cartons = Math.floor(deviceUnits / cartonSize)
    const remainder = deviceUnits % cartonSize
    totalCents += cents(cartonRate) * cartons + cents(remainderRate) * remainder
  }
  if (accessoryUnits !== 0) {
    if (!list.accessoryPick) {
      return part(null, ['accessory units are on the order and the price list has no accessory rate'])
    }
    totalCents += cents(list.accessoryPick.unitRate * accessoryUnits)
  }
  return part(money(totalCents / 100), reasons)
}

/**
 * One box, one material charge. An unknown code makes the whole order's
 * box total unknown: a sum that skips a box would look like a complete price.
 */
export function priceBoxes(list: PriceListDocument, boxes: BoxLine[]): PricedPart {
  if (boxes.length === 0) {
    return part(null, ['no box or weight line, so box material is unknown'])
  }
  const byCode = new Map(list.boxes.map((b) => [b.code.trim().toUpperCase(), b.rate]))
  let totalCents = 0
  for (const box of boxes) {
    const code = box.boxCode?.trim() ?? ''
    if (!code) {
      const label = box.weightLabel.trim().toLowerCase()
      const noBox = list.noBoxListed
      if (noBox && label === noBox.weightLabel.trim().toLowerCase()) {
        totalCents += cents(noBox.rate)
        continue
      }
      return part(null, [
        `weight ${box.weightLabel || '(blank)'} has no box code and no matching no-box rate`,
      ])
    }
    const rate = byCode.get(code.toUpperCase())
    if (rate === undefined) {
      return part(null, [`no box rate for ${code}`])
    }
    totalCents += cents(rate)
  }
  return part(money(totalCents / 100))
}

/**
 * Billable pounds for one box: the greater of scale weight and volume
 * weight, rounded up to the next whole pound. The zone card is keyed by
 * whole pounds. A missing volume weight uses the scale weight alone.
 */
export function billablePounds(statedLb: number, volumeLb: number | null): number | null {
  if (!Number.isFinite(statedLb) || statedLb < 0) return null
  const vol = volumeLb === null || volumeLb === undefined ? statedLb : volumeLb
  if (!Number.isFinite(vol) || vol < 0) return null
  const raw = Math.max(statedLb, vol)
  if (raw === 0) return 0
  return Math.ceil(raw - 1e-9)
}

function scheduleCovers(schedule: ShippingSchedule, onDate: string): boolean {
  const fromOk = schedule.effectiveFrom === null || schedule.effectiveFrom <= onDate
  const toOk = schedule.effectiveTo === null || onDate < schedule.effectiveTo
  return fromOk && toOk
}

function shippingRate(
  list: PriceListDocument,
  onDate: string,
  weightLb: number,
  zone: number,
): { rate: number | null; reason: string | null } {
  if (!list.shipping || list.shipping.cells.length === 0) {
    return { rate: null, reason: 'the price list has no shipping cells' }
  }
  const schedules = list.shipping.schedules.filter((s) => scheduleCovers(s, onDate))
  if (schedules.length === 0) {
    return { rate: null, reason: `no shipping schedule is in effect on ${onDate}` }
  }
  if (schedules.length > 1) {
    return {
      rate: null,
      reason: `${schedules.length} shipping schedules cover ${onDate}; not priced`,
    }
  }
  const cell = list.shipping.cells.find((c) => c.weightLb === weightLb && c.zone === zone)
  if (!cell) {
    return { rate: null, reason: `no shipping cell for ${weightLb} lb zone ${zone}` }
  }
  const divideBy = schedules[0].divideBy
  if (!Number.isFinite(divideBy) || divideBy === 0) {
    return { rate: null, reason: 'shipping schedule divideBy is not a usable number' }
  }
  return { rate: money(cell.rate / divideBy), reason: null }
}

/**
 * Each box is priced on its own billable weight and zone, then summed.
 * That is how a multi-box order is billed.
 */
export function priceShipping(
  list: PriceListDocument,
  onDate: string,
  zone: number | null,
  boxes: BoxLine[],
): PricedPart {
  if (zone === null || !Number.isInteger(zone)) {
    return part(null, ['no zone, so shipping is unknown'])
  }
  if (boxes.length === 0) {
    return part(null, ['no boxes, so shipping is unknown'])
  }
  let totalCents = 0
  for (const box of boxes) {
    const pounds = billablePounds(box.statedLb, box.volumeLb)
    if (pounds === null || pounds <= 0) {
      return part(null, [`billable weight for ${box.weightLabel || 'a box'} is unknown`])
    }
    const looked = shippingRate(list, onDate, pounds, zone)
    if (looked.rate === null) return part(null, [looked.reason ?? 'shipping is unknown'])
    totalCents += cents(looked.rate)
  }
  return part(money(totalCents / 100))
}

export function priceReceiving(list: PriceListDocument, cartons: number | null): PricedPart {
  if (cartons === null) return part(null, ['receiving cartons were not provided'])
  if (!list.receiving) return part(null, ['the price list has no receiving rate'])
  if (!Number.isFinite(cartons) || cartons < 0) return part(null, ['receiving cartons are not a number'])
  return part(money(cartons * list.receiving.perCarton))
}

export function priceStorage(
  list: PriceListDocument,
  pallets: number | null,
  shelves: number | null,
): PricedPart {
  if (pallets === null && shelves === null) {
    return part(null, ['storage quantity was not provided'])
  }
  if (!list.storage) return part(null, ['the price list has no storage rate'])
  const p = pallets ?? 0
  const s = shelves ?? 0
  if (!Number.isFinite(p) || !Number.isFinite(s) || p < 0 || s < 0) {
    return part(null, ['storage quantity is not a number'])
  }
  return part(money(p * list.storage.perPallet + s * list.storage.perShelf))
}

export function priceLabour(list: PriceListDocument, hours: number | null): PricedPart {
  if (hours === null) return part(null, ['labour hours were not provided'])
  if (!list.labour) return part(null, ['the price list has no labour rate'])
  if (!Number.isFinite(hours) || hours < 0) return part(null, ['labour hours are not a number'])
  return part(money(hours * list.labour.perHour))
}

/** Materials bill at cost plus the list's markup percent. 15 means 15%. */
export function priceMaterials(list: PriceListDocument, cost: number | null): PricedPart {
  if (cost === null) return part(null, ['materials cost was not provided'])
  if (!list.materials) return part(null, ['the price list has no materials markup'])
  if (!Number.isFinite(cost) || cost < 0) return part(null, ['materials cost is not a number'])
  return part(money(cost * (1 + list.materials.markupPct / 100)))
}

/** True when `yyyy-mm-dd` falls inside the peak window, inclusive, wrapping the year. */
export function isPeakDate(isoDate: string, fromMonthDay: string, toMonthDay: string): boolean {
  const md = isoDate.slice(5)
  if (fromMonthDay <= toMonthDay) return md >= fromMonthDay && md <= toMonthDay
  return md >= fromMonthDay || md <= toMonthDay
}

export interface WarehouseParts {
  devicePick: number | null
  accessoryPick: number | null
  box: number | null
  receiving: number | null
  storage: number | null
  labour: number | null
  materials: number | null
}

/**
 * Peak is a percentage of the warehouse parts the list names. A named part
 * that is null makes the surcharge itself null: a percentage of an unknown
 * fee is an unknown fee. Shipping is included only when the list says so.
 */
export function pricePeak(
  list: PriceListDocument,
  onDate: string,
  parts: WarehouseParts,
): PricedPart {
  if (!list.peak) return part(0)
  if (!isPeakDate(onDate, list.peak.fromMonthDay, list.peak.toMonthDay)) return part(0)
  const named = list.peak.appliesTo
  let basisCents = 0
  for (const key of named) {
    const amount = partAmount(parts, key)
    if (amount === null) {
      return part(null, [`peak surcharge needs ${key}, and that amount is unknown`])
    }
    basisCents += cents(amount)
  }
  if (basisCents === 0) return part(0)
  return part(money((basisCents / 100) * list.peak.pct / 100))
}

function partAmount(parts: WarehouseParts, key: PeakBasis): number | null {
  if (key === 'device_pick') return parts.devicePick
  if (key === 'accessory_pick') return parts.accessoryPick
  if (key === 'box') return parts.box
  if (key === 'receiving') return parts.receiving
  if (key === 'storage') return parts.storage
  if (key === 'labour') return parts.labour
  return parts.materials
}

export interface ClientReportPrice {
  pick: PricedPart
  box: PricedPart
  shipping: PricedPart
  /** Pick + box + shipping. Null when any of the three is unknown. */
  total: number | null
}

/**
 * The three amounts on the client billing workbook. Peak, receiving, storage,
 * labour and materials are not columns on that sheet.
 */
export function priceClientReport(
  list: PriceListDocument,
  onDate: string,
  zone: number | null,
  lines: SkuQty[],
  boxes: BoxLine[],
): ClientReportPrice {
  const pick = pricePick(list, lines)
  const box = priceBoxes(list, boxes)
  const shipping = priceShipping(list, onDate, zone, boxes)
  const total = pick.amount === null || box.amount === null || shipping.amount === null
    ? null
    : money(pick.amount + box.amount + shipping.amount)
  return { pick, box, shipping, total }
}

/**
 * Split a device pick into the two parts peak can name separately.
 * When the order has no units of a kind, that part is 0, not null.
 */
export function splitPick(list: PriceListDocument, lines: SkuQty[]): {
  device: PricedPart
  accessory: PricedPart
} {
  const devices = lines.filter((l) => list.devicePick && isDevice(l.sku, list.devicePick.skuPrefixes))
  const accessories = lines.filter((l) => !devices.includes(l))
  const device = devices.length === 0 ? part(0) : pricePick(list, devices)
  const accessory = accessories.length === 0 ? part(0) : pricePick(
    { ...list, devicePick: null },
    accessories,
  )
  return { device, accessory }
}
