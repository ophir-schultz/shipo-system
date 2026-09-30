import { describe, it, expect } from 'vitest'
import { buildStorageCharges } from '@/lib/ledger/storage-charges'

// effectiveFrom: null / effectiveTo: null means "always in effect", which is
// the correct state for these test fixtures. The brief declared the objects
// without these fields; Ruling 11 requires them to be added.
const rateCard = [
  { id: 'rs', chargeType: 'storage', variant: 'pallet', rate: 25, rateType: 'per_pallet',
    effectiveFrom: null, effectiveTo: null },
  { id: 'rh', chargeType: 'storage', variant: 'shelf',  rate: 12, rateType: 'per_shelf',
    effectiveFrom: null, effectiveTo: null },
]

const costRates = [
  { id: 'cs', cost_type: 'storage', variant: null, unit: 'per_pallet_month',
    rate: 12, effective_from: '2026-01-01', effective_to: null, basis: 'estimated' as const },
]

const base = {
  clientId: 'c1',
  periodMonth: '2026-09-01',
  palletPositions: 4,
  shelfPositions: 0,
  // client_storage_months.basis defaults to 'estimated': nothing we integrate
  // with reports pallet positions, so until a warehouse count sheet says
  // otherwise the number is declared, not measured.
  declarationBasis: 'estimated',
  rateCard,
  costRates,
}

/** Collects onWarn calls so a test can assert the finding was NAMED. */
function collector() {
  const seen: Array<{ context: string; detail: string }> = []
  return { seen, warn: (context: string, detail: string) => { seen.push({ context, detail }) } }
}

const shelfLine = (out: ReturnType<typeof buildStorageCharges>) =>
  out.find((c) => c.charge_key.endsWith(':shelf'))!

