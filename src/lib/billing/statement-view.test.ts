import { describe, it, expect } from 'vitest'
import { rateText, periodLabel, coverageNote, estimateNote, grainChoice } from '@/lib/billing/statement-view'
import { buildStatement, periodRange, GRAINS, type StatementCharge } from '@/lib/billing/statement'
import { UNPRICED_DASH } from '@/lib/billing/unpriced'

// Every assertion here is about a sentence that appears on a document a client
// is invoiced from. The ones worth the most are the two that decide whether a
// figure is presented as a measurement or as a caveat.

describe('rateText', () => {
  it('shows the rate at four decimals, which is what the rate card stores', () => {
    // $0.2300 and $0.2000 rounded to two decimals read as the same number at a
    // glance, and these are multiplied by thousands of picks.
    expect(rateText({ unit_rate: 0.23, rates: 1 })).toBe('$0.2300')
    expect(rateText({ unit_rate: 0.2349, rates: 1 })).toBe('$0.2349')
  })

  it('shows a whole-dollar rate with its decimals, not as $3', () => {
    expect(rateText({ unit_rate: 3, rates: 1 })).toBe('$3.0000')
  })

  it('groups thousands, so a large rate is not misread', () => {
    expect(rateText({ unit_rate: 1250, rates: 1 })).toBe('$1,250.0000')
  })

  it('shows a rate of zero as a rate and not as an absence', () => {
    // A line genuinely priced at 0 is a decision -- something given away. It
    // must not render as 'at cost' or as a dash.
    expect(rateText({ unit_rate: 0, rates: 1 })).toBe('$0.0000')
  })

  it('says "at cost" when the line has no rate-card rate at all', () => {
    expect(rateText({ unit_rate: null, rates: 0 })).toBe('at cost')
  })

  it('says how many rates when the rate changed inside the period', () => {
    // Not an average and not the first one: no single number is true of the
    // whole line, and the client multiplying rate x units would find it.
    expect(rateText({ unit_rate: null, rates: 2 })).toBe('2 rates')
    expect(rateText({ unit_rate: null, rates: 5 })).toBe('5 rates')
  })

  it('never renders the three cases the same way', () => {
    // The whole reason this function is not `line.unit_rate ?? '—'`.
    const priced = rateText({ unit_rate: 0.23, rates: 1 })
    const atCost = rateText({ unit_rate: null, rates: 0 })
    const varied = rateText({ unit_rate: null, rates: 3 })
    expect(new Set([priced, atCost, varied]).size).toBe(3)
  })

  it('falls back to the unknown dash for the state buildStatement cannot produce', () => {
    expect(rateText({ unit_rate: null, rates: 1 })).toBe(UNPRICED_DASH)
  })

  it('agrees with what buildStatement actually puts on a line', () => {
    // The two functions are used together on every row of the table, so the
    // pairing is pinned rather than assumed: this fails if either side changes
    // its mind about what a null rate means.
    const charge = (o: Partial<StatementCharge>): StatementCharge => ({
      charge_type: 'pick', label: 'Pick — single', quantity: 1, amount: 1, ...o,
    })
    const range = periodRange('month', '2026-10-13')

    const one = buildStatement([charge({ unit_rate: 0.35 }), charge({ unit_rate: 0.35 })], range)
    expect(rateText(one.lines[0])).toBe('$0.3500')

    const two = buildStatement([charge({ unit_rate: 0.35 }), charge({ unit_rate: 0.4 })], range)
    expect(rateText(two.lines[0])).toBe('2 rates')

    const none = buildStatement([charge({ unit_rate: null })], range)
    expect(rateText(none.lines[0])).toBe('at cost')
  })
})

describe('periodLabel', () => {
  it('writes a single day once, not as a range from itself to itself', () => {
    expect(periodLabel('day', { from: '2026-10-13', to: '2026-10-13' })).toBe('2026-10-13')
  })

  it('names both bounds and the grain for a real range', () => {
    expect(periodLabel('month', { from: '2026-10-01', to: '2026-10-31' }))
      .toBe('2026-10-01 to 2026-10-31 (month)')
  })

  it('stays in ISO, because the reader and the client are in different countries', () => {
    // '10/13/2026' and '13/10/2026' are the same string read two ways, and this
    // goes into an email beside an amount owed.
    const label = periodLabel('week', { from: '2026-10-12', to: '2026-10-18' })
    expect(label).toContain('2026-10-12')
    expect(label).not.toMatch(/\d{2}\/\d{2}\/\d{4}/)
  })

  it('labels every grain periodRange can produce', () => {
    // GRAINS and not a hand-written list. It WAS a hand-written list of four,
    // which is the same shape of defect the GRAIN_LABELS tests exist for: a
    // test whose name claims "every grain" while it iterates a literal no new
    // grain joins. It would have gone on passing with 'half-year' uncovered.
    for (const grain of GRAINS) {
      const label = periodLabel(grain, periodRange(grain, '2026-10-13'))
      expect(label.length, grain).toBeGreaterThan(0)
    }
  })
})

