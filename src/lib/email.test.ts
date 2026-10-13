import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// sendEmail() has four provider branches and exactly ONE of them runs in any
// given environment. So "reply-to is wired up" is not something production can
// tell you: it is true of whichever provider happens to be configured, and
// silently false of the other three until the day someone swaps providers and
// a partner's reply goes back to the wrong mailbox again.
//
// Hence the table below. Every branch gets the SAME four assertions from one
// loop, so a branch cannot be left out of this file by accident -- which is
// the failure mode that matters, the test file being the only place the three
// dormant branches are ever exercised at all.
//
// The absence assertions are as load-bearing as the presence ones. The field
// has to be missing entirely when no replyTo is passed, not present-and-
// undefined: for the two HTTP providers the request body is a string, and
// `reply_to: undefined` is dropped by JSON.stringify but `reply_to: null` or
// `reply_to: ''` is not, and a provider handed an empty reply-to is entitled
// to do whatever it likes with it.

const h = vi.hoisted(() => ({ createTransport: vi.fn(), sendMail: vi.fn() }))
vi.mock('nodemailer', () => ({ default: { createTransport: h.createTransport } }))

const { sendEmail } = await import('./email')

const PROVIDER_VARS = [
  'RESEND_API_KEY',
  'SENDGRID_API_KEY',
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_USER',
  'SMTP_PASS',
  'SUPABASE_SMTP_HOST',
  'SUPABASE_SMTP_PORT',
  'SUPABASE_SMTP_USER',
  'SUPABASE_SMTP_PASS',
  'EMAIL_FROM',
]

const MSG = { to: 'dana@example.com', subject: 'Statement', html: '<p>hi</p>', text: 'hi' }

const env = { ...process.env }
let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  // Deleted rather than overridden: a real key in the ambient shell would
  // otherwise pick the provider for us and three branches would go untested
  // while still reporting green.
  for (const key of PROVIDER_VARS) delete process.env[key]
  h.createTransport.mockReset().mockReturnValue({ sendMail: h.sendMail })
  h.sendMail.mockReset().mockResolvedValue({ messageId: 'x' })
  fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '' })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  process.env = { ...env }
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

interface Branch {
  provider: string
  configure: () => void
  /** The reply-to value as that provider received it, or undefined if absent. */
  replyTo: () => unknown
  /** Every key the provider was handed, to prove absence rather than undefined. */
  keys: () => string[]
  /** The payload as sent, for the byte-level check on the HTTP providers. */
  raw: () => string
}

function lastBody(): Record<string, unknown> {
  return JSON.parse(fetchMock.mock.calls[0][1].body as string) as Record<string, unknown>
}
function lastMail(): Record<string, unknown> {
  return h.sendMail.mock.calls[0][0] as Record<string, unknown>
}

const BRANCHES: Branch[] = [
  {
    provider: 'resend',
    configure: () => {
      process.env.RESEND_API_KEY = 're_test'
    },
    replyTo: () => lastBody().reply_to,
    keys: () => Object.keys(lastBody()),
    raw: () => fetchMock.mock.calls[0][1].body as string,
  },
  {
    provider: 'sendgrid',
    configure: () => {
      process.env.SENDGRID_API_KEY = 'SG.test'
    },
    // SendGrid is the odd one out: it wants the address split into parts, so
    // what arrives is an object and this unwraps it to compare like for like.
    replyTo: () => (lastBody().reply_to as { email?: string } | undefined)?.email,
    keys: () => Object.keys(lastBody()),
    raw: () => fetchMock.mock.calls[0][1].body as string,
  },
  {
    provider: 'smtp',
    configure: () => {
      process.env.SMTP_HOST = 'smtp.gmail.com'
      process.env.SMTP_USER = 'u'
      process.env.SMTP_PASS = 'p'
    },
    replyTo: () => lastMail().replyTo,
    keys: () => Object.keys(lastMail()),
    raw: () => JSON.stringify(lastMail()),
  },
  {
    provider: 'supabase-smtp',
    configure: () => {
      process.env.SUPABASE_SMTP_HOST = 'smtp.supabase.test'
      process.env.SUPABASE_SMTP_USER = 'u'
      process.env.SUPABASE_SMTP_PASS = 'p'
    },
    replyTo: () => lastMail().replyTo,
    keys: () => Object.keys(lastMail()),
    raw: () => JSON.stringify(lastMail()),
  },
]

