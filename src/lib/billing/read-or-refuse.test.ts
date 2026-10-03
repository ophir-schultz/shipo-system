import { describe, it, expect, vi, afterEach } from 'vitest'

// The failed-read policy the read-only diagnostic scripts share. Lives here
// rather than beside the script for the same reason as
// src/lib/billing/zone-weight-parity.test.ts and
// src/lib/billing/unpriced-filter-parity.test.ts: vitest.config.ts only collects
// `src/**/*.test.ts`, so a test next to the .mjs would never run.
const {
  UNKNOWN, readFailure, refuse, mustRead, mustCount, unknownLog,
} = await import('../../../scripts/read-or-refuse.mjs')

// This file exists because the seven diagnostic scripts all used to destructure
// `{ data }` and carry on. A read that failed outright therefore reached the
// output as an empty array, and an empty array renders as `0`, `none at all`,
// `NOT IN CHART`, `no rate cell` -- the worst answer each question has,
// produced by the script rather than by the data, and indistinguishable from a
// real finding. `readFailure` is the decision that prevents it, so it is pinned
// here apart from the `process.exit()` wrapped around it.

describe('readFailure tells a read that did not happen from one that found nothing', () => {
  it('accepts an empty row set, because that is a real answer', () => {
    // PostgREST answers `[]` for a query that matched nothing. Treating this as
    // a failure would make every script refuse the moment the problem it
    // reports on was actually fixed.
    expect(readFailure({ data: [], error: null })).toBeNull()
    expect(readFailure({ data: [{ id: 1 }], error: null })).toBeNull()
  })

  it('rejects a null row set, because a null is not an empty table', () => {
    expect(readFailure({ data: null, error: null })).toMatch(/no rows returned/)
    expect(readFailure({ data: undefined })).toMatch(/no rows returned/)
  })

  it('reports the error message when there is one', () => {
    expect(readFailure({ data: null, error: { message: 'JWT expired' } })).toBe('JWT expired')
  })

  it('rejects an error even when rows came back with it', () => {
    // A partial result with an error attached is not a population. Checking
    // `data` first would have let this through.
    expect(readFailure({ data: [{ id: 1 }], error: { message: 'canceling statement' } }))
      .toBe('canceling statement')
  })

  it('never yields an empty or undefined reason', () => {
    // An error with no message is a real PostgREST/transport case, and
    // `undefined` interpolated into a refusal reads as "no reason given,
    // probably nothing". Every branch has to name something.
    for (const error of [
      { message: 'said so' },
      { message: '', details: 'detail only' },
      { message: '', details: '', hint: 'hint only' },
      { code: 'PGRST301' },
      {},
    ]) {
      const why = readFailure({ data: null, error })
      expect(why).toBeTruthy()
      expect(String(why)).not.toMatch(/undefined/)
    }
    expect(readFailure({ data: null, error: {} })).toMatch(/code absent/)
    expect(readFailure({ data: null, error: { code: 'PGRST301' } })).toMatch(/PGRST301/)
  })

  it('rejects a missing response object rather than reading through it', () => {
    expect(readFailure(null)).toBe('no response object')
    expect(readFailure(undefined)).toBe('no response object')
    expect(readFailure('oops')).toBe('no response object')
  })

  describe("want: 'count'", () => {
    it('accepts a count of zero', () => {
      // The whole reason this mode exists. `{ count: 'exact', head: true }`
      // returns `data: null` on success, so the default check would call every
      // successful count a failure -- and a count of 0 is a finding these
      // scripts specifically report (a client with no rate card at all).
      expect(readFailure({ data: null, count: 0, error: null }, { want: 'count' })).toBeNull()
      expect(readFailure({ data: null, count: 896, error: null }, { want: 'count' })).toBeNull()
    })

    it('rejects an absent count', () => {
      expect(readFailure({ data: null, count: null }, { want: 'count' }))
        .toMatch(/no count returned/)
      expect(readFailure({ data: null }, { want: 'count' })).toMatch(/no count returned/)
    })

    it('still rejects an error', () => {
      expect(readFailure({ count: 5, error: { message: 'nope' } }, { want: 'count' })).toBe('nope')
    })
  })

  describe("want: 'maybe'", () => {
    it('accepts a null row, because that is the lookup miss being reported', () => {
      // `.maybeSingle()` on a zone_chart lookup answers null for "no such
      // origin->dest row", which is the finding diag-zonelookup.mjs prints.
      expect(readFailure({ data: null, error: null }, { want: 'maybe' })).toBeNull()
    })

    it('still rejects an error, which is a different finding entirely', () => {
      expect(readFailure({ data: null, error: { message: 'timeout' } }, { want: 'maybe' }))
        .toBe('timeout')
    })
  })
})

