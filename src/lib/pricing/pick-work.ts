import { priceClassifiedPick } from '@/lib/pricing/engine'
import type { PriceListDocument } from '@/lib/pricing/types'

// Picked units are the work. Ordered quantity is not a substitute.
// A current item-list price is not billed into a period unless the pick
// date is known and inside that period.

export interface WorkedPickLine {
  sku: string
  picked: number | null
  scannable: boolean | null
  pickDate: string | null
}

export type PickWorkStatus =
  | 'nothing-picked'
  | 'qty-unknown'
  | 'unclassified'
  | 'date-unknown'
  | 'outside'
  | 'priced'

export interface PickWorkAssessment {
  status: PickWorkStatus
  units: number
  catalogAmount: number | null
  /** Amount that belongs in this period. Null is not zero. */
  billedAmount: number | null
  pickDate: string | null
  deviceUnits: number
  accessoryUnits: number
  cartons: number
  remainder: number
}

function day(value: string | null): string | null {
  if (!value) return null
  const head = value.slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(head) ? head : null
}

export function assessPickWork(
  lines: readonly WorkedPickLine[],
  list: PriceListDocument | null,
  period: { from: string; to: string } | null,
): PickWorkAssessment {
  const empty = {
    units: 0,
    catalogAmount: null as number | null,
    billedAmount: null as number | null,
    pickDate: null as string | null,
    deviceUnits: 0,
    accessoryUnits: 0,
    cartons: 0,
    remainder: 0,
  }
  if (lines.some((line) => line.picked == null || !Number.isFinite(line.picked))) {
    return { ...empty, status: 'qty-unknown' }
  }
  const work = lines.filter((line) => (line.picked ?? 0) > 0)
  if (work.length === 0) {
    return { ...empty, status: 'nothing-picked', catalogAmount: 0, billedAmount: 0 }
  }
  if (!list) return { ...empty, status: 'unclassified', units: work.reduce((sum, line) => sum + (line.picked ?? 0), 0) }
  const priced = priceClassifiedPick(list, work.map((line) => ({
    sku: line.sku,
    qty: line.picked ?? 0,
    scannable: line.scannable,
  })))
  let deviceUnits = 0
  let accessoryUnits = 0
  for (const line of work) {
    if (line.scannable === true) deviceUnits += line.picked ?? 0
    else if (line.scannable === false) accessoryUnits += line.picked ?? 0
  }
  const size = list?.devicePick?.cartonSize ?? 0
  const units = work.reduce((sum, line) => sum + (line.picked ?? 0), 0)
  const base = {
    units,
    catalogAmount: priced.amount,
    billedAmount: null as number | null,
    pickDate: null as string | null,
    deviceUnits,
    accessoryUnits,
    cartons: size > 0 ? Math.floor(deviceUnits / size) : 0,
    remainder: size > 0 ? deviceUnits % size : deviceUnits,
  }
  if (priced.amount == null) return { ...base, status: 'unclassified' }
  const dates = new Set(work.map((line) => day(line.pickDate)))
  if (dates.size !== 1 || dates.has(null)) return { ...base, status: 'date-unknown' }
  const pickDate = [...dates][0]
  if (period && pickDate && (pickDate < period.from || pickDate > period.to)) {
    return { ...base, status: 'outside', pickDate }
  }
  return { ...base, status: 'priced', pickDate, billedAmount: priced.amount }
}
