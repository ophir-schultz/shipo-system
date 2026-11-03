// A client's price list, as uploaded. The pricing functions in engine.ts
// read this and nothing else: a discount is a different document, not a
// branch in the code.

export interface DevicePickRate {
  /** Units that bill as one carton. Nayax is 20. */
  cartonSize: number
  cartonRate: number
  /** Charged for each unit that does not fill a carton. */
  remainderRate: number
  /**
   * SKUs whose normalized form starts with one of these are devices.
   * Everything else on the order is an accessory, when an accessory rate
   * is present. Matching is case-insensitive and only at the start.
   */
  skuPrefixes: string[]
}

export interface BoxRate {
  /** Box code as it appears on the report, e.g. "7/6/6". */
  code: string
  rate: number
}

export interface NoBoxListedRate {
  /**
   * Weight label, compared case-insensitively to the weight text with no
   * box code, e.g. "1lb". Other weights with no box are not given this rate.
   */
  weightLabel: string
  rate: number
}

export interface PeakSurcharge {
  /** 8 means 8 percent, not 0.08. */
  pct: number
  /** MM-DD, inclusive. The window may wrap the new year. */
  fromMonthDay: string
  /** MM-DD, inclusive. */
  toMonthDay: string
  /**
   * Which priced parts the percentage applies to. Shipping is warehouse-fee
   * only when it is listed here; the Nayax list does not list it.
   */
  appliesTo: PeakBasis[]
}

export type PeakBasis =
  | 'device_pick'
  | 'accessory_pick'
  | 'box'
  | 'receiving'
  | 'storage'
  | 'labour'
  | 'materials'

export interface ShippingCell {
  weightLb: number
  zone: number
  rate: number
}

export interface ShippingSchedule {
  /** Inclusive. Null means the schedule has always applied. */
  effectiveFrom: string | null
  /** Exclusive. Null means the schedule has no end. */
  effectiveTo: string | null
  /**
   * Divide the cell by this, then round to the cent, per box.
   * 1 uses the cell as stored. The pre-May-19 Nayax card is 1.03.
   */
  divideBy: number
}

/** A service the list states in words. The engine does not price from these. */
export interface PriceListService {
  name: string
  /** Unit as written, e.g. "per pallet". */
  basis: string
  /** Null when the list states a rule and not a dollar amount. */
  amount: number | null
}

/** A line that was not turned into a rate, with the reason it was left alone. */
export interface PriceListAmbiguity {
  source: string
  reason: string
}

export interface PriceListDocument {
  name: string
  clientName: string
  devicePick: DevicePickRate | null
  accessoryPick: { unitRate: number } | null
  boxes: BoxRate[]
  noBoxListed: NoBoxListedRate | null
  receiving: { perCarton: number } | null
  storage: { perPallet: number; perShelf: number } | null
  labour: { perHour: number } | null
  materials: { markupPct: number } | null
  peak: PeakSurcharge | null
  /**
   * Name of another client's list whose shipping card this list uses.
   * The cells stay on that list. Resolving copies the object reference,
   * not the numbers, into `shipping`.
   */
  shippingSameAs: string | null
  shipping: {
    schedules: ShippingSchedule[]
    cells: ShippingCell[]
  } | null
  services: PriceListService[]
  ambiguous: PriceListAmbiguity[]
}

export interface SkuQty {
  sku: string
  qty: number
}

export interface BoxLine {
  /** Scale weight in pounds, before dimensional weight. */
  statedLb: number
  /** Dimensional / volume weight in pounds, when the report has one. */
  volumeLb: number | null
  /** Null when the weight line names no box. */
  boxCode: string | null
  /** The weight token as written, e.g. "1lb" or "3lbs", used for no-box rates. */
  weightLabel: string
}

export interface PricedPart {
  amount: number | null
  reasons: string[]
}
