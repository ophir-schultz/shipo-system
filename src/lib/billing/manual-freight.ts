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

function money(value: unknown): number | null {
  const n = priceOf(value)
  if (n === null || n < 0) return null
  return n
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
  const known = new Map(shipments.map((row) => [row.shipmentRef, row]))
  const already = new Set(existingRefs.map((ref) => ref.trim()).filter(Boolean))
  for (const [index, draft] of drafts.entries()) {
    const where = `Freight line ${index + 1}`
    const date = draft.date.trim()
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return { ok: false, error: `${where} needs a date, written YYYY-MM-DD.` }
    }
    const shipmentRef = draft.shipmentRef.trim()
    if (!shipmentRef) return { ok: false, error: `${where} needs a shipment.` }
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
    if (shipment.clientId !== draft.clientId) {
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
