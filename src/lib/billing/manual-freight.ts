import { priceOf } from '@/lib/billing/unpriced'

// One freight line is one shipment on one staff date.
// Two shipments on that date are two lines. The client is billed the full
// total the staff typed (carrier cost plus markup). The cost and the markup
// stay off the client statement. Nothing here invents a markup rate.

export const FREIGHT_SERVICE = 'carrier_freight'

export interface FreightDraft {
  clientId: string
  date: string
  shipmentRef: string
  carrierCost: unknown
  markup: unknown
}

export interface FreightLine {
  clientId: string
  date: string
  shipmentRef: string
  carrierCost: number
  markup: number
  /** Carrier cost plus the markup the staff typed. This is the client price. */
  fullTotal: number
}

export interface ShipmentForFreight {
  shipmentRef: string
  clientId: string
  /** True when a zone price is already the client rate. Not a reason to drop the line. */
  zonePriced: boolean
}

export function freightFullTotal(carrierCost: number, markup: number): number {
  return Math.round((carrierCost + markup) * 100) / 100
}

/** ShipStation shipment id. Not an order number and not a tracking number. */
export function canonicalShipmentId(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? ''
  if (!/^[1-9]\d*$/.test(trimmed)) return null
  try {
    const id = BigInt(trimmed)
    return id > BigInt(0) ? id.toString() : null
  } catch {
    return null
  }
}

function realCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const utc = new Date(Date.UTC(year, month - 1, day))
  return utc.getUTCFullYear() === year && utc.getUTCMonth() === month - 1 && utc.getUTCDate() === day
}

function money(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null
  const text = typeof value === 'number' ? String(value) : value.trim()
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return null
  const n = priceOf(text)
  if (n === null || n < 0) return null
  return n
}

export interface LinkedFreightPrice {
  shipmentId: string
  /** Full client price. Carrier cost and markup are not included. */
  amount: number
  logDate: string
}

/**
 * One saved freight row, or null when it cannot be billed.
 *
 * The client amount is carrier cost plus markup. A stored total that is not
 * that sum is left off the statement. An order number or a tracking number
 * in shipment_ref is not a shipment.
 */
export function linkedFreightPrice(
  record: {
    shipment_ref?: string | null
    total?: unknown
    log_date?: string | null
    client_id?: string | null
    service_type?: string | null
    freight_cost?: unknown
    freight_markup?: unknown
  },
  clientId: string,
  range?: { from: string; to: string },
): LinkedFreightPrice | null {
  const shipmentId = canonicalShipmentId(record.shipment_ref)
  const logDate = record.log_date?.slice(0, 10) ?? ''
  if (!shipmentId || !realCalendarDate(logDate)) return null
  if (record.client_id !== clientId || record.service_type !== FREIGHT_SERVICE) return null
  if (range && (logDate < range.from || logDate > range.to)) return null
  const carrierCost = money(record.freight_cost ?? null)
  const markup = money(record.freight_markup ?? null)
  if (carrierCost === null || markup === null) return null
  const full = freightFullTotal(carrierCost, markup)
  if (priceOf(record.total) !== full) return null
  return { shipmentId, amount: full, logDate }
}

/**
 * Check a batch of freight lines before anything is written.
 *
 * Same date and same client are allowed. The same shipment twice is not.
 * An existing line for that shipment is not overwritten.
 */
export function prepareFreightLines(
  drafts: readonly FreightDraft[],
  shipments: readonly ShipmentForFreight[],
  existingRefs: readonly string[],
): { ok: true; lines: FreightLine[] } | { ok: false; error: string } {
  const lines: FreightLine[] = []
  const seen = new Set<string>()
  const known = new Map<string, ShipmentForFreight>()
  for (const row of shipments) {
    const id = canonicalShipmentId(row.shipmentRef)
    if (id) known.set(id, { ...row, shipmentRef: id })
  }
  const already = new Set(existingRefs.map((ref) => ref.trim()).filter(Boolean))
  for (const [index, draft] of drafts.entries()) {
    const where = `Freight line ${index + 1}`
    const date = draft.date.trim()
    if (!realCalendarDate(date)) {
      return { ok: false, error: `${where} needs a real date, written YYYY-MM-DD.` }
    }
    const shipmentRef = canonicalShipmentId(draft.shipmentRef)
    if (!shipmentRef) {
      return { ok: false, error: `${where} needs the shipment id. An order number or a tracking number is not a shipment.` }
    }
    if (seen.has(shipmentRef)) {
      return { ok: false, error: `${where} repeats shipment ${shipmentRef}. Add a different shipment, or remove the extra line.` }
    }
    seen.add(shipmentRef)
    if (already.has(shipmentRef)) {
      return {
        ok: false,
        error: `${where} shipment ${shipmentRef} already has a freight line. The saved line was not replaced.`,
      }
    }
    const shipment = known.get(shipmentRef)
    if (!shipment) return { ok: false, error: `${where} shipment ${shipmentRef} was not found for this client.` }
    if (!shipment.clientId || shipment.clientId !== draft.clientId) {
      return { ok: false, error: `${where} shipment ${shipmentRef} belongs to another client.` }
    }
    const carrierCost = money(draft.carrierCost)
    const markup = money(draft.markup)
    if (carrierCost === null) return { ok: false, error: `${where} needs the carrier cost. It is not assumed.` }
    if (markup === null) return { ok: false, error: `${where} needs the markup. Type 0 if there is none. It is not assumed.` }
    lines.push({
      clientId: draft.clientId,
      date,
      shipmentRef,
      carrierCost,
      markup,
      fullTotal: freightFullTotal(carrierCost, markup),
    })
  }
  return { ok: true, lines }
}

export function freightColumnMissing(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false
  if (error.code === '42703') return true
  return /shipment_ref|freight_cost|freight_markup/i.test(error.message ?? '')
}
