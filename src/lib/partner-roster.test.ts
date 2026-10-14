import { describe, expect, it } from 'vitest'
import { REFERRAL_TERMS, type ReferredClient } from './referrals'
import { readFileSync } from 'node:fs'
import { ROSTER_STATE_TEXT, prettyDay, prettyMonth, rosterRows, windowPosition } from './partner-roster'

/**
 * §4.1. The actual complaint: "I don't see the option to add more of my
 * clients… I need to see his orders and every client".
 *
 * A partner with one signed, not-yet-paying client saw "No statement yet"
 * — a screen that says nothing is missing, about a client that exists.
 * Every test below is about the clients the old screen could not show:
 * the ones with no money attached yet, the ones whose window has run out,
 * and the ones whose hand-typed dates do not make sense.
 *
 * `asOf` is a parameter everywhere. A function that reads the clock cannot
 * be tested across a window boundary, and every boundary here is a month
 * somebody is paid or not paid in.
 */

const base: ReferredClient = {
  id: 'c1',
  name: 'Acme Supplements',
  referral_partner_id: 'p1',
  referral_signup_date: '2025-12-01',
  referral_first_payment_date: null,
}

const JAN_2026 = new Date('2026-01-15')

const awaiting: ReferredClient = { ...base, id: 'c1', name: 'Awaiting Co' }
const earning: ReferredClient = {
  ...base,
  id: 'c2',
  name: 'Earning Co',
  referral_first_payment_date: '2026-01-05',
}

describe('rosterRows', () => {
  it('lists EVERY client, earning or not', () => {
    expect(rosterRows([awaiting, earning], JAN_2026)).toHaveLength(2)
  })

  it('a client with no first payment reads awaiting, not a zero', () => {
    // The whole defect. A client who has signed but not yet paid is not a
    // zero and not an absence — he is a client, and the partner referred
    // him. "$0" and "month 0" both read as a verdict on his earnings.
    const row = rosterRows([awaiting], JAN_2026)[0]
    expect(row.state).toBe('awaiting_first_payment')
    expect(ROSTER_STATE_TEXT[row.state]).not.toMatch(/\$0|month 0/)
  })

  it('a client inside its window reads earning', () => {
    const row = rosterRows(
      [{ ...base, referral_first_payment_date: '2026-01-10' }],
      new Date('2026-03-01'),
    )[0]
    expect(row.state).toBe('earning')
  })

  it('a client past 12 months reads window_closed', () => {
    const row = rosterRows(
      [{ ...base, referral_signup_date: '2024-12-01', referral_first_payment_date: '2025-01-10' }],
      new Date('2026-03-01'),
    )[0]
    expect(row.state).toBe('window_closed')
  })

  it('is empty for a partner with no clients', () => {
    expect(rosterRows([], JAN_2026)).toEqual([])
  })

  it('carries the dates through as given, without reformatting or inventing one', () => {
    const row = rosterRows([earning], JAN_2026)[0]
    expect(row.clientId).toBe('c2')
    expect(row.clientName).toBe('Earning Co')
    expect(row.referred).toBe('2025-12-01')
    expect(row.firstPaid).toBe('2026-01-05')

    const none = rosterRows([{ ...base, referral_signup_date: null }], JAN_2026)[0]
    expect(none.referred).toBeNull()
    expect(none.firstPaid).toBeNull()
  })

  it('every state has partner-safe text with no staff instruction', () => {
    // partner-tax-status.ts has the staff voice: "set the first-payment
    // date to release". Handing that to a partner reads as an instruction
    // he cannot carry out, about a field he cannot see.
    for (const t of Object.values(ROSTER_STATE_TEXT)) {
      expect(t).not.toMatch(/set the first-payment|re-send|reactivate/i)
    }
  })

  it('states the standing terms by reading the constants, not by restating them', () => {
    // A hardcoded "5%" or "12 months" here is a second copy of the deal,
    // and the one that goes stale is the one on the partner's screen.
    expect(ROSTER_STATE_TEXT.earning).toContain(`${REFERRAL_TERMS.COMMISSION_RATE * 100}%`)
    expect(ROSTER_STATE_TEXT.window_closed).toContain(`${REFERRAL_TERMS.COMMISSION_MONTHS}`)
  })

  it('reads as awaiting when the first payment predates the signup date', () => {
    // Nonsense data must read as unknown, not as a window that opened
    // before the referral. Both dates are hand-typed by staff.
    const row = rosterRows(
      [{ ...base, referral_signup_date: '2026-06-01', referral_first_payment_date: '2026-01-01' }],
      new Date('2026-07-01'),
    )[0]
    expect(row.state).toBe('awaiting_first_payment')
  })

  it('reads a FUTURE first-payment date as awaiting, never as closed', () => {
    // Review Focus 2. windowPosition answers null for a future date, and
    // null-with-a-date would otherwise fall through to window_closed —
    // telling the partner the window for a client who has not paid yet is
    // already over, which is the one wrong answer that stops him asking.
    const row = rosterRows(
      [{ ...base, referral_first_payment_date: '2027-01-15' }],
      new Date('2026-10-14'),
    )[0]
    expect(row.state).toBe('awaiting_first_payment')
  })

  it('carries the window position on the row, agreeing with the state', () => {
    // Important 2 from the whole-branch review. The roster table was
    // calling windowPosition(r.firstPaid, asOf) a SECOND time to fill the
    // "Commission window" cell, and that second call does not know what
    // `unusable` knows. A client whose first payment predates its signup
    // date therefore rendered both sentences at once:
    //
    //   state  → "Signed up. Your commission starts the month this
    //             client pays their first invoice."
    //   window → "month 4 of 12 · closes after February 2027"
    //
    // One row telling him he is not earning yet and that he is in month 4
    // of earning. He cannot tell which half is wrong, and the half that
    // says a window is already running is the one he will plan around.
    //
    // Derived here, once, from the same branch that sets the state, so
    // the two cannot disagree — which is what the component's own comment
    // claimed and could not deliver.
    const row = rosterRows(
      [{ ...base, referral_signup_date: '2026-06-01', referral_first_payment_date: '2026-01-01' }],
      new Date('2026-07-01'),
    )[0]
    expect(row.state).toBe('awaiting_first_payment')
    expect(row.window).toBeNull()
  })

  it('an earning row carries the month and the closing month', () => {
    const row = rosterRows(
      [{ ...base, referral_first_payment_date: '2026-01-10' }],
      new Date('2026-03-01'),
    )[0]
    expect(row.state).toBe('earning')
    expect(row.window).toEqual({ month: 3, of: 12, closesAfter: 'December 2026' })
  })

  it('every state agrees with its window: a position exists if and only if earning', () => {
    // The property, stated once over all three states rather than as
    // three separate examples: the cell and the sentence are the same
    // fact. An awaiting or closed row that carried a position would put
    // a running window next to "not earning yet" or "has ended".
    const rows = rosterRows(
      [
        { ...base, id: 'a', referral_first_payment_date: null },
        { ...base, id: 'b', referral_first_payment_date: '2026-01-10' },
        {
          ...base,
          id: 'c',
          referral_signup_date: '2024-12-01',
          referral_first_payment_date: '2025-01-10',
        },
        { ...base, id: 'd', referral_first_payment_date: '2027-01-15' },
        {
          ...base,
          id: 'e',
          referral_signup_date: '2026-06-01',
          referral_first_payment_date: '2026-01-01',
        },
      ],
      new Date('2026-03-01'),
    )
    expect(rows).toHaveLength(5)
    for (const r of rows) {
      expect(r.window !== null, `${r.clientId} is ${r.state} with window ${JSON.stringify(r.window)}`)
        .toBe(r.state === 'earning')
    }
    // Control: the five rows are not all one state, or the loop above
    // would be satisfied by a function that always answers null.
    expect(new Set(rows.map((r) => r.state)).size).toBeGreaterThan(1)
    expect(rows.some((r) => r.window !== null)).toBe(true)
  })
})

