import { describe, it, expect, afterAll } from 'vitest'
import {
  periodRange, buildStatement, statementTotal, statementToday, isGrain, GRAINS,
  GRAIN_LABELS, resolvePeriod,
  type Grain, type StatementCharge, type PeriodRequest,
} from '@/lib/billing/statement'
import { warehouseParts, WAREHOUSE_TZ } from '@/lib/ledger/pick-date'

// The statement is the document that gets attached to an invoice, so the two
// things it can get wrong are the PERIOD it claims to cover and the TOTAL it
// claims is owed. This file is organised around those two, and nothing else.

describe('statementToday', () => {
  it('is the warehouse day, not the UTC day', () => {
    // 02:00 UTC on the 13th is 22:00 on the 12th in the warehouse. A statement
    // asked for "today" at that moment must mean the 12th, because the 12th is
    // the charge_date the ledger is still writing -- the UTC reading would show
    // an empty day while the warehouse was packing.
    expect(statementToday(new Date('2026-10-13T02:00:00Z'))).toBe('2026-10-12')
  })

  it('is the warehouse day, not the day west of it either', () => {
    // And the mirror case, so this is pinned on both sides rather than just
    // being "not UTC": 23:00 UTC on the 12th is 19:00 on the 12th in the
    // warehouse, and in Los Angeles it is still the 12th too -- so the case
    // that distinguishes is one where UTC has already rolled over.
    expect(statementToday(new Date('2026-10-12T23:00:00Z'))).toBe('2026-10-12')
    expect(statementToday(new Date('2026-10-13T16:00:00Z'))).toBe('2026-10-13')
  })

  it('agrees with the function that stamps charge_date, by construction', () => {
    // The claim being pinned is not a date, it is the SHARED ORIGIN. If someone
    // reimplements this with its own formatter, this fails for every moment at
    // which the two disagree rather than only for the two hours a day a
    // hard-coded example would catch.
    for (const iso of [
      '2026-01-01T00:30:00Z', '2026-03-08T06:30:00Z', '2026-07-04T03:59:00Z',
      '2026-11-01T05:30:00Z', '2026-12-31T23:59:00Z',
    ]) {
      const at = new Date(iso)
      expect(statementToday(at)).toBe(warehouseParts(at, WAREHOUSE_TZ).date)
    }
  })

  it('returns a date periodRange will accept', () => {
    // These two are used together on every request, and periodRange THROWS on
    // anything it cannot parse. A formatter change that produced '2026-1-5'
    // would take the screen down rather than render it wrong, which is the
    // right failure -- but it should fail here first.
    for (const grain of GRAINS) {
      expect(() => periodRange(grain, statementToday(new Date('2026-10-13T16:00:00Z')))).not.toThrow()
    }
  })
})

