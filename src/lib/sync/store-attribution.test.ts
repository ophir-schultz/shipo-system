import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createFakeSupabase, type FakeDb, type FakeRow } from '@/lib/ledger/fake-supabase'

const h = vi.hoisted(() => ({ db: null as unknown as FakeDb }))
vi.mock('@/lib/supabase', () => ({
  get supabaseAdmin() { return h.db.client },
}))

const { storeIdOf, loadStoreMap, decideAttribution } =
  await import('@/lib/sync/store-attribution')

beforeEach(() => {
  h.db = createFakeSupabase({ client_store_ids: [] })
})

function seedMapping(storeId: unknown, clientId: unknown) {
  (h.db.tables.client_store_ids as FakeRow[]).push({
    id: `csi-${String(storeId)}`, store_id: storeId, client_id: clientId,
  })
}

describe('storeIdOf', () => {
  it('reads the nested advancedOptions.storeId the API actually sends', () => {
    expect(storeIdOf({ advancedOptions: { storeId: 123456 } })).toBe('123456')
  })

  it('reads a top-level storeId, which older raw_data rows carry', () => {
    expect(storeIdOf({ storeId: '98765' })).toBe('98765')
  })

  it('prefers the nested key when both are present', () => {
    // Not a cosmetic preference. advancedOptions is what the live API populates,
    // so if the two ever disagree the nested one is the current truth and the
    // top-level one is a leftover from an earlier shape.
    expect(storeIdOf({ storeId: 'old', advancedOptions: { storeId: 'new' } })).toBe('new')
  })

  it('stringifies a numeric store id, because client_store_ids.store_id is text', () => {
    // The failure this prevents does not look like a type error. A number
    // compared to the text column's value finds nothing, so every label would
    // report as coming from an unmapped store -- a wrong answer that reads as a
    // data-entry problem and sends someone to map stores that are already
    // mapped.
    const map = new Map([['123456', 'client-a']])
    expect(decideAttribution({
      storeMap: map,
      payload: { advancedOptions: { storeId: 123456 } },
      existingClientId: null,
    })).toEqual({ action: 'attribute', clientId: 'client-a' })
  })

  it('treats a blank or whitespace store id as no store id at all', () => {
    // '' is a valid Map key. Letting it through would gather every store-less
    // label under one key, and a single blank-store_id row in client_store_ids
    // would then attribute all of them to that client in one pass.
    expect(storeIdOf({ advancedOptions: { storeId: '' } })).toBeNull()
    expect(storeIdOf({ advancedOptions: { storeId: '   ' } })).toBeNull()
  })

  it('returns null rather than throwing on the shapes a payload is not', () => {
    expect(storeIdOf(null)).toBeNull()
    expect(storeIdOf(undefined)).toBeNull()
    expect(storeIdOf('not an object')).toBeNull()
    expect(storeIdOf({})).toBeNull()
    expect(storeIdOf({ advancedOptions: null })).toBeNull()
    expect(storeIdOf({ advancedOptions: { storeId: null } })).toBeNull()
    expect(storeIdOf({ advancedOptions: { storeId: { nested: 1 } } })).toBeNull()
    expect(storeIdOf({ advancedOptions: { storeId: NaN } })).toBeNull()
  })

  it('trims a store id that arrives padded', () => {
    expect(storeIdOf({ advancedOptions: { storeId: ' 4242 ' } })).toBe('4242')
  })
})

