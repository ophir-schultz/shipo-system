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

// Admitted exactly as /api/referrals/partners stamps them: the two
// volume bars set, and bonus_min_revenue deliberately NULL. Ophir's
// approved wording is "more than 500 orders per month or in the FBA
// more than 1500 units per month" — no dollar route.
const founding: ReferralPartner = {
  id: 'p2', name: 'Founding Partner', company: null, status: 'active',
  signup_bonus_amount: 500, bonus_min_units: 1500, bonus_min_orders: 500,
  bonus_min_revenue: null, founding_partner: true,
}

const inv = (o: Partial<FbaInvoice>): FbaInvoice => ({
  id: 'i', client_id: 'c', period: '2026-10-01', amount: 0, ...o,
})

// ---- bars resolve from the partner row, then the standing terms ----
check('standing bars', qualifyBars(standing), { minRevenue: 500, minUnits: null, minOrders: null })
check('founding bars', qualifyBars(founding), { minRevenue: null, minUnits: 1500, minOrders: 500 })
check('standing bonus amount', bonusAmount(standing), 300)
check('founding bonus amount', bonusAmount(founding), 500)

// ---- THE ALL-OR-NOTHING RULE ----
// The money bug this guards: a Founding Partner's NULL revenue column
// must NOT fall back to the standing $500. If it did, a client billing
// $500 would collect a $500 bonus through a route never approved.
check(
  'founding partner has NO revenue path — null does not inherit $500',
  qualifyBars(founding).minRevenue,
  null,
)
check(
  'a $9,999 invoice with no volume does NOT qualify a founding partner',
  qualifiesInMonth(inv({ amount: 9999 }), qualifyBars(founding)),
  false,
)

// ---- DTC standing: no unit count at all, must still qualify on revenue ----
const sb = qualifyBars(standing)
check('standing DTC $500 billed -> qualifies', qualifiesInMonth(inv({ amount: 500 }), sb), true)
check('standing DTC $499 billed -> does not', qualifiesInMonth(inv({ amount: 499 }), sb), false)
check('standing DTC $3000, units null -> qualifies', qualifiesInMonth(inv({ amount: 3000, units_shipped: null }), sb), true)

// ---- FBA founding: clears on units, with no dollar help ----
const fb = qualifyBars(founding)
check('FBA 1501 units, $0 -> qualifies', qualifiesInMonth(inv({ amount: 0, units_shipped: 1501 }), fb), true)
check('FBA exactly 1500 units -> does NOT (more than)', qualifiesInMonth(inv({ amount: 0, units_shipped: 1500 }), fb), false)
check('FBA 1400 units and $9000 billed -> does NOT (no revenue path)', qualifiesInMonth(inv({ amount: 9000, units_shipped: 1400 }), fb), false)

// ---- DTC founding: clears on ORDERS ----
check('DTC 501 orders, $0 -> qualifies', qualifiesInMonth(inv({ amount: 0, orders_shipped: 501 }), fb), true)
check('DTC exactly 500 orders -> does NOT (more than)', qualifiesInMonth(inv({ amount: 0, orders_shipped: 500 }), fb), false)
check('DTC 600 orders and no unit count -> qualifies', qualifiesInMonth(inv({ orders_shipped: 600, units_shipped: null }), fb), true)

// ---- null is NOT zero ----
// The whole point of the nullable columns. A month nobody has entered
// volume for must not answer "does not qualify" as if it were a fact.
check('units null is not read as 0', qualifiesInMonth(inv({ units_shipped: null }), { minRevenue: null, minUnits: 0, minOrders: null }), false)
check('orders null is not read as 0', qualifiesInMonth(inv({ orders_shipped: null }), { minRevenue: null, minUnits: null, minOrders: 0 }), false)

// ---- the regression this whole change is about ----
check(
  'DTC referral under a units-ONLY bar would never qualify',
  qualifiesInMonth(inv({ amount: 9999, orders_shipped: 4000 }), { minRevenue: null, minUnits: 2000, minOrders: null }),
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
    inv({ id: 'a', client_id: 'dtc', amount: 4000, orders_shipped: 900 }),
    inv({ id: 'b', client_id: 'fba', amount: 800, units_shipped: 2400 }),
    inv({ id: 'c', client_id: 'small', amount: 300, orders_shipped: 40 }),
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

// ---- a 0 bar CLOSES that path, and must not fall back to $500 ----
//
// Changed deliberately from "0 is kept as 0". `amount >= 0` is true of
// every invoice ever written, so a live 0 bar would qualify every
// client instantly — the opposite of what typing a 0 looks like it
// means. What matters, and is still asserted, is that it does not
// silently become the standing 500.
const noBar: ReferralPartner = { ...standing, bonus_min_revenue: 0 }
check('explicit 0 revenue bar closes the path, not replaced by 500', qualifyBars(noBar).minRevenue, null)
check('...and a $1m invoice does not sneak through it', qualifiesInMonth(inv({ amount: 1_000_000 }), qualifyBars(noBar)), false)

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
