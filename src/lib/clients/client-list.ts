// What GET /api/clients/list said -- read so that a FAILED read cannot be
// mistaken for a client list with nobody on it.
//
// The shape this replaces, in app/scan/page.tsx:
//
//   fetch('/api/clients/list')
//     .then((r) => r.json())
//     .then((data: Client[]) => setClients(Array.isArray(data) ? data : []))
//     .catch(() => setClients([]))
//
// That route now answers 503 with `{ error }` when the database cannot be
// asked, and BOTH of those last two lines map it onto the same value as a
// successful read of an empty table. A 503 body is an object, so
// `Array.isArray(data) ? data : []` discards the explanation the server went
// to the trouble of sending and leaves an empty dropdown; the `.catch` does
// the same for a network failure. The operator standing at the scan station
// reads an empty dropdown as "this client is not set up yet" -- and the scan
// they came to record is billable work on cartons that are about to be sealed
// and shipped. Same defect lib/db/read.ts exists to remove, on the browser
// side of the same wire.
//
// This is a function in lib/ rather than four lines in the page because
// vitest.config.ts includes only `src/**/*.test.ts`: logic held in a .tsx
// cannot be given a test at all, and this is the logic that decides whether a
// screen is entitled to say there are no clients. Same reason
// lib/billing/warehouse-log-form.ts was extracted out of the warehouse page.

import type { Loaded } from '@/lib/db/read'

/** A row of GET /api/clients/list, which selects `id, name` where active. */
export type Client = { id: string; name: string }

/**
 * The server's own wording, when it sent any.
 *
 * Returned verbatim rather than replaced with a house message: the route
 * distinguishes reasons an operator can act on ("Could not read the client
 * list: relation does not exist" is a missing migration, not an outage), and a
 * screen that overwrites that with "could not load clients" has thrown the
 * actionable half away.
 *
 * A blank `error` is treated as no reason at all, matching `loaded()` in
 * lib/db/read.ts, which filters '' out for the same reason: an empty red box
 * refuses the screen and says nothing about why, which is worse than printing
 * the status code.
 */
function serverReason(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null
  const reason = (body as { error?: unknown }).error
  return typeof reason === 'string' && reason.trim() !== '' ? reason : null
}

/**
 * The client list, or the reason there isn't one -- never the two collapsed
 * together.
 *
 * Takes the response's `ok`/`status` and the already-parsed body rather than
 * the Response itself, so the awaiting and the `.json()` stay in the page and
 * every branch of the decision is reachable from a test. A real `Response` is
 * structurally assignable to the first parameter, so the call site passes it
 * unchanged.
 *
 * Returns `Loaded` from lib/db/read.ts rather than its own union. That type's
 * redundant `ok` literal is the whole mechanism: it makes the union
 * discriminated, so `data` stays `undefined` until the caller has branched and
 * assigning it to `Client[]` without checking is a compile error. The header
 * of that file has the full reasoning, and duplicating the type here would
 * give the doctrine a second definition to drift from.
 */
export function readClientList(
  res: { ok: boolean; status: number },
  body: unknown,
): Loaded<Client[]> {
  // The status decides, and it is asked FIRST. A reader that checked the shape
  // first would accept any failure whose body happened to parse as an array --
  // and would report "came back as an object" over a 503 that had just
  // explained itself in words.
  if (!res.ok) {
    return { ok: false, error: serverReason(body) ?? `HTTP ${res.status}` }
  }

  // A 200 whose body is not a list is not an empty list either. This catches
  // both a body that would not parse as JSON at all -- the caller hands null
  // for that -- and a future change to what the route returns. Refusing is
  // what the `: []` fallback should always have done; it also stops the
  // render crashing on `clients.map`.
  if (!Array.isArray(body)) {
    return {
      ok: false,
      error:
        `The client list came back as ${body === null ? 'null' : typeof body}, `
        + `not a list. Nothing here says how many clients there are.`,
    }
  }

  // Element shape is trusted exactly as far as the `(data: Client[])`
  // annotation this replaces trusted it, and no further. Checking each row
  // would force a worse decision than it solves: dropping the rows that failed
  // would hand back a SHORT list that still looks complete, which is this
  // whole file's defect again one level down.
  return { ok: true, error: null, data: body as Client[] }
}
