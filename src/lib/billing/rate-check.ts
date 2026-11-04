import { easternCalendarDay } from '@/lib/ledger/eastern-day'
import {
  chargeableOunces,
  DEFAULT_RATE_CHECK_FLAGS,
  matchClientPrice,
  type RateCheckFlags,
  type RateMatchKind,
  type RateSheet,
} from './rate-sheet'

// Compares shipments with the 2026-11 sheet. It does not price a bill and it
// does not read Shipo's cost. ICL is a client price list with no dashboard
// client yet, so no shipment is priced from it.

export interface RateCheckShipment {
  id: string
  clientName: string | null
  orderNumber: string | null
  shipDate: string | null
  weightOz: number | null
  zone: number | null
  service: string | null
  sheetPrice: number | null
  clientRate: number | null
  difference: number | null
  reason: string | null
  kind: RateMatchKind
}

export interface RateCheckSummary {
  clientName: string
  shipments: number
  matched: number
  /** Clients with no tab, and Suteka parcels over 6 lb. Not mismatches. */
  notCompared: number
  billedTotal: number | null
  sheetTotal: number | null
  difference: number | null
}

function cents(n: number): number {
  return Math.round(n * 100)
}

function fromCents(n: number): number {
  return n / 100
}

export function storedZone(zone: number | null, raw: unknown): number | null {
  if (typeof zone === 'number' && zone >= 1 && zone <= 8) return zone
  if (!raw || typeof raw !== 'object') return null
  const data = raw as Record<string, unknown>
  const advanced = data.advancedOptions
  const shipTo = data.shipTo
  const candidates = [
    data.zone,
    data.shippingZone,
    advanced && typeof advanced === 'object' ? (advanced as Record<string, unknown>).zone : null,
    shipTo && typeof shipTo === 'object' ? (shipTo as Record<string, unknown>).zone : null,
  ]
  for (const candidate of candidates) {
    const n = typeof candidate === 'number' ? candidate : typeof candidate === 'string' ? Number(candidate) : NaN
    if (Number.isInteger(n) && n >= 1 && n <= 8) return n
  }
  return null
}

export function checkShipment(
  sheet: RateSheet,
  row: {
    id: string
    clientName: string | null
    orderNumber: string | null
    shipDate: string | null
    weight: number | null
    weightUnit: string | null
    length: number | null
    width: number | null
    height: number | null
    dimWeight: number | null
    carrier: string | null
    zone: number | null
    raw: unknown
    service: string | null
    clientRate: number | null
  },
  flags: RateCheckFlags = DEFAULT_RATE_CHECK_FLAGS,
): RateCheckShipment {
  const zone = storedZone(row.zone, row.raw)
  const charged = chargeableOunces({
    weight: row.weight,
    weightUnit: row.weightUnit,
    length: row.length,
    width: row.width,
    height: row.height,
    dimWeight: row.dimWeight,
    carrier: row.carrier,
    service: row.service,
  }, flags)
  const weightOz = charged.ounces
  const withNote = (reason: string | null): string | null => {
    if (!charged.note) return reason
    return reason ? `${reason} ${charged.note}` : charged.note
  }
  const base = {
    id: row.id,
    clientName: row.clientName,
    orderNumber: row.orderNumber,
    shipDate: row.shipDate ? easternCalendarDay(row.shipDate) : null,
    weightOz,
    zone,
    service: row.service,
    sheetPrice: null,
    clientRate: row.clientRate,
    difference: null,
    reason: null as string | null,
    kind: 'unmatched' as RateMatchKind,
  }
  const match = matchClientPrice(sheet, {
    clientName: row.clientName ?? '',
    weightOz: weightOz ?? 0,
    zone: zone ?? 0,
    service: row.service,
    roundWeight: flags.roundWeight,
  })
  const reason = match.kind === 'no_sheet' ? match.reason : withNote(match.reason)
  if (match.kind !== 'matched' || match.price == null) {
    return { ...base, kind: match.kind, reason }
  }
  const difference = row.clientRate == null ? null : fromCents(cents(row.clientRate) - cents(match.price))
  return {
    ...base,
    zone: zone,
    sheetPrice: match.price,
    difference,
    kind: 'matched',
    reason: withNote(null),
  }
}

export function summarizeRateCheck(rows: readonly RateCheckShipment[]): RateCheckSummary[] {
  const byClient = new Map<string, RateCheckShipment[]>()
  for (const row of rows) {
    const name = row.clientName?.trim() || 'No client'
    const list = byClient.get(name) ?? []
    list.push(row)
    byClient.set(name, list)
  }
  return [...byClient.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([clientName, list]) => {
    const matched = list.filter((row) => row.kind === 'matched')
    const notCompared = list.filter((row) => row.kind === 'no_sheet' || row.kind === 'manual').length
    const billed = matched.filter((row) => row.clientRate != null)
    const compared = matched.filter((row) => row.clientRate != null)
    const billedTotal = billed.length === 0 ? null : fromCents(billed.reduce((sum, row) => sum + cents(row.clientRate ?? 0), 0))
    const sheetTotal = matched.length === 0 ? null : fromCents(matched.reduce((sum, row) => sum + cents(row.sheetPrice ?? 0), 0))
    const difference = compared.length === 0 ? null : fromCents(compared.reduce((sum, row) => sum + cents((row.clientRate ?? 0) - (row.sheetPrice ?? 0)), 0))
    return {
      clientName,
      shipments: list.length,
      matched: matched.length,
      notCompared,
      billedTotal,
      sheetTotal,
      difference,
    }
  })
}
