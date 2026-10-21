import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  LINK_TTL_DAYS,
  generateLinkToken,
  signInLinkUrl,
  linkTokenFromQuery,
} from './partner-login-link'
import { sha256Hex } from './partner-auth'

// ============================================================
// The one-click sign-in link. Spec §2.1.
//
// The thing being defended against here is not a guessed token — 32
// bytes of CSPRNG is not guessable. It is an EMAIL SCANNER: a security
// proxy, a link prefetcher or a mail client that fetches every URL in
// every message before a human sees it. A link that logs you in when
// fetched is spent by that scanner, and the partner's first contact
// with the portal is a dead credential and a form asking him to start
// again.
//
// So the tests below care about two properties that have nothing to do
// with cryptography:
//
//   1. The token is in the URL, but fetching the URL signs nobody in.
//      Redemption is a POST the Continue button makes.
//   2. A token that arrives malformed, absent, or as an array (which is
//      what a duplicated query param deserialises to) is refused, not
//      coerced into something that might match a row.
// ============================================================

describe('generateLinkToken', () => {
  it('is 32 bytes, base64url, with no padding', () => {
    const t = generateLinkToken()
    // 32 bytes -> ceil(32/3)*4 = 44 chars with padding, 43 without.
    expect(t).toHaveLength(43)
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(t).not.toContain('=')
  })

  it('never repeats across a thousand draws', () => {
    // Not a test of the RNG — a test that we called it once per token
    // rather than caching one at module load, which is the mistake that
    // would hand every partner the same link.
    const seen = new Set<string>()
    for (let i = 0; i < 1000; i++) seen.add(generateLinkToken())
    expect(seen.size).toBe(1000)
  })

  it('produces a token whose hash is what gets stored, never the token', async () => {
    const t = generateLinkToken()
    const hash = await sha256Hex(t)
    expect(hash).toHaveLength(64)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(hash).not.toContain(t)
  })
})

describe('LINK_TTL_DAYS', () => {
  it('is 7 days — long enough to survive a weekend', () => {
    // §2.1 pins the number. It is longer than the code's 10 minutes
    // because the link is delivered when staff create the row, not when
    // the partner asks for it.
    expect(LINK_TTL_DAYS).toBe(7)
  })
})

describe('signInLinkUrl', () => {
  it('points at a page, not at the API route', () => {
    // THE WHOLE DESIGN. If this returned /api/partner/verify-link, a
    // scanner's GET would hit the handler. It returns a page that
    // renders a button.
    const url = signInLinkUrl('https://shipousa.com', 'tok123')
    expect(url).toBe('https://shipousa.com/partner/signin?t=tok123')
    expect(url).not.toContain('/api/')
  })

  it('percent-encodes the token rather than interpolating it raw', () => {
    // base64url contains no character that needs encoding, so this can
    // never bite today. It is here because the token generator is one
    // edit away from emitting standard base64, whose `+` and `/` would
    // silently change meaning in a query string — `+` decodes as a
    // space, and the partner would meet a dead link with no clue why.
    const url = signInLinkUrl('https://shipousa.com', 'a+b/c=')
    expect(url).toContain('t=a%2Bb%2Fc%3D')
    expect(url).not.toContain('t=a+b/c=')
  })

  it('tolerates a trailing slash on the site url without doubling it', () => {
    expect(signInLinkUrl('https://shipousa.com/', 'tok')).toBe(
      'https://shipousa.com/partner/signin?t=tok',
    )
  })

  it('refuses to build a link over an insecure or missing origin', () => {
    // The token travels in this URL. Over http it travels in cleartext,
    // and an emailed link is retried, forwarded and logged by machines
    // we do not own. Better no link in the email than a link that
    // leaks: the 6-digit code in the same email still works.
    expect(signInLinkUrl('http://shipousa.com', 'tok')).toBeNull()
    expect(signInLinkUrl('', 'tok')).toBeNull()
    expect(signInLinkUrl(undefined, 'tok')).toBeNull()
  })

  it('allows http on localhost, so the flow can be exercised in development', () => {
    expect(signInLinkUrl('http://localhost:3000', 'tok')).toBe(
      'http://localhost:3000/partner/signin?t=tok',
    )
  })

  it('refuses an empty token rather than emitting a tokenless link', () => {
    // A link reading `?t=` lands on the Continue page, which POSTs
    // nothing and refuses — a partner clicking a Shipo link and being
    // told his credential is invalid. Omit the link instead.
    expect(signInLinkUrl('https://shipousa.com', '')).toBeNull()
  })
})

