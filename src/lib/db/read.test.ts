import { describe, it, expect } from 'vitest'
import { read, readOne, readErrors } from '@/lib/db/read'

// These two functions exist to keep "we looked and there is nothing" apart from
// "we could not look". Both of the defects below were live on
// src/app/clients/[id]/page.tsx, and both point the same way: the screen makes
// its strongest absence claim on its weakest evidence.

describe('read', () => {
  it('returns the rows when the query worked', () => {
    expect(read('t', { data: [{ id: 1 }], error: null }))
      .toEqual({ rows: [{ id: 1 }], error: null })
  })

  it('distinguishes a genuinely empty table from a failed read', () => {
    // The whole point. Both of these used to come back as `[]` and the screen
    // printed "No warehouse rates yet · Upload a CSV" over each of them.
    const empty = read('client_warehouse_rates', { data: [], error: null })
    const broken = read('client_warehouse_rates', {
      data: null, error: { message: 'canceling statement due to statement timeout' },
    })

    expect(empty.rows).toEqual([])
    expect(empty.error).toBeNull()

    expect(broken.rows).toEqual([])
    expect(broken.error).not.toBeNull()
    // Same rows, different verdict. A caller that branches on rows.length alone
    // cannot tell these apart; one that asks about `error` first always can.
    expect(empty.error === broken.error).toBe(false)
  })

  it('names the table in the message, because one screen makes four reads', () => {
    const r = read('client_zone_rates', {
      data: null, error: { message: 'relation does not exist' },
    })
    expect(r.error).toBe('client_zone_rates: relation does not exist')
  })

  it('never hands back rows alongside an error', () => {
    // A partial result read as complete is worse than no result: the zone
    // matrix would render whatever arrived as the client's whole rate card.
    const r = read('t', { data: [{ id: 1 }], error: { message: 'boom' } })
    expect(r.rows).toEqual([])
  })
})

describe('readErrors', () => {
  const ok = { error: null }
  const bad = { error: 'shipments: fetch failed' }
  const alsoBad = { error: 'manual_charges: statement timeout' }

  it('is null when every read succeeded', () => {
    // null and not '' -- the caller branches on this to decide whether it is
    // allowed to publish a figure at all, and '' is falsy in the same way but
    // would render as an empty reason if it ever reached the screen.
    expect(readErrors(ok, ok, ok)).toBeNull()
  })

  it('is null when there is nothing to combine', () => {
    expect(readErrors()).toBeNull()
  })

  it('reports a failure even when it is not the first read', () => {
    // The defect this guards: "revenue this week" is shipments + warehouse +
    // manual charges, and a check that only looked at the shipments read
    // published a confident total missing the manual charges entirely.
    expect(readErrors(ok, ok, bad)).toBe('shipments: fetch failed')
  })

  it('names every failed read, not just the first', () => {
    // One unreachable table and a dead connection need different responses,
    // and the first error alone cannot tell an operator which one this is.
    const combined = readErrors(bad, ok, alsoBad)
    expect(combined).toContain('shipments')
    expect(combined).toContain('manual_charges')
  })

  it('tolerates a missing read rather than reading it as success', () => {
    // A null slot is a read that was never performed. It carries no error, so
    // it must not manufacture one -- but it must also not be the reason a
    // caller skips the real failure sitting next to it.
    expect(readErrors(null, undefined, bad)).toBe('shipments: fetch failed')
    expect(readErrors(null, undefined)).toBeNull()
  })

  it('does not count an empty-string error as a failure', () => {
    // read() never produces '', but a caller hand-rolling the shape might, and
    // an empty reason on screen is worse than no reason: it blanks a figure
    // and says nothing about why.
    expect(readErrors({ error: '' })).toBeNull()
  })

  it('composes with read(), so a real failure blanks a real figure', () => {
    const shipments = read('shipments', { data: [{ client_rate: 10 }], error: null })
    const warehouse = read('warehouse_daily_log', {
      data: null, error: { message: 'canceling statement due to statement timeout' },
    })
    // Shipments arrived, so a naive total would render $10.00 and look fine.
    expect(shipments.rows).toHaveLength(1)
    expect(readErrors(shipments, warehouse))
      .toBe('warehouse_daily_log: canceling statement due to statement timeout')
  })
})

describe('readOne', () => {
  it('returns the row when exactly one matched', () => {
    expect(readOne('clients', { data: { id: 'c1' }, error: null }))
      .toEqual({ row: { id: 'c1' }, error: null })
  })

  it('reads PGRST116 as ABSENT, which is an answer', () => {
    // .single() over a primary key: PGRST116 can only mean no row matched.
    // This is the one case that justifies notFound().
    const r = readOne('clients', {
      data: null,
      error: { message: 'JSON object requested, multiple (or no) rows returned', code: 'PGRST116' },
    })
    expect(r.row).toBeNull()
    expect(r.error).toBeNull()
  })

  it('reads any other error as UNREADABLE, which is not', () => {
    // The defect: `const { data } = ...; if (!client) notFound()`. A dropped
    // connection rendered the 404 page -- the strongest possible absence claim
    // ("there is no such client") on the weakest possible evidence (we never
    // got an answer). The reasonable response to that page is to re-create the
    // client, which produces a duplicate with an empty rate card.
    const r = readOne('clients', {
      data: null, error: { message: 'fetch failed', code: '08006' },
    })
    expect(r.row).toBeNull()
    expect(r.error).toBe('clients: fetch failed')
  })

  it('does not treat a missing error code as PGRST116', () => {
    // A thrown-and-wrapped fetch failure often carries no code at all. Falling
    // through to the absent branch would restore the exact bug above, silently.
    const r = readOne('clients', { data: null, error: { message: 'network error' } })
    expect(r.error).toBe('clients: network error')
  })
})
