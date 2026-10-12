// Proof for the two-track qualification. Run: npx tsx scripts/check-referral-qualification.ts
//
// This exists because the bonus gate decides real money and the two
// service lines fail in opposite directions: a units-only bar pays
// nothing on DTC, while a revenue-only bar pays a partner on bespoke
// volume terms for an account well under the volume they contracted.

import {
  computeOwed,
  qualifyBars,
  qualifiesInMonth,
  bonusAmount,
  tenureReleaseDate,
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
// Nothing in the UI writes these, and there is no program-wide offer
// that sets them — the launch offer that once did was withdrawn
// 2026-10-12. The columns remain because qualifyBars() still honours
// them for a partner admitted on a contracted figure, and the
// all-or-nothing reading below is what stops a NULL revenue column
// quietly inheriting the standing bar.
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

// ---- THERE IS NO LAUNCH OFFER ----
//
// Withdrawn by Ophir on 2026-10-12, before any partner was signed and
// before any bonus was paid. What used to be here: a $500 bonus for the
// first 10 referred clients clearing a volume bar, and a revenue-share
// window shifted to the client's second month.
//
// These checks are the guard in the other direction. The expensive
// failure now is a raised bonus or a withheld first month coming BACK
// without a decision, so what is asserted is that a volume of clients
// all price identically and that the dead column prices nothing.

// 12 qualifying clients, one per month, all under ONE STANDING partner.
//
// Standing and not the bespoke fixture above on purpose: that partner
// carries signup_bonus_amount = 500, so every client of theirs would be
// worth $500 regardless and a re-introduced raised bonus would be
// invisible. The $300 is only observable against the standing terms.
const many = Array.from({ length: 12 }, (_, i) => ({
  ...client(`c${String(i).padStart(2, '0')}`, '2026-01-01'),
  referral_partner_id: 'p1',
}))
// amount 9000 and 9000 units: these clients clear the standing revenue
// bar AND would have cleared both withdrawn volume bars. If a launch
// tier is ever re-added, this fixture is what notices.
const manyInv = many.map((c, i) =>
  inv({ id: `i${i}`, client_id: c.id, period: `2026-${String(i + 1).padStart(2, '0')}-01`, amount: 9000, units_shipped: 9000 }),
)

const capOwed = computeOwed([standing], many, manyInv, [], { now: NOW })
const capBonus = Object.fromEntries(
  capOwed.filter((l) => l.kind === 'signup_bonus').map((b) => [b.clientId, b]),
)
check(
  'every one of 12 high-volume clients is paid the standing $300',
  [...new Set(Object.values(capBonus).map((b) => b.amount))],
  [REFERRAL_TERMS.SIGNUP_BONUS],
)
check(
  'the first client is not special',
  [capBonus.c00.amount, capBonus.c09.amount, capBonus.c10.amount, capBonus.c11.amount],
  Array(4).fill(REFERRAL_TERMS.SIGNUP_BONUS),
)
check(
  'total bonus exposure is exactly 12 x $300 — no premium anywhere',
  Object.values(capBonus).reduce((s, b) => s + b.amount, 0),
  many.length * REFERRAL_TERMS.SIGNUP_BONUS,
)
// A note mentioning a place or an offer means a tier came back with
// wording attached. Cheap to check, and it reads the human-facing text
// rather than the arithmetic.
check(
  'no bonus note mentions a launch place or offer',
  Object.values(capBonus).some((b) => /launch|place|founding/i.test(b.note ?? '')),
  false,
)
console.log(`        standing bonus note: "${capBonus.c00.note}"`)

// ---- THE 5% STARTS IN MONTH 1, FOR EVERYONE ----
//
// The withdrawn offer moved the window to months 2-13 for launch
// clients, keyed off the stored `founding_bonus_seq`. That column still
// exists in the database, so the check that matters is that a row
// carrying a value prices EXACTLY the same as a row carrying null.
// Otherwise a leftover value — or one typed in by hand — would silently
// withhold a month of commission from a live partner.
const yearOf = (id: string, partnerId: string, seq: number | null) => {
  const c: ReferredClient = {
    id, name: id, referral_partner_id: partnerId,
    referral_signup_date: null, referral_first_payment_date: '2026-01-01',
    founding_bonus_seq: seq,
  }
  // 15 straight months of trading, so the window's edges are visible.
  const invs = Array.from({ length: 15 }, (_, i) =>
    inv({
      id: `${id}-${i}`, client_id: id,
      period: `${2026 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}-01`,
      amount: 10000, units_shipped: 9000,
    }),
  )
  return { c, invs }
}

const commissionMonths = (seq: number | null) =>
  computeOwed([standing], [yearOf('x', 'p1', seq).c], yearOf('x', 'p1', seq).invs, [], { now: NOW })
    .filter((l) => l.kind === 'commission')
    .map((l) => l.period)

const plainMonths = commissionMonths(null)
check('5% starts in the first paid month', plainMonths[0], '2026-01')
check('and runs for 12 months', plainMonths.length, REFERRAL_TERMS.COMMISSION_MONTHS)
check('so the last paid month is month 12', plainMonths[plainMonths.length - 1], '2026-12')

// THE withdrawal check: a stored place must now be completely inert.
const seqMonths = commissionMonths(1)
check(
  'a leftover founding_bonus_seq does NOT withhold month 1',
  seqMonths.includes('2026-01'),
  true,
)
check(
  'a leftover founding_bonus_seq changes the window not at all',
  seqMonths,
  plainMonths,
)

// ...and it must not price the BONUS either, which is the other half of
// the question and the half nothing above was asking.
//
// Found by reversion: adding `+ (founding_bonus_seq != null ? 200 : 0)`
// to the bonus stayed green through every check in this file, because
// no fixture paired a non-null seq with an assertion on the amount. The
// column still exists in the database, so a value left behind by a
// migration — or typed in by hand — is a live route to an unapproved
// premium. Both fixtures clear the standing revenue bar and are past
// the 60-day gate, so both bonuses are real owed figures, not 'awaiting'.
const bonusFor = (seq: number | null) => {
  const y = yearOf('b', 'p1', seq)
  return computeOwed([standing], [y.c], y.invs, [], { now: NOW })
    .find((l) => l.kind === 'signup_bonus')!
}
check('a client WITHOUT a stored place is paid $300', bonusFor(null).amount, REFERRAL_TERMS.SIGNUP_BONUS)
check('a client WITH one is paid the same $300', bonusFor(1).amount, REFERRAL_TERMS.SIGNUP_BONUS)
check(
  'the dead column moves the bonus by exactly nothing',
  bonusFor(1).amount - bonusFor(null).amount,
  0,
)
// Premise guard: if these ever stopped being released, the three checks
// above would compare two 'awaiting' lines and prove nothing.
check('...and both of those bonuses are genuinely owed', [bonusFor(null).period, bonusFor(1).period], ['2026-01', '2026-01'])

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
