import { shipmentIdFromChargeKey } from '@/lib/billing/statement-detail'
import type { BuiltCharge } from '@/lib/ledger/calculate-charges'
import type { ChargeType } from '@/lib/ledger/charge-key'

// An approved zone price is a shipping charge whose source is
// zone_client_rate. The amount and the unit rate are the client rate
// already stored on the label. calculate-charges.ts prices the same
// charge_key from the warehouse rate card, and the upsert replaces the
// whole row. An at-cost card, or a card that leaves the amount unknown,
// would otherwise downgrade that approved price on the next run.
//
// This does not invent a price. A zone row is kept. A saved full freight
// total stays on the statement. It is not copied onto a calculator row,
// and it is not written as a second charge. Two prices, a date that does
// not match, or a void against an approved zone price are flagged and
// the stored approved price stays.

export const APPROVED_ZONE_SOURCE = 'zone_client_rate'

/** Recorded on sync_runs.mode. The date-repair apply refuses any other mode. */
export const PRESERVE_STORED_MODE = 'preserve_stored'

export interface StoredChargeIdentity {
  order_id: string
  client_id: string | null
  charge_key: string
  charge_type: ChargeType
  label: string
  quantity: number | null
  unit_rate: number | null
  amount: number | null
  cost: number | null
  cost_basis: string | null
  rate_id: string | null
  cost_rate_id: string | null
  charge_date: string
  charge_date_source: string
  source: string
  is_estimate: boolean
}

export interface StoredShippingCharge {
  order_id: string
  client_id: string | null
  charge_key: string
  charge_type: 'shipping'
  label: string
  quantity: number | null
  unit_rate: number | null
  amount: number | null
  cost: number | null
  cost_basis: string | null
  rate_id: string | null
  cost_rate_id: string | null
  charge_date: string
  charge_date_source: string
  source: string
  is_estimate: boolean
}

export interface ApprovedManual {
  clientId: string
  shipmentId: string
  amount: number
  logDate: string
}

function cents(value: number): number {
  return Math.round(Number((value * 100).toPrecision(12)))
}

function sameMoney(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return a === b
  return cents(a) === cents(b)
}

function shown(value: number | null): string {
  return value === null ? 'unknown' : value.toFixed(2)
}

function keptZone(stored: StoredShippingCharge): BuiltCharge {
  return {
    order_id: stored.order_id,
    client_id: stored.client_id,
    charge_key: stored.charge_key,
    charge_type: 'shipping',
    label: stored.label,
    quantity: stored.quantity,
    unit_rate: stored.unit_rate,
    amount: stored.amount,
    cost: stored.cost,
    cost_basis: stored.cost_basis,
    rate_id: stored.rate_id,
    cost_rate_id: stored.cost_rate_id,
    charge_date: stored.charge_date,
    charge_date_source: stored.charge_date_source,
    source: APPROVED_ZONE_SOURCE,
    is_estimate: stored.is_estimate,
  }
}

function atCostShape(charge: BuiltCharge): boolean {
  return charge.charge_type === 'shipping'
    && charge.label === 'Shipping'
    && charge.unit_rate === null
    && shipmentIdFromChargeKey(charge.charge_key) !== null
}

function manualsFor(charge: BuiltCharge, manuals: readonly ApprovedManual[]): ApprovedManual[] {
  const shipmentId = shipmentIdFromChargeKey(charge.charge_key)
  if (!shipmentId || !charge.client_id) return []
  return manuals.filter((manual) =>
    manual.clientId === charge.client_id && manual.shipmentId === shipmentId)
}

function applyManual(
  charge: BuiltCharge,
  manuals: readonly ApprovedManual[],
  flags: string[],
): BuiltCharge {
  // The statement already shows one full total. This writer does not copy
  // that total onto the ledger row: doing so on a recalculation would
  // change a price that was already billed. One shipping key is kept, and
  // a disagreement is flagged instead of becoming a second charge.
  if (charge.charge_type !== 'shipping') return charge
  const links = manualsFor(charge, manuals)
  const shipmentId = shipmentIdFromChargeKey(charge.charge_key)
  if (links.length === 0 || !shipmentId) return charge
  if (!atCostShape(charge)) {
    flags.push(
      `Shipment ${shipmentId} already has a unit rate. The manual freight line was not applied.`,
    )
    return charge
  }
  if (links.length !== 1) {
    flags.push(
      `Shipment ${shipmentId} has ${links.length} manual freight lines. The calculator amount was not replaced.`,
    )
    return charge
  }
  const link = links[0]
  if (link.logDate !== charge.charge_date) {
    flags.push(
      `Shipment ${shipmentId} manual date ${link.logDate} is not the charge date ${charge.charge_date}. The calculator amount was not replaced.`,
    )
    return charge
  }
  flags.push(
    `Shipment ${shipmentId} has one manual full total ${shown(link.amount)}. `
    + `The calculator amount ${shown(charge.amount)} was not replaced, and no second charge was added.`,
  )
  return charge
}

