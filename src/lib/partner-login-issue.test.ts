import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { isMissingLinkColumn, loginLinkLines, signInLinkOrigin } from './partner-login-issue'

// ============================================================
// Issuing the link, and surviving the day it cannot be issued.
//
// THE ORDERING HAZARD THIS FILE EXISTS FOR
//
// supabase/partner_login_link.sql is applied BY HAND in the Supabase
// SQL editor. The code that writes link_token_hash can therefore reach
// production before the column does — and request-code is the live
// front door. PostgREST answers an insert naming a column that does
// not exist with 42703, so a naive "add the two columns to the insert"
// turns every partner login into a 500 until somebody opens a SQL
// editor. That is strictly worse than having no link at all.
//
// So the insert degrades: it tries with the link, and on a
// missing-column error it retries code-only and logs loudly. A deploy
// that lands before the migration behaves exactly as today — a 6-digit
// code, no link — instead of locking every partner out.
//
// isMissingLinkColumn is the pure half of that decision, and it is
// pure precisely so this can be tested without a database.
// ============================================================

describe('isMissingLinkColumn', () => {
  it('recognises the undefined-column error PostgREST returns', () => {
    // 42703 is Postgres's undefined_column. This is the one that fires
    // when the migration has not been applied.
    expect(isMissingLinkColumn({ code: '42703', message: '' })).toBe(true)
  })

  it('recognises it from the message when no code is attached', () => {
    // supabase-js does not always surface `code` — a PostgREST schema
    // cache miss arrives as a message and nothing else. Reading only
    // the code would make the fallback silently unreachable in exactly
    // the case it was written for.
    expect(
      isMissingLinkColumn({
        message: "Could not find the 'link_token_hash' column of 'partner_login_codes' in the schema cache",
      }),
    ).toBe(true)
    expect(isMissingLinkColumn({ message: 'column "link_expires_at" does not exist' })).toBe(true)
  })

  it('does NOT swallow an unrelated failure', () => {
    // The fallback must not become a catch-all. A unique violation, a
    // dead connection or an RLS refusal are real failures: retrying
    // code-only would hide them and hand the partner a working login
    // built on a database that is misbehaving.
    expect(isMissingLinkColumn({ code: '23505', message: 'duplicate key value' })).toBe(false)
    expect(isMissingLinkColumn({ code: '42P01', message: 'relation does not exist' })).toBe(false)
    expect(isMissingLinkColumn({ message: 'fetch failed' })).toBe(false)
    expect(isMissingLinkColumn(null)).toBe(false)
    expect(isMissingLinkColumn(undefined)).toBe(false)
  })

  it('does not match a message that merely mentions a link', () => {
    // "link" appears in plenty of unrelated prose. The match has to be
    // on the column names, not on the word.
    expect(isMissingLinkColumn({ message: 'could not send the sign-in link' })).toBe(false)
  })
})

describe('signInLinkOrigin', () => {
  const saved = {
    site: process.env.NEXT_PUBLIC_SITE_URL,
    vercel: process.env.VERCEL_PROJECT_PRODUCTION_URL,
  }
  afterEach(() => {
    process.env.NEXT_PUBLIC_SITE_URL = saved.site
    process.env.VERCEL_PROJECT_PRODUCTION_URL = saved.vercel
  })

  it('prefers the configured site url', () => {
    process.env.NEXT_PUBLIC_SITE_URL = 'https://shipousa.com'
    process.env.VERCEL_PROJECT_PRODUCTION_URL = 'shipo-system.vercel.app'
    expect(signInLinkOrigin()).toBe('https://shipousa.com')
  })

  it("falls back to Vercel's injected production host", () => {
    // The platform injects this into every deployment, host only, no
    // scheme. The retired src/lib/partner-invite.ts learned this the
    // hard way: the DocuSign webhook is a server-to-server POST with no
    // origin, and with no env var set every freshly-signed partner was
    // emailed a dead link. Without this branch the sign-in link would
    // simply be ABSENT from every email on a deploy where the var is
    // unset — a silent degradation, which is worse than a loud one.
    delete process.env.NEXT_PUBLIC_SITE_URL
    process.env.VERCEL_PROJECT_PRODUCTION_URL = 'shipo-system.vercel.app'
    expect(signInLinkOrigin()).toBe('https://shipo-system.vercel.app')
  })

  it('returns null rather than a guess when neither is set', () => {
    // THIS IS THE GUARD THAT REPLACED A HOSTNAME PROHIBITION, and it is
    // worth knowing why, because the thing it inherited is now deleted.
    //
    // partnerPortalUrl's last resort used to be the literal
    // 'https://shipousa.com'. Every unit of that function worked; the
    // string was simply wrong about the world — shipousa.com is the
    // WordPress site and 404s on the portal paths, while
    // shipo-system.vercel.app answers 200. And it was not the rare
    // branch: with NEXT_PUBLIC_SITE_URL unset it was the ONLY branch the
    // DocuSign webhook could take, so a partner's first experience of
    // the portal was a dead link. partner-invite.test.ts guarded that by
    // forbidding one hostname by name.
    //
    // Null is the stronger form of the same rule. Forbidding a hostname
    // only catches the host somebody already got wrong; refusing to
    // invent ANY host catches the next one too. Add a `?? 'https://...'`
    // of any kind to signInLinkOrigin and this line fails.
    //
    // Sending no link is a problem Shipo finds out about — linkIssued
    // comes back false and the log says so. Sending a confident link to
    // a 404 is a problem only the partner finds out about.
    delete process.env.NEXT_PUBLIC_SITE_URL
    delete process.env.VERCEL_PROJECT_PRODUCTION_URL
    expect(signInLinkOrigin()).toBeNull()
  })

  it('takes no argument — there is nowhere to pass a request origin in', () => {
    // THE SECURITY PROPERTY, and the reason this is not the retired
    // partnerPortalUrl().
    //
    // That function resolved NEXT_PUBLIC_SITE_URL ?? origin ??
    // VERCEL_..., and `origin` is a REQUEST HEADER. That was fine there:
    // the invite email carried the portal address and nothing else, so a
    // forged origin produced a useless link to a stranger's site.
    //
    // This email carries a CREDENTIAL. A request with
    // `Origin: https://evil.example` would otherwise cause Shipo to
    // email the real partner a real single-use sign-in token pointed at
    // an attacker's host — and the attacker needs no reply, because the
    // partner's own click would deliver the token to them.
    //
    // So the origin of a sign-in link comes only from server-side
    // configuration. The arity is the enforcement: there is no
    // parameter to pass a header into.
    expect(signInLinkOrigin.length).toBe(0)
  })
})