describe.each(BRANCHES)('sendEmail via $provider', (branch) => {
  it('passes replyTo to the provider', async () => {
    branch.configure()

    const result = await sendEmail({ ...MSG, replyTo: 'Support@shipousa.com' })

    expect(result).toEqual({ sent: true, provider: branch.provider })
    expect(branch.replyTo()).toBe('Support@shipousa.com')
  })

  it('omits the field entirely when no replyTo is given', async () => {
    branch.configure()

    const result = await sendEmail(MSG)

    expect(result.sent).toBe(true)
    // `not.toHaveProperty` would also pass on present-and-undefined, which is
    // the one case worth distinguishing here.
    expect(branch.keys()).not.toContain('reply_to')
    expect(branch.keys()).not.toContain('replyTo')
    expect(branch.raw()).not.toMatch(/reply/i)
  })

  it('still reports a provider failure rather than throwing', async () => {
    branch.configure()
    fetchMock.mockResolvedValue({ ok: false, status: 422, text: async () => 'bad request' })
    h.sendMail.mockRejectedValue(new Error('connection refused'))

    const result = await sendEmail({ ...MSG, replyTo: 'Support@shipousa.com' })

    // The contract every caller leans on: never throws, always says who
    // failed and why. request-code turns this into the 502 a partner sees.
    expect(result.sent).toBe(false)
    expect(result.error).toBeTruthy()
    expect(result.provider).toBeTruthy()
  })
})

describe('the provider table covers every branch sendEmail has', () => {
  // The guard-the-guard for the loop above. Add a fifth provider without
  // wiring reply-to into it and the loop above stays green, because a loop
  // only tests the rows it is given. This asserts the rows ARE the branches.
  //
  // Comments are stripped first because this file and email.ts both discuss
  // the provider names in prose, and a grep over source counts its own
  // prose. The control below measures the stripper instead of trusting it.
  function code(src: string): string {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*)/.test(line))
      .join('\n')
  }

  it('the comment stripper drops prose and keeps string literals', () => {
    expect(code("  return { provider: 'resend' }\n")).toContain("'resend'")
    expect(code("  // the provider: 'mailgun' branch\n")).not.toContain('mailgun')
    expect(code("/**\n * provider: 'postmark'\n */\nconst x = 1\n")).not.toContain('postmark')
  })

  it('every provider email.ts can report is exercised above', () => {
    const src = code(readFileSync('src/lib/email.ts', 'utf8'))
    const found = new Set(
      [...src.matchAll(/provider: '([a-z-]+)'/g)].map((m) => m[1]),
    )
    // 'none' (nothing configured) and 'error' (threw) are not providers and
    // carry no payload, so they have their own tests below.
    found.delete('none')
    found.delete('error')

    expect([...found].sort()).toEqual(BRANCHES.map((b) => b.provider).sort())
  })
})

describe('sendEmail: the address splitting SendGrid needs', () => {
  beforeEach(() => {
    process.env.SENDGRID_API_KEY = 'SG.test'
  })

  it('splits a display name from the address', async () => {
    await sendEmail({ ...MSG, replyTo: 'Shipo Support <Support@shipousa.com>' })
    expect(lastBody().reply_to).toEqual({ email: 'Support@shipousa.com', name: 'Shipo Support' })
  })

  it('gives a bare address no name, rather than naming it after itself', async () => {
    // Otherwise SendGrid renders the recipient-visible 'Support@shipousa.com
    // <Support@shipousa.com>'. This is the quirk the shared `from` parsing
    // still has, and the reason reply-to does not reuse it.
    await sendEmail({ ...MSG, replyTo: 'Support@shipousa.com' })
    expect(lastBody().reply_to).toEqual({ email: 'Support@shipousa.com' })
  })
})

describe('sendEmail: the contract callers depend on', () => {
  it('reports no-provider instead of throwing, even with a replyTo', async () => {
    const result = await sendEmail({ ...MSG, replyTo: 'Support@shipousa.com' })

    // monitor/route.ts asserts on this exact shape: a dead alerting channel
    // has to become an HTTP status, not an exception.
    expect(result).toEqual({
      sent: false,
      provider: 'none',
      error: 'No email provider configured',
    })
  })

  it('reports a thrown transport error as provider "error"', async () => {
    process.env.SMTP_HOST = 'smtp.gmail.com'
    process.env.SMTP_USER = 'u'
    process.env.SMTP_PASS = 'p'
    h.sendMail.mockRejectedValue(new Error('EAUTH'))

    const result = await sendEmail({ ...MSG, replyTo: 'Support@shipousa.com' })

    expect(result).toEqual({ sent: false, provider: 'error', error: 'EAUTH' })
  })

  it('leaves the From address alone — replyTo adds, it does not replace', async () => {
    // The bug this feature fixes is two addresses disagreeing. Fixing it by
    // quietly rewriting From would change the sender of every partner email
    // and break SPF/DKIM alignment on a domain we do not own the DNS answer
    // for in every environment.
    process.env.RESEND_API_KEY = 're_test'
    process.env.EMAIL_FROM = 'Shipo Security <security@shipousa.com>'

    await sendEmail({ ...MSG, replyTo: 'Support@shipousa.com' })

    expect(lastBody().from).toBe('Shipo Security <security@shipousa.com>')
    expect(lastBody().reply_to).toBe('Support@shipousa.com')
  })
})
