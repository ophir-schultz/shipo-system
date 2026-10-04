import { describe, it, expect } from 'vitest'
import { createLazyClient, requireEnv } from './lazy-client'

// The bug being locked down: src/lib/supabase.ts built both Supabase clients at
// MODULE SCOPE, from `process.env.NEXT_PUBLIC_SUPABASE_URL!`. The `!` is a
// compile-time assertion and checks nothing at runtime, so with the variable
// absent createClient() threw "supabaseUrl is required." the moment the module
// was imported. `next build` imports every page and route to collect page data,
// and 52 files import this module, so the BUILD died rather than any request --
// which is why every preview deployment on this repo has failed (verified
// first-hand: dpl_DQ6gtMxBJSkh5rG6dbPuE1T6Hr9T, state ERROR).
//
// Deferring construction to first use is what makes the build survive. The
// assertions that matter most are therefore: the factory is NOT called when the
// client is created, it IS called on first property access, and it is called
// only once. The rest exist so that laziness does not buy a passing build at
// the price of a client that misbehaves -- a detached `this`, a swallowed
// configuration error, or a broken client cached for the life of the process.

describe('createLazyClient', () => {
  it('does not call the factory when the lazy client is created', () => {
    let calls = 0
    createLazyClient(() => { calls++; return {} })

    // This is the whole point: at module scope this is the line that used to
    // throw, and nothing has touched the client yet.
    expect(calls).toBe(0)
  })

  it('calls the factory on first property access', () => {
    let calls = 0
    const client = createLazyClient(() => { calls++; return { from: () => 'rows' } })

    const from = client.from

    expect(calls).toBe(1)
    expect(from()).toBe('rows')
  })

  it('calls the factory only once however many properties are read', () => {
    let calls = 0
    const client = createLazyClient(() => {
      calls++
      return { from: () => 'rows', auth: {}, rpc: () => 'rpc' }
    })

    void client.from
    void client.auth
    void client.rpc
    void client.from

    // A factory called per access would open a new connection pool per query.
    expect(calls).toBe(1)
  })

  it('keeps `this` bound to the real client when a method is called', () => {
    // supabaseAdmin.from(...) is used 59 times. A naive `get` that returns the
    // raw function detaches it from its receiver, so any method reading its own
    // state breaks -- and supabase-js methods do.
    const client = createLazyClient(() => ({
      table: 'shipments',
      from(this: { table: string }) { return this.table },
    }))

    expect(client.from()).toBe('shipments')
  })

  // NOTE ON THE TEST ABOVE: it does not discriminate, and is kept only as
  // documentation. `client.from()` is a member call, so JS sets `this` to the
  // RECEIVER -- the Proxy -- and `this.table` is then served by the same `get`
  // handler off the real instance. It therefore passes whether or not `get`
  // binds. Verified by mutation: deleting the bind() left it green. The two
  // tests below are the ones that actually hold bind() in place.

  it('calls methods ON the real client, so private fields resolve', () => {
    // This is the case that makes bind() load-bearing rather than decorative.
    // A `#private` field is keyed to the instance's own class, and a Proxy is
    // NOT that instance -- so `this.#table` with `this` set to the Proxy throws
    // TypeError, even though every public property forwards fine. supabase-js
    // ships class instances, so an unbound `get` is a live hazard here, not a
    // hypothetical one.
    class Client {
      #table = 'shipments'
      from() { return this.#table }
    }

    const client = createLazyClient(() => new Client())

    expect(client.from()).toBe('shipments')
  })

  it('keeps a method working after it is detached from the client', () => {
    // `const { from } = supabaseAdmin` and callback passing both drop the
    // receiver. Without bind() `this` is undefined at call time.
    // A class, not an object literal with an explicit `this` parameter: tsc
    // rejects calling the latter detached, which would make the test fail at
    // compile time instead of exercising the runtime behaviour.
    class Client {
      table = 'shipments'
      from() { return this.table }
    }

    const client = createLazyClient(() => new Client())

    const { from } = client

    expect(from()).toBe('shipments')
  })

  it('forwards nested property access like auth.getUser()', () => {
    // `supabase.auth` is read 20 times, and `.auth` is an object, not a method.
    const client = createLazyClient(() => ({
      auth: { getUser: () => ({ user: 'ophir' }) },
    }))

    expect(client.auth.getUser()).toEqual({ user: 'ophir' })
  })

  it('rethrows a factory failure to the caller that touched the client', () => {
    // The missing-variable error must still be LOUD -- it just has to arrive at
    // the first real use instead of at import. Swallowing it here would turn a
    // misconfigured deployment into a silently broken one, which is worse than
    // the failed build this change is removing.
    const client = createLazyClient<{ from: () => string }>(() => {
      throw new Error('supabaseUrl is required.')
    })

    expect(() => client.from).toThrow('supabaseUrl is required.')
  })

  it('does not cache a failed construction', () => {
    // If the first access failed, the next one must try again rather than serve
    // a half-built client or a stale error for the life of the process.
    let calls = 0
    const client = createLazyClient<{ from: () => string }>(() => {
      calls++
      throw new Error('boom')
    })

    expect(() => client.from).toThrow('boom')
    expect(() => client.from).toThrow('boom')
    expect(calls).toBe(2)
  })
})

describe('requireEnv', () => {
  it('returns the value when the variable is set', () => {
    expect(requireEnv('X_TEST_VAR', { X_TEST_VAR: 'https://db.example' }))
      .toBe('https://db.example')
  })

  it('throws naming the missing variable', () => {
    // `process.env.NEXT_PUBLIC_SUPABASE_URL!` produced "supabaseUrl is
    // required." -- an error naming supabase-js's parameter, not the variable an
    // operator has to set. The name of the variable is the actionable part.
    expect(() => requireEnv('NEXT_PUBLIC_SUPABASE_URL', {}))
      .toThrow('NEXT_PUBLIC_SUPABASE_URL')
  })

  it('treats an empty variable as missing', () => {
    // An env var set to '' is exactly as unusable as an absent one, and is how
    // a blanked-out dashboard field arrives. `??` would accept it.
    expect(() => requireEnv('NEXT_PUBLIC_SUPABASE_URL', { NEXT_PUBLIC_SUPABASE_URL: '' }))
      .toThrow('NEXT_PUBLIC_SUPABASE_URL')
  })
})
