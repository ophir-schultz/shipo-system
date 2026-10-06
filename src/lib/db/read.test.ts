import { describe, it, expect } from 'vitest'
import { read, readOne, readErrors, isMigrationMissing, loaded, embedOne } from '@/lib/db/read'

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

describe('loaded', () => {
  it('carries the data and an ok:true discriminant when every read worked', () => {
    expect(loaded(null, () => ({ total: 42 })))
      .toEqual({ ok: true, error: null, data: { total: 42 } })
  })

  it('carries the reason and NO data when a read failed', () => {
    const l = loaded('bills: statement timeout', () => ({ total: 42 }))
    expect(l.ok).toBe(false)
    expect(l.error).toBe('bills: statement timeout')
    expect(l.data).toBeUndefined()
  })

  it('does not run the build at all when a read failed', () => {
    // The point of the thunk. pnl aggregates six tables into per-client margin
    // and referrals runs computeOwed over partners x invoices x payouts; doing
    // that over `[]` yields a full set of plausible $0.00 figures that then
    // have to be remembered to be thrown away. This way they never exist.
    let calls = 0
    loaded('shipments: fetch failed', () => { calls++; return [] })
    expect(calls).toBe(0)
  })

  it('runs the build exactly once on success', () => {
    let calls = 0
    loaded(null, () => { calls++; return [] })
    expect(calls).toBe(1)
  })

  it('treats an empty reason as success, matching readErrors', () => {
    // readErrors filters '' out for the same reason: a blank red box blanks a
    // figure and explains nothing. If one ever reached here, failing closed on
    // it would be a mystery rather than a refusal.
    expect(loaded('', () => 1)).toEqual({ ok: true, error: null, data: 1 })
  })

  it('does not confuse falsy DATA with a failed read', () => {
    // The near neighbour. Keyed on the error, never on the shape of the data,
    // so a legitimately empty table and a legitimate $0 both stay ok:true.
    expect(loaded(null, () => [])).toEqual({ ok: true, error: null, data: [] })
    expect(loaded(null, () => 0)).toEqual({ ok: true, error: null, data: 0 })
    expect(loaded(null, () => null)).toEqual({ ok: true, error: null, data: null })
  })

  it('composes with read and readErrors end to end', () => {
    const shipments = read('shipments', { data: [{ client_rate: 10 }], error: null })
    const bills = read('bills', { data: null, error: { message: 'statement timeout' } })

    // Shipments arrived. A page that rendered what it had would show $10.00.
    const l = loaded(readErrors(shipments, bills), () => ({
      revenue: shipments.rows.reduce((s, r) => s + r.client_rate, 0),
    }))
    expect(l.ok).toBe(false)
    expect(l.data).toBeUndefined()
    expect(l.error).toContain('bills')
  })
})

