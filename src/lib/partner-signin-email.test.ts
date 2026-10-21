import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeSupabase, type FakeDb, type FakeRow } from './ledger/fake-supabase'

const h: { db: FakeDb } = { db: createFakeSupabase() }
const sendEmail = vi.fn()

vi.mock('@/lib/supabase', () => ({
  get supabaseAdmin() { return h.db.client },
}))
vi.mock('@/lib/email', () => ({
  get sendEmail() { return sendEmail },
}))

const { sendSignInEmail, SIGN_IN_EMAIL_COLUMNS } = await import('./partner-signin-email')

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * A module's body with the import block removed.
 *
 * Every source-reading guard below needs this. `import { sendPortalInvite }`
 * at the top of a file satisfies a naive `toContain('sendPortalInvite')`, so a
 * guard that reads the whole file can pass over a call site that no longer
 * calls the thing — which is exactly the vacuous assertion this helper was
 * written to kill.
 */
function bodyOf(path: string): string {
  return readFileSync(path, 'utf8').replace(/^import[\s\S]*?from '[^']+'\n/gm, '')
}

const WEBHOOK = join(HERE, '../app/api/partner/agreement-webhook/route.ts')
const PORTAL_ACCESS = join(HERE, '../app/api/referrals/portal-access/route.ts')
const REQUEST_CODE = join(HERE, '../app/api/partner/request-code/route.ts')

/** A partner who is past every gate: active, signed, with an address to mail. */
function ok(over: Record<string, unknown> = {}) {
  return {
    id: 'p1',
    name: 'Dana Katz',
    email: 'dana@example.com',
    status: 'active',
    agreement_status: 'signed',
    ...over,
  }
}

function seed(rows: FakeRow[] = []) {
  h.db = createFakeSupabase({ partner_login_codes: rows })
}

beforeEach(() => {
  seed()
  sendEmail.mockReset()
  sendEmail.mockResolvedValue({ sent: true, provider: 'resend' })
  process.env.NEXT_PUBLIC_SITE_URL = 'https://shipo-system.vercel.app'
})

/** The one row this module writes, whatever else happened. */
function issuedRow(): FakeRow {
  const rows = h.db.tables.partner_login_codes ?? []
  const live = rows.filter((r) => !r.consumed_at)
  expect(live).toHaveLength(1)
  return live[0]
}

function bodies() {
  expect(sendEmail).toHaveBeenCalledTimes(1)
  const call = sendEmail.mock.calls[0][0] as { text: string; html: string; subject: string }
  return call
}

// ===========================================================================
// THE GATE IS INSIDE THIS FUNCTION, NOT AT ITS CALL SITES
//
// Spec §2.2 says creating the partner row sends the sign-in email. Ophir's
// standing rule says the agreement comes before access, and that rule is
// enforced in four places already. Where the two disagree, access wins: an
// email that carries a working credential to someone who has not signed is
// the one failure mode nobody notices, because the email looks correct and
// the partner is delighted.
//
// So the gate lives in HERE rather than in each caller. Two routes send this
// email today and more will; a gate a caller has to remember is a gate that
// gets forgotten exactly once.
// ===========================================================================