describe('linkTokenFromQuery', () => {
  it('reads a well-formed token', () => {
    // Built at the real length, with both of base64url's special
    // characters in it. An 11-character sample would be rejected by the
    // length rule below, which is the mistake the first draft of this
    // test made — a "happy path" that was not one.
    const t = 'abcDEF123_-'.padEnd(43, 'x')
    expect(linkTokenFromQuery(t)).toBe(t)
  })

  it('refuses anything that is not a base64url string', () => {
    // Everything here would otherwise reach sha256Hex and produce a
    // perfectly valid hash of garbage, which then queries the database.
    // Refusing by SHAPE keeps that read from happening at all.
    expect(linkTokenFromQuery('tok en')).toBeNull()
    expect(linkTokenFromQuery('tok/en')).toBeNull()
    expect(linkTokenFromQuery("' or 1=1--")).toBeNull()
    expect(linkTokenFromQuery('')).toBeNull()
    expect(linkTokenFromQuery(undefined)).toBeNull()
    expect(linkTokenFromQuery(null)).toBeNull()
  })

  it('refuses an array, which is what a duplicated query param becomes', () => {
    // `?t=a&t=b`. Next hands that over as string[]; `String(['a','b'])`
    // would quietly produce "a,b". Taking the first element would let a
    // crafted link carry a decoy for a human reading the URL and a real
    // token for the handler.
    expect(linkTokenFromQuery(['a', 'b'] as unknown as string)).toBeNull()
  })

  it('refuses a token of the wrong length', () => {
    // Shape alone is not enough: a 4-character base64url string is
    // well-formed and cannot be one of ours.
    expect(linkTokenFromQuery('abcd')).toBeNull()
    expect(linkTokenFromQuery('a'.repeat(200))).toBeNull()
    expect(linkTokenFromQuery(generateLinkToken())).not.toBeNull()
  })
})

// ============================================================
// The route and the page, asserted over their source.
//
// The property that matters most here cannot be observed by calling the
// handler: it is the ABSENCE of a GET export. A test that POSTs and
// gets a session back passes identically whether or not a GET handler
// exists beside it.
// ============================================================

const ROUTE = 'src/app/api/partner/verify-link/route.ts'
const PAGE = 'src/app/partner/signin/page.tsx'
const BUTTON = 'src/components/partner/SignInLink.tsx'

const codeOf = (file: string) =>
  readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

// Same, with the IMPORT BLOCK removed as well — and this is not a
// refinement, it is a bug fix found by reversion.
//
// `src.indexOf('portalAccessPartnerMessage')` finds the IMPORT, which
// sits above everything, so "the gate comes before the mint" was true
// no matter where the gate actually was. Moving the whole gate to below
// generateSessionToken() left the suite green. An ordering assertion
// over a file that imports the symbols it orders is vacuous, and the
// only way to know that is to move the code and watch.
//
// Every index comparison below reads this, never codeOf.
const bodyOf = (file: string) => codeOf(file).replace(/^import[\s\S]*?from\s+'[^']+'\s*$/gm, '')

