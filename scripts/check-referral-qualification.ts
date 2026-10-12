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
//
// The standing programme has NO bar as of 2026-10-12 — Ophir dropped
// both the $500/month threshold and the 60-day wait. So the standing row
// resolves to three nulls PLUS `unbarred: true`, and the flag is the
// load-bearing half: three nulls on their own are also what a bespoke
// row full of zeroes resolves to, and that case must fail closed. See
// the 0-bar section at the bottom of this file.
check('standing bars — no threshold at all', qualifyBars(standing), {
  minRevenue: null, minUnits: null, minOrders: null, unbarred: true,
})
check('founding bars', qualifyBars(founding), {
  minRevenue: null, minUnits: 1500, minOrders: 500, unbarred: false,
})
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

// ---- STANDING TERMS: every invoice qualifies, whatever the amount ----
//
// This is the dropped threshold, asserted from both sides. The old
// checks here were "$500 qualifies / $499 does not"; the $499 line is
// the one that flipped, and it flipped on purpose. Keeping a small
// amount in the fixture is the point — a regression that quietly
// restored a bar would pass a "$3,000 qualifies" check unchanged.
const sb = qualifyBars(standing)
check('standing $40 billed -> qualifies (no threshold)', qualifiesInMonth(inv({ amount: 40 }), sb), true)
check('standing $499 billed -> qualifies (it used not to)', qualifiesInMonth(inv({ amount: 499 }), sb), true)
check('standing $1 billed -> qualifies', qualifiesInMonth(inv({ amount: 1 }), sb), true)
check('standing $3000, units null -> qualifies', qualifiesInMonth(inv({ amount: 3000, units_shipped: null }), sb), true)
// A $0 invoice qualifies too, and that is not an oversight: with no
// threshold there is nothing for it to fall under. What stops a $0
// invoice releasing $300 is the OTHER condition — a human has to set
// referral_first_payment_date, and nothing pays $0. Asserted so the
// behaviour is on the record rather than discovered later.
check('standing $0 invoice also clears the (absent) bar', qualifiesInMonth(inv({ amount: 0 }), sb), true)

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
// `unbarred: false` on these hand-built bars is not boilerplate — it is
// the condition under test. These are bespoke-shaped bars, and an
// unbarred offer short-circuits before any of them is read.
check('units null is not read as 0', qualifiesInMonth(inv({ units_shipped: null }), { minRevenue: null, minUnits: 0, minOrders: null, unbarred: false }), false)
check('orders null is not read as 0', qualifiesInMonth(inv({ orders_shipped: null }), { minRevenue: null, minUnits: null, minOrders: 0, unbarred: false }), false)

// ---- the regression this whole change is about ----
check(
  'DTC referral under a units-ONLY bar would never qualify',
  qualifiesInMonth(inv({ amount: 9999, orders_shipped: 4000 }), { minRevenue: null, minUnits: 2000, minOrders: null, unbarred: false }),
  false,
)

// ---- end to end through computeOwed ----
//
// A FIXED `now` well clear of every fixture's invoices. Using the real clock here
// would make these checks pass today and fail on a machine whose date
// is a week earlier — a test that depends on when it is run is not a
// test.
const NOW = new Date('2027-06-01T00:00:00Z')

const client = (id: string, paid: string | null, seq: number | null = null): ReferredClient => ({
  id, name: id, referral_partner_id: 'p2', referral_signup_date: null, referral_first_payment_date: paid,
  founding_bonus_seq: seq,
})

/**
 * The same, referred by the STANDING partner (p1) instead of the bespoke
 * one (p2). Which partner a fixture hangs off decides which code path it
 * exercises, so it is not interchangeable: p2 carries contracted bars and
 * never reaches the unbarred branch at all.
 */
