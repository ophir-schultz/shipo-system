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
  rateCard,
  costRates,
}

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
  it('leaves shelf cost null rather than zero', () => {
    const out = buildStorageCharges({ ...base, palletPositions: 0, shelfPositions: 3 })
    expect(out[0].cost).toBeNull()
    expect(out[0].cost_basis).toBeNull()
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
})