describe('the verify-link route', () => {
  it('reads the route and finds real code (control for every absence below)', () => {
    const src = codeOf(ROUTE)
    expect(src.length).toBeGreaterThan(500)
    expect(src).toContain('export async function POST')
  })

  it('exports no GET — a fetched link must not be a login', () => {
    // §8: "`GET` on the verify-link route is not a login." This is the
    // single most important line in the file, and it is an absence, so
    // the control test above is what makes it mean anything.
    const src = codeOf(ROUTE)
    expect(src).not.toMatch(/export\s+(async\s+)?function\s+GET/)
    expect(src).not.toMatch(/export\s+const\s+GET/)
    expect(src).not.toMatch(/export\s+\{[^}]*\bGET\b/)
  })

  it('hashes the token before it queries, and never selects on the raw value', () => {
    const src = bodyOf(ROUTE)
    const hash = src.indexOf('sha256Hex(')
    const query = src.indexOf("from('partner_login_codes')")
    expect(hash).toBeGreaterThan(-1)
    expect(query).toBeGreaterThan(hash)
    expect(src).toContain(".eq('link_token_hash'")
    expect(src).not.toMatch(/\.eq\(\s*['"]link_token_hash['"]\s*,\s*token\s*\)/)
  })

  it('checks expiry and single-use, and consumes in a guarded update', () => {
    const src = codeOf(ROUTE)
    expect(src).toContain('link_expires_at')
    expect(src).toContain(".is('consumed_at', null)")
    // The guarded update is what makes "single use" true under a race:
    // two simultaneous POSTs both read an unconsumed row, and only the
    // one whose UPDATE ... WHERE consumed_at IS NULL returns a row may
    // mint a session.
    expect(src).toMatch(/update\(\{\s*consumed_at/)
  })

  it('re-asks the portal gate before minting a session, and before consuming', () => {
    // A link issued on row creation can be clicked after the partner is
    // paused or his agreement is voided. The link proves he read the
    // email; it does not prove he may still be in the portal.
    //
    // bodyOf, not codeOf. This assertion was VACUOUS until a reversion
    // showed it: the import line put portalAccessPartnerMessage at
    // index ~400, above every other symbol in the file, so moving the
    // entire gate below the mint kept it green.
    const src = bodyOf(ROUTE)
    const gate = src.indexOf('portalAccessPartnerMessage(')
    const consume = src.indexOf('update({ consumed_at')
    const mint = src.indexOf('generateSessionToken()')
    expect(gate).toBeGreaterThan(-1)
    // Before the CONSUME as well, which is the subtler half. The
    // DocuSign webhook can flip agreement_status while a click is in
    // flight, and burning a link on a refusal would strand a partner
    // who signed a minute ago. An unspent credential is still good.
    expect(consume).toBeGreaterThan(gate)
    expect(mint).toBeGreaterThan(gate)
  })

  it('never logs or returns the token', () => {
    const src = codeOf(ROUTE)
    expect(src).not.toMatch(/console\.(log|error|warn)\([^)]*\btoken\b/)
    expect(src).not.toMatch(/json\(\s*\{[^}]*\btoken\b/)
  })
})

describe('the Continue page', () => {
  it('reads both files and finds real code (control)', () => {
    expect(codeOf(PAGE).length).toBeGreaterThan(300)
    expect(codeOf(BUTTON).length).toBeGreaterThan(300)
  })

  it('offers the 6-digit code as a way out instead of dead-ending', () => {
    // §8: "An expired link falls back to the 6-digit code without a
    // dead end." Neither the page nor the button can know whether the
    // token is good — only the POST knows — so the fallback has to be
    // on screen from the start, beside the button.
    //
    // Asserted over the BUTTON and not the page, which is where the
    // first draft of this test looked. The page is a server component
    // that resolves searchParams and renders one child; all markup,
    // including this link, lives in the client component. Pointing the
    // assertion at the page pinned a file layout rather than the
    // property, and it failed on a correct implementation.
    const src = codeOf(BUTTON)
    expect(src).toContain('/partner/login')
  })

  it('redeems nothing while rendering — neither half of the screen', () => {
    // A server component that redeemed the token during render would be
    // a GET login wearing a page's clothes — the exact failure the
    // Continue button exists to prevent. Checked on BOTH files: the
    // page is the one a scanner's GET reaches, and the button is one
    // 'use client' deletion away from becoming a server component that
    // runs during that same render.
    for (const file of [PAGE, BUTTON]) {
      const src = codeOf(file)
      expect(src).not.toContain('partner_login_codes')
      expect(src).not.toContain('generateSessionToken')
      expect(src).not.toContain('supabaseAdmin')
      expect(src).not.toContain('sha256Hex')
    }
  })

  it('reaches the route only by POST', () => {
    // The button's fetch is the single redemption path in the product.
    // A `fetch('/api/partner/verify-link')` with no method would
    // default to GET, which the route does not export — so this pins
    // the verb on the caller as well as the absence on the handler.
    const src = codeOf(BUTTON)
    expect(src).toContain('/api/partner/verify-link')
    expect(src).toMatch(/method:\s*'POST'/)
  })
})
