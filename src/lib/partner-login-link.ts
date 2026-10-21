// The one-click sign-in link. Spec §2.1.
//
// ============================================================
// WHY THE LINK IS NOT A LOGIN
//
// "Auto sign in" means one click for the partner. The obvious
// implementation — a URL that mints a session when fetched — is wrong
// for a reason that has nothing to do with cryptography: nobody controls
// who fetches a URL in an email. Microsoft Defender, Proofpoint, Gmail's
// image proxy, iOS Mail's link preview and every corporate security
// gateway fetch links in messages before a human sees them. A
// single-use credential redeemed on GET is therefore spent by a machine,
// and the partner's first contact with Shipo's portal is "this link has
// expired".
//
// So the token rides in a URL to a PAGE. The page renders a Continue
// button. The button POSTs. A scanner that fetches the page gets HTML
// and changes nothing. §2.1: "One click for the partner, immune to
// prefetch."
//
// This file is deliberately pure — no database, no cookies, no request
// object — so the shape rules below can be tested without a transport.
// ============================================================

/**
 * Seven days.
 *
 * Longer than the 6-digit code's 10 minutes because the two are
 * delivered at different moments. The code is requested by someone
 * sitting at the login form; the link is issued when STAFF create the
 * partner row, which may be days before the partner opens his mail. A
 * link with the code's TTL would be dead before it was ever seen.
 *
 * Not longer than seven days: an emailed link is archived, forwarded and
 * synced to devices nobody is thinking about, and every extra day is a
 * day that copy is a key to someone's earnings.
 */
export const LINK_TTL_DAYS = 7

/** The page the link lands on. Not an API route — see the header. */
export const SIGNIN_PATH = '/partner/signin'

/** The query parameter carrying the token. */
export const LINK_PARAM = 't'

/**
 * 32 bytes of CSPRNG as base64url, unpadded — 43 characters.
 *
 * Wider than `generateSessionToken`'s 24 bytes on purpose. A session
 * token lives in an httpOnly cookie on one device; this one lives in a
 * mailbox for a week and passes through infrastructure Shipo does not
 * own. 256 bits costs nothing here.
 *
 * base64url and not hex because the value goes in a URL a human may
 * read aloud or a mail client may wrap: no `+`, no `/`, no `=`, nothing
 * a query string rewrites.
 */
export function generateLinkToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** The exact length of a token this module issues. */
const TOKEN_LENGTH = 43

/**
 * Build the emailed URL, or null when it must not be sent.
 *
 * Returns NULL rather than throwing, and null rather than a
 * best-effort link, because the caller is an email send. Both refusals
 * below leave the partner with the 6-digit code in the same message,
 * which is a working way in — so omitting the link degrades the email,
 * while a bad link breaks it.
 *
 * Refuses a non-HTTPS origin. The token is the credential and it is in
 * the URL; over http it crosses the network in cleartext, gets logged
 * by proxies verbatim, and appears in any Referer a later page sends.
 * localhost is exempt so the flow can be exercised in development —
 * there is no network to sniff, and the alternative is a feature nobody
 * can try before it reaches production.
 */
export function signInLinkUrl(siteUrl: string | undefined | null, token: string): string | null {
  if (!siteUrl || !token) return null

  let origin: URL
  try {
    origin = new URL(siteUrl)
  } catch {
    return null
  }

  const local = origin.hostname === 'localhost' || origin.hostname === '127.0.0.1'
  if (origin.protocol !== 'https:' && !local) return null

  // encodeURIComponent, not interpolation. base64url needs no escaping
  // today, which is exactly why this is easy to get wrong later: one
  // edit to generateLinkToken that drops the `+`/`/` replacement would
  // produce tokens whose `+` decodes as a space on arrival, and the
  // partner would meet a dead link with nothing to explain it.
  return `${origin.origin}${SIGNIN_PATH}?${LINK_PARAM}=${encodeURIComponent(token)}`
}

/**
 * Read a token out of a query parameter, or null.
 *
 * Validating by SHAPE before hashing is not belt-and-braces: anything
 * at all hashes to a valid-looking digest, so without this every
 * malformed or hostile value reaches the database as a lookup. Refusing
 * here means the query never runs.
 *
 * The array case is the one worth naming. `?t=a&t=b` deserialises to
 * `['a','b']`; `String(...)` of that is `"a,b"`, and taking `[0]` would
 * let a crafted link show one token to a human reading the address bar
 * and hand another to the handler. Neither is a token, so neither is
 * accepted.
 */
export function linkTokenFromQuery(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  if (raw.length !== TOKEN_LENGTH) return null
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) return null
  return raw
}

/** When a link issued now stops working. */
export function linkExpiresAt(now: Date = new Date()): Date {
  return new Date(now.getTime() + LINK_TTL_DAYS * 86_400_000)
}