export function retainApprovedShipping(
  built: readonly BuiltCharge[],
  stored: readonly StoredShippingCharge[],
  manuals: readonly ApprovedManual[] = [],
  options?: { cancelled?: boolean },
): { charges: BuiltCharge[]; flags: string[] } {
  const flags: string[] = []
  const zones = new Map<string, StoredShippingCharge>()
  for (const row of stored) {
    if (row.source !== APPROVED_ZONE_SOURCE || row.charge_type !== 'shipping') continue
    zones.set(row.charge_key, row)
  }

  if (options?.cancelled) {
    for (const zone of zones.values()) {
      flags.push(
        `Order ${zone.order_id} is cancelled. Approved zone price ${zone.charge_key} was not carried forward.`,
      )
    }
    return { charges: [...built], flags }
  }

  const out: BuiltCharge[] = []
  for (const charge of built) {
    const zone = charge.charge_type === 'shipping' ? zones.get(charge.charge_key) : undefined
    if (!zone) {
      out.push(applyManual(charge, manuals, flags))
      continue
    }
    zones.delete(charge.charge_key)
    out.push(keptZone(zone))
    const shipmentId = shipmentIdFromChargeKey(charge.charge_key) ?? charge.charge_key
    if (manualsFor(charge, manuals).length > 0) {
      flags.push(
        `Shipment ${shipmentId} already has an approved zone price. The manual freight line was not applied.`,
      )
    }
    const amountDiffers = !sameMoney(charge.amount, zone.amount)
    const rateDiffers = !sameMoney(charge.unit_rate, zone.unit_rate)
    const dateDiffers = charge.charge_date !== zone.charge_date
    if (amountDiffers || rateDiffers || dateDiffers) {
      flags.push(
        `Shipment ${shipmentId} keeps approved zone price ${shown(zone.amount)}. `
        + `The calculator would have written ${shown(charge.amount)} on ${charge.charge_date}. `
        + `The approved price was not replaced.`,
      )
    }
  }

  for (const zone of zones.values()) {
    out.push(keptZone(zone))
    const shipmentId = shipmentIdFromChargeKey(zone.charge_key) ?? zone.charge_key
    flags.push(
      `Shipment ${shipmentId} keeps approved zone price ${shown(zone.amount)}. `
      + `The calculator did not rebuild ${zone.charge_key}. The approved price was not replaced.`,
    )
  }

  return { charges: out, flags }
}

function fromStored(row: StoredChargeIdentity): BuiltCharge {
  return {
    order_id: row.order_id,
    client_id: row.client_id,
    charge_key: row.charge_key,
    charge_type: row.charge_type,
    label: row.label,
    quantity: row.quantity,
    unit_rate: row.unit_rate,
    amount: row.amount,
    cost: row.cost,
    cost_basis: row.cost_basis,
    rate_id: row.rate_id,
    cost_rate_id: row.cost_rate_id,
    charge_date: row.charge_date,
    charge_date_source: row.charge_date_source,
    source: row.source,
    is_estimate: row.is_estimate,
  }
}

/**
 * Keep the stored date and amount on a charge that already exists.
 *
 * A new row keeps the calculator's date, including a carrier day. A row
 * that is already stored keeps that stored date and amount, so a deploy
 * does not rewrite history, and a later approved date repair stays where
 * it was written. A cancelled order is left to the existing empty build.
 */
export function preserveStoredCharges(
  built: readonly BuiltCharge[],
  stored: readonly StoredChargeIdentity[],
  options?: { cancelled?: boolean },
): { charges: BuiltCharge[]; flags: string[] } {
  if (options?.cancelled) return { charges: [...built], flags: [] }
  const flags: string[] = []
  const byKey = new Map(stored.map((row) => [row.charge_key, row]))
  const seen = new Set<string>()
  const out: BuiltCharge[] = []
  for (const charge of built) {
    const prev = byKey.get(charge.charge_key)
    if (!prev) {
      out.push(charge)
      continue
    }
    seen.add(charge.charge_key)
    out.push(fromStored(prev))
    if (charge.charge_date !== prev.charge_date || !sameMoney(charge.amount, prev.amount)) {
      flags.push(
        `Kept stored ${charge.charge_key} on ${prev.charge_date} at ${shown(prev.amount)}. `
        + `The calculator would have written ${charge.charge_date} at ${shown(charge.amount)}.`,
      )
    }
  }
  for (const prev of byKey.values()) {
    if (seen.has(prev.charge_key)) continue
    out.push(fromStored(prev))
    flags.push(`Kept stored ${prev.charge_key}. The calculator did not rebuild it.`)
  }
  return { charges: out, flags }
}