describe('periodRange', () => {
  it('a day is itself, both bounds', () => {
    expect(periodRange('day', '2026-10-13')).toEqual({ from: '2026-10-13', to: '2026-10-13' })
  })

  describe('a week runs Monday to Sunday', () => {
    // 2026-10-13 is a Tuesday. Every case below is the SAME week, asked for
    // from a different day inside it -- which is the property that matters: the
    // statement must not move when the operator opens it on a different day.
    const WEEK = { from: '2026-10-12', to: '2026-10-18' }

    it('from a midweek day', () => {
      expect(periodRange('week', '2026-10-13')).toEqual(WEEK)
    })

    it('from the Monday itself', () => {
      expect(periodRange('week', '2026-10-12')).toEqual(WEEK)
    })

    it('from the Sunday, which is the end of that week and not the start of the next', () => {
      // The edge the `(dow + 6) % 7` exists for. getUTCDay() calls Sunday 0, so
      // the obvious `dow - 1` sends Sunday BACKWARDS one day into the previous
      // Saturday and produces a week running Sat-Fri. Every other day in the
      // week would still look right, which is how it would ship.
      expect(periodRange('week', '2026-10-18')).toEqual(WEEK)
    })

    it('spans a month boundary rather than stopping at it', () => {
      // 2026-11-01 is a Sunday, so its week starts in October. A week clamped
      // to the month would bill six of its days on one statement and one on
      // another, or neither.
      expect(periodRange('week', '2026-11-01')).toEqual({ from: '2026-10-26', to: '2026-11-01' })
    })

    it('spans a year boundary', () => {
      // 2027-01-01 is a Friday.
      expect(periodRange('week', '2027-01-01')).toEqual({ from: '2026-12-28', to: '2027-01-03' })
    })
  })

  describe('a month runs the 1st to the real last day', () => {
    it('a 31-day month', () => {
      expect(periodRange('month', '2026-10-13')).toEqual({ from: '2026-10-01', to: '2026-10-31' })
    })

    it('a 30-day month', () => {
      expect(periodRange('month', '2026-11-30')).toEqual({ from: '2026-11-01', to: '2026-11-30' })
    })

    it('February in a common year', () => {
      expect(periodRange('month', '2026-02-07')).toEqual({ from: '2026-02-01', to: '2026-02-28' })
    })

    it('February in a leap year', () => {
      // A hard-coded 28, or a `to` built as 'YYYY-MM-28', drops a billable day
      // once every four years and nothing on the statement would say which day.
      expect(periodRange('month', '2028-02-07')).toEqual({ from: '2028-02-01', to: '2028-02-29' })
    })

    it('December, where the last day is found by rolling into the next YEAR', () => {
      // Date.UTC(y, 12, 0) is the 31st of December of y, not of January y+1.
      expect(periodRange('month', '2026-12-05')).toEqual({ from: '2026-12-01', to: '2026-12-31' })
    })

    it('is the same answer from the first and last day of the month', () => {
      expect(periodRange('month', '2026-10-01')).toEqual(periodRange('month', '2026-10-31'))
    })
  })

  describe('a half-year is the calendar half, never a trailing six months', () => {
    // The distinction this whole grain turns on. A trailing window asked from
    // 2026-10-13 would answer 2026-04-14..2026-10-13, and every case below is
    // chosen so that the trailing reading gives a DIFFERENT answer -- otherwise
    // the tests would pass against the implementation the grain exists to rule
    // out. The specific harm: "the last six months" is a heading two statements
    // sent a week apart would share while covering different periods, so
    // neither reconciles against the monthly invoices already sent.

    it('July..December for a date in the second half', () => {
      expect(periodRange('half-year', '2026-10-13'))
        .toEqual({ from: '2026-07-01', to: '2026-12-31' })
    })

    it('January..June for a date in the first half', () => {
      expect(periodRange('half-year', '2026-03-17'))
        .toEqual({ from: '2026-01-01', to: '2026-06-30' })
    })

    it('June 30 is the last day of the first half, not the first of the second', () => {
      // The boundary. An off-by-one in the `m <= 6` comparison moves a whole
      // month of revenue across a statement line, and June is the month it
      // moves.
      expect(periodRange('half-year', '2026-06-30'))
        .toEqual({ from: '2026-01-01', to: '2026-06-30' })
    })

    it('July 1 is the first day of the second half', () => {
      expect(periodRange('half-year', '2026-07-01'))
        .toEqual({ from: '2026-07-01', to: '2026-12-31' })
    })

    it('the second half ends on December 31, found by rolling into the next YEAR', () => {
      // Date.UTC(y, 6 + 6, 0) is December 31 of y, not of y + 1 -- the same
      // reason the December month case is written out separately above.
      expect(periodRange('half-year', '2026-12-31'))
        .toEqual({ from: '2026-07-01', to: '2026-12-31' })
    })

    it("the first half is 181 days in a common year and 182 in a leap one", () => {
      // Derived from the returned bounds rather than asserted as dates, so this
      // checks that the half is built from real month lengths instead of a
      // fixed span. A '6 months = 183 days' implementation passes every
      // hand-written case above and fails here.
      const days = (g: 'half-year', day: string) => {
        const { from, to } = periodRange(g, day)
        return (Date.parse(to) - Date.parse(from)) / 86_400_000 + 1
      }
      expect(days('half-year', '2026-03-17')).toBe(181)
      expect(days('half-year', '2028-03-17')).toBe(182)
      // And the second half is 184 either way -- Jul, Aug, Oct, Dec are 31.
      expect(days('half-year', '2026-10-13')).toBe(184)
      expect(days('half-year', '2028-10-13')).toBe(184)
    })

    it('is the same answer from the first and last day of the half', () => {
      expect(periodRange('half-year', '2026-07-01'))
        .toEqual(periodRange('half-year', '2026-12-31'))
      expect(periodRange('half-year', '2026-01-01'))
        .toEqual(periodRange('half-year', '2026-06-30'))
    })

    it('splits the year into exactly two halves that tile it without overlap', () => {
      // The property that makes the grain additive with `year`, which is the
      // reason the calendar reading was chosen. A trailing window cannot
      // satisfy this at all.
      const h1 = periodRange('half-year', '2026-01-01')
      const h2 = periodRange('half-year', '2026-12-31')
      const yr = periodRange('year', '2026-06-15')
      expect(h1.from).toBe(yr.from)
      expect(h2.to).toBe(yr.to)
      // h2 starts the day after h1 ends: no gap, no shared day.
      expect(Date.parse(h2.from) - Date.parse(h1.to)).toBe(86_400_000)
    })
  })

  it('a year is January 1 to December 31', () => {
    expect(periodRange('year', '2026-10-13')).toEqual({ from: '2026-01-01', to: '2026-12-31' })
  })

  it('every grain returns a range whose end is not before its start', () => {
    // Cheap, but it is the invariant the export route's own 400 is built on:
    // dateFrom after dateTo is a range no row can satisfy.
    for (const g of GRAINS) {
      for (const day of ['2026-01-01', '2026-02-28', '2026-10-18', '2026-12-31', '2028-02-29']) {
        const r = periodRange(g, day)
        expect(r.from <= r.to, `${g} from ${day} produced ${r.from}..${r.to}`).toBe(true)
      }
    }
  })

  it('contains the day it was asked about, for every grain', () => {
    // The property that actually defines "the period containing today". Every
    // off-by-one above fails this too, which is the point of stating it
    // separately from the hand-written expectations.
    for (const g of GRAINS) {
      for (const day of ['2026-01-01', '2026-10-12', '2026-10-18', '2026-11-01', '2026-12-31']) {
        const r = periodRange(g, day)
        expect(r.from <= day && day <= r.to, `${g} of ${day} is ${r.from}..${r.to}`).toBe(true)
      }
    }
  })

  describe('refuses a date it cannot read, rather than inventing a period', () => {
    // Returning a fallback period here would put real-looking money under the
    // wrong heading, which is worse than an error page.
    for (const bad of ['', 'today', '2026-10', '2026-10-1', '13/10/2026', '2026-13-01', '2026-02-30', '2026-00-10']) {
      it(`rejects ${JSON.stringify(bad)}`, () => {
        expect(() => periodRange('month', bad)).toThrow(/statement period/)
      })
    }

    it('names the offending value, so the error is actionable', () => {
      expect(() => periodRange('day', '2026-13-01')).toThrow(/2026-13-01/)
    })
  })

  describe('is independent of the machine timezone', () => {
    // Not a style point. Vercel runs UTC, a laptop does not, and a date-only
    // string read with LOCAL getters is the previous calendar day for most of
    // the UTC day anywhere west of Greenwich. That turns "this month" into a
    // period starting on the 30th of the month before -- a statement that
    // double-bills one day against the previous one.
    //
    // Node applies a TZ change at runtime, so this is exercised rather than
    // asserted in prose. Verified that the lever works: with TZ set to
    // America/Los_Angeles, `new Date('2026-10-01').getDate()` is 30.
    const original = process.env.TZ
    afterAll(() => { process.env.TZ = original })

    for (const tz of ['America/Los_Angeles', 'Pacific/Kiritimati', 'UTC']) {
      it(`gives the same answer in ${tz}`, () => {
        process.env.TZ = tz
        expect(periodRange('month', '2026-10-01')).toEqual({ from: '2026-10-01', to: '2026-10-31' })
        expect(periodRange('day', '2026-10-01')).toEqual({ from: '2026-10-01', to: '2026-10-01' })
        expect(periodRange('week', '2026-10-18')).toEqual({ from: '2026-10-12', to: '2026-10-18' })
        expect(periodRange('year', '2026-01-01')).toEqual({ from: '2026-01-01', to: '2026-12-31' })
      })
    }
  })
})

