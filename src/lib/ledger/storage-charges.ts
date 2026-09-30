import { findCostRate, costOf, type CostRateRow } from '@/lib/ledger/cost-rate'
import { cents } from '@/lib/ledger/calculate-charges'
import type { BuiltCharge, RateCardLine } from '@/lib/ledger/calculate-charges'

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
  rateCard: RateCardLine[]          // must carry effectiveFrom/effectiveTo for date-match
  costRates: CostRateRow[]
}

export function buildStorageCharges(input: StorageInput): StorageCharge[] {
  const out: StorageCharge[] = []

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
    // id, matching calculate-charges.ts:91-94.
    if (candidates.length > 1) {
      candidates.sort((a, b) =>
        (b.effectiveFrom ?? '').localeCompare(a.effectiveFrom ?? '')
        || a.id.localeCompare(b.id))
    }
    return candidates[0]
  }

  const line = (variant: 'pallet' | 'shelf', qty: number | null, costType: string | null) => {
    // null means undeclared and 0 means "stored nothing". Neither bills, but
    // they are different facts and only the first should ever be chased up.
    if (qty === null || qty <= 0) return

    const rate = rateFor(variant)
    if (!rate || rate.rate === null) return

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
      // Not chargeKey(): that shape keys storage on the month alone, which
      // would collide pallet and shelf onto one row. The variant has to be in
      // the key, and (client_id, charge_key) is the index it must be unique on.
      charge_key: `storage:${input.periodMonth}:${variant}`,
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
      is_estimate: !lookup?.known || lookup.basis === 'estimated',
    })
  }

  line('pallet', input.palletPositions, 'storage')
  // No cost rate exists for shelf storage. Passing null leaves cost null rather
  // than borrowing the pallet rate, which would be inventing a number.
  line('shelf', input.shelfPositions, null)

  return out
}
