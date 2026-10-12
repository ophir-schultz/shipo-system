import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createFakeSupabase, type FakeDb, type FakeRow } from '@/lib/ledger/fake-supabase'

const h = vi.hoisted(() => ({ db: null as unknown as FakeDb }))

vi.mock('@/lib/supabase', () => ({
  get supabaseAdmin() { return h.db.client },
}))

// partner-auth imports next/headers for getPartnerFromSession, which this
// route never calls. The route only wants its email helpers, and those are
// pure. Stubbing the module keeps the request-scoped API out of a node test
// without giving the route a second definition of "is this an email" to
// drift away from.
vi.mock('next/headers', () => ({
  cookies: async () => { throw new Error('cookies() is not available in this test') },
}))

const { POST } = await import('./route')

/**
 * Only `referral_partners` is touched, but seeding it explicitly means an
 * empty table is a deliberate fixture rather than an accident of the double
 * auto-creating one on first read.
 */
function seed(rows: FakeRow[] = []) {
  h.db = createFakeSupabase({ referral_partners: rows })
}

/** A row as the website form would have created it, `n` minutes ago. */
function formRow(n: number, over: FakeRow = {}): FakeRow {
  return {
    id: `p-${Math.random().toString(36).slice(2)}`,
    name: 'Prior signup',
    email: null,
    source: 'website_form',
    status: 'pending',
    created_at: new Date(Date.now() - n * 60_000).toISOString(),
    ...over,
  }
}

function post(body: unknown, init: { url?: string; headers?: Record<string, string> } = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return POST(
    new Request(init.url ?? 'https://shipousa.com/api/referrals/intake', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
      body: text,
    }),
  )
}

/** The rows the route actually wrote, as opposed to the fixture it read. */
function inserted(): FakeRow[] {
  return h.db.calls.filter((c) => c.verb === 'insert').flatMap((c) => c.payload)
}

beforeEach(() => {
  seed()
  delete process.env.REFERRAL_INTAKE_TOKEN
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env.REFERRAL_INTAKE_TOKEN
})

describe('the shared secret', () => {
  it('accepts anything while REFERRAL_INTAKE_TOKEN is unset', async () => {
    // This is the current production state. The test exists so that making
    // the token mandatory is a deliberate, visible change rather than
    // something that slips in and silently 401s every real lead.
    const res = await post({ name: 'Open Era', email: 'open@example.com' })
    expect(res.status).toBe(200)
    expect(inserted()).toHaveLength(1)
  })

  it('says out loud that it is accepting an unauthenticated write', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await post({ name: 'Open Era', email: 'open@example.com' })
    expect(warn.mock.calls.flat().join(' ')).toContain('REFERRAL_INTAKE_TOKEN is not set')
  })

  it('rejects a missing or wrong token once the secret IS set', async () => {
    process.env.REFERRAL_INTAKE_TOKEN = 'correct-horse'

    const missing = await post({ name: 'A', email: 'a@example.com' })
    expect(missing.status).toBe(401)

    const wrong = await post(
      { name: 'A', email: 'a@example.com' },
      { url: 'https://shipousa.com/api/referrals/intake?token=wrong' },
    )
    expect(wrong.status).toBe(401)

    // Nothing reached the database on either attempt.
    expect(inserted()).toHaveLength(0)
  })

  it('accepts the token from the query string or the header', async () => {
    process.env.REFERRAL_INTAKE_TOKEN = 'correct-horse'

    const viaQuery = await post(
      { name: 'A', email: 'a@example.com' },
      { url: 'https://shipousa.com/api/referrals/intake?token=correct-horse' },
    )
    expect(viaQuery.status).toBe(200)

    const viaHeader = await post(
      { name: 'B', email: 'b@example.com' },
      { headers: { 'x-intake-token': 'correct-horse' } },
    )
    expect(viaHeader.status).toBe(200)
  })
})

describe('body shape', () => {
  it('refuses a JSON body that is not an object instead of crashing', async () => {
    // `Object.keys(null)` throws a TypeError, which an unguarded handler
    // surfaces as a 500. A bare string or an array reads as an object with no
    // usable keys. All three are legal JSON and none is a sign-up.
    for (const body of ['null', '"just a string"', '[]', '[{"email":"a@b.co"}]', '42']) {
      const res = await post(body)
      expect(res.status, `body ${body}`).toBe(400)
      expect(await res.json()).toEqual({ error: 'Expected a JSON object.' })
    }
    expect(inserted()).toHaveLength(0)
  })

  it('refuses a body larger than the cap before reading it', async () => {
    const res = await POST(
      new Request('https://shipousa.com/api/referrals/intake', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': String(65 * 1024) },
        body: JSON.stringify({ name: 'x', email: 'a@example.com' }),
      }),
    )
    expect(res.status).toBe(413)
    // No query ran at all — the guard is in front of the parse and the DB.
    expect(h.db.calls).toHaveLength(0)
  })

  // One case per field, because the guard is four separate arms of one
  // condition. Testing only `name` leaves the other three free to be deleted
  // with the suite still green — which is exactly what a reversion run of an
  // earlier version of this file showed.
  it.each([
    ['name', { name: 'x'.repeat(201) }],
    ['company', { company: 'x'.repeat(201) }],
    ['phone', { phone: '5'.repeat(51) }],
    ['partner_type', { partner_type: 'x'.repeat(101) }],
  ])('refuses an over-long %s', async (_field, over) => {
    const res = await post({ name: 'Fine', email: 'fine@example.com', ...over })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'A field is longer than this form allows.' })
    expect(inserted()).toHaveLength(0)
  })

  it('accepts each identity field at exactly its limit', async () => {
    // The caps are inclusive. An off-by-one here rejects a legitimate 200-
    // character company name, and the rejection is indistinguishable from
    // spam in the log.
    const res = await post({
      name: 'x'.repeat(200),
      company: 'c'.repeat(200),
      phone: '5'.repeat(50),
      partner_type: 't'.repeat(100),
      email: 'edge@example.com',
    })
    expect(res.status).toBe(200)
    expect(inserted()).toHaveLength(1)
  })

  it('truncates a long narrative rather than dropping the lead', async () => {
    const res = await post({
      name: 'Verbose Partner',
      email: 'verbose@example.com',
      refer_method: 'y'.repeat(5000),
    })
    expect(res.status).toBe(200)
    const row = inserted()[0]
    expect(String(row.refer_method)).toHaveLength(2000 + '… [truncated at intake]'.length)
    expect(String(row.refer_method).endsWith('… [truncated at intake]')).toBe(true)
  })
})

