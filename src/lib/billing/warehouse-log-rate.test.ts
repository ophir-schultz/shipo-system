import { describe, it, expect } from 'vitest'
import { priceServiceLine, inEffect, type WarehouseRateRow } from './warehouse-log-rate'

// The function under test decides whether work performed becomes money
// invoiced. Its predecessor -- `rateRow?.rate ?? 0` in
// src/app/api/warehouse/log/route.ts -- answered every question with a
// billable zero, and `warehouse_daily_log.total` is read by six surfaces, so
// that zero agreed with itself everywhere it appeared.
//
// Every test here therefore asserts BOTH halves: that `rate` is null (not 0)
// and that `reason` is non-empty. A null rate with no reason is the same
// defect wearing different clothes -- a line that vanishes from revenue with
// nothing on screen to say why -- so neither assertion alone is enough.

function row(over: Partial<WarehouseRateRow> & { id: string }): WarehouseRateRow {
  return { service_type: 'storage', rate: 1.5, ...over }
}

const DATE = '2026-06-15'

describe('priceServiceLine', () => {
  // --- the priced case, which is the positive control for everything below --

  it('prices a single in-effect line', () => {
    const r = priceServiceLine([row({ id: 'a', rate: 2.25 })], 'storage', DATE)
    expect(r).toEqual({ rate: 2.25, reason: null })
  })

  it('reads a numeric column that arrives as a string', () => {
    // numeric(10,2) over PostgREST is a column type not worth betting a
    // billing path on. If it ever arrives quoted, `Number(raw)` must still
    // price it -- the alternative is every warehouse line silently unpriced.
    const r = priceServiceLine([row({ id: 'a', rate: '3.40' })], 'storage', DATE)
    expect(r).toEqual({ rate: 3.4, reason: null })
  })

  it('keeps a rate of exactly 0 as 0, not as unknown', () => {
    // The distinction runs in BOTH directions. A card that says 0 is a card
    // on which someone deliberately wrote "this service is free", and
    // converting that to null would raise an alert about a decision that was
    // actually made -- an alert nobody can clear, which is how operators
    // learn to ignore the column.
    const r = priceServiceLine([row({ id: 'a', rate: 0 })], 'storage', DATE)
    expect(r).toEqual({ rate: 0, reason: null })
  })

  it('admits a negative rate as a credit', () => {
    const r = priceServiceLine([row({ id: 'a', rate: -5 })], 'storage', DATE)
    expect(r).toEqual({ rate: -5, reason: null })
  })

  // --- the four conditions that used to bill zero -------------------------

  it('refuses to price when the client has no rate card at all', () => {
    const r = priceServiceLine([], 'storage', DATE)
    expect(r.rate).toBeNull()
    expect(r.reason).toMatch(/no warehouse rate card at all/)
  })

  it('refuses to price a service the card does not name', () => {
    const r = priceServiceLine([row({ id: 'a', service_type: 'receiving' })], 'storage', DATE)
    expect(r.rate).toBeNull()
    expect(r.reason).toMatch(/no rate line names service_type 'storage'/)
    // Must NOT be mistaken for the structured-card case: this card is legacy,
    // so the action is "agree a price", not "use the calculator".
    expect(r.reason).not.toMatch(/charge_type/)
  })

  it('says so when the card is structured and this screen cannot read it', () => {
    // The distinguishing case, and the one that matters most in practice:
    // ledger_05_seed_nayax.sql writes eighteen charge_type/variant lines with
    // service_type NULL, so for a migrated client EVERY line on this screen
    // is unpriced -- and under `?? 0` every one of them billed zero. The
    // message has to send the reader to the calculator rather than to the
    // rate card, because the price IS agreed; it is just not here.
    const r = priceServiceLine(
      [row({ id: 'a', service_type: null, charge_type: 'pick', variant: 'device' } as never)],
      'storage', DATE)
    expect(r.rate).toBeNull()
    expect(r.reason).toMatch(/structured charge_type\/variant lines/)
    expect(r.reason).toMatch(/charge calculator/)
  })

  it('refuses to price from a line whose rate cell is empty', () => {
    // ledger_03_charges.sql drops the NOT NULL on `rate` so an at_cost line
    // can be expressed at all. That makes null a legitimate stored value and
    // `?? 0` a claim of free work, on a line that exists precisely because
    // the amount comes from somewhere else.
    const r = priceServiceLine([row({ id: 'a', rate: null })], 'storage', DATE)
    expect(r.rate).toBeNull()
    expect(r.reason).toMatch(/carries no usable rate/)
    expect(r.reason).toMatch(/id a/)
  })

  it.each([['', '""'], ['abc', '"abc"']])(
    'refuses to price an unreadable rate value %j', (raw) => {
      const r = priceServiceLine([row({ id: 'a', rate: raw })], 'storage', DATE)
      expect(r.rate).toBeNull()
      expect(r.reason).toMatch(/carries no usable rate/)
    })

  it('refuses to price when two lines are both in effect', () => {
    // Reachable, not hypothetical. client_warehouse_rates_no_overlap is keyed
    // on `charge_type with =`, and a NULL never conflicts in an exclusion
    // constraint -- so the charge_type-null rows this screen reads are
    // exactly the rows that constraint does not cover. `.single()` reported
    // this the same way it reported none: null data, which `?? 0` billed as
    // free.
    const r = priceServiceLine(
      [row({ id: 'a', rate: 1 }), row({ id: 'b', rate: 99 })], 'storage', DATE)
    expect(r.rate).toBeNull()
    expect(r.reason).toMatch(/2 rate lines/)
    // Both ids, because the operator has to find and delete one of them, and
    // a count with no names is a prompt to read the whole card.
    expect(r.reason).toMatch(/ids a, b/)
  })

  it('does not resolve an ambiguity by picking the first row', () => {
    // The tempting wrong fix. Sorting and taking one bills a real, plausible
    // amount from an arbitrary row -- worse than refusing, because it leaves
    // nothing to notice. This is the same failure
    // client_warehouse_rates_no_overlap was added to stop in
    // calculate-charges.ts:91-98.
    const r = priceServiceLine(
      [row({ id: 'a', rate: 1 }), row({ id: 'b', rate: 99 })], 'storage', DATE)
    expect(r.rate).not.toBe(1)
    expect(r.rate).not.toBe(99)
  })

  // --- effective dating ----------------------------------------------------

  it('ignores a line that has expired, and says which windows it saw', () => {
    const r = priceServiceLine(
      [row({ id: 'a', effective_from: '2026-01-01', effective_to: '2026-06-01' })],
      'storage', DATE)
    expect(r.rate).toBeNull()
    expect(r.reason).toMatch(/none is in effect on 2026-06-15/)
    expect(r.reason).toMatch(/2026-01-01\.\.2026-06-01/)
  })

  it('ignores a line that has not started yet', () => {
    const r = priceServiceLine(
      [row({ id: 'a', effective_from: '2026-07-01' })], 'storage', DATE)
    expect(r.rate).toBeNull()
    expect(r.reason).toMatch(/none is in effect/)
  })

  it('picks the one line in effect when an expired one sits beside it', () => {
    // The case that makes date filtering worth having: without it this is the
    // ambiguity above, and with a naive filter it is priced from the old row.
    const r = priceServiceLine([
      row({ id: 'old', rate: 1.0, effective_from: '2026-01-01', effective_to: '2026-06-01' }),
      row({ id: 'new', rate: 2.0, effective_from: '2026-06-01' }),
    ], 'storage', DATE)
    expect(r).toEqual({ rate: 2.0, reason: null })
  })

  it('treats an absent effective_from/to as unbounded', () => {
    // Not a convenience. The two columns are added by `alter table` in
    // ledger_03_charges.sql with no backfill, so on an un-migrated database
    // they are absent rather than null -- and any reading other than
    // "unbounded" leaves every legacy rate card unpriceable.
    const r = priceServiceLine([{ id: 'a', service_type: 'storage', rate: 7 }], 'storage', DATE)
    expect(r).toEqual({ rate: 7, reason: null })
  })
})

