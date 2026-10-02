// Matching a shipment to its legacy weight-band rate, as a pure function.
//
// Extracted from lib/billing/recalculate.ts, which runs unattended from
// api/agent/monitor and reprices EVERY shipment that has a client. What it did
// when it could not find a rate was write `client_rate: 0`, and then
// `profit_loss: 0 - actual_cost` with `is_loss: true` -- a stored, billable
// zero on the largest revenue stream in the system, shown as $0.00 by fifteen
// surfaces that all do `client_rate ?? 0`.
//
// Worse than the zero were the two fallbacks, because a zero at least looks
// odd:
//
//   1. When no rate-card row matched the shipment's carrier/service, the pool
//      became the client's ENTIRE card. A USPS parcel could be billed from a
//      UPS Ground row.
//   2. When no weight band matched, it billed `sorted[sorted.length - 1]`, the
//      HEAVIEST band. That is defensible for a parcel above every band and
//      indefensible for one below every band -- an 8oz parcel against a card
//      starting at 16oz was billed the 20lb rate.
//
// Both produce a real, plausible number from the wrong row. Nothing downstream
// can question it, and no alert can be written for it, because the output is
// indistinguishable from a correct price. This module refuses instead, and says
// which row it wanted and could not find.
//
// Pure, so the decision can be tested without a database: the project has no
// test database and the live one holds the figures the business invoices from.

export interface ShippingRateRow {
  /**
   * Admits string because numeric(10,2) over PostgREST is not a shape worth
   * betting a billing path on, and null because the column has no NOT NULL.
   * Coerced and checked for finiteness rather than trusted.
   */
  rate: number | string | null
  /** Both bounds nullable, and null means unbounded on that side. */
  weight_min?: number | null
  weight_max?: number | null
  /** Empty or null means "any", which is how a blanket card row is written. */
  carrier?: string | null
  service?: string | null
}

export interface PricedShipment {
  /** null means UNKNOWN. Never 0 -- 0 is a price, and the wrong one. */
  rate: number | null
  /** null exactly when `rate` is non-null. Says what is missing, not just that something is. */
  reason: string | null
}

/**
 * Preserved exactly as recalculate.ts had it, bidirectional substring and all,
 * because this function's job is to stop the fallbacks -- not to reprice
 * shipments that match today. A stricter rule would change live numbers for a
 * reason unrelated to the defect being fixed, and that is a separate decision
 * with a separate blast radius.
 *
 * An empty or null column on the card row means "any", which is how the
 * blanket card is expressed.
 */
export function cardRowCovers(
  row: ShippingRateRow, carrier: string, service: string,
): boolean {
  const rowCarrier = (row.carrier ?? '').toLowerCase()
  const rowService = (row.service ?? '').toLowerCase()
  const carrierOk = !rowCarrier
    || carrier.includes(rowCarrier) || rowCarrier.includes(carrier)
  const serviceOk = !rowService
    || service.includes(rowService) || rowService.includes(service)
  return carrierOk && serviceOk
}

/** Inclusive on both ends, as `>= weight_min && <= weight_max` always was. */
export function bandCovers(row: ShippingRateRow, billedWeightOz: number): boolean {
  // Checked first, and as its own statement rather than left to the two
  // comparisons below. Every comparison against NaN is false, so both of those
  // guards pass and the function would fall through to `return true` -- i.e.
  // claim that this band covers a weight nobody can read, and so would EVERY
  // other band on the card. matchLegacyRate refuses a non-finite weight before
  // it reaches here, but this function is exported and says something on its
  // own: a band does not cover a weight that cannot be read.
  if (!Number.isFinite(billedWeightOz)) return false
  if (row.weight_min != null && billedWeightOz < row.weight_min) return false
  if (row.weight_max != null && billedWeightOz > row.weight_max) return false
  return true
}

function describeBands(rows: ShippingRateRow[]): string {
  return rows
    .map((r) => `${r.weight_min ?? 'open'}-${r.weight_max ?? 'open'}oz`)
    .join(', ')
}

/**
 * @param card  the client's WHOLE legacy shipping rate card. Filtering happens
 *              here so that "this client has no card" and "the card does not
 *              cover this carrier" can be reported as themselves; a caller
 *              that pre-filtered would hand over an empty array for both.
 */