describe('buildStorageCharges', () => {
  it('bills pallet positions at the card rate', () => {
    const out = buildStorageCharges(base)
    const pallet = out.find((c) => c.charge_key === 'storage:2026-09-01:pallet')!
    expect(pallet.amount).toBe(100)
    expect(pallet.quantity).toBe(4)
    expect(pallet.order_id).toBeNull()
    expect(pallet.client_id).toBe('c1')
  })

  it('bills shelf positions separately from pallets', () => {
    const out = buildStorageCharges({ ...base, palletPositions: 2, shelfPositions: 3 })
    expect(out.find((c) => c.charge_key === 'storage:2026-09-01:pallet')!.amount).toBe(50)
    expect(out.find((c) => c.charge_key === 'storage:2026-09-01:shelf')!.amount).toBe(36)
  })

  // Zero positions is a real, known fact: the client stored nothing. It must
  // raise no charge, but it must also not be confused with "we never asked".
  it('raises no charge for zero positions', () => {
    const out = buildStorageCharges({ ...base, palletPositions: 0, shelfPositions: 0 })
    expect(out).toEqual([])
  })

  // A null count means nobody has declared it. Treating it as 0 would silently
  // bill nothing and look identical to a client who genuinely stored nothing.
  it('raises no charge for a null count, and that is not the same as zero', () => {
    const out = buildStorageCharges({ ...base, palletPositions: null, shelfPositions: null })
    expect(out).toEqual([])
  })

  it('charges the storage cost rate against pallet-months', () => {
    const out = buildStorageCharges(base)
    const pallet = out.find((c) => c.charge_key === 'storage:2026-09-01:pallet')!
    expect(pallet.cost).toBe(48)          // 4 pallets * $12
    expect(pallet.cost_basis).toBe('estimated')
    expect(pallet.is_estimate).toBe(true)
  })

  // Shelf storage has no cost rate of its own. Null, not zero -- a shelf is not
  // free to provide, we simply have not costed it.
  //
  // Indexed by KEY, not by out[0]. With palletPositions 0 the shelf line happens
  // to be first today, but a test that asserts "the shelf cost is null" must
  // fail if the shelf line disappears, not silently start asserting it about
  // whatever row slid into position 0.
  it('leaves shelf cost null rather than zero', () => {
    const out = buildStorageCharges({ ...base, palletPositions: 0, shelfPositions: 3 })
    const shelf = shelfLine(out)
    expect(shelf.cost).toBeNull()
    expect(shelf.cost_basis).toBeNull()
  })

  it('raises nothing when the client has no storage line on their card', () => {
    expect(buildStorageCharges({ ...base, rateCard: [] })).toEqual([])
  })

  // Three crons a day. The key must not move.
  it('produces identical keys on repeated calls', () => {
    expect(buildStorageCharges(base).map((c) => c.charge_key))
      .toEqual(buildStorageCharges(base).map((c) => c.charge_key))
  })

  // charge_date is the first of the billed month, not today. Dating it to the
  // run date would move the charge into whichever month the cron happened to
  // run in, and September's storage would land in October's P&L.
  it('dates the charge to the billed month, not the run date', () => {
    expect(buildStorageCharges(base)[0].charge_date).toBe('2026-09-01')
  })

  // Ruling 11: a storage rate whose effectiveFrom === effectiveTo is the
  // off-switch pattern (see ledger_05_seed_nayax.sql:148-149). The off-switch
  // must produce NO charge — the effective period is an empty half-open interval
  // [from, to) = [2026-09-01, 2026-09-01) which contains no date.
  it('produces no charge when the rate card line is switched off via empty daterange', () => {
    const switchedOffCard = [
      { id: 'rs', chargeType: 'storage', variant: 'pallet', rate: 25, rateType: 'per_pallet',
        effectiveFrom: '2026-09-01', effectiveTo: '2026-09-01' },
    ]
    const out = buildStorageCharges({ ...base, rateCard: switchedOffCard })
    expect(out).toEqual([])
  })

  // --- Ruling 11, the ON half --------------------------------------------
  // The off-switch test above passes for a bare .find() too, as long as the one
  // line in the array is the switched-off one. These two exercise the part that
  // actually needs the dated lookup: choosing BETWEEN lines.

  it('bills the superseding rate, not whichever line comes first in the array', () => {
    // The old rate is listed FIRST, so a bare .find() would return it.
    const succession = [
      { id: 'old', chargeType: 'storage', variant: 'pallet', rate: 25, rateType: 'per_pallet',
        effectiveFrom: null, effectiveTo: '2026-06-01' },
      { id: 'new', chargeType: 'storage', variant: 'pallet', rate: 30, rateType: 'per_pallet',
        effectiveFrom: '2026-06-01', effectiveTo: null },
    ]
    const out = buildStorageCharges({ ...base, rateCard: succession })
    expect(out).toHaveLength(1)
    expect(out[0].rate_id).toBe('new')
    expect(out[0].unit_rate).toBe(30)
    expect(out[0].amount).toBe(120)          // 4 pallets * $30
  })

  // Two lines genuinely in effect on the same day is a data error on the rate
  // card. The choice must be deterministic — latest start wins — AND it must be
  // named, because a silent arbitrary pick is the failure mode this whole task
  // exists to stop (calculate-charges.ts:88-92).
  it('tie-breaks overlapping rates deterministically and says so', () => {
    const overlapping = [
      { id: 'a', chargeType: 'storage', variant: 'pallet', rate: 25, rateType: 'per_pallet',
        effectiveFrom: null, effectiveTo: '2026-06-01' },
      { id: 'b', chargeType: 'storage', variant: 'pallet', rate: 30, rateType: 'per_pallet',
        effectiveFrom: '2026-06-01', effectiveTo: null },
      { id: 'c', chargeType: 'storage', variant: 'pallet', rate: 40, rateType: 'per_pallet',
        effectiveFrom: '2026-08-01', effectiveTo: null },
    ]
    const w = collector()
    const out = buildStorageCharges({ ...base, rateCard: overlapping }, w.warn)
    expect(out).toHaveLength(1)
    expect(out[0].rate_id).toBe('c')         // latest effectiveFrom wins
    expect(out[0].amount).toBe(160)
    expect(w.seen.map((x) => x.context)).toContain('ambiguous storage rate')
    expect(w.seen[0].detail).toContain('c')
  })

  // --- Ruling 12: the canonical `cents` ----------------------------------
  // DO NOT "simplify" cents back to Math.round(n * 100) / 100. Both
  // client_warehouse_rates.rate and client_storage_months.pallet_positions are
  // numeric(10,2), so a four-decimal product is reachable with ordinary data,
  // and on an exact half-cent the naive form takes it DOWN and underbills:
  // 16.49 * 0.5 = 8.245, whose float representation is 824.5000000000001 before
  // rounding in one form and 824.4999... in the other. Every fixture above uses
  // values on which the two agree, which is why this case is here on its own.
  it('rounds an exact half-cent UP, as calculate-charges.cents does', () => {
    const halfCentCard = [
      { id: 'rs', chargeType: 'storage', variant: 'pallet', rate: 16.49, rateType: 'per_pallet',
        effectiveFrom: null, effectiveTo: null },
    ]
    const out = buildStorageCharges({
      ...base, rateCard: halfCentCard, palletPositions: 0.5, shelfPositions: 0,
    })
    expect(out).toHaveLength(1)
    expect(out[0].amount).toBe(8.25)
    expect(out[0].amount).not.toBe(8.24)
  })

  // --- m1: absence versus corruption -------------------------------------
  // `NaN <= 0` is false, so the single guard this replaced let NaN through. On
  // the shelf branch there was no cost lookup to throw on it either, so the row
  // was built with quantity: NaN and amount: NaN — which JSON.stringify sends to
  // Postgres as null, i.e. a shelf charge of "unknown" that nobody asked for.
  it('throws on a corrupt pallet count rather than billing it', () => {
    expect(() => buildStorageCharges({ ...base, palletPositions: NaN }))
      .toThrow(RangeError)
  })

  it('throws on a corrupt SHELF count too, where there is no cost lookup to catch it', () => {
    expect(() => buildStorageCharges({ ...base, palletPositions: 0, shelfPositions: NaN }))
      .toThrow(RangeError)
    // And the row is never built, so no NaN can reach the database.
    let out: ReturnType<typeof buildStorageCharges> = []
    try { out = buildStorageCharges({ ...base, palletPositions: 0, shelfPositions: NaN }) }
    catch { /* expected */ }
    expect(out).toEqual([])
  })

  it('throws on a negative count, which would otherwise be a credit', () => {
    expect(() => buildStorageCharges({ ...base, palletPositions: -2 }))
      .toThrow(RangeError)
  })

  // --- m6: the declaration basis -----------------------------------------
  // A guessed pallet count and a counted one otherwise produce identical
  // charges. basis <> 'measured' forces is_estimate regardless of how certain
  // the cost side is.
  it('marks a charge as an estimate when the COUNT was declared, not counted', () => {
    const measuredCost = [{
      id: 'cs', cost_type: 'storage', variant: null, unit: 'per_pallet_month',
      rate: 12, effective_from: '2026-01-01', effective_to: null, basis: 'measured' as const,
    }]
    const declared = buildStorageCharges({
      ...base, costRates: measuredCost, declarationBasis: 'estimated' })
    expect(declared[0].cost_basis).toBe('measured')   // the COST is measured...
    expect(declared[0].is_estimate).toBe(true)        // ...but the COUNT is not

    const counted = buildStorageCharges({
      ...base, costRates: measuredCost, declarationBasis: 'measured' })
    expect(counted[0].is_estimate).toBe(false)
  })

  it('treats a null basis as not measured, which is the safe direction', () => {
    const measuredCost = [{
      id: 'cs', cost_type: 'storage', variant: null, unit: 'per_pallet_month',
      rate: 12, effective_from: '2026-01-01', effective_to: null, basis: 'measured' as const,
    }]
    const out = buildStorageCharges({
      ...base, costRates: measuredCost, declarationBasis: null })
    expect(out[0].is_estimate).toBe(true)
  })

  // --- m10: rate_type is not decoration ----------------------------------
  // A hand-entered cost_plus line with rate 15.00 means cost + 15%, not $15 a
  // pallet. Multiplying it by 4 bills $60 against a true figure near $55.
  it('refuses to multiply a rate type it cannot read, and names it', () => {
    const costPlusCard = [
      { id: 'rs', chargeType: 'storage', variant: 'pallet', rate: 15, rateType: 'cost_plus',
        effectiveFrom: null, effectiveTo: null },
    ]
    const w = collector()
    const out = buildStorageCharges({ ...base, rateCard: costPlusCard }, w.warn)
    expect(out).toEqual([])
    expect(w.seen.map((x) => x.context)).toContain('unsupported storage rate type')
    expect(w.seen[0].detail).toContain('cost_plus')
  })

  it('accepts the flat per-position rate types the Nayax card actually uses', () => {
    const out = buildStorageCharges({ ...base, palletPositions: 2, shelfPositions: 3 })
    expect(out.map((c) => c.amount)).toEqual([50, 36])
  })
})