describe('isMigrationMissing', () => {
  const err = (code?: string, message = 'boom') => ({ data: null, error: { message, code } })

  it('recognises the table not existing in Postgres', () => {
    expect(isMigrationMissing(err('42P01', 'relation "public.campaigns" does not exist'))).toBe(true)
  })

  it('recognises the table not existing in the PostgREST schema cache', () => {
    // The code supabase-js actually returns: PostgREST resolves the table name
    // against its own cache and 404s before Postgres is ever asked, so a page
    // that only knew 42P01 would never show its migration banner at all.
    expect(isMigrationMissing(err('PGRST205',
      "Could not find the table 'public.campaigns' in the schema cache"))).toBe(true)
  })

  it('recognises a missing column, because the remedy is the same file', () => {
    expect(isMigrationMissing(err('42703',
      'column clients.founding_bonus_seq does not exist'))).toBe(true)
  })

  it('does NOT read a statement timeout as a missing migration', () => {
    // The defect. `migrationApplied = !res.error` made this true, so a
    // one-second blip told the operator to go and paste DDL at a database whose
    // referral ledger was sitting there intact.
    expect(isMigrationMissing(err(undefined,
      'canceling statement due to statement timeout'))).toBe(false)
  })

  it('does NOT read a dropped connection as a missing migration', () => {
    expect(isMigrationMissing(err('08006', 'fetch failed'))).toBe(false)
    expect(isMigrationMissing(err('57014', 'query canceled'))).toBe(false)
  })

  it('does NOT read permission denied as a missing migration', () => {
    // 42501. The table exists; the grant is wrong. Pasting the CREATE TABLE
    // again does nothing, and the operator needs to see the real message.
    expect(isMigrationMissing(err('42501', 'permission denied for table campaigns'))).toBe(false)
  })

  it('does NOT read an absent row as a missing migration', () => {
    // PGRST116 is readOne's "no such row" -- a successful answer about a table
    // that plainly exists.
    expect(isMigrationMissing(err('PGRST116', 'multiple (or no) rows returned'))).toBe(false)
  })

  it('does NOT read the write-path column code as a missing migration', () => {
    // PGRST204 is deliberately out of the set: write path only, unexercised by
    // any caller here, so it falls through to showing the real message.
    expect(isMigrationMissing(err('PGRST204', "Column 'x' not found"))).toBe(false)
  })

  it('is false for a read that succeeded', () => {
    expect(isMigrationMissing({ data: [{ id: 1 }], error: null })).toBe(false)
    expect(isMigrationMissing({ data: [], error: null })).toBe(false)
  })

  it('is false for a read that was never performed', () => {
    expect(isMigrationMissing(null)).toBe(false)
    expect(isMigrationMissing(undefined)).toBe(false)
  })

  it('matches codes exactly, and does not guess from the message', () => {
    // Two separate guards. A substring or case-insensitive match would make
    // "42P019" or "pgrst205" true; and a message-sniffing implementation would
    // fire on the word "exist" in an unrelated constraint error.
    expect(isMigrationMissing(err('42P019'))).toBe(false)
    expect(isMigrationMissing(err('pgrst205'))).toBe(false)
    expect(isMigrationMissing(err('', 'relation "public.campaigns" does not exist'))).toBe(false)
    expect(isMigrationMissing(err('23505',
      'duplicate key value violates unique constraint, row does not exist yet'))).toBe(false)
  })

  it('is still a FAILED read, so a page must ask this one first', () => {
    // Both are true at once by design. A page that checked read()'s error
    // before this predicate would cover its own actionable yellow banner with
    // an opaque red one on exactly the day the banner is needed.
    const res = { data: null, error: { message: 'relation "public.campaigns" does not exist', code: '42P01' } }
    expect(isMigrationMissing(res)).toBe(true)
    expect(read('campaigns', res).error).not.toBeNull()
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

describe('embedOne', () => {
  // The question this answers is unresolved, on purpose: nobody here has
  // checked whether `clients(name)` arrives from PostgREST as an object or as
  // a one-element array. Fourteen call sites in this repo assume object;
  // supabase-js's select-string parser assumes array. These tests pin that
  // BOTH readings produce the same name, so the answer stops mattering.

  it('passes an object embed straight through', () => {
    expect(embedOne<{ name: string }>({ name: 'Acme' })).toEqual({ name: 'Acme' })
  })

  it('unwraps a one-element array embed to the same row', () => {
    expect(embedOne<{ name: string }>([{ name: 'Acme' }])).toEqual({ name: 'Acme' })
  })

  it('agrees with itself across the two shapes', () => {
    // The actual contract. If this ever fails, /reports renders a client name
    // on one shape and a dash on the other, which is the defect `data: any`
    // was hiding: `({ name: 'Acme' } as any).name` works and
    // `([{ name: 'Acme' }] as any).name` is silently undefined.
    const row = { name: 'Acme' }
    expect(embedOne<typeof row>(row)).toEqual(embedOne<typeof row>([row]))
  })

  it('reads an empty array as absent rather than undefined', () => {
    // `e[0]` alone would hand back undefined here, which passes a `!= null`
    // check differently from null at some call sites and defeats `=== null`
    // at others. An embed with no match is an absence; say so in one word.
    expect(embedOne<{ name: string }>([])).toBeNull()
  })

  it('reads a null or absent embed as absent', () => {
    // PostgREST sends null for a left-join miss; the column is also simply
    // missing when a page's select string never asked for it.
    expect(embedOne<{ name: string }>(null)).toBeNull()
    expect(embedOne<{ name: string }>(undefined)).toBeNull()
  })

  it('keeps a legitimately null field distinct from a missing row', () => {
    // clients.name is nullable. `embedOne(x)?.name` must be able to say "there
    // is a client and it has no name" -- distinct from "there is no client" --
    // or an unnamed client and a broken join render identically.
    expect(embedOne<{ name: string | null }>({ name: null })).toEqual({ name: null })
    expect(embedOne<{ name: string | null }>(null)).toBeNull()
  })

  it('takes the first row when an array embed somehow has several', () => {
    // Should not happen for a many-to-one, but if the cardinality guess is
    // wrong in the other direction, picking one deterministically beats
    // rendering `[object Object]`.
    expect(embedOne<{ name: string }>([{ name: 'A' }, { name: 'B' }])).toEqual({ name: 'A' })
  })
})
