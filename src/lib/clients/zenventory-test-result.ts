// What the "Test API 2.0" banner says.
//
// It used to say one thing: "✗ API 2.0 connection failed — check API Key and
// Secret", hardcoded, for every failure. That sentence is a diagnosis, and it
// was wrong for most of the ways this can fail:
//
//   - the route answers `{success:false, error:'No Zenventory credentials
//     saved for this client'}` when the column is empty, and the banner
//     rendered that as "check API Key and Secret" -- advice to check a
//     credential that does not exist
//   - a 403 is a credential that authenticated and is not allowed to read
//     customer-orders. Checking the key will never fix it
//   - a timeout or a 5xx is Zenventory being down. The key is fine
//
// The real reason was already on the wire -- the route returns `status` and
// `error`, and `handleTest` passed `error` to a toast that disappears. An
// operator who looked away for four seconds was left with a red box blaming
// the credentials.
//
// This lives in lib/ because vitest excludes `.test.tsx`: inside the
// component none of it could be tested at all.

export interface ZenventoryTestResponse {
  success?: boolean
  /** HTTP status Zenventory answered with, when a request was made at all. */
  status?: number
  /** `HTTP <status>: <body>` from extractError, or the route's own refusal. */
  error?: string
}

export interface TestBanner {
  ok: boolean
  /** The headline. A claim about WHERE the problem is. */
  title: string
  /** The reason, verbatim from the server. Empty string when there is none. */
  detail: string
}

/**
 * Zenventory's 401 body is `{"message":"Invalid API key and/or secret",
 * "parameter":""}`. That empty `parameter` is a field in THEIR error envelope
 * -- it is not evidence that we sent an empty parameter, which is how it was
 * read for a while. Do not re-derive "the key is empty" from it.
 */
export function testBanner(res: ZenventoryTestResponse): TestBanner {
  if (res.success) {
    return {
      ok: true,
      title: 'API 2.0 connection successful',
      detail: '',
    }
  }

  const detail = (res.error ?? '').trim()

  // The status is read out of the error string rather than trusted from
  // `status`, because the route only populates `status` on SUCCESS --
  // testZenventoryCredentials returns `{ok:true,status}` or `{ok:false,error}`,
  // never both. A failed test therefore arrives with `status: undefined` and
  // the code embedded in `error`. Reading `res.status` here would have made
  // every branch below dead.
  const code = statusOf(detail) ?? res.status ?? null

  return { ok: false, title: titleFor(code, detail), detail }
}

/** `HTTP 401: {...}` -> 401. Null when the message is not from extractError. */
export function statusOf(error: string): number | null {
  const m = /^HTTP (\d{3})\b/.exec(error)
  if (!m) return null
  const n = Number(m[1])
  // `Number.isInteger` rather than a truthiness check: the regex already
  // guarantees three digits, so this only guards a future loosening of it.
  return Number.isInteger(n) ? n : null
}

function titleFor(code: number | null, detail: string): string {
  // Checked before the status codes because this failure never reached
  // Zenventory at all, so it carries no status -- and it is the one case
  // where telling someone to check the key is actively misleading.
  if (/no zenventory credentials/i.test(detail)) {
    return 'No API 2.0 credentials saved — nothing was sent'
  }
  // Also no status: `extractError` falls through to `err.message` for a
  // connection error, and axios spells a timeout this way.
  if (code === null && /timeout|ECONNRESET|ENOTFOUND|ECONNREFUSED|socket hang up/i.test(detail)) {
    return 'Could not reach Zenventory — the credentials were not tested'
  }

  if (code === 401) return 'Zenventory rejected the API Key and Secret'
  // NOT folded in with 401. A 403 authenticated successfully; the account is
  // just not permitted to read customer orders. Sending someone to re-check
  // the key here is how an hour goes into retyping a credential that works.
  if (code === 403) return 'Credentials are valid but not allowed to read orders'
  if (code === 404) return 'Zenventory endpoint not found — not a credentials problem'
  if (code === 429) return 'Zenventory rate-limited the test — try again shortly'
  if (code !== null && code >= 500) return 'Zenventory is erroring — the credentials may be fine'
  if (code !== null) return `Zenventory answered HTTP ${code}`

  // Last resort, and deliberately does not name a cause. An unrecognised
  // failure with no status is exactly the case the old hardcoded sentence got
  // wrong; the detail line below the title is what to read.
  return 'API 2.0 test failed'
}

/**
 * What to say when there is no usable API 2.0 key -- and why `''` gets its own
 * sentence instead of sharing one with `null`.
 *
 * The card showed one message for both: "No API 2.0 credentials — add them to
 * enable order syncing." For `null` that is true and the client is correctly
 * left out of the scheduled sync. For `''` it is false in the direction that
 * costs something: syncClientAssignments filters on
 * `.not('zenventory_api_key','is',null)` (src/lib/sync/zenventory.ts:18), and
 * `''` is not null, so the client IS in the sync -- authenticating with an
 * empty key six times a day, for ever, while this card says it is not syncing
 * at all. Clearing the field to null is the fix, and saying so is the point of
 * the second branch.
 *
 * Returns null when a key is present; the card shows the masked value then.
 */
export function missingKeyNotice(
  apiKey: string | null | undefined,
): { tone: 'info' | 'warn'; text: string } | null {
  if (apiKey === null || apiKey === undefined) {
    return {
      tone: 'info',
      text: 'No API 2.0 credentials — add them to enable order syncing.',
    }
  }
  // `btrim`-equivalent: a whitespace-only key behaves exactly like '' against
  // the sync filter -- not null, so still selected -- while looking present in
  // the database. Same sentence.
  if (apiKey.trim() === '') {
    return {
      tone: 'warn',
      text: 'The API Key is saved as an empty value, not as "no credentials". '
        + 'This client is still included in the scheduled sync and every run '
        + 'fails. Add a real key, or save the field empty once to clear it to '
        + 'null and take the client out of the sync.',
    }
  }
  return null
}
