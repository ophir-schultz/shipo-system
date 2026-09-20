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
  foundingPlaces,
  clearsLaunchBar,
  tenureReleaseDate,
  FOUNDING_CLIENT_TERMS,
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

// A partner on BESPOKE terms written by hand in the DB: the two volume
// bars set, and bonus_min_revenue deliberately NULL — no dollar route.
//
// Nothing in the UI writes these any more. The launch offer moved to
// the CLIENT (see the launch-places block at the bottom of this file),
// because a 10-PARTNER cap with unlimited clients each is an unbounded
// liability. The columns remain because qualifyBars() still honours
// them, and the all-or-nothing reading below is what stops a NULL
// revenue column quietly inheriting the standing $500.
const founding: ReferralPartner = {
  id: 'p2', name: 'Bespoke Partner', company: null, status: 'active',
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
//
// A FIXED `now` well past the 60-day gate. Using the real clock here
// would make these checks pass today and fail on a machine whose date
// is a week earlier — a test that depends on when it is run is not a
// test.
const NOW = new Date('2027-06-01T00:00:00Z')

const client = (id: string, paid: string | null, seq: number | null = null): ReferredClient => ({
  id, name: id, referral_partner_id: 'p2', referral_signup_date: null, referral_first_payment_date: paid,
  founding_bonus_seq: seq,
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
  { now: NOW },
)

const bonuses = owed.filter((l) => l.kind === 'signup_bonus')
const byClient = Object.fromEntries(bonuses.map((b) => [b.clientId, b]))

check('DTC bonus is $500 and owed', [byClient.dtc.amount, byClient.dtc.period], [500, '2026-10'])
check('FBA bonus is $500 and owed', [byClient.fba.amount, byClient.fba.period], [500, '2026-10'])
check('sub-scale client is NOT owed', byClient.small.period, 'awaiting')
console.log(`        small client note: "${byClient.small.note}"`)
console.log(`        fba client note:   "${byClient.fba.note}"`)
console.log(`        dtc client note:   "${byClient.dtc.note}"`)

// ---- THE 60-DAY GATE ----
// Published on the partner page and, until now, enforced nowhere:
// "bills >= $500 in a calendar month, 60 days active, and first invoice
// paid in full." Three conditions, two of which were implemented.
check(
  'release date is 60 days after the first invoiced month',
  tenureReleaseDate([inv({ period: '2026-10-01' })], 60)?.toISOString().slice(0, 10),
  '2026-11-30',
)

const earlyOwed = computeOwed(
  [founding],
  [client('fast', '2026-10-01')],
  [inv({ id: 'e', client_id: 'fast', amount: 9000, units_shipped: 5000 })],
  [],
  { now: new Date('2026-10-15T00:00:00Z') }, // 14 days in
)
const early = earlyOwed.find((l) => l.kind === 'signup_bonus')!
check('qualified on day 14 -> still awaiting, not owed', early.period, 'awaiting')
console.log(`        day-14 note: "${early.note}"`)
check(
  'the same client past 60 days -> owed',
  computeOwed([founding], [client('fast', '2026-10-01')],
    [inv({ id: 'e', client_id: 'fast', amount: 9000, units_shipped: 5000 })], [], { now: NOW })
    .find((l) => l.kind === 'signup_bonus')!.period,
  '2026-10',
)

// ---- THE LAUNCH OFFER, PER CLIENT ----
//
// The bug this replaces: the cap used to count PARTNERS, so 10 partners
// referring 100 clients each paid 1,000 × $500. Counting clients makes
// the published ceiling — 10 × $200 = $2,000 — actually true.
check('launch bar: 1,501 units clears', clearsLaunchBar(inv({ units_shipped: 1501 })), true)
check('launch bar: 1,500 units does NOT (more than)', clearsLaunchBar(inv({ units_shipped: 1500 })), false)
check('launch bar: 501 orders clears', clearsLaunchBar(inv({ orders_shipped: 501 })), true)
check('launch bar: $1m with no volume does NOT clear', clearsLaunchBar(inv({ amount: 1_000_000 })), false)

// 12 qualifying clients, one per month, all under ONE STANDING partner.
//
// Standing and not the bespoke fixture above on purpose: that partner
// carries signup_bonus_amount = 500, so every client of theirs is worth
// $500 whether or not they hold a launch place, and the cap would look
// like it was working when it was doing nothing at all. The $300
// fallback is only visible against a partner on the standing terms.
const many = Array.from({ length: 12 }, (_, i) => ({
  ...client(`c${String(i).padStart(2, '0')}`, '2026-01-01'),
  referral_partner_id: 'p1',
}))
// amount 9000 so they also clear the STANDING $500 revenue bar — the
// launch place decides what the bonus is worth, not whether it exists.
const manyInv = many.map((c, i) =>
  inv({ id: `i${i}`, client_id: c.id, period: `2026-${String(i + 1).padStart(2, '0')}-01`, amount: 9000, units_shipped: 9000 }),
)
const places = foundingPlaces(many, manyInv)
check('the cap is 10 CLIENTS, not 10 partners', places.taken, FOUNDING_CLIENT_TERMS.CAP)
check('...so the 11th and 12th get nothing', [places.place.get('c10'), places.place.get('c11')], [undefined, undefined])
check('places go to the earliest qualifiers, in order', [places.place.get('c00'), places.place.get('c09')], [1, 10])
check('every unapproved place is provisional', places.provisional.size, 10)

// A stored place is FIXED. Client c11 qualified last, but was approved
// and paid at place 1 — a backdated invoice for anyone else must not be
// able to take that back.
const withStored = many.map((c) => (c.id === 'c11' ? { ...c, founding_bonus_seq: 1 } : c))
const storedPlaces = foundingPlaces(withStored, manyInv)
check('a stored place is honoured exactly, not re-ranked', storedPlaces.place.get('c11'), 1)
check('...and place 1 is not handed out twice', storedPlaces.place.get('c00'), 2)
check('...and the earliest qualifier still fits', storedPlaces.taken, 10)
check('a stored place is not provisional', storedPlaces.provisional.has('c11'), false)

// The partner statement sees ONE partner's clients. Ranking inside that
// slice would promise a $500 to someone 40th in line.
const sliceOnly = foundingPlaces(many, manyInv, false)
check('a partial client list assigns NO provisional places', sliceOnly.taken, 0)
check('...but still honours stored ones', foundingPlaces(withStored, manyInv, false).place.get('c11'), 1)

// End to end: the 11th qualifying client is paid the standing $300.
const capOwed = computeOwed([standing], many, manyInv, [], { now: NOW })
const capBonus = Object.fromEntries(
  capOwed.filter((l) => l.kind === 'signup_bonus').map((b) => [b.clientId, b]),
)
check('launch client #1 is paid $500', capBonus.c00.amount, FOUNDING_CLIENT_TERMS.BONUS)
check('client #11 is paid the standing $300', capBonus.c10.amount, REFERRAL_TERMS.SIGNUP_BONUS)
check('client #12 is paid the standing $300', capBonus.c11.amount, REFERRAL_TERMS.SIGNUP_BONUS)
check(
  'total launch exposure is exactly 10 x $200',
  Object.values(capBonus).reduce((s, b) => s + b.amount, 0) - many.length * REFERRAL_TERMS.SIGNUP_BONUS,
  FOUNDING_CLIENT_TERMS.CAP * (FOUNDING_CLIENT_TERMS.BONUS - REFERRAL_TERMS.SIGNUP_BONUS),
)
console.log(`        launch place note: "${capBonus.c00.note}"`)

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