const RANGE = { from: '2026-10-01', to: '2026-10-31' }

const charge = (o: Partial<StatementCharge>): StatementCharge => ({
  charge_type: 'pick', label: 'Pick — single', quantity: 1, amount: 1, ...o,
})

describe('buildStatement', () => {
  it('has no lines and a real zero for a period with no charges', () => {
    // $0.00 and not a dash. A client with no activity genuinely owes nothing;
    // that is a fact about an empty set, not a gap in the data.
    const s = buildStatement([], RANGE)
    expect(s.lines).toEqual([])
    expect(s.sum).toEqual({ total: 0, unpriced: 0, counted: 0 })
    expect(statementTotal(s)).toBe(0)
  })

  it('tolerates null and undefined rather than throwing on a failed read', () => {
    expect(buildStatement(null, RANGE).lines).toEqual([])
    expect(buildStatement(undefined, RANGE).lines).toEqual([])
  })

  it('carries the period it was given, so the document can state its own claim', () => {
    const s = buildStatement([], RANGE)
    expect(s.from).toBe('2026-10-01')
    expect(s.to).toBe('2026-10-31')
  })

  it('adds up the units and the money on one line', () => {
    const s = buildStatement([
      charge({ quantity: 3, amount: 1.5 }),
      charge({ quantity: 2, amount: 1 }),
    ], RANGE)
    expect(s.lines).toHaveLength(1)
    expect(s.lines[0].quantity).toBe(5)
    expect(s.lines[0].sum).toEqual({ total: 2.5, unpriced: 0, counted: 2 })
  })

  it('keeps rate-card variants apart', () => {
    // 'Pick — single' and 'Pick — multi' are different rates on the client's
    // price list. Collapsing them to one 'Pick' line hides the exact thing the
    // client is being asked to check, and makes the unit figure uncheckable
    // against any single rate.
    const s = buildStatement([
      charge({ label: 'Pick — single', quantity: 2, amount: 2 }),
      charge({ label: 'Pick — multi', quantity: 5, amount: 7.5 }),
    ], RANGE)
    expect(s.lines.map(l => l.label)).toEqual(['Pick — multi', 'Pick — single'])
    expect(s.lines.map(l => l.quantity)).toEqual([5, 2])
  })

  it('keeps the same label apart when the charge type differs', () => {
    const s = buildStatement([
      charge({ charge_type: 'pick', label: 'Handling', amount: 1 }),
      charge({ charge_type: 'pack', label: 'Handling', amount: 2 }),
    ], RANGE)
    expect(s.lines).toHaveLength(2)
    expect(s.lines.map(l => l.charge_type)).toEqual(['pack', 'pick'])
  })

  describe('an amount the ledger could not price', () => {
    it('is excluded from the total and counted, never summed as zero', () => {
      // THE RULE THIS FILE EXISTS FOR. order_charges.amount is null when the
      // carrier has not reported yet. Treating that as $0 does not make the
      // statement smaller, it makes it confidently wrong -- and it is the
      // figure on the invoice.
      const s = buildStatement([
        charge({ charge_type: 'shipping', label: 'Shipping', amount: 10 }),
        charge({ charge_type: 'shipping', label: 'Shipping', amount: null }),
      ], RANGE)
      expect(s.lines[0].sum).toEqual({ total: 10, unpriced: 1, counted: 2 })
      expect(statementTotal(s)).toBe(10)
    })

    it('makes the grand total UNKNOWN when it excluded every row', () => {
      // A statement whose every line is waiting on a carrier invoice must not
      // print $0.00 beside the word Total.
      const s = buildStatement([
        charge({ amount: null }),
        charge({ charge_type: 'shipping', label: 'Shipping', amount: null }),
      ], RANGE)
      expect(s.sum.counted).toBe(2)
      expect(s.sum.unpriced).toBe(2)
      expect(statementTotal(s)).toBeNull()
    })

    it('is distinguished from a deliberate zero', () => {
      // A line genuinely billed at nothing is priced, and belongs in the total.
      const s = buildStatement([charge({ amount: 0 })], RANGE)
      expect(s.sum).toEqual({ total: 0, unpriced: 0, counted: 1 })
      expect(statementTotal(s)).toBe(0)
    })

    it('counts an empty string as unknown, not as zero', () => {
      // The shape a numeric column arrives in when it is absent from the
      // select rather than null in the row.
      const s = buildStatement([charge({ amount: '' })], RANGE)
      expect(s.sum).toEqual({ total: 0, unpriced: 1, counted: 1 })
      expect(statementTotal(s)).toBeNull()
    })
  })

  it('reads a numeric that arrived as a string', () => {
    // numeric(10,2) over PostgREST is not guaranteed to be a JS number, and
    // `0 + '12.34'` is '012.34'. priceOf is what stands between that and the
    // total; this pins that the statement actually goes through it.
    const s = buildStatement([
      charge({ amount: '12.34', quantity: '3' }),
      charge({ amount: '0.66', quantity: '2' }),
    ], RANGE)
    expect(s.lines[0].sum.total).toBe(13)
    expect(s.lines[0].quantity).toBe(5)
  })

  it('adds money in cents, so a long period does not drift', () => {
    // 0.1 + 0.2 is the standard reason a total ends in a stray fraction of a
    // cent. A year statement is a sum over thousands of these.
    const s = buildStatement(
      [charge({ amount: 0.1 }), charge({ amount: 0.2 })], RANGE)
    expect(s.lines[0].sum.total).toBe(0.3)
  })

  describe('quantity', () => {
    it('is null when no row on the line carries one', () => {
      // A peak surcharge is a percentage of a basis, with quantity null
      // (calculate-charges.ts:432). Rendering 0 there states that nothing was
      // handled, beside a charge for handling it.
      const s = buildStatement([
        charge({ charge_type: 'surcharge', label: 'Peak surcharge (5%)', quantity: null, amount: 5 }),
      ], RANGE)
      expect(s.lines[0].quantity).toBeNull()
      expect(s.lines[0].sum.total).toBe(5)
    })

    it('reports what it knows when only some rows carry one', () => {
      const s = buildStatement([
        charge({ quantity: 4, amount: 1 }),
        charge({ quantity: null, amount: 1 }),
      ], RANGE)
      expect(s.lines[0].quantity).toBe(4)
    })

    it('is a real zero when a row says zero', () => {
      const s = buildStatement([charge({ quantity: 0, amount: 1 })], RANGE)
      expect(s.lines[0].quantity).toBe(0)
    })

    it('is rounded, so a fractional quantity does not drift either', () => {
      // Not every quantity is a whole count -- a weight-based or
      // percentage-based line carries a fraction -- and the same float drift
      // that the money sum rounds away applies to it. Without the rounding this
      // reports 0.30000000000000004 units, which is both wrong on a document
      // sent to a client and the kind of figure that makes a reader distrust
      // the rest of the statement.
      const s = buildStatement([
        charge({ quantity: 0.1, amount: 1 }),
        charge({ quantity: 0.2, amount: 1 }),
      ], RANGE)
      expect(s.lines[0].quantity).toBe(0.3)
    })
  })

  describe('unit_rate', () => {
    it('is the rate when every row on the line shares one', () => {
      const s = buildStatement([
        charge({ unit_rate: 0.35, quantity: 10, amount: 3.5 }),
        charge({ unit_rate: 0.35, quantity: 4, amount: 1.4 }),
      ], RANGE)
      expect(s.lines[0].unit_rate).toBe(0.35)
      expect(s.lines[0].rates).toBe(1)
    })

    it('is null, and counted, when the rate changed inside the period', () => {
      // A rate card edited mid-month. Printing 0.35 beside an amount that
      // 0.35 x units does not produce is the one error a client is guaranteed
      // to find, because that multiplication is what the column invites.
      const s = buildStatement([
        charge({ unit_rate: 0.35, quantity: 10, amount: 3.5 }),
        charge({ unit_rate: 0.40, quantity: 10, amount: 4 }),
      ], RANGE)
      expect(s.lines[0].unit_rate).toBeNull()
      expect(s.lines[0].rates).toBe(2)
      // The money is still complete. A disagreement about the rate is not a
      // reason to withhold the amount actually charged.
      expect(s.lines[0].sum.total).toBe(7.5)
    })

    it('counts a rate once however many rows carry it', () => {
      const s = buildStatement(
        [1, 2, 3, 4].map(() => charge({ unit_rate: '0.35' })), RANGE)
      expect(s.lines[0].rates).toBe(1)
      expect(s.lines[0].unit_rate).toBe(0.35)
    })

    it('does not round two near-identical rates into one', () => {
      // unit_rate is numeric(10,4). 0.3500 and 0.3549 are two rates, and
      // rounding them together to print one is the same misstatement in a
      // smaller font.
      const s = buildStatement([
        charge({ unit_rate: 0.3500 }),
        charge({ unit_rate: 0.3549 }),
      ], RANGE)
      expect(s.lines[0].rates).toBe(2)
      expect(s.lines[0].unit_rate).toBeNull()
    })

    it('is null with a count of 0 when no row carries a rate', () => {
      // An at-cost freight line is billed at whatever the carrier charged, so
      // there is no rate-card rate to show. Distinct from the case above: the
      // screen says "at cost" rather than "2 rates".
      const s = buildStatement([charge({ charge_type: 'shipping', label: 'Freight, at cost', unit_rate: null })], RANGE)
      expect(s.lines[0].unit_rate).toBeNull()
      expect(s.lines[0].rates).toBe(0)
    })

    it('ignores an unreadable rate rather than counting it as a rate', () => {
      const s = buildStatement([
        charge({ unit_rate: 0.35 }),
        charge({ unit_rate: '' }),
        charge({ unit_rate: undefined }),
      ], RANGE)
      expect(s.lines[0].rates).toBe(1)
      expect(s.lines[0].unit_rate).toBe(0.35)
    })

    it('keeps each line to its own rate', () => {
      const s = buildStatement([
        charge({ label: 'Pick — multi', unit_rate: 0.25 }),
        charge({ label: 'Pick — single', unit_rate: 0.35 }),
      ], RANGE)
      expect(s.lines.map(l => l.unit_rate)).toEqual([0.25, 0.35])
    })
  })

  it('flags estimated rows per line and in total', () => {
    // is_estimate means the ledger priced it off an assumed rate rather than a
    // measured one. On a document going to a client that has to be visible.
    const s = buildStatement([
      charge({ amount: 1, is_estimate: true }),
      charge({ amount: 1, is_estimate: false }),
      charge({ charge_type: 'pack', label: 'Pack — single', amount: 1, is_estimate: true }),
    ], RANGE)
    expect(s.estimated).toBe(2)
    expect(s.lines.find(l => l.charge_type === 'pack')!.estimated).toBe(1)
    expect(s.lines.find(l => l.charge_type === 'pick')!.estimated).toBe(1)
  })

  it('treats a missing is_estimate as not an estimate, not as one', () => {
    const s = buildStatement([charge({ amount: 1 })], RANGE)
    expect(s.estimated).toBe(0)
  })

  it('orders lines the same way whatever order the charges arrived in', () => {
    // Map iteration follows insertion, so without the sort the line order of a
    // statement depends on which charge happened to be written first -- and two
    // statements for the same client and period could list the same lines
    // differently. That is the kind of difference a client notices and asks
    // about.
    const rows: StatementCharge[] = [
      charge({ charge_type: 'shipping', label: 'Shipping', amount: 3 }),
      charge({ charge_type: 'pack', label: 'Pack — single', amount: 2 }),
      charge({ charge_type: 'pick', label: 'Pick — single', amount: 1 }),
    ]
    const forward = buildStatement(rows, RANGE).lines.map(l => l.label)
    const reversed = buildStatement([...rows].reverse(), RANGE).lines.map(l => l.label)
    expect(forward).toEqual(reversed)
    expect(forward).toEqual(['Pack — single', 'Pick — single', 'Shipping'])
  })

  it('totals every line together, carrying what each one left out', () => {
    const s = buildStatement([
      charge({ amount: 10 }),
      charge({ charge_type: 'pack', label: 'Pack — single', amount: 5 }),
      charge({ charge_type: 'shipping', label: 'Shipping', amount: null }),
    ], RANGE)
    expect(s.sum).toEqual({ total: 15, unpriced: 1, counted: 3 })
    expect(statementTotal(s)).toBe(15)
  })

  it('does not filter by date, because the caller already did', () => {
    // Deliberate, and recorded as a test so it is not "fixed" later. Filtering
    // here too would be a second implementation of the range rule, and the two
    // would disagree about a boundary day exactly once, quietly. The row below
    // is outside RANGE and is still counted.
    const s = buildStatement([charge({ amount: 7 })], RANGE)
    expect(s.sum.counted).toBe(1)
    expect(statementTotal(s)).toBe(7)
  })
})

