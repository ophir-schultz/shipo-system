import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

import { priceOf, isPriced } from '@/lib/billing/unpriced'
// The .mjs helper the read-only diagnostic scripts share. Same arrangement as
// src/lib/billing/zone-weight-parity.test.ts: vitest resolves what plain Node
// cannot, so the pin lives here rather than in the script.
const {
  UNPRICED_OR, NO_RATE, ZERO_RATE, rateKind, splitUnpriced, onlyNoRate, onlyZeroRate,
} = await import('../../../scripts/unpriced-filter.mjs')

// This file exists for one reason. src/lib/billing/recalculate.ts changed what
// it writes for a shipment it cannot price, from `client_rate: 0` to NULL. Its
// header says why the monitor's scan had to change in the same commit: "a NULL
// does not equal 0 in SQL, so writing NULL without touching that scan would
// have switched off the only existing alarm for this exact condition."
//
// Seven diagnostic scripts carried the same `.eq('client_rate', 0)` and were
// not changed with it, so each reported only the pre-change legacy zeros and
// silently omitted every shipment unpriced since -- one of them into an
// operator worklist on disk. The predicate is now in scripts/unpriced-filter.mjs
// once instead of seven times, and this pins it to the two things it has to
// keep agreeing with: the monitor's scan, and how the app reads the column.

describe('rateKind agrees with the real priceOf about which value is UNKNOWN', () => {
  // Each case asserts what rateKind answers AND what priceOf answers, rather
  // than only that the two agree. A parity-only assertion passes vacuously if
  // both drift the same way, which is the regression that would merge the two
  // populations back together.
  const CASES: Array<[unknown, string, string]> = [
    [null, NO_RATE, 'the NULL recalculate.ts writes when it cannot price'],
    [undefined, NO_RATE, 'column absent from the row object'],
    ['', NO_RATE, 'empty string, which Number() would turn into 0'],
    ['not a price', NO_RATE, 'unparseable string'],
    [NaN, NO_RATE, 'NaN'],
    [Infinity, NO_RATE, 'non-finite'],
    [{}, NO_RATE, 'neither number nor string'],

    [0, ZERO_RATE, 'a stored 0: legacy, or a card that says free'],
    // numeric(10,2) arrives over PostgREST as a quoted string, so `=== 0`
    // would have filed this under NO RATE and double-counted it as uncovered.
    ['0.00', ZERO_RATE, 'a stored 0 as PostgREST sends it'],
    ['0', ZERO_RATE, 'a stored 0 as a bare string'],
    [-0, ZERO_RATE, 'negative zero is still a decision somebody made'],

    [12.34, ZERO_RATE, 'a real price is not UNKNOWN'],
    ['12.34', ZERO_RATE, 'a real price as a string'],
  ]

  it.each(CASES)('%j -> %s (%s)', (value, expected) => {
    expect(rateKind({ client_rate: value })).toBe(expected)
    // The authority for the same distinction, in the module the app reads this
    // column with.
    expect(priceOf(value) === null).toBe(expected === NO_RATE)
    expect(isPriced(value)).toBe(expected !== NO_RATE)
  })

  it('refuses a row that never selected client_rate', () => {
    // An absent column is not a NULL price. `priceOf(undefined)` is correctly
    // null, so without this guard a script that forgot client_rate in its
    // .select() would file every legacy zero in the table under NO RATE and
    // report a confident, wrong split.
    expect(() => rateKind({ id: 1 })).toThrow(/client_rate/)
    expect(() => rateKind(null)).toThrow(/client_rate/)
    // Present-but-null is the real case and must NOT throw.
    expect(() => rateKind({ client_rate: null })).not.toThrow()
  })

  it('splits a population into two disjoint halves that add up', () => {
    const rows = [
      { client_rate: null }, { client_rate: 0 }, { client_rate: '0.00' },
      { client_rate: null }, { client_rate: 7.5 },
    ]
    const split = splitUnpriced(rows)
    expect(split.noRate).toHaveLength(2)
    expect(split.zero).toHaveLength(3)
    expect(split.noRate.length + split.zero.length).toBe(split.all.length)
    expect(split.all).toHaveLength(rows.length)
  })

  it('treats a missing population as empty rather than throwing', () => {
    for (const empty of [null, undefined, []]) {
      const split = splitUnpriced(empty)
      expect(split.all).toHaveLength(0)
      expect(split.noRate).toHaveLength(0)
      expect(split.zero).toHaveLength(0)
    }
  })
})