const client2 = (id: string, paid: string | null): ReferredClient => ({
  ...client(id, paid),
  referral_partner_id: 'p1',
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

// ---- THERE IS NO WAITING PERIOD ----
//
// Dropped by Ophir on 2026-10-12 along with the revenue threshold. The
// partner page used to publish three conditions — ">= $500 in a calendar
// month, 60 days active, first invoice paid in full" — and only the last
// survives.
//
// `tenureReleaseDate` is left in place and still tested, because it
// takes minDays as an ARGUMENT rather than reading the constant: it is
// the mechanism, and the mechanism is correct whether or not anything
// calls it with a non-zero wait. Keeping it proven means restoring a
// waiting period is one edit to REFERRAL_TERMS.
check(
  'the mechanism still works when given a wait: 60 days from the first invoiced month',
  tenureReleaseDate([inv({ period: '2026-10-01' })], 60)?.toISOString().slice(0, 10),
  '2026-11-30',
)
check(
  'a zero wait releases on the first invoiced day itself',
  tenureReleaseDate([inv({ period: '2026-10-01' })], 0)?.toISOString().slice(0, 10),
  '2026-10-01',
)
check('and the constant it is called with is now 0', REFERRAL_TERMS.QUALIFY_MIN_DAYS_ACTIVE, 0)

// The behavioural inversion. This fixture used to assert "qualified on
// day 14 -> still awaiting"; it is now owed on day 14, which is the
// whole change. 14 days is kept deliberately — a restored 60-day gate
// would fail here, where a fixture dated a year out would not notice.
const early = computeOwed(
  [founding],
  [client('fast', '2026-10-01')],
  [inv({ id: 'e', client_id: 'fast', amount: 9000, units_shipped: 5000 })],
  [],
  { now: new Date('2026-10-15T00:00:00Z') }, // 14 days in
).find((l) => l.kind === 'signup_bonus')!
check('qualified on day 14 -> OWED, no waiting period', early.period, '2026-10')
console.log(`        day-14 note: "${early.note}"`)

// A client invoiced for a FUTURE period. This is the case plain
// arithmetic got wrong: `tenureReleaseDate(.., 0)` returns the first
// invoiced DATE, so a post-dated invoice has a release date `now` has
// not reached, and the bonus would have sat at 'awaiting' for a wait
// that does not exist. The gate is switched off by name, not computed,
// so this is owed.
const future = computeOwed(
  [standing],
  [client2('prepaid', '2026-10-01')],
  [inv({ id: 'f', client_id: 'prepaid', period: '2027-12-01', amount: 2000 })],
  [],
  { now: new Date('2026-10-15T00:00:00Z') },
).find((l) => l.kind === 'signup_bonus')!
check('a post-dated invoice is not held back by a zero-length wait', future.period, '2027-12')

// No note may ever say "0 days active" — the sentence that would have
// shipped if the gate were computed rather than switched off.
check(
  'no bonus note mentions a 0-day wait',
  [early.note, future.note].some((n) => /0 days/.test(n ?? '')),
  false,
)

// And the OTHER condition is untouched: no recorded payment, no bonus.
// Agreement 3.1 still turns on "signs ... and pays its first invoice",
// so dropping the threshold must not have dropped this too.
const unpaid = computeOwed(
  [standing],
  [client2('nopay', null)],
  [inv({ id: 'g', client_id: 'nopay', amount: 5000 })],
  [],
  { now: NOW },
).find((l) => l.kind === 'signup_bonus')!
check('qualified but unpaid -> still awaiting', unpaid.period, 'awaiting')
console.log(`        unpaid note: "${unpaid.note}"`)

// A referred client with NO invoice at all. Under an unbarred offer
// "nothing qualified" can only mean "nothing was invoiced", and the note
// has to say that rather than name a threshold that does not exist.
const dormant = computeOwed([standing], [client2('dormant', '2026-10-01')], [], [], { now: NOW })
  .find((l) => l.kind === 'signup_bonus')!
check('never invoiced -> awaiting', dormant.period, 'awaiting')
check('...and the note names the missing invoice, not a missing threshold', {
  invoice: /invoiced/i.test(dormant.note ?? ''),
  dollars: /\$/.test(dormant.note ?? ''),
}, { invoice: true, dollars: false })
console.log(`        dormant note: "${dormant.note}"`)

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
// premium. Both fixtures are invoiced and have a recorded first payment,
// so both bonuses are real owed figures, not 'awaiting'.
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

// ---- A BESPOKE 0 BAR STILL FAILS CLOSED ----
//
// `amount >= 0` is true of every invoice ever written, so a live 0 bar
// would qualify every client instantly — the opposite of what typing a 0
// looks like it means. `bar()` maps 0 to null for that reason.
//
// Which is why dropping the standing threshold was not a one-line edit.
// AFTER the drop, a zeroed bespoke row and the standing programme
// resolve to the SAME three nulls and must give OPPOSITE answers:
//
//   standing, no threshold   -> every invoice qualifies
//   bespoke row zeroed out   -> nothing qualifies
//
// Nothing in the resolved numbers can tell those apart. `unbarred` is
// set at the branch that knows and is checked before any bar is read,
// and these are the checks that hold that line. If `qualifiesInMonth`
// ever goes back to inferring "no bars" from the nulls, the $1m line
// below is what fails.
const noBar: ReferralPartner = { ...standing, bonus_min_revenue: 0 }
check('explicit 0 revenue bar closes the path, not replaced by anything', qualifyBars(noBar).minRevenue, null)
check('a zeroed bespoke row is NOT unbarred — it is closed', qualifyBars(noBar).unbarred, false)
check('...and a $1m invoice does not sneak through it', qualifiesInMonth(inv({ amount: 1_000_000 }), qualifyBars(noBar)), false)
check('...nor does a $0 one', qualifiesInMonth(inv({ amount: 0 }), qualifyBars(noBar)), false)
// All three bespoke bars zeroed: the shape most easily confused with the
// standing programme, since every resolved field is identical to it.
const allZero: ReferralPartner = { ...standing, bonus_min_revenue: 0, bonus_min_units: 0, bonus_min_orders: 0 }
check(
  'all three bespoke bars zeroed resolves identically to standing...',
  [qualifyBars(allZero).minRevenue, qualifyBars(allZero).minUnits, qualifyBars(allZero).minOrders],
  [qualifyBars(standing).minRevenue, qualifyBars(standing).minUnits, qualifyBars(standing).minOrders],
)
check('...and still answers the opposite question', [
  qualifiesInMonth(inv({ amount: 50_000, units_shipped: 90_000, orders_shipped: 9_000 }), qualifyBars(allZero)),
  qualifiesInMonth(inv({ amount: 50_000, units_shipped: 90_000, orders_shipped: 9_000 }), qualifyBars(standing)),
], [false, true])
// End to end: a real partner row with zeroed bars pays nothing, and the
// note says why and what to do about it rather than reading like there
// was never anything to clear.
const zeroOwed = computeOwed(
  [{ ...allZero, id: 'p3', name: 'Zeroed Partner' }],
  [{ ...client2('zc', '2026-10-01'), referral_partner_id: 'p3' }],
  [inv({ id: 'z', client_id: 'zc', amount: 9000, units_shipped: 9000 })],
  [],
  { now: NOW },
).find((l) => l.kind === 'signup_bonus')!
check('a zeroed partner row never releases a bonus', zeroOwed.period, 'awaiting')
check('...and its note says the row is the problem', /clear those columns/i.test(zeroOwed.note ?? ''), true)
console.log(`        zeroed-row note: "${zeroOwed.note}"`)

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
