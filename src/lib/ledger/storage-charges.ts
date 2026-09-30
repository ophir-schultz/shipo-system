import { chargeKey } from '@/lib/ledger/charge-key'
import { findCostRate, costOf, type CostRateRow } from '@/lib/ledger/cost-rate'
import { cents } from '@/lib/ledger/calculate-charges'
import type { BuiltCharge, ChargeWarn, RateCardLine } from '@/lib/ledger/calculate-charges'

// Storage charges have no order_id — they belong to a client and a month, not
// to any order. BuiltCharge.order_id is `string`, so we narrow it to `null`
// here rather than widening BuiltCharge (which would ripple into persist-charges
// and Task 14's stale-delete). Any field added to BuiltCharge later propagates
// automatically because we Omit then re-add.
export type StorageCharge = Omit<BuiltCharge, 'order_id'> & { order_id: null }

export interface StorageInput {
  clientId: string
  periodMonth: string               // always a month start, YYYY-MM-01
  palletPositions: number | null    // null = nobody has declared it
  shelfPositions: number | null
  /**
   * client_storage_months.basis — how the counts were arrived at.
   *
   * The governing principle of this ledger applied to its own input. A GUESSED
   * pallet count and a COUNTED one otherwise produce identical charges, so
   * without this the two are indistinguishable downstream. Anything other than
   * 'measured' forces is_estimate = true however certain the COST side happens
   * to be. Null reads as "not measured" — the safe direction, since an absent
   * basis is not evidence that somebody counted.
   */
  declarationBasis: string | null
  rateCard: RateCardLine[]          // must carry effectiveFrom/effectiveTo for date-match
  costRates: CostRateRow[]
}

/**
 * Rate types whose amount is `rate × positions`.
 *
 * A storage line entered as `cost_plus` or `percentage` means something else
 * entirely: `cost_plus` with rate 15.00 means cost plus 15%, and multiplying it
 * by 4 pallets bills $60 against a true figure of roughly $55. Multiplying a
 * rate we do not know how to read is the flattering-direction failure this
 * ledger exists to stop, so an unrecognised rate type raises NO charge and is
 * named through onWarn instead. The caller counts that month as unpriced, which
 * is the same treatment a missing rate card line gets — both mean "nobody has
 * told us what to bill".
 */
const FLAT_STORAGE_RATE_TYPES: ReadonlySet<string> = new Set([
  'per_pallet', 'per_shelf', 'per_position', 'per_unit',
  'per_pallet_month', 'per_shelf_month',
])

