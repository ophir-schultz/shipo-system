import { describe, it, expect } from 'vitest'
import { createFakeSupabase } from '@/lib/ledger/fake-supabase'

// A test double is only worth what its fidelity is worth. These tests exist
// because the double is now the sole evidence for the two database modules in
// this task, and a double that is KINDER than supabase-js turns every test
// written against it into evidence for a behaviour production does not have.
//
// They are deliberately about the places where the real client is surprising,
// not about the places where it is obvious.

describe('fake-supabase — maybeSingle()', () => {
  it('returns the row when exactly one matches', async () => {
    const db = createFakeSupabase({ sync_runs: [{ id: 'r1', source: 'charges' }] })

    const { data, error } = await db.client
      .from('sync_runs').select('id').eq('source', 'charges').maybeSingle()

    expect(error).toBeNull()
    expect(data).toMatchObject({ id: 'r1' })
  })

  it('returns null with no error when nothing matches', async () => {
    // This is the difference between maybeSingle() and single(), and it is the
    // reason openSyncRun() can use it: no row yet is not an error.
    const db = createFakeSupabase({ sync_runs: [] })

    const { data, error } = await db.client
      .from('sync_runs').select('id').eq('source', 'charges').maybeSingle()

    expect(error).toBeNull()
    expect(data).toBeNull()
  })

  it('returns a PGRST116 ERROR OBJECT — not the first row, and not a throw — on multiple matches', async () => {
    // THE DRIFT GUARD. supabase-js does not throw here; it returns
    // { data: null, error: { code: 'PGRST116' } }. Code that destructures only
    // `data` therefore reads null as "no row exists" and inserts a duplicate —
    // the defect fixed three times on this branch and documented as DEFECT 1 in
    // sync/shipstation.ts. An earlier version of this double answered
    // `affected[0]`, which makes that whole class of bug untestable: the test
    // passes, production duplicates.
    const db = createFakeSupabase({
      sync_runs: [
        { id: 'r1', source: 'charges' },
        { id: 'r2', source: 'charges' },
      ],
    })

    const { data, error } = await db.client
      .from('sync_runs').select('id').eq('source', 'charges').maybeSingle()

    expect(data).toBeNull()
    expect(error).toMatchObject({ code: 'PGRST116' })
  })

  it('is measured on the rows actually returned, so a limit(1) is one match', async () => {
    // Not a pedantic case: it is how a caller legitimately narrows a query that
    // would otherwise be ambiguous, and the double has to agree with PostgREST
    // about whether the limit applies before the single-row check.
    const db = createFakeSupabase({
      sync_runs: [
        { id: 'r1', source: 'charges' },
        { id: 'r2', source: 'charges' },
      ],
    })

    const { data, error } = await db.client
      .from('sync_runs').select('id').eq('source', 'charges')
      .order('id', { ascending: true }).limit(1).maybeSingle()

    expect(error).toBeNull()
    expect(data).toMatchObject({ id: 'r1' })
  })
})

describe('fake-supabase — single()', () => {
  it('returns the row when exactly one matches', async () => {
    const db = createFakeSupabase({ orders: [] })

    const { data, error } = await db.client
      .from('orders')
      .upsert({ order_key: 'A-1' }, { onConflict: 'client_id,order_key' })
      .select('id').single()

    expect(error).toBeNull()
    expect(data).toMatchObject({ order_key: 'A-1' })
  })

  it('errors on ZERO rows, where maybeSingle() would answer null', async () => {
    // The whole reason the double needs both. zenventory.ts branches on
    // `if (orderErr || !orderRow)` after an upsert...single(); if the double
    // answered null-with-no-error for the empty case, the test would exercise
    // the `!orderRow` half while production took the `orderErr` half.
    const db = createFakeSupabase({ orders: [] })

    const { data, error } = await db.client
      .from('orders').select('id').eq('order_key', 'nope').single()

    expect(data).toBeNull()
    expect(error).toMatchObject({ code: 'PGRST116' })
  })

  it('errors on multiple rows, as maybeSingle() does', async () => {
    const db = createFakeSupabase({
      orders: [{ id: 'o1', order_key: 'A-1' }, { id: 'o2', order_key: 'A-1' }],
    })

    const { error } = await db.client
      .from('orders').select('id').eq('order_key', 'A-1').single()

    expect(error).toMatchObject({ code: 'PGRST116' })
  })
})

describe('fake-supabase — unimplemented operators fail loudly', () => {
  it('throws rather than silently matching everything', () => {
    // The default that matters most. A double that quietly ignored an operator
    // it did not model would return MORE rows than production, and a
    // stale-delete test would pass on a filter that does not exist.
    const db = createFakeSupabase({ shipments: [{ id: 's1' }] })

    expect(() =>
      db.client.from('shipments').select('id').not('ship_date', 'gt', '2026-01-01'),
    ).toThrow(/unimplemented/)
  })
})