describe('loadStoreMap', () => {
  it('builds store_id -> client_id', async () => {
    seedMapping('111', 'client-a')
    seedMapping('222', 'client-b')

    const { map, error } = await loadStoreMap()

    expect(error).toBeNull()
    expect(map?.get('111')).toBe('client-a')
    expect(map?.get('222')).toBe('client-b')
    expect(map?.size).toBe(2)
  })

  it('returns an EMPTY map when nobody has mapped a store yet', async () => {
    // The positive control for the test below, and it is not optional. "A
    // failed read must not look like an empty map" can only be asserted if the
    // empty map is itself a reachable, non-error state -- otherwise the next
    // test passes against an implementation that returns null for both.
    const { map, error } = await loadStoreMap()

    expect(error).toBeNull()
    expect(map).toBeInstanceOf(Map)
    expect(map?.size).toBe(0)
  })

  it('returns map: null when the read FAILED, not an empty map', async () => {
    // The distinction the whole return shape exists for. An empty map on
    // failure makes every store report as unmapped: the monitor would raise an
    // alert naming stores that are already mapped and asking a person to map
    // them, while the actual fault is one select. The alert that is wrong about
    // what needs doing spends the attention a real one needs.
    h.db.failOn = (call) => call.table === 'client_store_ids'
      ? { message: 'permission denied for table client_store_ids', code: '42501' }
      : null

    const { map, error } = await loadStoreMap()

    expect(map).toBeNull()
    expect(error).toMatchObject({ code: '42501' })
  })

  it('drops a lookup row with either half missing', async () => {
    // Not reachable through the schema -- both columns are NOT NULL -- but the
    // map is also built from backfill output and hand edits. A half-row would
    // map a store to the client_id `null`, which PostgREST sends as a literal
    // and the foreign key rejects, failing the shipment update over a bad
    // lookup row rather than over anything wrong with the shipment.
    seedMapping('333', null)
    seedMapping(null, 'client-c')
    seedMapping('444', 'client-d')

    const { map } = await loadStoreMap()

    expect(map?.size).toBe(1)
    expect(map?.get('444')).toBe('client-d')
  })

  it('stringifies and trims both sides of a stored mapping', async () => {
    seedMapping(555, ' client-e ')

    const { map } = await loadStoreMap()

    expect(map?.get('555')).toBe('client-e')
  })
})

