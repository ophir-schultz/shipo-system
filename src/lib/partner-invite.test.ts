import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { partnerPortalUrl, sendPortalInvite } from './partner-invite'

// This file exists because of a bug that was invisible from inside the code.
//
// partnerPortalUrl's last resort used to be the literal 'https://shipousa.com'.
// Every unit of that function worked; the string was simply wrong about the
// world. shipousa.com is the WordPress site and answers 404 on
// /partner/login, while shipo-system.vercel.app answers 200. And the wrong
// branch was not the rare one: the DocuSign webhook is a server-to-server
// POST with no Origin header, so with NEXT_PUBLIC_SITE_URL unset in
// production it was the ONLY branch that ever ran for the caller that matters
// most — a partner's first experience of the portal was a dead link.
//
// So the assertions below are about the shape of the output rather than its
// internals, and the one that actually guards the bug is the one that forbids
// a specific hostname. A test that only checked "returns a URL" was satisfied
// by the broken version.

const env = { ...process.env }
afterEach(() => {
  process.env = { ...env }
  vi.restoreAllMocks()
  vi.resetModules()
})

function clearEnv() {
  delete process.env.NEXT_PUBLIC_SITE_URL
  delete process.env.VERCEL_PROJECT_PRODUCTION_URL
}

// Both routes below EXPLAIN the bugs they guard against in their comments, so
// the first version of the delegation check failed on prose that describes the
// thing it forbids. A grep over source counts its own prose. Comments are
// therefore stripped first — and because the stripper is now what two checks
// depend on, the control in each measures it instead of trusting it.
//
// Only whole-line comments and block comments go. A trailing `// ...` is left
// alone deliberately: splitting a code line on `//` would also cut
// 'https://host/path' in half and quietly blind the hostname assertions.
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join('\n')
}

describe('partnerPortalUrl', () => {
  it('never points at shipousa.com — that host 404s on /partner/login', () => {
    clearEnv()
    // `?? ''` rather than a bare .not.toContain: toContain THROWS on null, so
    // the null case would have passed for the wrong reason — it would have
    // reported a failure whether or not the hostname was there.
    for (const origin of [undefined, null]) {
      expect(partnerPortalUrl(origin) ?? '').not.toContain('shipousa.com')
    }
    process.env.VERCEL_PROJECT_PRODUCTION_URL = 'shipo-system.vercel.app'
    expect(partnerPortalUrl(null) ?? '').not.toContain('shipousa.com')
  })

  it('returns null rather than guessing when it has nothing to go on', () => {
    clearEnv()
    // Sending no email is a problem we find out about. Sending a confident
    // link to a 404 is one the partner finds out about.
    expect(partnerPortalUrl(null)).toBeNull()
    expect(partnerPortalUrl(undefined)).toBeNull()
    expect(partnerPortalUrl('')).toBeNull()
  })

  it('falls back to the platform-injected production host', () => {
    clearEnv()
    // VERCEL_PROJECT_PRODUCTION_URL is set by Vercel on every deployment and
    // carries no scheme. This is the branch the DocuSign webhook takes, and
    // the reason this fix needs nothing configured by hand.
    process.env.VERCEL_PROJECT_PRODUCTION_URL = 'shipo-system.vercel.app'
    expect(partnerPortalUrl(null)).toBe('https://shipo-system.vercel.app/partner/login')
  })

  it('prefers the request origin over the production host', () => {
    clearEnv()
    // A preview deployment must keep linking to itself. If production won
    // here, clicking a link in a preview-generated email would land you in
    // production mid-test.
    process.env.VERCEL_PROJECT_PRODUCTION_URL = 'shipo-system.vercel.app'
    expect(partnerPortalUrl('https://shipo-system-git-abc.vercel.app')).toBe(
      'https://shipo-system-git-abc.vercel.app/partner/login',
    )
  })

  it('prefers an explicit NEXT_PUBLIC_SITE_URL over everything', () => {
    clearEnv()
    // The override exists for the day there IS a custom domain.
    process.env.NEXT_PUBLIC_SITE_URL = 'https://portal.shipousa.com'
    process.env.VERCEL_PROJECT_PRODUCTION_URL = 'shipo-system.vercel.app'
    expect(partnerPortalUrl('https://somewhere.else')).toBe(
      'https://portal.shipousa.com/partner/login',
    )
  })

  it('does not double the slash when the base has a trailing one', () => {
    clearEnv()
    process.env.NEXT_PUBLIC_SITE_URL = 'https://portal.shipousa.com/'
    expect(partnerPortalUrl(null)).toBe('https://portal.shipousa.com/partner/login')
  })
})