describe('loginLinkLines', () => {
  it('returns empty strings when there is no link to offer', () => {
    // §2.1 degradation: no link in the email beats a broken link in
    // the email, because the 6-digit code in the same message is a
    // working way in. Empty strings concatenate into the body without
    // leaving a dangling heading or an empty paragraph behind.
    expect(loginLinkLines(null)).toEqual({ text: '', html: '' })
  })

  it('puts the url in both bodies', () => {
    const { text, html } = loginLinkLines('https://shipousa.com/partner/signin?t=tok')
    expect(text).toContain('https://shipousa.com/partner/signin?t=tok')
    expect(html).toContain('https://shipousa.com/partner/signin?t=tok')
  })

  it('shows the url as text as well as linking it', () => {
    // A link whose label is "click here" is unverifiable by the person
    // being asked to click it, and this is an email about access to his
    // earnings. The visible href lets him see it is a shipousa.com
    // address before he trusts it.
    const { html } = loginLinkLines('https://shipousa.com/partner/signin?t=tok')
    expect(html).toMatch(/href="https:\/\/shipousa\.com\/partner\/signin\?t=tok"/)
    expect(html).toContain('>https://shipousa.com/partner/signin?t=tok<')
  })

  it('says the link expires and is single use', () => {
    // Both bodies. A partner who reads only the plain-text part still
    // needs to know why a link from last month does nothing.
    const { text, html } = loginLinkLines('https://shipousa.com/partner/signin?t=tok')
    for (const body of [text, html]) {
      expect(body).toMatch(/7 days|seven days/i)
      expect(body).toMatch(/once/i)
    }
  })

  it('never says the link is a one-click login with no code needed', () => {
    // The code is the fallback and must not be presented as redundant.
    // A partner told "no code needed" who then meets an expired link
    // has been told the only remaining way in does not apply to him.
    const { text, html } = loginLinkLines('https://shipousa.com/partner/signin?t=tok')
    for (const body of [text, html]) {
      expect(body).not.toMatch(/no code/i)
      expect(body).not.toMatch(/instead of the code/i)
    }
  })
})

// ============================================================
// The caller, asserted over its source.
//
// The property that matters is an ORDERING and a FALLBACK, neither of
// which a unit test of a pure function can see: the insert must try
// the link columns first, and a missing-column failure must not reach
// the partner as a 500.
//
// THE CALLER MOVED. Issuance used to live in request-code/route.ts and
// now lives in src/lib/partner-signin-email.ts, because three paths mail
// a partner his way in — the login screen, the DocuSign webhook on
// signature, and the staff invite button — and three copies of "hash
// before you store" is three places to get it wrong.
//
// These guards follow the code rather than the filename. A guard left
// pointing at the route would still pass, since a route that handles no
// credential trivially satisfies every absence below, and that is the
// shape of a test that has quietly stopped checking anything. The route
// keeps one guard of its own, at the end: that it delegates and holds no
// credential code itself.
// ============================================================

const ISSUER = 'src/lib/partner-signin-email.ts'
const REQUEST_CODE = 'src/app/api/partner/request-code/route.ts'

const codeOf = (file: string) =>
  readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

// The same, minus the import block. Needed because a bare
// `toContain('isMissingLinkColumn')` is satisfied by the IMPORT of
// isMissingLinkColumn, so the check passed with the guard it describes
// replaced by `if (false)`. Found by reversion, not by reading.
const bodyOf = (file: string) => codeOf(file).replace(/^import[\s\S]*?from\s+'[^']+'\s*$/gm, '')