describe('inEffect', () => {
  // The window is half-open [from, to), matching
  // client_warehouse_rates_no_overlap's `daterange(effective_from,
  // effective_to, '[)')`. A different convention here would let two rates the
  // DATABASE considers non-overlapping both be in effect on the same day --
  // which lands in the ambiguity branch above and makes a correctly-dated
  // card unpriceable.
  const r: WarehouseRateRow = {
    id: 'a', service_type: 'storage', rate: 1,
    effective_from: '2026-06-01', effective_to: '2026-07-01',
  }

  it('includes the first day of the window', () => {
    expect(inEffect(r, '2026-06-01')).toBe(true)
  })

  it('excludes the day before', () => {
    expect(inEffect(r, '2026-05-31')).toBe(false)
  })

  it('excludes effective_to itself, so adjacent windows do not both match', () => {
    expect(inEffect(r, '2026-07-01')).toBe(false)
  })

  it('includes the last day inside the window', () => {
    expect(inEffect(r, '2026-06-30')).toBe(true)
  })

  it('does not depend on the server timezone', () => {
    // No Date is constructed anywhere in inEffect, deliberately:
    // `new Date('2026-06-01')` is UTC midnight and
    // `new Date('2026-06-01T00:00:00')` is local, so a boundary comparison
    // built on Date silently answers differently either side of midnight in
    // some zones. ISO yyyy-mm-dd strings compare correctly with `<` and `>=`.
    // This asserts the property that makes that safe: lexical order on these
    // strings IS chronological order, including across a month boundary where
    // zero-padding is what carries it.
    const dates = ['2026-01-09', '2026-01-10', '2026-02-01', '2026-10-01', '2027-01-01']
    expect([...dates].sort()).toEqual(dates)
  })
})