describe('decideAttribution', () => {
  const map = new Map([['111', 'client-a'], ['222', 'client-b']])

  it('attributes an unattributed shipment from a mapped store', async () => {
    expect(decideAttribution({
      storeMap: map,
      payload: { advancedOptions: { storeId: '111' } },
      existingClientId: null,
    })).toEqual({ action: 'attribute', clientId: 'client-a' })
  })

  it('leaves a shipment alone when the map agrees with what it already holds', () => {
    expect(decideAttribution({
      storeMap: map,
      payload: { advancedOptions: { storeId: '111' } },
      existingClientId: 'client-a',
    })).toEqual({ action: 'keep' })
  })

  it('reports a conflict instead of overwriting a stored attribution', () => {
    // zenventory.ts attributes by order_number and a person attributed 291 rows
    // by hand. Where the store map disagrees with either, one of the two is
    // wrong and a sync has no way to tell which -- so it writes neither and
    // says so. Overwriting would move a real invoice from one client to
    // another, three times a day, with no record that it moved.
    const decision = decideAttribution({
      storeMap: map,
      payload: { advancedOptions: { storeId: '111' } },
      existingClientId: 'client-zzz',
    })

    expect(decision).toEqual({
      action: 'conflict',
      existingClientId: 'client-zzz',
      mappedClientId: 'client-a',
    })
    // And it carries BOTH ids, because an alert that says "a conflict" without
    // naming the two clients cannot be acted on without a SQL session.
  })

  it('does not call a representation difference a conflict', () => {
    expect(decideAttribution({
      storeMap: map,
      payload: { advancedOptions: { storeId: '111' } },
      existingClientId: '  client-a  ',
    })).toEqual({ action: 'keep' })
  })

  it('names the store when the store is real and unmapped', () => {
    // The actionable case: one row in client_store_ids attributes every
    // shipment that store has ever sent, so the id is the entire content of
    // the alert.
    expect(decideAttribution({
      storeMap: map,
      payload: { advancedOptions: { storeId: '999' } },
      existingClientId: null,
    })).toEqual({ action: 'unmapped-store', storeId: '999' })
  })

  it('separates a label with no store key from one whose store is unmapped', () => {
    // Different work, so they cannot share a counter. An unmapped store is one
    // INSERT away from being fixed for every shipment from it; a label with no
    // store key at all cannot be attributed by any SQL and needs someone
    // reading tracking numbers in ShipStation. Collapsing the two hides which
    // kind of problem the money is actually sitting behind.
    expect(decideAttribution({
      storeMap: map,
      payload: { orderNumber: 'A-1' },
      existingClientId: null,
    })).toEqual({ action: 'no-store-id' })
  })

  it('reports map-unavailable rather than claiming a mapped store needs mapping', () => {
    // With the map unreadable, an implementation that consulted the payload
    // first would answer 'unmapped-store' here -- a confident claim that this
    // store needs a mapping row, made by code that could not read the mapping
    // table, about a store that is in fact already mapped.
    expect(decideAttribution({
      storeMap: null,
      payload: { advancedOptions: { storeId: '111' } },
      existingClientId: null,
    })).toEqual({ action: 'map-unavailable' })
  })

  it('reports map-unavailable ahead of no-store-id, so a degraded pass asks for no hand work', () => {
    // THE CASE THAT PINS THE ORDER, and the test the first version of this file
    // was missing: with the map unreadable AND no store key on the label, the
    // checks disagree, and the test above cannot tell them apart because its
    // payload has a store id either way.
    //
    // Both answers are true of this input. Only one is safe to report.
    // 'no-store-id' is counted and surfaced as "cannot be attributed by any
    // SQL -- someone must read tracking numbers in ShipStation", which is a
    // claim about work a person has to do; making it from a pass that could
    // not read the lookup table is how a person spends an afternoon on a
    // failed select. 'map-unavailable' is one signal for the whole run and
    // asks for the one thing that is actually wrong.
    expect(decideAttribution({
      storeMap: null,
      payload: { orderNumber: 'A-1' },
      existingClientId: null,
    })).toEqual({ action: 'map-unavailable' })
  })

  it('NEVER returns attribute for a shipment that already has a client', () => {
    // The case that must never fire, asserted directly rather than inferred
    // from the examples above. A sync running three times a day that re-decided
    // attribution and got it wrong would un-bill or mis-bill the only
    // shipments in this database anyone can currently invoice.
    const existing = ['client-a', 'client-b', 'client-zzz', '  client-a  ']
    const payloads: unknown[] = [
      { advancedOptions: { storeId: '111' } },
      { advancedOptions: { storeId: '222' } },
      { advancedOptions: { storeId: '999' } },
      { advancedOptions: { storeId: '' } },
      { storeId: 111 },
      {},
      null,
    ]
    const maps: Array<Map<string, string> | null> = [map, new Map(), null]

    for (const storeMap of maps) {
      for (const payload of payloads) {
        for (const existingClientId of existing) {
          const decision = decideAttribution({ storeMap, payload, existingClientId })
          expect(decision.action).not.toBe('attribute')
        }
      }
    }
  })

  it('attributes across that same matrix wherever the row is unattributed and the store is mapped', () => {
    // The counterpart, so the assertion above is not satisfied by a function
    // that returns 'keep' for everything. Same payloads, same maps, with the
    // existing client empty: exactly the mapped-store cases must attribute, and
    // the ones that must not are named individually rather than left implied.
    const blank = [null, undefined, '', '   '] as Array<string | null | undefined>

    for (const existingClientId of blank) {
      expect(decideAttribution({
        storeMap: map, payload: { advancedOptions: { storeId: '222' } }, existingClientId,
      })).toEqual({ action: 'attribute', clientId: 'client-b' })

      expect(decideAttribution({
        storeMap: map, payload: { advancedOptions: { storeId: '999' } }, existingClientId,
      }).action).toBe('unmapped-store')

      expect(decideAttribution({
        storeMap: new Map(), payload: { advancedOptions: { storeId: '111' } }, existingClientId,
      }).action).toBe('unmapped-store')

      expect(decideAttribution({
        storeMap: null, payload: { advancedOptions: { storeId: '111' } }, existingClientId,
      }).action).toBe('map-unavailable')
    }
  })
})