describe('the email address', () => {
  it('normalises case and whitespace before storing', async () => {
    await post({ name: 'Mixed Case', email: '  Partner@Example.COM ' })
    expect(inserted()[0].email).toBe('partner@example.com')
  })

  it('de-dupes against an existing row that differs only in case', async () => {
    // The de-dupe is an equality match, so an un-normalised address would
    // create a second partner for the same person — and two partner rows for
    // one human is two sets of referral credit.
    seed([formRow(600, { id: 'existing-1', email: 'partner@example.com' })])

    const res = await post({ name: 'Mixed Case', email: 'PARTNER@EXAMPLE.COM' })
    expect(await res.json()).toEqual({ success: true, deduped: true, id: 'existing-1' })
    expect(inserted()).toHaveLength(0)
  })

  it('keeps a lead whose address is malformed but who gave a name', async () => {
    // A typo is a human being who tried. Ophir can read the row and correct it.
    const res = await post({ name: 'Typo Partner', email: 'not-an-address' })
    expect(res.status).toBe(200)
    const row = inserted()[0]
    expect(row.email).toBeNull()
    expect(row.name).toBe('Typo Partner')
  })

  it('refuses a submission with neither a usable address nor a name', async () => {
    const res = await post({ email: 'not-an-address' })
    expect(res.status).toBe(400)
    expect(inserted()).toHaveLength(0)
  })

  it('refuses an address past the RFC length limit', async () => {
    const long = 'a'.repeat(250) + '@example.com'
    const res = await post({ email: long })
    expect(res.status).toBe(400)
  })
})

describe('the rate ceiling', () => {
  it('turns away a submission once the window is full', async () => {
    seed(Array.from({ length: 20 }, () => formRow(1)))

    const res = await post({ name: 'Twenty-first', email: 'c21@example.com' })
    expect(res.status).toBe(429)
    expect(inserted()).toHaveLength(0)
  })

  it('counts only website rows inside the window', async () => {
    // Rows that are old, or that Ophir typed in by hand, must not be able to
    // close the public form.
    seed([
      ...Array.from({ length: 30 }, () => formRow(60)),                      // outside the window
      ...Array.from({ length: 30 }, () => formRow(1, { source: 'manual' })), // not the form
    ])

    const res = await post({ name: 'Legit', email: 'legit@example.com' })
    expect(res.status).toBe(200)
    expect(inserted()).toHaveLength(1)
  })

  it('still accepts the sign-up when the counting query itself fails', async () => {
    // Failing closed here would hand anyone who can break this one query the
    // power to shut the form — a denial of service dressed as a safety guard.
    seed()
    h.db.failOn = (call) => (call.count ? { message: 'column created_at does not exist' } : null)

    const res = await post({ name: 'Counted Out', email: 'counted@example.com' })
    expect(res.status).toBe(200)
    expect(inserted()).toHaveLength(1)
  })
})

describe('what gets written', () => {
  it('always lands as pending from the website form', async () => {
    // referral_partners.status DEFAULTS to 'active'. If this insert ever
    // stopped naming the status, a stranger posting to an open endpoint would
    // create a live partner.
    await post({
      name: 'New Partner',
      email: 'new@example.com',
      company: 'Agency Co',
      phone: '+1 555 0100',
      partner_type: 'ecommerce_agency',
      refer_method: 'Our client base',
    })

    expect(inserted()[0]).toMatchObject({
      name: 'New Partner',
      email: 'new@example.com',
      company: 'Agency Co',
      phone: '+1 555 0100',
      partner_type: 'ecommerce_agency',
      refer_method: 'Our client base',
      status: 'pending',
      source: 'website_form',
    })
  })

  it('reads Forminator-style field labels, not just tidy keys', async () => {
    const res = await post({
      'Full Name': 'Label Partner',
      'Email Address': 'label@example.com',
      'Company Name': 'Label Co',
      'How will you refer sellers to us?': 'Newsletter',
    })
    expect(res.status).toBe(200)
    expect(inserted()[0]).toMatchObject({
      name: 'Label Partner',
      email: 'label@example.com',
      company: 'Label Co',
      refer_method: 'Newsletter',
    })
  })

  it('falls back to a readable name when only a malformed address arrived', async () => {
    // `name` is NOT NULL, so this path has to produce something.
    const res = await post({ 'Full Name': '', email: 'bad@@address', company: 'Co' })
    expect(res.status).toBe(400) // no name and no usable email

    const withCompanyOnly = await post({ name: 'Co Contact', email: 'bad@@address' })
    expect(withCompanyOnly.status).toBe(200)
    expect(inserted()[0].name).toBe('Co Contact')
  })
})