describe('sendPortalInvite', () => {
  it('refuses to send when there is no URL to send', async () => {
    clearEnv()
    vi.resetModules()
    const sendEmail = vi.fn()
    vi.doMock('@/lib/email', () => ({ sendEmail }))
    const { sendPortalInvite: send } = await import('./partner-invite')

    const result = await send({ name: 'Dana Katz', email: 'dana@example.com' }, null)

    expect(result.sent).toBe(false)
    // The email's entire payload is the link. An invite with a broken link is
    // worse than no invite: the partner reads it as the portal being down and
    // we never hear about it.
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('refuses a partner with no email address', async () => {
    clearEnv()
    process.env.VERCEL_PROJECT_PRODUCTION_URL = 'shipo-system.vercel.app'
    const result = await sendPortalInvite({ name: 'Dana Katz', email: null })
    expect(result.sent).toBe(false)
    expect(result.error).toMatch(/email/i)
  })

  it('puts the resolved URL in both the text and the HTML body', async () => {
    vi.resetModules()
    const sendEmail = vi.fn().mockResolvedValue({ sent: true, provider: 'resend' })
    vi.doMock('@/lib/email', () => ({ sendEmail }))
    const { sendPortalInvite: send } = await import('./partner-invite')

    await send({ name: 'Dana Katz', email: 'dana@example.com' }, 'https://preview.example.com')

    const sent = sendEmail.mock.calls[0][0]
    const url = 'https://preview.example.com/partner/login'
    // Two bodies, one link. A text/HTML mismatch means the two readers of the
    // same email disagree about where to sign in.
    expect(sent.text).toContain(url)
    expect(sent.html).toContain(`href="${url}"`)
    expect(sent.text).not.toContain('null')
    expect(sent.html).not.toContain('null')
    expect(sent.to).toBe('dana@example.com')
  })

  it('carries no credential — the partner fetches their own code', async () => {
    vi.resetModules()
    const sendEmail = vi.fn().mockResolvedValue({ sent: true, provider: 'resend' })
    vi.doMock('@/lib/email', () => ({ sendEmail }))
    const { sendPortalInvite: send } = await import('./partner-invite')

    await send({ name: 'Dana Katz', email: 'dana@example.com' }, 'https://preview.example.com')

    const sent = sendEmail.mock.calls[0][0]
    // This is what makes the invite safe to re-send and worthless if
    // intercepted. If a code or token ever gets added to this email, that
    // property is gone and this test should be the thing that says so.
    expect(sent.text).toMatch(/no password/i)
    expect(sent.text).not.toMatch(/\b\d{6}\b/)
    expect(sent.html).not.toMatch(/\b\d{6}\b/)
  })

  it('sends a reply to the mailbox its own footer names', async () => {
    vi.resetModules()
    const sendEmail = vi.fn().mockResolvedValue({ sent: true, provider: 'resend' })
    vi.doMock('@/lib/email', () => ({ sendEmail }))
    const { sendPortalInvite: send } = await import('./partner-invite')

    await send({ name: 'Dana Katz', email: 'dana@example.com' }, 'https://preview.example.com')

    const sent = sendEmail.mock.calls[0][0]
    // This email instructs the reader to reply, and the From address is a
    // single env var shared by all system mail that defaults to security@.
    // So the invite told the partner to write to us and then routed the
    // answer to a mailbox it never named.
    expect(sent.text).toMatch(/reply to this email/i)

    // Asserted against the footer rather than against a literal, because the
    // invariant is AGREEMENT: the address a reply reaches has to be the
    // address the email printed. A hardcoded expectation here would keep
    // passing after someone changed the footer, which is the drift that
    // produced the bug in the first place.
    const printed = [
      ...new Set(
        [...`${sent.text} ${sent.html}`.matchAll(/[\w.+-]+@shipousa\.com/g)].map((m) =>
          m[0].toLowerCase(),
        ),
      ),
    ]
    expect(printed).toHaveLength(1)
    expect(sent.replyTo?.toLowerCase()).toBe(printed[0])
  })
})

describe('the staff route does not keep its own copy of the email', () => {
  // Two callers invite partners: a staff member clicking Invite, and the
  // DocuSign webhook. They must produce an identical email, because a partner
  // who gets a different-looking message depending on which path fired has no
  // way to tell the automated one from a phishing attempt.
  //
  // The staff route DID keep a second copy, and it had already drifted: it
  // still carried the shipousa.com fallback after the shared helper was fixed.
  // Asserting the two strings match is not possible from here (one is built
  // inside a route handler), so this asserts the stronger structural fact:
  // there is only one place that builds it.
  const routes = [
    'src/app/api/referrals/portal-access/route.ts',
    'src/app/api/partner/agreement-webhook/route.ts',
  ]

  it('the comment stripper keeps string literals and drops prose', () => {
    expect(code("  const u = 'https://shipousa.com/partner/login'\n")).toContain(
      'shipousa.com/partner/login',
    )
    expect(code('  // the old https://shipousa.com fallback 404s\n')).not.toContain('shipousa.com')
    expect(code('/**\n * /partner/login\n */\nconst x = 1\n')).not.toContain('/partner/login')
  })

  for (const path of routes) {
    it(`${path} delegates to partner-invite`, () => {
      const src = code(readFileSync(path, 'utf8'))
      expect(src).toContain('sendPortalInvite')
      // Importing the mailer directly is how a second copy gets written.
      expect(src).not.toMatch(/from '@\/lib\/email'/)
      // Markers of a hand-rolled body.
      expect(src).not.toContain('/partner/login')
      expect(src).not.toContain('shipousa.com')
    })
  }
})

describe('the login-code email also replies to the mailbox it names', () => {
  // The other partner-facing email. It builds its body inline inside a route
  // handler that reaches Supabase on every path, so there is no way to call it
  // from here and read the payload — hence a source-level check. What it
  // guards is the same agreement as the invite test above: one address
  // printed, and replies going to that address rather than to the shared
  // security@ From.
  const path = 'src/app/api/partner/request-code/route.ts'

  it('the comment stripper is still the thing doing the stripping', () => {
    // Control. This route's own comments name both mailboxes while explaining
    // the choice, so without stripping the assertions below would be
    // satisfied by the prose and would hold after the code stopped agreeing
    // with it.
    expect(code("    replyTo: 'Support@shipousa.com',\n")).toContain('Support@shipousa.com')
    expect(code('    // security@ is not a staffed mailbox\n')).not.toContain('security@')
  })

  it('names exactly one address and points replies at it', () => {
    const src = code(readFileSync(path, 'utf8'))

    const printed = [
      ...new Set([...src.matchAll(/[\w.+-]+@shipousa\.com/g)].map((m) => m[0].toLowerCase())),
    ]
    expect(printed).toHaveLength(1)

    const replyTo = src.match(/replyTo:\s*'([^']+)'/)?.[1]
    expect(replyTo).toBeDefined()
    expect(replyTo?.toLowerCase()).toBe(printed[0])
  })
})