describe('mustRead refuses, and refuses with the whole result intact', () => {
  afterEach(() => { vi.restoreAllMocks() })

  /** Replaces process.exit so the refusal can be observed without ending the run. */
  const trapExit = () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`)
    }) as never)
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    return { exit, err }
  }

  it('hands back the entire response, not just the rows', () => {
    // Deliberately the whole object: gen-rate-card-worklist.mjs compares `count`
    // against `data.length` to notice a capped read, and a helper that returned
    // only the rows would have quietly removed that check.
    const res = { data: [{ id: 1 }], count: 400, error: null }
    expect(mustRead('the shipments read', res)).toBe(res)
    expect(mustCount('a count', { data: null, count: 7, error: null })).toBe(7)
  })

  it('exits 1 and names both the read and the reason', () => {
    const { exit, err } = trapExit()
    expect(() => mustRead('the clients read', { data: null, error: { message: 'JWT expired' } }))
      .toThrow('exit:1')
    expect(exit).toHaveBeenCalledWith(1)
    const printed = err.mock.calls.flat().join('\n')
    expect(printed).toMatch(/REFUSING/)
    expect(printed).toMatch(/the clients read/)
    expect(printed).toMatch(/JWT expired/)
  })

  it('passes the caller\'s consequence through, so the refusal says what was not done', () => {
    const { err } = trapExit()
    expect(() => mustRead('the clients read', { data: null }, {
      instead: 'Nothing was written to docs/rate-card-worklist.md.',
    })).toThrow('exit:1')
    expect(err.mock.calls.flat().join('\n')).toMatch(/Nothing was written to docs/)
  })

  it('does not exit for an empty result', () => {
    const { exit } = trapExit()
    expect(mustRead('the shipments read', { data: [], error: null }).data).toEqual([])
    expect(mustCount('a count', { data: null, count: 0, error: null })).toBe(0)
    expect(exit).not.toHaveBeenCalled()
  })

  it('refuse() on its own exits 1', () => {
    const { exit } = trapExit()
    expect(() => refuse('a read', 'a reason')).toThrow('exit:1')
    expect(exit).toHaveBeenCalledWith(1)
  })
})

describe('unknownLog keeps a failed per-item read out of the numbers', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('distinguishes a zero from a count that was never read', () => {
    // The null-vs-zero doctrine, as the scripts actually consume it. Both of
    // these used to print as `0`, and `0 rate-card rows` is what makes a script
    // tell an operator to create a card.
    const log = unknownLog()
    const real = log.soft('client A card', { data: null, count: 0, error: null }, { want: 'count' })
    const failed = log.soft('client B card', { data: null, error: { message: 'nope' } }, { want: 'count' })

    expect(real.ok).toBe(true)
    expect(real.value ?? UNKNOWN).toBe(0)
    expect(failed.ok).toBe(false)
    expect(failed.value ?? UNKNOWN).toBe(UNKNOWN)
    expect(UNKNOWN).not.toBe(0)
    expect(log.length).toBe(1)
  })

  it('reports ok for a maybeSingle miss, so "not in chart" stays a finding', () => {
    const log = unknownLog()
    const miss = log.soft('198->902', { data: null, error: null }, { want: 'maybe' })
    const broke = log.soft('198->903', { data: null, error: { message: 'timeout' } }, { want: 'maybe' })
    // Both carry a null value. Only the flag tells them apart, which is why
    // soft() returns a flag rather than just the value.
    expect(miss.value).toBeNull()
    expect(broke.value).toBeNull()
    expect(miss.ok).toBe(true)
    expect(broke.ok).toBe(false)
    expect(log.length).toBe(1)
  })

  it('stays silent when nothing failed', () => {
    const log = unknownLog()
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    log.soft('a read', { data: [], error: null })
    log.tail('rate-card reads')
    expect(log.length).toBe(0)
    expect(err).not.toHaveBeenCalled()
  })

  it('names every failure in the tail and says an UNKNOWN is not a finding', () => {
    const log = unknownLog()
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    log.soft('client A card', { data: null, error: { message: 'first thing' } })
    log.soft('client B card', { data: null, error: { message: 'second thing' } })
    log.tail('rate-card reads')
    const printed = err.mock.calls.flat().join('\n')
    expect(printed).toMatch(/2 rate-card reads failed/)
    expect(printed).toMatch(/client A card: first thing/)
    expect(printed).toMatch(/client B card: second thing/)
    expect(printed).toMatch(/not a finding/)
    expect(log.list()).toHaveLength(2)
  })

  it('gives each log its own list', () => {
    // Two independent groups of soft reads in one script must not pool their
    // failures, or one group's tail claims the other's.
    const a = unknownLog()
    const b = unknownLog()
    a.soft('a read', { data: null })
    expect(a.length).toBe(1)
    expect(b.length).toBe(0)
  })
})
