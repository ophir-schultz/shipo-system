// Proof for the two-track qualification. Run: npx tsx scripts/check-referral-qualification.ts
//
// This exists because the bonus gate decides real money and the two
// service lines fail in opposite directions: a units-only bar pays
// nothing on DTC, a revenue-only bar pays a Founding Partner for an
// account well under the volume they were promised the $500 for.

import {
  computeOwed,
  qualifyBars,
  qualifiesInMonth,
  bonusAmount,
  REFERRAL_TERMS,
  type ReferralPartner,
  type ReferredClient,
  type FbaInvoice,
} from '../src/lib/referrals'

let failures = 0
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`)
}

const standing: ReferralPartner = { id: 'p1', name: 'Standing Partner', company: null, status: 'active' }
const founding: ReferralPartner = {
  id: 'p2', name: 'Founding Partner', company: null, status: 'active',
  signup_bonus_amount: 500, bonus_min_units: 2000, bonus_min_revenue: 2500, founding_partner: true,
}

const inv = (o: Partial<FbaInvoice>): FbaInvoice => ({
  id: 'i', client_id: 'c', period: '2026-10-01', amount: 0, ...o,
})

// ---- bars resolve from the partner row, then the standing terms ----
check('standing bars', qualifyBars(standing), { minRevenue: 500, minUnits: null })
check('founding bars', qualifyBars(founding), { minRevenue: 2500, minUnits: 2000 })
check('standing bonus amount', bonusAmount(standing), 300)
check('founding bonus amount', bonusAmount(founding), 500)

// ---- DTC: no unit count at all, must still qualify on revenue ----
const sb = qualifyBars(standing)
check('DTC $500 billed, 0 units -> qualifies', qualifiesInMonth(inv({ amount: 500 }), sb), true)
check('DTC $499 billed, 0 units -> does not', qualifiesInMonth(inv({ amount: 499 }), sb), false)
check('DTC $3000 billed, units null -> qualifies', qualifiesInMonth(inv({ amount: 3000, units_shipped: null }), sb), true)

// ---- FBA: clears on units even when the dollar bar is not met ----
const fb = qualifyBars(founding)
check('FBA 2001 units, $0 -> qualifies', qualifiesInMonth(inv({ amount: 0, units_shipped: 2001 }), fb), true)
check('FBA exactly 2000 units -> does NOT (more than)', qualifiesInMonth(inv({ amount: 0, units_shipped: 2000 }), fb), false)
check('FBA 1500 units but $2500 billed -> qualifies on revenue', qualifiesInMonth(inv({ amount: 2500, units_shipped: 1500 }), fb), true)
check('FBA 1500 units and $2499 -> does not', qualifiesInMonth(inv({ amount: 2499, units_shipped: 1500 }), fb), false)

// ---- the regression this whole change is about ----
check(
  'DTC referral under a units-ONLY bar would never qualify',
  qualifiesInMonth(inv({ amount: 9999, units_shipped: 0 }), { minRevenue: null, minUnits: 2000 }),
  false,
)

// ---- end to end through computeOwed ----
const client = (id: string, paid: string | null): ReferredClient => ({
  id, name: id, referral_partner_id: 'p2', referral_signup_date: null, referral_first_payment_date: paid,
})

const owed = computeOwed(
  [founding],
  [client('dtc', '2026-10-01'), client('fba', '2026-10-01'), client('small', '2026-10-01')],
  [
    inv({ id: 'a', client_id: 'dtc', amount: 4000, units_shipped: 0 }),
    inv({ id: 'b', client_id: 'fba', amount: 800, units_shipped: 2400 }),
    inv({ id: 'c', client_id: 'small', amount: 300, units_shipped: 40 }),
  ],
  [],
)

const bonuses = owed.filter((l) => l.kind === 'signup_bonus')
const byClient = Object.fromEntries(bonuses.map((b) => [b.clientId, b]))

check('DTC bonus is $500 and owed', [byClient.dtc.amount, byClient.dtc.period], [500, '2026-10'])
check('FBA bonus is $500 and owed', [byClient.fba.amount, byClient.fba.period], [500, '2026-10'])
check('sub-scale client is NOT owed', byClient.small.period, 'awaiting')
console.log(`        small client note: "${byClient.small.note}"`)
console.log(`        fba client note:   "${byClient.fba.note}"`)
console.log(`        dtc client note:   "${byClient.dtc.note}"`)

// ---- a 0 bar on the row means no bar, and must not fall back ----
const noBar: ReferralPartner = { ...standing, bonus_min_revenue: 0 }
check('explicit 0 revenue bar is kept, not replaced by 500', qualifyBars(noBar).minRevenue, 0)

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
