// Deferred construction for clients that must not be built at import time.
//
// src/lib/supabase.ts used to call createClient() at module scope. `next build`
// imports every page and route to collect page data, and 52 files import that
// module, so a missing NEXT_PUBLIC_SUPABASE_URL killed the BUILD rather than any
// request -- which is why every preview deployment on this repo failed, no env
// var being scoped to preview. The `!` on each process.env read is a
// compile-time assertion and checks nothing at runtime, so there was no point
// at which the absence was noticed before supabase-js threw.
//
// Deferring to first property access moves that failure from build time to
// first use. It does NOT soften it: a deployment with no credentials still
// fails, loudly, at the first query -- see the rethrow below. What it buys is
// that a build, and any page that never touches the database, no longer depends
// on credentials being present.

/**
 * Wraps a factory so the value is built on first property access rather than
 * when this function is called, and built at most once.
 *
 * Returns a Proxy typed as the real thing, so existing call sites
 * (`supabaseAdmin.from(...)`, `supabase.auth`) are unchanged.
 */
export function createLazyClient<T extends object>(factory: () => T): T {
  let instance: T | undefined

  const resolve = (): T => {
    // Only a SUCCESSFUL construction is remembered. A factory that threw leaves
    // `instance` undefined so the next access retries, rather than caching a
    // half-built client -- or a stale error -- for the life of the process.
    if (instance === undefined) instance = factory()
    return instance
  }

  // The target is an empty object and is never read from: every `get` is served
  // by the resolved instance. It exists only because Proxy requires one.
  return new Proxy({} as T, {
    get(_target, property) {
      const client = resolve() as Record<PropertyKey, unknown>
      const value = client[property]
      // bind(), so the method runs on the real client rather than on this
      // Proxy. Note what this is NOT for: a plain `supabaseAdmin.from(...)`
      // member call survives without it, because JS sets `this` to the
      // receiver -- the Proxy -- and public property reads just route back
      // through this same handler. Verified by mutation: dropping the bind
      // left those green. It is load-bearing for two other shapes, both real
      // here: a `#private` field is keyed to its own class and throws
      // TypeError when `this` is the Proxy (supabase-js ships class
      // instances), and a method pulled off the object -- `const { from } =
      // ...`, or passed as a callback -- has no receiver at all.
      return typeof value === 'function' ? value.bind(client) : value
    },
  })
}

/**
 * Reads a required environment variable, throwing a message that names it.
 *
 * `env` is a parameter so this is testable without mutating process.env, which
 * leaks between test files.
 */
export function requireEnv(
  name: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const value = env[name]

  // `''` is rejected alongside undefined. A variable set to empty is exactly as
  // unusable as an absent one, and is what a blanked-out dashboard field
  // produces; `?? 'default'` and a bare falsy check disagree on this, so it is
  // stated explicitly.
  if (value === undefined || value === '') {
    throw new Error(
      `Missing required environment variable ${name}. The Supabase client cannot `
      + `be built without it. If this is a Vercel preview deployment, no value is `
      + `scoped to the Preview environment -- set one in Project Settings -> `
      + `Environment Variables.`)
  }

  return value
}
