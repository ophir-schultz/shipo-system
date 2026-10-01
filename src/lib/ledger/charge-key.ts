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

/**
 * Every value `order_charges.charge_type` is allowed to hold.
 *
 * A runtime array with the type derived from it, rather than a bare union,
 * because this list has to exist in two languages. Three views select on exact
 * literals of it -- leaks_monthly's picked_never_billed and
 * shipped_never_billed (ledger_04_views.sql:185, :224) and
 * labour_variance_inputs (:464) -- so the column is really an enum that
 * Postgres was never told about, and ledger_03_charges.sql now carries the
 * matching check constraint. SQL cannot import a TypeScript union, so the
 * second copy is unavoidable; what is avoidable is the two copies drifting
 * apart silently, and charge-key.test.ts reads the literal list back out of
 * the .sql file and asserts it equals this array. Adding a charge type in one
 * language and not the other is then a failing test rather than a leak report
 * that quietly stops mentioning a category.
 *
 * `as const` is what makes the derived type a union of literals instead of
 * `string`, so dropping the assertion silently turns ChargeType into string
 * and disarms every use below.
 */
export const CHARGE_TYPES = [
  'shipping', 'pick', 'pack', 'material',
  'storage', 'receiving', 'surcharge', 'return',
] as const

export type ChargeType = (typeof CHARGE_TYPES)[number]

export class BlankIdentifierError extends Error {
  constructor(field: string, chargeType: ChargeType) {
    super(`Cannot build a charge_key for '${chargeType}': ${field} is blank.`)
    this.name = 'BlankIdentifierError'
  }
}

export type ChargeKeyInput =
  | { chargeType: 'shipping'; shipmentId: string }
  // Its own shape rather than sharing shipping's, so that the two cannot be
  // written as one `case` again. See the 'return' arm below for what that cost.
  | { chargeType: 'return'; shipmentId: string }
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
      return `shipment:${require_(input.shipmentId, 'shipmentId', input.chargeType)}`

    // A RETURN IS NOT THE SHIPMENT IT REVERSES. These two shared one `case` and
    // therefore one key: a return on an already-billed label produced
    // 'shipment:<id>', the same string the outbound shipping charge had already
    // claimed, and (order_id, charge_key) is unique. The upsert does not fail —
    // it UPDATES — so the return would have silently overwritten the shipping
    // charge it was meant to sit beside. Outbound revenue replaced by a credit,
    // one row where there should be two, and no error on any surface.
    //
    // This is the storage bug one paragraph up, repeated: two different facts
    // computing the same identity. It was dormant only because nothing emits
    // charge_type 'return' yet — the trap was armed and waiting for whoever
    // wrote the returns path, which is the worst way for this to be discovered.
    //
    // 'return:' is its own namespace rather than 'shipment:<id>:return' because
    // the surcharge arm below builds 'shipment:<id>:<code>' from a carrier-
    // supplied code. A carrier that ever names a surcharge 'return' would
    // reintroduce exactly this collision, and nothing in that path validates
    // the code against a list. A separate prefix cannot be reached that way.
    case 'return':
      return `return:${require_(input.shipmentId, 'shipmentId', input.chargeType)}`

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
