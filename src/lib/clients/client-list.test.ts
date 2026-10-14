import { describe, it, expect } from 'vitest'
import { readClientList } from './client-list'

// The subject is one question: is this a list of clients, or a read that
// failed? Every case below is chosen to separate the correct answer from a
// plausible wrong one, because the wrong ones are all SILENT -- they render a
// dropdown with nothing in it, which looks exactly like a client list with
// nobody on it.

const ROWS = [
  { id: 'c1', name: 'Acme' },
  { id: 'c2', name: 'Globex' },
]

// What the route actually sends on a failed read, copied from
// api/clients/list/route.ts.
const ROUTE_503 = { error: 'Could not read the client list: relation "clients" does not exist' }

describe('readClientList', () => {
  describe('a failed read is refused', () => {
    it("uses the server's own wording, not a house message", () => {
      const r = readClientList({ ok: false, status: 503 }, ROUTE_503)
      expect(r.ok).toBe(false)
      // Verbatim. An implementation that invented its own copy would pass a
      // `toBe(false)` assertion and fail this one, and the difference matters:
      // this particular message names a missing migration, which is a
      // different action from waiting out an outage.
      expect(r.error).toBe(ROUTE_503.error)
    })

    it('falls back to the status when the body would not parse as JSON', () => {
      // The caller hands null for that, so null must not read as "no error".
      const r = readClientList({ ok: false, status: 503 }, null)
      expect(r.ok).toBe(false)
      expect(r.error).toBe('HTTP 503')
    })

    it('falls back to the status when the body carries a blank reason', () => {
      // A blank reason refuses the screen and says nothing about why. Three
      // spellings of blank, because `error: ''` and `error: '   '` are the two
      // a JSON body can really arrive with and `?? ` alone catches neither.
      for (const body of [{ error: '' }, { error: '   ' }, { error: '\n' }]) {
        const r = readClientList({ ok: false, status: 503 }, body)
        expect(r.ok).toBe(false)
        expect(r.error).toBe('HTTP 503')
      }
    })

    it('falls back to the status when `error` is not a string', () => {
      // `{ error: 42 }` through a bare `?? ` would put the number 42 on screen
      // as the reason, or worse, `[object Object]`.
      for (const body of [{ error: 42 }, { error: null }, { error: { nested: 'x' } }]) {
        const r = readClientList({ ok: false, status: 503 }, body)
        expect(r.ok).toBe(false)
        expect(r.error).toBe('HTTP 503')
      }
    })

    it('refuses even when the failure body happens to be an array of clients', () => {
      // The status is the authority, not the shape. This is the case that
      // kills a reader which tests `Array.isArray(body)` first: that one
      // returns a confident, populated client list from a 503.
      const r = readClientList({ ok: false, status: 503 }, ROWS)
      expect(r.ok).toBe(false)
      expect(r.error).toBe('HTTP 503')
      expect(r.data).toBeUndefined()
    })

    it('reports the real status rather than a hardcoded 503', () => {
      // 401 and 500 reach this screen too -- requireStaff() answers one of
      // them -- and "HTTP 503" printed over an expired session sends the
      // reader to the database instead of to the login page.
      expect(readClientList({ ok: false, status: 401 }, null).error).toBe('HTTP 401')
      expect(readClientList({ ok: false, status: 500 }, null).error).toBe('HTTP 500')
    })

    it('never hands back rows alongside a refusal', () => {
      const r = readClientList({ ok: false, status: 503 }, ROUTE_503)
      expect(r.data).toBeUndefined()
    })
  })

  describe('a 200 that is not a list is also refused', () => {
    it('refuses null, and says so without claiming a count', () => {
      const r = readClientList({ ok: true, status: 200 }, null)
      expect(r.ok).toBe(false)
      expect(r.error).toContain('null')
      expect(r.error).toContain('not a list')
      expect(r.data).toBeUndefined()
    })

    it('refuses an object, including one shaped like an error', () => {
      // A route that started answering `{ clients: [...] }` would land here,
      // and so would a 200 carrying `{ error }`. Both are shape changes this
      // screen must not read as "no clients".
      for (const body of [{}, { clients: ROWS }, { error: 'x' }]) {
        const r = readClientList({ ok: true, status: 200 }, body)
        expect(r.ok).toBe(false)
        expect(r.data).toBeUndefined()
      }
    })

    it('refuses a string, which is what an HTML error page parses to', () => {
      const r = readClientList({ ok: true, status: 200 }, '<html>502 Bad Gateway</html>')
      expect(r.ok).toBe(false)
      expect(r.error).toContain('string')
    })
  })

  describe('a successful read is accepted, empty or not', () => {
    it('returns the rows', () => {
      const r = readClientList({ ok: true, status: 200 }, ROWS)
      expect(r.ok).toBe(true)
      expect(r.error).toBeNull()
      expect(r.data).toEqual(ROWS)
    })

    it('accepts a genuinely empty list as empty, not as a failure', () => {
      // The counter-test, and the reason the others are not enough on their
      // own: a function that refused EVERYTHING would satisfy every assertion
      // above. An empty `clients` table is a real answer and the screen is
      // entitled to say so.
      const r = readClientList({ ok: true, status: 200 }, [])
      expect(r.ok).toBe(true)
      expect(r.error).toBeNull()
      expect(r.data).toEqual([])
    })

    it('hands back the same array, not a copy', () => {
      // Pins that the rows are passed through untouched -- no filtering, no
      // sorting. The route already orders by name, and re-sorting here would
      // put the dropdown in a different order than the server promised.
      const r = readClientList({ ok: true, status: 200 }, ROWS)
      expect(r.data).toBe(ROWS)
    })
  })

  it('accepts a real Response structurally', () => {
    // The page passes the Response straight in. If this ever stops compiling
    // the call site has to change, so it is worth pinning that a genuine
    // Response satisfies the parameter.
    const res = new Response('[]', { status: 200 })
    const r = readClientList(res, [])
    expect(r.ok).toBe(true)
  })
})