describe('grainChoice', () => {
  it('uses a grain it recognises, and says nothing about it', () => {
    for (const grain of GRAINS) {
      expect(grainChoice(grain, 'month')).toEqual({ grain, note: '' })
    }
  })

  it('falls back silently when no grain was asked for', () => {
    // Arriving at /statements with no query string is the ordinary way in. A
    // caveat on the default view is the caveat nobody reads.
    expect(grainChoice(undefined, 'month')).toEqual({ grain: 'month', note: '' })
    expect(grainChoice(null, 'month')).toEqual({ grain: 'month', note: '' })
    expect(grainChoice('', 'month')).toEqual({ grain: 'month', note: '' })
  })

  it('never silently substitutes a period for an unrecognised one', () => {
    // The defect this function exists for: '?grain=weekly' rendering a MONTH of
    // revenue under a heading the reader believed said week is a figure roughly
    // four times too big, arriving with nothing to say anything was swapped.
    for (const asked of ['weekly', 'monthly', 'quarter', 'WEEK', 'all', 'Week']) {
      const { grain, note } = grainChoice(asked, 'month')
      expect(grain, asked).toBe('month')
      expect(note, asked).not.toBe('')
    }
  })

  it('names the rejected value, not just the one it used', () => {
    // 'showing the month' alone does not tell anyone the link they followed was
    // wrong, and it is the link that needs fixing.
    const { note } = grainChoice('weekly', 'month')
    expect(note).toContain("'weekly'")
    expect(note).toContain('month')
  })

  it('honours the fallback it was given rather than assuming one', () => {
    expect(grainChoice('weekly', 'day').grain).toBe('day')
    expect(grainChoice('weekly', 'day').note).toContain('day')
  })
})

describe('coverageNote', () => {
  const OCTOBER = { from: '2026-10-01', to: '2026-10-31' }

  it('says nothing when the period is fully covered', () => {
    // A caveat printed on every statement is one nobody reads.
    expect(coverageNote('2026-09-01', OCTOBER)).toBe('')
  })

  it('says nothing when the earliest charge is the first day of the period', () => {
    // The boundary. `>` and not `>=`, or every statement for a client's first
    // month carries a warning about being incomplete when it is complete.
    expect(coverageNote('2026-10-01', OCTOBER)).toBe('')
  })

  it('distinguishes an empty sum from a quiet period when there are no charges at all', () => {
    // The single most important sentence here. A client with no ledger rows
    // sums to a confident $0.00, which reads as "this client did nothing".
    const note = coverageNote(null, OCTOBER)
    expect(note).toMatch(/no charges for this client on any date/i)
    expect(note).toMatch(/sum over nothing/i)
  })

  it('says the record starts mid-period, and from when', () => {
    const note = coverageNote('2026-10-07', OCTOBER)
    expect(note).toContain('2026-10-07')
    expect(note).toContain('2026-10-31')
    expect(note).toMatch(/not the whole period/i)
  })

  it('says the figures cover from the earliest charge, not from the period start', () => {
    // The clause that carries the whole point. A note reading 'cover 2026-10-01
    // to 2026-10-31 and not the whole period' states that October is fully
    // covered inside a sentence saying it is not -- and an operator reading the
    // range rather than the prose would bill for a month of which nine days
    // were never recorded. Asserted as the range PHRASE, because '2026-10-07'
    // appears in the first clause too and a toContain cannot tell the two
    // apart.
    expect(coverageNote('2026-10-07', OCTOBER)).toContain('cover 2026-10-07 to 2026-10-31')
  })

  it('says the record starts after the period ends', () => {
    const note = coverageNote('2026-11-02', OCTOBER)
    expect(note).toContain('2026-11-02')
    expect(note).toMatch(/after this period ends/i)
  })

  it('asserts a fact and never a cause', () => {
    // "No charge is recorded before X" is true whether the ledger was not
    // running or the client was genuinely inactive. Claiming either would be
    // asserting something this function cannot see -- and both wrong readings
    // are actionable in opposite directions.
    for (const note of [
      coverageNote(null, OCTOBER),
      coverageNote('2026-10-07', OCTOBER),
      coverageNote('2026-11-02', OCTOBER),
    ]) {
      expect(note).not.toMatch(/sync|cron|not running|inactive|no activity|outage/i)
    }
  })

  it('covers a single-day period the same way', () => {
    const day = { from: '2026-10-13', to: '2026-10-13' }
    expect(coverageNote('2026-10-13', day)).toBe('')
    expect(coverageNote('2026-10-14', day)).toMatch(/after this period ends/i)
  })
})

describe('estimateNote', () => {
  it('says nothing when nothing was estimated', () => {
    expect(estimateNote(0)).toBe('')
  })

  it('says nothing for a negative count rather than printing one', () => {
    // Cannot arise from buildStatement, which counts a filtered array. Guarded
    // so a future caller passing a subtraction cannot print '-2 charges'.
    expect(estimateNote(-1)).toBe('')
  })

  it('is singular for one and plural for more', () => {
    expect(estimateNote(1)).toMatch(/^1 charge priced/)
    expect(estimateNote(3)).toMatch(/^3 charges priced/)
  })

  it('says what an estimate IS, not just that there is one', () => {
    // 'estimated: 3' on a screen is not actionable. The reason the figure can
    // still move is the part the operator has to be able to repeat to a client.
    expect(estimateNote(2)).toMatch(/assumed rate/)
    expect(estimateNote(2)).toMatch(/not a measured one/)
  })
})
