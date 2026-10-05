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
      // client_id is in the payload because it is in the conflict target, and
      // the double now refuses a target naming a key the payload lacks. This
      // fixture used to omit it, which is how that hole was found.
      .upsert({ client_id: 'c1', order_key: 'A-1' }, { onConflict: 'client_id,order_key' })
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

describe('fake-supabase — gt()', () => {
  it('drops null rather than comparing it, as SQL does', async () => {
    // A null is not > anything in Postgres, so the row is excluded. Were the
    // double to treat null as 0, the monitor's undated-pick scan would report
    // every line that has never been picked as a line picked without a date.
    const db = createFakeSupabase({
      order_items: [
        { id: 'i1', quantity_picked: 2 },
        { id: 'i2', quantity_picked: 0 },
        { id: 'i3', quantity_picked: null },
      ],
    })

    const { data } = await db.client
      .from('order_items').select('id').gt('quantity_picked', 0)

    // The whole row, because the double does not model column projection.
    expect(data).toEqual([{ id: 'i1', quantity_picked: 2 }])
  })

  it('compares numbers NUMERICALLY, not as strings', async () => {
    // The trap its sibling operators get away with: lt/lte/gte here only ever
    // receive ISO dates, which sort correctly as strings. gt()'s caller
    // compares an integer quantity, and as strings '9' > '10' is true, so a
    // 9-unit line would pass a 10-unit threshold.
    const db = createFakeSupabase({
      order_items: [{ id: 'i1', quantity_picked: 9 }],
    })

    const { data } = await db.client
      .from('order_items').select('id').gt('quantity_picked', 10)

    expect(data).toEqual([])
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

describe('fake-supabase — the onConflict target', () => {
  // Why this is worth a test of the harness itself: without it, a typo in a
  // conflict target was INVISIBLE here but fatal in production. The double
  // matched on `valuesEqual(row[k], incoming[k])`, and for a column neither
  // side has that is `undefined === undefined` -- true. So a misspelled target
  // matched the first row in the table, every row in a batch collapsed onto it,
  // and the upsert still looked like it worked. Real PostgREST answers 42703
  // for the unknown column, or 42P10 when no unique index matches the target.
  //
  // persist-charges.test.ts's idempotency test, which spec §8 calls the single
  // most important test in the file, documented this as a known blind spot:
  // it could prove charge_key was deterministic and could say nothing at all
  // about `onConflict: 'order_id,charge_key'`. This closes it.
  it('refuses a conflict target naming a key the payload does not have', async () => {
    const db = createFakeSupabase({ order_charges: [] })

    await expect(db.client.from('order_charges').upsert(
      { charge_key: 'shipment:1', amount: 5 },
      { onConflict: 'order_id,charge_key' },
    )).rejects.toThrow(/onConflict target, but the payload has no such key/)
  })

  it('accepts a conflict key that is present and null', async () => {
    // Not a special case to be kind about -- it is how storage charges and
    // unattributed label spend are stored. order_id null is a legitimate
    // conflict-target value that NULL-distinctness leaves unconstrained, which
    // is precisely why ledger_03_charges.sql carries two further partial unique
    // indexes for those rows. Present-and-null must pass; only absent fails.
    const db = createFakeSupabase({ order_charges: [] })

    const { error } = await db.client.from('order_charges').upsert(
      { order_id: null, charge_key: 'storage:2026-09-01:pallet', amount: 5 },
      { onConflict: 'order_id,charge_key' },
    )

    expect(error).toBeNull()
    expect(db.tables.order_charges).toHaveLength(1)
  })

  it('does not collapse a batch onto one row when the target is correct', async () => {
    // The shape of the failure the guard exists to expose: three distinct
    // charge keys for one order must be three rows. Under the old behaviour a
    // mangled target made this one row, and nothing said so.
    const db = createFakeSupabase({ order_charges: [] })

    await db.client.from('order_charges').upsert([
      { order_id: 'o1', charge_key: 'item:a:pick', amount: 1 },
      { order_id: 'o1', charge_key: 'item:a:pack', amount: 2 },
      { order_id: 'o1', charge_key: 'shipment:9', amount: 3 },
    ], { onConflict: 'order_id,charge_key' })

    expect(db.tables.order_charges).toHaveLength(3)
  })
})

describe('fake-supabase — upsert({ ignoreDuplicates })', () => {
  // supabase-js turns this option into `Prefer: resolution=ignore-duplicates`,
  // which is `ON CONFLICT DO NOTHING` rather than `DO UPDATE`. Two consequences
  // are load-bearing for sync/shipstation.ts's rate-adjustment write and
  // neither is visible in a fixture where the incoming payload happens to match
  // the stored row, so both get their own test:
  //
  //   1. the stored row is LEFT ALONE. An already-approved adjustment must not
  //      be reset to 'pending' by a second overlapping sync, and its
  //      adjustment_date must not move.
  //   2. the skipped row is ABSENT from the returned representation. That is
  //      the only signal the caller has for "I did not write this", and
  //      shipstation.ts counts results.adjustments off exactly that.
  it('leaves the stored row alone instead of merging the incoming payload', async () => {
    const db = createFakeSupabase({
      rate_adjustments: [
        { id: 'a1', shipment_id: 's1', adjustment_amount: 1.5, status: 'approved' },
      ],
    })

    await db.client.from('rate_adjustments').upsert(
      { shipment_id: 's1', adjustment_amount: 1.5, status: 'pending' },
      { onConflict: 'shipment_id,adjustment_amount', ignoreDuplicates: true },
    )

    expect(db.tables.rate_adjustments).toHaveLength(1)
    expect(db.tables.rate_adjustments[0]).toMatchObject({ status: 'approved' })
  })

  it('returns an EMPTY representation for a row it skipped', async () => {
    const db = createFakeSupabase({
      rate_adjustments: [{ id: 'a1', shipment_id: 's1', adjustment_amount: 1.5 }],
    })

    const { data, error } = await db.client.from('rate_adjustments').upsert(
      { shipment_id: 's1', adjustment_amount: 1.5, status: 'pending' },
      { onConflict: 'shipment_id,adjustment_amount', ignoreDuplicates: true },
    ).select('id')

    expect(error).toBeNull()
    expect(data).toEqual([])
  })

  it('returns the row when there was no conflict, so [] really means "skipped"', async () => {
    // The positive control for the test above. Without it, a double that
    // returned [] from every ignoreDuplicates upsert -- conflict or not --
    // would pass, and shipstation.ts would then be proven to count nothing at
    // all rather than to count only what it wrote.
    const db = createFakeSupabase({ rate_adjustments: [] })

    const { data } = await db.client.from('rate_adjustments').upsert(
      { shipment_id: 's1', adjustment_amount: 1.5, status: 'pending' },
      { onConflict: 'shipment_id,adjustment_amount', ignoreDuplicates: true },
    ).select('id')

    expect(data).toHaveLength(1)
  })

  it('keeps processing a batch after the first duplicate', async () => {
    // The skip is `continue` inside the per-row loop, not `break`. A `break`
    // passes every single-row test in this file and silently discards every
    // row AFTER the first conflict in a batch -- the kind of hole that only
    // shows up once some future caller upserts an array.
    const db = createFakeSupabase({
      rate_adjustments: [{ id: 'a1', shipment_id: 's1', adjustment_amount: 1.5 }],
    })

    await db.client.from('rate_adjustments').upsert([
      { shipment_id: 's1', adjustment_amount: 1.5 },
      { shipment_id: 's1', adjustment_amount: 2.5 },
      { shipment_id: 's2', adjustment_amount: 1.5 },
    ], { onConflict: 'shipment_id,adjustment_amount', ignoreDuplicates: true })

    expect(db.tables.rate_adjustments).toHaveLength(3)
  })

  it('still merges on conflict when ignoreDuplicates is not asked for', async () => {
    // The default must not have moved. Every other upsert in the codebase --
    // orders, order_items, order_charges -- relies on DO UPDATE, and a change
    // that made skipping universal would break them in a way no test above
    // distinguishes.
    const db = createFakeSupabase({
      order_charges: [{ id: 'c1', order_id: 'o1', charge_key: 'item:a:pick', amount: 1 }],
    })

    await db.client.from('order_charges').upsert(
      { order_id: 'o1', charge_key: 'item:a:pick', amount: 99 },
      { onConflict: 'order_id,charge_key' },
    )

    expect(db.tables.order_charges).toHaveLength(1)
    expect(db.tables.order_charges[0]).toMatchObject({ amount: 99 })
  })
})