describe('the access gate is inside, not at the call site', () => {
  it('sends nothing to a partner whose agreement is unsigned', async () => {
    const r = await sendSignInEmail(ok({ agreement_status: 'sent' }))

    expect(r.sent).toBe(false)
    expect(sendEmail).not.toHaveBeenCalled()
    // And no credential was minted. A row written but not mailed is a live
    // token sitting in the database for seven days with nobody expecting it.
    expect(h.db.tables.partner_login_codes ?? []).toHaveLength(0)
  })

  it('sends nothing to an inactive partner', async () => {
    const r = await sendSignInEmail(ok({ status: 'inactive' }))
    expect(r.sent).toBe(false)
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('names the blocking reason for staff rather than returning a bare false', async () => {
    // The caller logs this. "No email arrived" is otherwise unanswerable.
    const r = await sendSignInEmail(ok({ agreement_status: null }))
    expect(r.sent).toBe(false)
    if (r.sent) throw new Error('unreachable')
    expect(r.reason).toBe('blocked')
    if (r.reason !== 'blocked') throw new Error('unreachable')
    expect(r.blocked).toMatch(/agreement/i)
  })

  it('sends to a partner who is active and signed', async () => {
    // The control. Without it a gate that refused everyone would pass
    // all three refusals above.
    const r = await sendSignInEmail(ok())
    expect(r.sent).toBe(true)
    expect(sendEmail).toHaveBeenCalledTimes(1)
  })

  it('refuses a partner with no address to send to', async () => {
    const r = await sendSignInEmail(ok({ email: null }))
    expect(r.sent).toBe(false)
    if (r.sent) throw new Error('unreachable')
    expect(r.reason).toBe('no-email')
    expect(sendEmail).not.toHaveBeenCalled()
  })
})

// ===========================================================================
// WHAT REACHES THE DATABASE
// ===========================================================================

describe('the credential is hashed before it is stored', () => {
  it('stores a hash of the code and never the code itself', async () => {
    await sendSignInEmail(ok())
    const row = issuedRow()
    const { text } = bodies()
    const code = /\b(\d{6})\b/.exec(text)![1]

    expect(row.code_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(row.code_hash).not.toBe(code)
    // The whole row, serialised, must not contain the mailed secret.
    expect(JSON.stringify(row)).not.toContain(code)
  })

  it('stores a hash of the link token and never the token itself', async () => {
    await sendSignInEmail(ok())
    const row = issuedRow()
    const { text } = bodies()
    const token = /[?&]t=([A-Za-z0-9_-]+)/.exec(text)![1]

    expect(row.link_token_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(row)).not.toContain(token)
  })

  it('does not return the code or the token to the caller', async () => {
    // The caller is a route that answers a browser. A credential in the
    // result is a credential one careless `NextResponse.json(result)`
    // away from the wire.
    const r = await sendSignInEmail(ok())
    const { text } = bodies()
    const code = /\b(\d{6})\b/.exec(text)![1]
    expect(JSON.stringify(r)).not.toContain(code)
  })

  it('issues the code and the link on ONE row, sharing one consumed_at', async () => {
    // Signing in by link must retire the code that travelled in the same
    // email, and vice versa. Two rows would leave a live credential in a
    // mailbox after its owner was already inside.
    await sendSignInEmail(ok())
    expect(h.db.tables.partner_login_codes).toHaveLength(1)
    const row = issuedRow()
    expect(row.code_hash).toBeTruthy()
    expect(row.link_token_hash).toBeTruthy()
    expect(row.consumed_at ?? null).toBeNull()
  })

  it('retires anything still outstanding for this partner first', async () => {
    seed([
      { id: 'old', referral_partner_id: 'p1', code_hash: 'aaa', consumed_at: null },
      { id: 'other', referral_partner_id: 'p2', code_hash: 'bbb', consumed_at: null },
    ])
    await sendSignInEmail(ok())

    const rows = h.db.tables.partner_login_codes!
    expect(rows.find((r) => r.id === 'old')!.consumed_at).toBeTruthy()
    // Another partner's live code is untouched. An `eq` that went missing
    // here would sign every other partner out on one person's request.
    expect(rows.find((r) => r.id === 'other')!.consumed_at).toBeNull()
  })

  it('reports an insert failure instead of mailing a code it did not store', async () => {
    h.db.client = {
      from: () => ({
        update: () => ({ eq: () => ({ is: async () => ({ error: null }) }) }),
        insert: async () => ({ error: { message: 'connection reset', code: '08006' } }),
      }),
    } as unknown as FakeDb['client']

    const r = await sendSignInEmail(ok())
    expect(r.sent).toBe(false)
    if (r.sent) throw new Error('unreachable')
    expect(r.reason).toBe('insert-failed')
    // The email is the thing that must not happen. A mailed code with no
    // stored hash is a credential guaranteed to be refused.
    expect(sendEmail).not.toHaveBeenCalled()
  })
})

// ===========================================================================
// DEGRADING WHEN THE MIGRATION IS LATE
// ===========================================================================

describe('a missing link column degrades to code-only, it does not fail', () => {
  it('still mails a working code when link_token_hash does not exist', async () => {
    let attempt = 0
    h.db.client = {
      from: () => ({
        update: () => ({ eq: () => ({ is: async () => ({ error: null }) }) }),
        insert: async () => {
          attempt += 1
          return attempt === 1
            ? { error: { message: 'column "link_token_hash" does not exist', code: '42703' } }
            : { error: null }
        },
      }),
    } as unknown as FakeDb['client']

    const r = await sendSignInEmail(ok())

    expect(r.sent).toBe(true)
    if (!r.sent) throw new Error('unreachable')
    expect(r.linkIssued).toBe(false)
    expect(attempt).toBe(2)

    const { text, html } = bodies()
    expect(text).toMatch(/\b\d{6}\b/)
    // No link offered, because its hash is not stored and it would be
    // refused. An offered-but-dead link is worse than no link.
    expect(text).not.toContain('/partner/signin')
    expect(html).not.toContain('/partner/signin')
  })

  it('does NOT retry on a failure that is not a missing column', async () => {
    let attempts = 0
    h.db.client = {
      from: () => ({
        update: () => ({ eq: () => ({ is: async () => ({ error: null }) }) }),
        insert: async () => {
          attempts += 1
          return { error: { message: 'duplicate key value', code: '23505' } }
        },
      }),
    } as unknown as FakeDb['client']

    const r = await sendSignInEmail(ok())
    expect(r.sent).toBe(false)
    // A unique violation retried code-only would hide a real bug behind a
    // degraded email nobody reads as a symptom.
    expect(attempts).toBe(1)
  })
})

// ===========================================================================
// THE EMAIL
// ===========================================================================

describe('the email carries both ways in', () => {
  it('puts the code in the subject and in both bodies', async () => {
    await sendSignInEmail(ok())
    const { subject, text, html } = bodies()
    const code = /\b(\d{6})\b/.exec(text)![1]
    expect(subject).toContain(code)
    expect(html).toContain(code)
  })

  it('puts the one-click link in both bodies', async () => {
    await sendSignInEmail(ok())
    const { text, html } = bodies()
    expect(text).toContain('https://shipo-system.vercel.app/partner/signin?t=')
    expect(html).toContain('https://shipo-system.vercel.app/partner/signin?t=')
  })

  it('replies to the mailbox it names, not the shared From identity', async () => {
    // The From address defaults to security@, which is nobody's inbox. A
    // partner answering "this code does not work" must reach a human.
    await sendSignInEmail(ok())
    const call = sendEmail.mock.calls[0][0] as { replyTo: string; text: string }
    expect(call.replyTo).toBe('Support@shipousa.com')
    expect(call.text).toContain('Support@shipousa.com')
  })

  it('names exactly one address, and that is the one a reply reaches', async () => {
    // Relocated here when partner-invite.ts was deleted. It guarded the
    // same agreement on the invite email, and the agreement is what matters
    // rather than the literal: the address a reply ARRIVES at has to be the
    // address the email PRINTED.
    //
    // A hardcoded expectation keeps passing after someone edits the footer,
    // and that drift is what produced the original bug — an email that told
    // the partner to write to us and then routed his answer to the shared
    // security@ From identity, which is nobody's inbox. Two addresses
    // printed is the same failure one step earlier: he cannot tell which
    // one of them answers.
    await sendSignInEmail(ok())
    const call = sendEmail.mock.calls[0][0] as {
      replyTo?: string
      text: string
      html: string
    }
    const printed = [
      ...new Set(
        [...`${call.text} ${call.html}`.matchAll(/[\w.+-]+@shipousa\.com/g)].map((m) =>
          m[0].toLowerCase(),
        ),
      ),
    ]
    expect(printed).toHaveLength(1)
    expect(call.replyTo).toBeDefined()
    expect(call.replyTo?.toLowerCase()).toBe(printed[0])
  })

  it('greets the partner by first name and tolerates a missing one', async () => {
    await sendSignInEmail(ok({ name: null }))
    expect(bodies().text).toContain('Hi there,')
  })

  it('reports a send failure with the provider name instead of claiming success', async () => {
    sendEmail.mockResolvedValue({ sent: false, provider: 'none', error: 'No email provider' })
    const r = await sendSignInEmail(ok())
    expect(r.sent).toBe(false)
    if (r.sent) throw new Error('unreachable')
    expect(r.reason).toBe('send-failed')
    if (r.reason !== 'send-failed') throw new Error('unreachable')
    // 'none' means no mail env var in THIS environment — the fix is in
    // Vercel, not at the provider. Three failures want three fixes.
    expect(r.provider).toBe('none')
  })

  it('says nothing about commission, clients or money', async () => {
    // This email is delivered on signature, before the partner has ever
    // opened the portal, and it travels through infrastructure Shipo does
    // not own. It is a way in and nothing else.
    await sendSignInEmail(ok())
    const { text, html } = bodies()
    for (const body of [text, html]) {
      expect(body).not.toMatch(/commission|\$|per order|per unit|rate/i)
    }
  })
})

// ===========================================================================
// THE W-9 THAT FOLLOWS THE AGREEMENT. Spec §2.3.
//
// This email is sent the instant the agreement is signed, so it is the only
// moment anything reaches the partner automatically. §2.3 reads as though the
// webhook should send him a W-9 envelope; it cannot — that envelope is
// EMBEDDED, reachable only through a recipient-view URL minted for somebody
// with a browser open, and with no w9_envelope_id column anywhere a
// webhook-fired one would be invisible to the dashboard, which would go on
// offering its own button. Two live envelopes is two taxpayer numbers
// collected from one man.
//
// So what fires automatically is the PROMPT. The decision of what to say, and
// when to say nothing, is tested in partner-signin-w9-step.test.ts; what is
// tested here is that the email actually carries it, and that the silent
// cases leave the message exactly as it was.
// ===========================================================================

describe('the email names the W-9 as the next step', () => {
  it('tells a signed US partner what is waiting inside', async () => {
    await sendSignInEmail(ok({ tax_status: 'us_person', w9_received_at: null }))
    const { text, html } = bodies()

    for (const body of [text, html]) {
      expect(body).toMatch(/W-9/)
      expect(body).toMatch(/dashboard/i)
    }
  })

  it('says nothing about a W-9 we already hold', async () => {
    // He gave us the number. Being asked again on his next login reads as
    // "the first one was lost", and the rational response is to do it twice.
    await sendSignInEmail(ok({ tax_status: 'us_person', w9_received_at: '2026-10-20T00:00:00Z' }))
    const { text, html } = bodies()

    for (const body of [text, html]) expect(body).not.toMatch(/W-9/)
  })

  it('stays silent about the W-9 when staff have not recorded a tax status', async () => {
    // The dashboard form refuses that partner, so a promise here points him
    // at a locked door. The email goes out unchanged and the condition goes
    // to staff instead — it is theirs to fix and it is invisible otherwise.
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await sendSignInEmail(ok({ tax_status: null, w9_received_at: null }))
      const { text, html } = bodies()

      for (const body of [text, html]) expect(body).not.toMatch(/W-9/)
      expect(log.mock.calls.flat().join(' ')).toMatch(/tax_status/)
    } finally {
      log.mockRestore()
    }
  })

  it('still says nothing about commission, clients or money with the W-9 step in it', async () => {
    // The money guard above runs on a fixture with no tax status, so it
    // never sees this paragraph. The W-9 is the one subject in this email
    // that invites a figure, so the guard is repeated over the variant that
    // actually prints it.
    await sendSignInEmail(ok({ tax_status: 'us_person', w9_received_at: null }))
    const { text, html } = bodies()

    for (const body of [text, html]) {
      expect(body).not.toMatch(/commission|\$|per order|per unit/i)
    }
  })

  it('keeps the code and the link in the message that mentions the W-9', async () => {
    // The W-9 paragraph is an aside in an email whose job is access. If it
    // ever displaced either way in, a partner would be reading about tax
    // paperwork on a message he cannot act on.
    await sendSignInEmail(ok({ tax_status: 'us_person', w9_received_at: null }))
    const { subject, text } = bodies()

    const code = /\b(\d{6})\b/.exec(text)![1]
    expect(subject).toContain(code)
    expect(text).toContain('https://shipo-system.vercel.app/partner/signin?t=')
  })

  it('every caller reads the columns this decision needs', async () => {
    // AN UNSELECTED COLUMN ARRIVES AS undefined, AND undefined READS AS
    // "NO W-9 ON FILE". A caller that forgot w9_received_at would nag a
    // partner who has already handed over his taxpayer number into handing
    // it over again — which is the failure this whole step exists to
    // prevent, reintroduced by an omission in a SELECT list.
    //
    // Forgetting tax_status fails the other way and more quietly: every
    // partner reads as "not recorded", so the prompt silently never fires
    // and the only symptom is a log line nobody is looking for.
    //
    // So the list is a shared constant and this is the guard that keeps it
    // shared. A hand-written select naming agreement_status is a partner row
    // being read with its own list, and is refused outright.
    expect(SIGN_IN_EMAIL_COLUMNS).toContain('w9_received_at')
    expect(SIGN_IN_EMAIL_COLUMNS).toContain('tax_status')

    for (const path of [WEBHOOK, PORTAL_ACCESS, REQUEST_CODE]) {
      const src = bodyOf(path)
      expect(src).toContain('.select(SIGN_IN_EMAIL_COLUMNS)')
      expect(src).not.toMatch(/\.select\('[^']*agreement_status/)
    }
  })
})

// ===========================================================================
// THE ORIGIN OF THE LINK
// ===========================================================================

describe('the link origin comes from config, never from a request', () => {
  it('takes no origin parameter at all', async () => {
    // The arity IS the enforcement. A forged `Origin:` header that reached
    // this function would have Shipo email the real partner a real token
    // pointed at an attacker's host. There is no parameter to forge.
    expect(sendSignInEmail.length).toBe(1)
  })

  it('omits the link when no origin is configured, and still mails the code', async () => {
    delete process.env.NEXT_PUBLIC_SITE_URL
    delete process.env.VERCEL_PROJECT_PRODUCTION_URL
    const r = await sendSignInEmail(ok())

    expect(r.sent).toBe(true)
    if (!r.sent) throw new Error('unreachable')
    expect(r.linkIssued).toBe(false)
    expect(bodies().text).toMatch(/\b\d{6}\b/)
  })

  it('omits the link over plain http rather than mailing a token in the clear', async () => {
    process.env.NEXT_PUBLIC_SITE_URL = 'http://staging.example.com'
    const r = await sendSignInEmail(ok())
    expect(r.sent).toBe(true)
    if (!r.sent) throw new Error('unreachable')
    expect(r.linkIssued).toBe(false)
    expect(bodies().text).not.toContain('/partner/signin')
  })
})

// ===========================================================================
// THE CALL SITES
//
// Two routes mail a partner his way in: the DocuSign webhook, on signature,
// and the staff invite button. Both used to send sendPortalInvite -- an email
// whose entire payload was the portal's ADDRESS, leaving the partner to type
// his email and wait for a second message before he could get in.
//
// §2.1's "one click" belongs at the moment he first becomes entitled, which
// is the webhook. And the two messages must stay indistinguishable: a partner
// who gets a different-looking email depending on which path fired cannot
// tell the automated one from a phishing attempt. This file used to hold a
// second copy of the invite, which had already drifted.
// ===========================================================================

describe('both routes that mail a partner use this function', () => {
  it('the DocuSign webhook sends the sign-in email on signature', () => {
    const src = bodyOf(WEBHOOK)
    expect(src).toContain('sendSignInEmail(')
    expect(src).not.toContain('sendPortalInvite(')
  })

  it('the staff invite button sends the same email', () => {
    const src = bodyOf(PORTAL_ACCESS)
    expect(src).toContain('sendSignInEmail(')
    expect(src).not.toContain('sendPortalInvite(')
  })

  it('neither route passes a request origin into it', () => {
    // The credential is in the URL. Both routes have `req` in scope and
    // both used to hand its `origin` header to the invite.
    for (const path of [WEBHOOK, PORTAL_ACCESS]) {
      const src = bodyOf(path)
      expect(src).not.toMatch(/sendSignInEmail\([^)]*headers\.get/)
      expect(src).not.toMatch(/sendSignInEmail\([^)]*origin/)
    }
  })

  it('the login-code route issues through this function too', () => {
    // Not DRY for its own sake. Two copies of a partner-facing email is
    // the exact drift the staff route already suffered once, and a second
    // issuance path is a second place for "hash before you store" to be
    // got wrong.
    const src = bodyOf(REQUEST_CODE)
    expect(src).toContain('sendSignInEmail(')
  })

  it('no route imports the mailer directly', () => {
    // Relocated from partner-invite.test.ts. Asserting that the three
    // bodies MATCH is not possible from here — two are built inside route
    // handlers that reach Supabase on every path — so this asserts the
    // stronger structural fact: there is one place that builds it, because
    // nowhere else can.
    //
    // Importing @/lib/email into a route is how the second copy got
    // written last time, and that copy had already drifted: it still
    // carried the dead shipousa.com fallback after the shared helper was
    // fixed. This reads the WHOLE file rather than bodyOf, because the
    // import line is the thing being forbidden.
    for (const path of [WEBHOOK, PORTAL_ACCESS, REQUEST_CODE]) {
      expect(readFileSync(path, 'utf8')).not.toMatch(/from '@\/lib\/email'/)
    }
  })
})