export function buildStorageCharges(
  input: StorageInput,
  onWarn?: ChargeWarn,
): StorageCharge[] {
  const out: StorageCharge[] = []
  const who = `client ${input.clientId} ${input.periodMonth}`

  // Ruling 11: apply the same inEffect test as calculate-charges uses for the
  // billing rate lookup. effectiveFrom inclusive, effectiveTo exclusive, matched
  // against input.periodMonth. A rate whose effectiveFrom === effectiveTo is the
  // off-switch pattern (empty half-open interval) and must produce no charge.
  // A bare .find() lets a superseded or switched-off rate still bill.
  const inEffect = (r: RateCardLine) =>
    (r.effectiveFrom === null || r.effectiveFrom <= input.periodMonth)
    && (r.effectiveTo === null || input.periodMonth < r.effectiveTo)

  const rateFor = (variant: 'pallet' | 'shelf'): RateCardLine | undefined => {
    const candidates = input.rateCard.filter(
      (r) => r.chargeType === 'storage' && r.variant === variant && inEffect(r))
    if (candidates.length === 0) return undefined
    // More than one in effect: deterministic tie-break, latest-start-first then
    // id, matching calculate-charges.ts:93-96.
    //
    // The sort alone is not the fix. calculate-charges states the rule beside
    // its copy: "Picking one arbitrarily and silently is the failure mode this
    // whole task exists to stop, so it is named." An overlapping rate card is a
    // data error a person has to correct, and a deterministic-but-unannounced
    // choice only guarantees it is wrong the same way every run.
    if (candidates.length > 1) {
      candidates.sort((a, b) =>
        (b.effectiveFrom ?? '').localeCompare(a.effectiveFrom ?? '')
        || a.id.localeCompare(b.id))
      onWarn?.('ambiguous storage rate', `${who}: ${candidates.length} storage/`
        + `${variant} rates are in effect on ${input.periodMonth}; `
        + `using ${candidates[0].id}`)
    }
    return candidates[0]
  }

  const line = (variant: 'pallet' | 'shelf', qty: number | null, costType: string | null) => {
    // ABSENCE versus CORRUPTION, split the way calculate-charges.ts:108-115
    // splits them.
    //
    //   null / undefined  nobody has declared it. Normal. No charge.
    //   0                 the client stored nothing. A real, known fact. No charge.
    //   NaN / -3          corrupt. A person has to fix it, so it throws.
    //
    // The single `qty <= 0` guard this replaces let NaN straight through —
    // `NaN <= 0` is false. On the pallet branch costOf() then threw, which was
    // loud and correct; on the SHELF branch costType is null so costOf is never
    // called and there was no guard at all, so the row was built with
    // quantity: NaN and amount: NaN, which JSON.stringify sends to Postgres as
    // null. A shelf charge of "unknown" that nobody asked for.
    if (qty === null || qty === undefined) return
    if (!Number.isFinite(qty) || qty < 0) {
      throw new RangeError(
        `buildStorageCharges: ${who}: ${variant} positions must be a finite `
        + `number >= 0, got ${qty}`)
    }
    if (qty === 0) return

    const rate = rateFor(variant)
    if (!rate || rate.rate === null) return

    // rateType is not decoration. See FLAT_STORAGE_RATE_TYPES.
    if (!FLAT_STORAGE_RATE_TYPES.has(rate.rateType)) {
      onWarn?.('unsupported storage rate type', `${who}: the storage/${variant} `
        + `line ${rate.id} has rate_type '${rate.rateType || 'none'}', which is not a `
        + `flat per-position rate. No storage charge was raised — multiplying a rate `
        + `whose meaning we cannot read would put a wrong number on an invoice.`)
      return
    }

    // Ruling 8: no `variant` key in this call. The storage COST row in
    // ledger_06_seed_cost_rates.sql has variant = NULL. Passing variant: 'pallet'
    // here would match nothing and every storage charge would land un-costed.
    // findCostRate does `query.variant ?? null`, so omitting the key and passing
    // variant-NULL are equivalent.
    const lookup = costType
      ? findCostRate(input.costRates, { costType, chargeDate: input.periodMonth })
      : null
    const cost = lookup ? costOf(lookup, qty) : null

    out.push({
      // Storage belongs to a client and a month, not to an order. This is the
      // row the client-keyed partial unique index in Task 9 exists for.
      order_id: null,
      client_id: input.clientId,
      // chargeKey() now REQUIRES the variant for storage, so the shared helper
      // can no longer produce the month-only key that collided pallet onto
      // shelf. Called rather than built inline so there is exactly one
      // definition of the shape — the persist module's stale-sweep matches on
      // the `storage:<month>:` prefix and has to be able to rely on it.
      charge_key: chargeKey({
        chargeType: 'storage', periodMonth: input.periodMonth, variant,
      }),
      charge_type: 'storage',
      label: variant === 'pallet' ? 'Pallet position' : 'Shelf',
      quantity: qty,
      unit_rate: rate.rate,
      amount: cents(rate.rate * qty),
      cost: cost === null ? null : cents(cost),
      cost_basis: lookup?.known ? lookup.basis : null,
      rate_id: rate.id,
      cost_rate_id: lookup?.known ? lookup.rateId : null,
      // The billed month, never the run date.
      charge_date: input.periodMonth,
      charge_date_source: 'period_month',
      source: 'calculator',
      // Three independent ways this number can be soft, and any one of them is
      // enough: the cost is unknown, the cost rate is itself an estimate, or the
      // QUANTITY was declared rather than counted (declarationBasis).
      is_estimate: !lookup?.known
        || lookup.basis === 'estimated'
        || input.declarationBasis !== 'measured',
    })
  }

  line('pallet', input.palletPositions, 'storage')
  // No cost rate exists for shelf storage. Passing null leaves cost null rather
  // than borrowing the pallet rate, which would be inventing a number.
  line('shelf', input.shelfPositions, null)

  return out
}