export function matchLegacyRate(
  card: ShippingRateRow[],
  carrier: string | null,
  service: string | null,
  billedWeightOz: number,
): PricedShipment {
  if (!Number.isFinite(billedWeightOz)) {
    return {
      rate: null,
      reason: `billed weight is ${JSON.stringify(billedWeightOz)}, so no `
        + `weight band can be chosen. Priced from a weight that cannot be `
        + `read, every band comparison is false and the old code fell through `
        + `to the heaviest one.`,
    }
  }

  if (card.length === 0) {
    return {
      rate: null,
      reason: 'this client has no legacy shipping rate card, so no price has '
        + 'been agreed for any weight',
    }
  }

  const c = (carrier ?? '').toLowerCase()
  const s = (service ?? '').toLowerCase()
  const covering = card.filter((r) => cardRowCovers(r, c, s))

  // Refused, where the old code widened the pool to the whole card. A rate
  // from another carrier's row is not a fallback, it is a different price.
  if (covering.length === 0) {
    const have = [...new Set(card.map(
      (r) => `${r.carrier || 'any'}/${r.service || 'any'}`))].join(', ')
    return {
      rate: null,
      reason: `no rate-card row covers carrier '${carrier ?? ''}' service `
        + `'${service ?? ''}'. The card covers ${have}. A row for another `
        + `carrier is not used as a fallback -- that bills a real amount from `
        + `the wrong agreement. Add a row for this carrier/service.`,
    }
  }

  const inBand = covering.filter((r) => bandCovers(r, billedWeightOz))

  // Refused, where the old code billed the heaviest band. Being outside every
  // band is a gap in the card, and which direction it is outside in decides
  // what the operator has to do, so the message says.
  if (inBand.length === 0) {
    const mins = covering.map((r) => r.weight_min ?? 0)
    const below = billedWeightOz < Math.min(...mins)
    return {
      rate: null,
      reason: `${billedWeightOz}oz falls ${below ? 'below' : 'outside'} every `
        + `weight band on the card for this carrier/service `
        + `(${describeBands(covering)}). The heaviest band is NOT used as a `
        + `fallback -- for a parcel under the lightest band that overcharges `
        + `by the full difference. Add a band covering this weight.`,
    }
  }

  // Coerced BEFORE the ambiguity check, and compared as numbers rather than
  // as strings. numeric(10,2) can arrive as 5 from one row and '5.00' from
  // another; on strings those are two different rates and the shipment would
  // be refused as ambiguous when the card in fact agrees with itself.
  const parsedRates = inBand.map((r) => {
    const raw = r.rate
    return raw === null || raw === undefined || raw === '' ? NaN : Number(raw)
  })

  const badIndex = parsedRates.findIndex((n) => !Number.isFinite(n))
  if (badIndex !== -1) {
    return {
      rate: null,
      reason: `the rate-card row covering ${billedWeightOz}oz `
        + `(${describeBands([inBand[badIndex]])}) carries no usable rate `
        + `(${JSON.stringify(inBand[badIndex].rate)}), so this shipment `
        + `cannot be priced. Fill in that rate.`,
    }
  }

  const distinct = new Set(parsedRates)

  // Overlapping bands with different rates. Nothing constrains them, and
  // picking one by sort order bills a real amount from an arbitrary row -- the
  // same failure the zone-rate exclusion constraint was added to stop
  // elsewhere.
  if (distinct.size > 1) {
    return {
      rate: null,
      reason: `${inBand.length} rate-card rows cover ${billedWeightOz}oz with `
        + `different rates (${[...distinct].join(', ')}; bands `
        + `${describeBands(inBand)}), so which one applies is ambiguous. `
        + `Narrow the overlapping bands.`,
    }
  }

  const parsed = parsedRates[0]

  // 0 is returned as 0. A card row that says 0 is one somebody wrote a 0 on,
  // which is a different statement from the card not covering the shipment --
  // and that distinction is what this whole module exists to keep.
  return { rate: parsed, reason: null }
}

/**
 * The profit on a shipment, or UNKNOWN.
 *
 * `clientRate - (actual_cost ?? 0)` treated a missing carrier invoice as free
 * carriage, which reports the full rate as profit -- the most flattering
 * possible reading of the one number that says whether the business is making
 * money. A null cost is not zero cost.
 */
export function shipmentProfit(
  clientRate: number | null, actualCost: number | string | null | undefined,
): { profitLoss: number | null; isLoss: boolean; reason: string | null } {
  if (clientRate === null) {
    return { profitLoss: null, isLoss: false, reason: 'the shipment has no rate' }
  }
  const cost = actualCost === null || actualCost === undefined || actualCost === ''
    ? NaN
    : Number(actualCost)
  if (!Number.isFinite(cost)) {
    return {
      profitLoss: null,
      isLoss: false,
      reason: `actual_cost is ${JSON.stringify(actualCost)}, so profit cannot `
        + `be computed. It is not treated as 0 -- that would report the whole `
        + `rate as profit on a shipment whose carrier cost is simply not in `
        + `yet.`,
    }
  }
  const profitLoss = Math.round((clientRate - cost) * 100) / 100
  // is_loss stays false when profit is UNKNOWN. The column drives a loss
  // report; a shipment of unknown profit is not evidence of a loss, and
  // filling the report with unknowns is how a real loss stops being noticed.
  return { profitLoss, isLoss: profitLoss < 0, reason: null }
}