describe('GRAINS', () => {
  it('is the five the operator asked for, in increasing length', () => {
    expect(GRAINS).toEqual(['day', 'week', 'month', 'half-year', 'year'] satisfies Grain[])
  })
})

describe('GRAIN_LABELS', () => {
  // The defect these tests exist for, stated plainly: `year` was implemented,
  // tested, accepted by isGrain and handled by periodRange, and the screen's
  // hand-written list of three did not offer it. Nothing anywhere failed. The
  // picker now renders GRAINS over GRAIN_LABELS, so the only question left is
  // whether those two can still disagree.

  it('labels every grain, with nothing left unoffered', () => {
    // The load-bearing assertion. `Record<Grain, string>` already refuses to
    // compile with a grain missing, so GRAIN_LABELS is exhaustive by
    // construction -- but GRAINS is typed `readonly Grain[]`, and an array type
    // says nothing about COVERAGE. `['day', 'week', 'month']` would still
    // typecheck and would reintroduce exactly this bug, because the picker maps
    // over GRAINS. Comparing the two closes that hole: the Record supplies the
    // complete set, and this proves the array matches it.
    expect([...GRAINS].sort()).toEqual(Object.keys(GRAIN_LABELS).sort())
  })

  it('gives every grain a distinct, non-empty label', () => {
    const labels = GRAINS.map(g => GRAIN_LABELS[g])
    // Non-empty, because '' renders as a blank <option> that is selectable and
    // invisible -- worse than an absent one, which at least cannot be picked.
    for (const [i, label] of labels.entries()) {
      expect(label.trim(), `label for ${GRAINS[i]}`).not.toBe('')
    }
    // Distinct, because two periods sharing a label is a statement whose
    // heading cannot be trusted to say which period it covers.
    expect(new Set(labels).size).toBe(labels.length)
  })

  it('orders shortest period first, so the heaviest read is last', () => {
    // Not cosmetic. A year is the most expensive read on the screen and far the
    // most expensive in the download; first position is where a default lands,
    // and defaulting to the slowest query teaches people the screen is slow.
    // Measured through periodRange's actual spans rather than by restating the
    // order, so this checks the claim instead of echoing the literal above.
    const today = '2026-10-13'
    const spans = GRAINS.map(g => {
      const { from, to } = periodRange(g, today)
      return Date.parse(to) - Date.parse(from)
    })
    for (let i = 1; i < spans.length; i += 1) {
      expect(spans[i], `${GRAINS[i]} must span more than ${GRAINS[i - 1]}`)
        .toBeGreaterThan(spans[i - 1]!)
    }
  })
})