describe('the issuer', () => {
  it('reads the issuer and finds real code (control for the absences below)', () => {
    const src = codeOf(ISSUER)
    expect(src.length).toBeGreaterThan(500)
    expect(src).toContain('export async function sendSignInEmail')
  })

  it('issues a link alongside the code', () => {
    const src = codeOf(ISSUER)
    expect(src).toContain('generateLinkToken')
    expect(src).toContain('link_token_hash')
    expect(src).toContain('link_expires_at')
  })

  it('stores the hash of the link token, never the token', () => {
    const src = codeOf(ISSUER)
    expect(src).not.toMatch(/link_token_hash:\s*linkToken\b/)
    expect(src).toMatch(/link_token_hash:\s*linkTokenHash\b/)
  })

  it('falls back to a code-only row rather than failing the login', () => {
    // The whole reason isMissingLinkColumn exists. Without this branch
    // a deploy that lands before the hand-applied migration takes
    // partner login down entirely.
    //
    // THE FIRST VERSION OF THIS TEST COULD NOT FAIL. It asserted
    // codeOf(...).toContain('isMissingLinkColumn') — satisfied by the
    // import line — and then compared indexes, also satisfied by the
    // import. Replacing the whole condition with `if (false)` left it
    // green. It is asserted here on the CALL, in the body, with the
    // argument, and the reversion now reports it.
    const src = bodyOf(ISSUER)
    const guard = src.indexOf('isMissingLinkColumn(insertError)')
    const retry = src.indexOf('.insert(row)')
    // The RETURN, not the type union. `reason: 'insert-failed'` also
    // appears in SignInEmailResult at the top of the file, which is
    // BEFORE the guard — matching that would invert the ordering
    // assertion and make this test fail on correct code. The comma
    // after the key only occurs in the object literal; the union
    // declares it with a semicolon.
    const refusal = src.indexOf("reason: 'insert-failed', error")
    expect(guard).toBeGreaterThan(-1)
    expect(refusal).toBeGreaterThan(-1)
    // The retry is the code-only insert, and it comes after the guard —
    // a blanket retry would be a different and worse thing, hiding a
    // unique violation or a dead connection behind a working login.
    expect(retry).toBeGreaterThan(guard)
    expect(refusal).toBeGreaterThan(retry)
  })

  it('builds the link origin from config, never from a request header', () => {
    // The credential is IN the url. A forged `Origin:` header that
    // reached signInLinkUrl would have Shipo email the real partner a
    // real token pointed at an attacker's host.
    const src = bodyOf(ISSUER)
    expect(src).toContain('signInLinkOrigin()')
    expect(src).not.toMatch(/signInLinkUrl\([^)]*headers\.get/)
    expect(src).not.toMatch(/signInLinkUrl\([^)]*origin/)
  })

  it('never puts the raw link token in a log line', () => {
    const src = codeOf(ISSUER)
    expect(src).not.toMatch(/console\.(log|error|warn)\([^)]*\blinkToken\b/)
  })

  it('builds no field named code, link or token anywhere in the file', () => {
    // The uniform OK is the contract: a credential in the response body
    // would hand a stranger who typed an address a working way in.
    //
    // Asserted as "no property by these names EXISTS in this file"
    // rather than "no json() call contains them", for a reason worth
    // recording. The first draft was
    // /json\(\s*\{[^}]*\bcode\b/ and it FAILED on correct code — it
    // matched the route's own error sentence, "We could not send the
    // code." A pattern that reads the file as text counts prose as
    // evidence, and user-facing copy is prose. Matching a property KEY
    // (`code:`) cannot be satisfied by a sentence about a code.
    //
    // File-wide and not scoped to the response, because a caller can
    // only serialise what it first assigns: code_hash, link_token_hash
    // and linkTokenHash are all fine, a bare `code:` is not.
    const src = codeOf(ISSUER)
    expect(src).not.toMatch(/^\s*(code|link|token|linkToken)\s*:/m)
  })

  // ----------------------------------------------------------------
  // And the route that used to do all of the above.
  // ----------------------------------------------------------------

  it('request-code delegates instead of issuing a credential itself', () => {
    // Positive first. Every absence below is satisfied by an empty file,
    // and an empty file is one deletion away.
    const src = bodyOf(REQUEST_CODE)
    expect(src).toContain('sendSignInEmail(')

    // Nothing credential-shaped is left behind. A second issuance path is
    // a second place for "hash before you store" to be got wrong, and the
    // dangerous version of that is not a crash — it is a route that still
    // works while storing something it should not.
    for (const needle of [
      'generateCode',
      'generateLinkToken',
      'sha256Hex',
      'code_hash',
      'link_token_hash',
    ]) {
      expect(src).not.toContain(needle)
    }
  })

  it('request-code passes no request origin into the issuer', () => {
    // The credential is in the URL. This route has `req` in scope and the
    // old invite it replaced DID take `req.headers.get('origin')`.
    const src = bodyOf(REQUEST_CODE)
    expect(src).not.toMatch(/sendSignInEmail\([^)]*origin/)
  })
})