describe('the scripts ask for the same client_rate values the monitor scans', () => {
  // AUTHORITY. Read from source because there is nothing importable here: the
  // monitor's predicate is two PostgREST query builders inside a route handler,
  // and the scripts' is an `.or()` string. They cannot be made the same object,
  // so they are compared as text.
  const routeSrc = readFileSync(
    new URL('../../app/api/agent/monitor/route.ts', import.meta.url), 'utf8',
  )

  /** Every `client_rate` filter the route actually applies, as `op:value`. */
  const routeFilters = () => {
    // Comment lines are dropped first, because the route explains its own
    // history in a comment that quotes `.eq('client_rate', 0)` as the predicate
    // it STOPPED using. That quotation happens to name a filter the route still
    // applies, so stripping changes nothing today -- it is here for the case
    // this test exists to catch: the route dropping a condition while the
    // comment describing it stays, which an un-stripped scrape would read as
    // still live. Only whole-line comments are stripped, so a `//` inside a
    // string (a URL) is left alone.
    const code = routeSrc
      .split('\n')
      .filter(line => !line.trim().startsWith('//'))
      .join('\n')
    const found = new Set<string>()
    const re = /\.(is|eq|neq|gt|gte|lt|lte)\(\s*'client_rate'\s*,\s*([^)]*?)\s*\)/g
    for (const m of code.matchAll(re)) found.add(`${m[1]}:${m[2]}`)
    return found
  }

  it('matches exactly the two conditions, NULL and 0', () => {
    // Deliberately an equality and not a superset check. If the monitor grows a
    // third condition -- or drops one -- the scripts are describing a different
    // population than the live alarm, which is the entire defect. Failing here
    // means: update scripts/unpriced-filter.mjs to match, then this list.
    expect(routeFilters()).toEqual(new Set(['is:null', 'eq:0']))
  })

  it('UNPRICED_OR names those same two conditions as a PostgREST disjunction', () => {
    // `.is(...).eq(...)` chained on one builder is an AND and matches nothing,
    // which is why the scripts use a single `.or()` rather than two filters.
    expect(UNPRICED_OR).toBe('client_rate.is.null,client_rate.eq.0')

    const clauses = UNPRICED_OR.split(',').map((c: string) => {
      const [column, op, value] = c.split('.')
      return { column, op, value }
    })
    expect(clauses.every(c => c.column === 'client_rate')).toBe(true)
    expect(new Set(clauses.map(c => `${c.op}:${c.value}`))).toEqual(routeFilters())
  })

  it('onlyNoRate and onlyZeroRate apply one route filter each', () => {
    // Records what a query builder would have been told, so the two halves are
    // pinned to the same source of truth as the union rather than being a third
    // hand-written copy of it.
    const recorder = () => {
      const calls: string[] = []
      const q: Record<string, (c: string, v: unknown) => unknown> = {}
      for (const op of ['is', 'eq']) {
        q[op] = (column, value) => { calls.push(`${op}:${column}:${value}`); return q }
      }
      return { q, calls }
    }

    const a = recorder()
    onlyNoRate(a.q)
    expect(a.calls).toEqual(['is:client_rate:null'])

    const b = recorder()
    onlyZeroRate(b.q)
    expect(b.calls).toEqual(['eq:client_rate:0'])

    // Together they cover the union and nothing else.
    expect(new Set([...a.calls, ...b.calls].map(c => {
      const [op, , value] = c.split(':')
      return `${op}:${value}`
    }))).toEqual(routeFilters())
  })

  it('the monitor still reports the two counts apart', () => {
    // The scripts print the split because the monitor does, and the reason is
    // in the route's own comment: a stored 0 can be a card that says the
    // shipping is free, so it "is still reported ... and the message
    // distinguishes the two counts so neither is read as the other". If the
    // monitor ever merges them, the scripts' split is no longer mirroring
    // anything and this is the place to notice.
    expect(routeSrc).toMatch(/unpricedRes/)
    expect(routeSrc).toMatch(/zeroRes/)
    expect(NO_RATE).not.toBe(ZERO_RATE)
  })
})