describe('isGrain', () => {
  it('accepts every grain the screen offers', () => {
    for (const g of GRAINS) expect(isGrain(g)).toBe(true)
  })

  it('rejects the near-misses a hand-written link produces', () => {
    // 'weekly' and 'monthly' are the two a person types from memory, and both
    // would fall through periodRange's day/week/month branches onto the year
    // arm -- a twelve-month statement under a heading claiming one week.
    for (const bad of ['weekly', 'monthly', 'Week', 'WEEK', 'quarter', 'all', '']) {
      expect(isGrain(bad), bad).toBe(false)
    }
  })

  it('rejects an absent parameter rather than reading it as a grain', () => {
    expect(isGrain(null)).toBe(false)
    expect(isGrain(undefined)).toBe(false)
  })

  it('rejects anything inherited from Array.prototype', () => {
    // `.includes` on the array, not `value in someObject`: a membership test
    // written against an object would accept 'constructor' and 'toString'.
    for (const bad of ['includes', 'constructor', 'toString', 'length']) {
      expect(isGrain(bad), bad).toBe(false)
    }
  })
})

describe('resolvePeriod', () => {
  /**
   * The period is one of the two things a statement can get wrong, and this is
   * now the only function that decides it for both forms the request can take.
   * So the tests here are about the REFUSALS. Every one of them is a case that
   * would otherwise produce a correctly-formatted statement over a period
   * nobody asked for -- which is indistinguishable, on the screen and in the
   * emailed file, from a correct one.
   */
  const TODAY = '2026-10-13' // a Tuesday

  it('resolves a grain to the same range periodRange gives', () => {
    // Pinned against periodRange rather than against literal dates, because
    // the point is that there is ONE period rule and this is a path into it,
    // not a second implementation that agrees today.
    for (const g of GRAINS) {
      const r = resolvePeriod({ grain: g }, TODAY)
      expect(r.ok, g).toBe(true)
      if (!r.ok) continue
      expect(r.range, g).toEqual(periodRange(g, TODAY))
      expect(r.grain, g).toBe(g)
    }
  })

  it('resolves explicit dates to themselves, with no grain', () => {
    const r = resolvePeriod({ from: '2026-09-01', to: '2026-09-30' }, TODAY)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.range).toEqual({ from: '2026-09-01', to: '2026-09-30' })
    // Null and not 'month'. The range happens to BE September, and claiming
    // the grain would be a statement about how it was derived -- false the
    // next time someone asks for the 1st to the 29th.
    expect(r.grain).toBeNull()
  })

  it('accepts a single day as from === to', () => {
    const r = resolvePeriod({ from: TODAY, to: TODAY }, TODAY)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.range).toEqual({ from: TODAY, to: TODAY })
  })

  it('refuses a reversed range instead of reporting an empty period', () => {
    // THE test in this describe. `.gte('2026-10-31').lte('2026-10-01')`
    // matches nothing, so without this check the answer is a confident $0.00
    // for a client who was in fact invoiced -- and $0.00 is a sentence about
    // the client's activity, not about the request.
    const r = resolvePeriod({ from: '2026-10-31', to: '2026-10-01' }, TODAY)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toMatch(/backwards/)
    // Names both ends, so the reader can see which one to fix.
    expect(r.error).toContain('2026-10-31')
    expect(r.error).toContain('2026-10-01')
  })

  it('refuses half a range rather than defaulting the other end', () => {
    // The shape a dropped parameter takes. Defaulting `to` to today would turn
    // a typo into a plausible statement over the wrong period.
    const onlyFrom = resolvePeriod({ from: '2026-10-01' }, TODAY)
    expect(onlyFrom.ok).toBe(false)
    if (!onlyFrom.ok) expect(onlyFrom.error).toMatch(/to is missing/)

    const onlyTo = resolvePeriod({ to: '2026-10-31' }, TODAY)
    expect(onlyTo.ok).toBe(false)
    if (!onlyTo.ok) expect(onlyTo.error).toMatch(/from is missing/)
  })

  it('refuses a request that asks for a period twice', () => {
    // Two contradictory claims. Either answer would be a guess, and a
    // precedence rule would make the guess silent forever.
    const r = resolvePeriod(
      { grain: 'week', from: '2026-01-01', to: '2026-12-31' }, TODAY,
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/asked for twice/)
  })

  it('refuses grain plus a half range too', () => {
    // The ambiguity check has to come BEFORE the half-range check, or this
    // case reports 'to is missing' and invites the caller to add it -- which
    // produces the ambiguous request rather than resolving anything.
    const r = resolvePeriod({ grain: 'month', from: '2026-01-01' }, TODAY)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/asked for twice/)
  })

  it('refuses an unknown grain, naming the valid ones', () => {
    for (const bad of ['weekly', 'monthly', 'quarter', 'Week']) {
      const r = resolvePeriod({ grain: bad }, TODAY)
      expect(r.ok, bad).toBe(false)
      if (r.ok) continue
      expect(r.error, bad).toContain(bad)
      // Lists what IS accepted. An error naming only the rejected value leaves
      // the caller guessing at the spelling.
      for (const g of GRAINS) expect(r.error, `${bad} -> ${g}`).toContain(g)
    }
  })

  it('refuses a date that is not a real date', () => {
    // Date.UTC rolls 2026-02-30 over into March 2, so without parseDay this
    // resolves to a real range two days wide of the one requested.
    for (const bad of ['2026-02-30', '2026-13-01', '13-10-2026', 'yesterday', '2026-10']) {
      const r = resolvePeriod({ from: bad, to: '2026-12-31' }, TODAY)
      expect(r.ok, bad).toBe(false)
    }
  })

  it('refuses rather than throwing on a malformed date', () => {
    // parseDay throws. A throw out of a query-string read lands as a 500,
    // which reads as "the server is broken" rather than "the link is wrong",
    // so this function is obliged to catch it.
    expect(() => resolvePeriod({ from: 'nope', to: 'nope' }, TODAY)).not.toThrow()
  })

  it('refuses an empty request', () => {
    const r = resolvePeriod({}, TODAY)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/No period/)
  })

  it('treats a present-but-empty parameter as absent', () => {
    // `?grain=&from=&to=` is what a form submits for untouched fields, and
    // URLSearchParams reports '' not null. An '' grain must not reach isGrain
    // as a value worth naming back, and an '' from must not count as half a
    // range -- all three are the same request as `?` with nothing in it.
    const r = resolvePeriod({ grain: '', from: '', to: '' }, TODAY)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/No period/)

    // And '' alongside real dates must not trip the ambiguity check.
    const ok = resolvePeriod({ grain: '', from: '2026-10-01', to: '2026-10-31' }, TODAY)
    expect(ok.ok).toBe(true)
    if (ok.ok) expect(ok.range).toEqual({ from: '2026-10-01', to: '2026-10-31' })
  })

  it('treats null and undefined alike', () => {
    const nulls = resolvePeriod({ grain: null, from: null, to: null }, TODAY)
    const undef = resolvePeriod({ grain: undefined, from: undefined, to: undefined }, TODAY)
    expect(nulls.ok).toBe(false)
    expect(undef.ok).toBe(false)
    if (!nulls.ok && !undef.ok) expect(nulls.error).toBe(undef.error)
  })

  it('defaults today to the warehouse day, not the UTC day', () => {
    // The default argument is the one thing here that cannot be seen from a
    // caller, and getting it from statementToday is what keeps the day grain
    // from asking for a date the ledger is not yet writing. Compared against
    // statementToday() rather than a literal so this does not expire.
    const r = resolvePeriod({ grain: 'day' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.range).toEqual({ from: statementToday(), to: statementToday() })
  })

  it('never returns a range that runs backwards, for any accepted request', () => {
    // The invariant every caller relies on: whatever comes out is safe to hand
    // to .gte(from).lte(to) without checking it again.
    const requests: PeriodRequest[] = [
      ...GRAINS.map(g => ({ grain: g })),
      { from: '2026-10-01', to: '2026-10-31' },
      { from: TODAY, to: TODAY },
      { from: '2020-01-01', to: '2030-12-31' },
    ]
    for (const req of requests) {
      const r = resolvePeriod(req, TODAY)
      expect(r.ok, JSON.stringify(req)).toBe(true)
      if (r.ok) expect(r.range.from <= r.range.to, JSON.stringify(req)).toBe(true)
    }
  })
})