describe('windowPosition', () => {
  it('is null with no first paid invoice', () => {
    expect(windowPosition(null, JAN_2026)).toBeNull()
  })

  it('month 1 of 12 in the first paid month', () => {
    expect(windowPosition('2026-01-15', new Date('2026-01-20'))).toMatchObject({ month: 1, of: 12 })
  })

  it('month 12 of 12 in the last month', () => {
    expect(windowPosition('2026-01-15', new Date('2026-12-20'))).toMatchObject({ month: 12, of: 12 })
  })

  it('is null once the window has closed', () => {
    expect(windowPosition('2026-01-15', new Date('2027-02-01'))).toBeNull()
  })

  it('closes the month AFTER the twelfth, not during it', () => {
    // The boundary computeOwed uses: [start, start + COMMISSION_MONTHS).
    // Off by one here either pays a thirteenth month or withholds the
    // twelfth, and both are real money on a signed agreement.
    expect(windowPosition('2026-01-15', new Date('2026-12-31'))).not.toBeNull()
    expect(windowPosition('2026-01-15', new Date('2027-01-01'))).toBeNull()
  })

  it('counts whole calendar months, not elapsed days', () => {
    // The window runs on month boundaries because the ledger is monthly.
    // The day of the month inside either date must not move the answer.
    expect(windowPosition('2026-01-31', new Date('2026-02-01'))).toMatchObject({ month: 2 })
    expect(windowPosition('2026-01-01', new Date('2026-02-28'))).toMatchObject({ month: 2 })
  })

  // §4.2 — "month N of 12, and the month the window closes"
  it('states the month the window closes', () => {
    expect(windowPosition('2026-01-15', new Date('2026-03-01'))!.closesAfter).toMatch(/December 2026/)
  })

  it('names the LAST month commission is owed, not the month after it', () => {
    // The bound is [start, start + 12), so the twelfth owed month for a
    // January start is December — naming January 2027 would promise a
    // thirteenth month the payout does not honour, and the partner would
    // find that out by not being paid.
    const pos = windowPosition('2026-01-15', new Date('2026-03-01'))!
    expect(pos.closesAfter).toBe('December 2026')
    // and the same month is still inside the window
    expect(windowPosition('2026-01-15', new Date('2026-12-31'))).not.toBeNull()
    expect(windowPosition('2026-01-15', new Date('2027-01-01'))).toBeNull()
  })

  it('closesAfter crosses the year for a mid-year start', () => {
    expect(windowPosition('2026-07-01', new Date('2026-08-01'))!.closesAfter).toBe('June 2027')
  })

  it('reports the window length from the terms, not from a literal', () => {
    expect(windowPosition('2026-01-15', new Date('2026-01-20'))!.of).toBe(
      REFERRAL_TERMS.COMMISSION_MONTHS,
    )
  })

  // Review Focus 2 — these dates are hand-set and can be in the future
  it('never returns month 0 or a negative month for a FUTURE first-payment date', () => {
    expect(windowPosition('2027-01-15', new Date('2026-10-14'))).toBeNull()
  })

  it('never returns a month outside 1..of, for any pair of dates', () => {
    // The guard on the two branches above, stated once over a range: no
    // input may produce a position that is not a real month of the window.
    const days = ['2024-01-01', '2026-01-15', '2026-12-31', '2027-06-30', '2030-02-28']
    for (const paid of days) {
      for (const asOf of days) {
        const pos = windowPosition(paid, new Date(asOf))
        if (pos === null) continue
        expect(pos.month).toBeGreaterThanOrEqual(1)
        expect(pos.month).toBeLessThanOrEqual(pos.of)
      }
    }
  })
})

