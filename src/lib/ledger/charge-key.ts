/**
 * Deterministic identity for a row in `order_charges`.
 *
 * The monitor cron runs three times a day and recalculates charges each time.
 * An insert-only calculator would therefore triple every charge daily. The key
 * is derived from the record the charge is ABOUT, so the same input always
 * produces the same key and recalculation becomes an upsert.
 *
 * See the ledger spec, section 5.2.
 */

export type ChargeType =
  | 'shipping' | 'pick' | 'pack' | 'material'
  | 'storage' | 'receiving' | 'surcharge' | 'return'

export class BlankIdentifierError extends Error {
  constructor(field: string, chargeType: ChargeType) {
    super(`Cannot build a charge_key for '${chargeType}': ${field} is blank.`)
    this.name = 'BlankIdentifierError'
  }
}

export type ChargeKeyInput =
  | { chargeType: 'shipping' | 'return'; shipmentId: string }
  | { chargeType: 'surcharge'; shipmentId: string; surchargeCode: string }
  | { chargeType: 'pick' | 'pack' | 'receiving'; orderItemId: string }
  | { chargeType: 'material'; orderItemId: string; variant: string }
  // The variant is REQUIRED. Storage is billed as pallet positions and shelf
  // positions separately, and this shape used to key on the month alone: both
  // variants produced 'storage:2026-09-01', the (client_id, charge_key) partial
  // unique index took only the second write, and half the storage revenue
  // disappeared with no error. storage-charges.ts built its key inline to avoid
  // that, which left the trap armed for the next caller to reach for the shared
  // helper. It is now impossible to build a storage key without saying which
  // variant it is.
  | { chargeType: 'storage'; periodMonth: string; variant: string }

/** Blank, whitespace, null and undefined are all refused. */
function require_(value: unknown, field: string, chargeType: ChargeType): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new BlankIdentifierError(field, chargeType)
  }
  return value.trim()
}

export function chargeKey(input: ChargeKeyInput): string {
  switch (input.chargeType) {
    case 'shipping':
    case 'return':
      return `shipment:${require_(input.shipmentId, 'shipmentId', input.chargeType)}`

    case 'surcharge': {
      const id = require_(input.shipmentId, 'shipmentId', input.chargeType)
      const code = require_(input.surchargeCode, 'surchargeCode', input.chargeType)
      return `shipment:${id}:${code}`
    }

    case 'pick':
    case 'pack':
    case 'receiving':
      return `item:${require_(input.orderItemId, 'orderItemId', input.chargeType)}:${input.chargeType}`

    case 'material': {
      const id = require_(input.orderItemId, 'orderItemId', input.chargeType)
      const variant = require_(input.variant, 'variant', input.chargeType)
      return `item:${id}:material:${variant}`
    }

    case 'storage': {
      const month = require_(input.periodMonth, 'periodMonth', input.chargeType)
      const variant = require_(input.variant, 'variant', input.chargeType)
      return `storage:${month}:${variant}`
    }
  }
}