describe('prettyMonth', () => {
  it('names the month in full, with the year', () => {
    expect(prettyMonth('2026-12')).toBe('December 2026')
    expect(prettyMonth('2026-01')).toBe('January 2026')
  })

  it('accepts a full YYYY-MM-DD and ignores the day', () => {
    expect(prettyMonth('2026-07-31')).toBe('July 2026')
  })

  it('hands back anything it cannot parse, rather than printing a wrong month', () => {
    // computeOwed's unreleased signup lines carry the literal period
    // 'awaiting'. Printing 'undefined NaN' for it, or defaulting to
    // January, would both read as a month the partner can check against.
    expect(prettyMonth('awaiting')).toBe('awaiting')
    expect(prettyMonth('')).toBe('')
  })

  it('does not drift a month boundary into the previous one', () => {
    // Parsed by slicing, never by new Date(s): a date-only string is UTC
    // midnight, printed in the viewer's zone, so the 1st renders as the
    // last day of the previous month for anybody west of Greenwich. These
    // are the months a partner checks his commission window against.
    expect(prettyMonth('2026-03-01')).toBe('March 2026')
  })

  it('is the ONLY month-name list in src — one formatter, not two', () => {
    // Statement.tsx had its own MONTH_NAMES + prettyPeriod. The roster
    // cell and the month headings sit in the same table, so two
    // formatters would eventually print the same month two ways.
    const own = readFileSync('src/lib/partner-roster.ts', 'utf8')
    expect(own).toContain('December') // control: the list is really here
    const statement = readFileSync('src/components/partner/Statement.tsx', 'utf8')
    expect(statement).toContain('prettyMonth') // control: the file was read
    expect(statement).not.toMatch(/\bMONTH_NAMES\b/)
    expect(statement).not.toMatch(/function prettyPeriod/)
    expect(statement).not.toMatch(/function prettyDay/)
  })
})

/**
 * `prettyDay` renders the roster's Referred / First paid columns. It moved
 * out of Statement.tsx with `prettyMonth` so there is one month-name list
 * — and a .tsx is where vitest cannot reach it, so these branches were
 * untested for as long as it lived there.
 */
describe('prettyDay', () => {
  it('names the day, the month in full, and the year', () => {
    expect(prettyDay('2026-01-05')).toBe('5 January 2026')
  })

  it('renders a missing date as an em dash, never as a date', () => {
    // Both dates are hand-typed and routinely absent. A substituted or
    // guessed day would read as a fact about the partner's window.
    expect(prettyDay(null)).toBe('—')
  })

  it('hands back anything it cannot parse', () => {
    expect(prettyDay('awaiting')).toBe('awaiting')
    expect(prettyDay('2026-13-01')).toBe('2026-13-01')
  })

  it('does not drift the 1st into the previous month', () => {
    // Same reason as prettyMonth: sliced, never new Date(s). The 1st of a
    // month is exactly the value that renders as the previous month's last
    // day for anybody west of Greenwich.
    expect(prettyDay('2026-03-01')).toBe('1 March 2026')
  })

  it('ignores a time component rather than failing on it', () => {
    expect(prettyDay('2026-03-01T00:00:00Z')).toBe('1 March 2026')
  })
})
