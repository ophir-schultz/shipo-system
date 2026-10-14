import { describe, expect, it } from 'vitest'
import { W9_SIGN_FALLBACK, w9SignRefusal, type W9SignContext } from './partner-w9-sign'
import { holdsW9 } from './partner-w9'

/**
 * The ladder in front of the only send this application performs.
 *
 * Every rung is a refusal, and the reason they are a pure function rather
 * than four early returns in the route is that each one is wrong in a
 * different expensive way: one collects a second taxpayer identification
 * number from the same person, one mails a tax form to nobody, one sends a
 * US form to someone the IRS wants a different form from. None of those
 * can be reached by a test that has to stand up a session and a DocuSign
 * account first.
 */

const US: W9SignContext = {
  partner: { id: 'p1', name: 'Acme', email: 'a@b.com', tax_status: 'us_person', w9_received_at: null },
  accountantEmail: 'cpa@firm.com',
  accountantName: 'Dana Reyes',
  docusignConfigured: true,
}

describe('w9SignRefusal', () => {
  it('lets a US partner with no W-9 through', () => {
    expect(w9SignRefusal(US)).toBeNull()
  })

  it('refuses with 401 when there is no session', () => {
    const r = w9SignRefusal({ ...US, partner: null })!
    expect(r.status).toBe(401)
  })

  it('refuses with 409 when we already hold one', () => {
    // Not an error state to recover from — a second envelope is a second
    // TIN collection from a person who already gave us theirs.
    const r = w9SignRefusal({
      ...US,
      partner: { ...US.partner!, w9_received_at: '2026-10-13T09:00:00.000Z' },
    })!
    expect(r.status).toBe(409)
    expect(r.message).toMatch(/already/i)
  })

  it('agrees with holdsW9 about what "already" means', () => {
    // The drift this forbids: the gate opens on a blank string while this
    // route reads the same blank string as "nothing on file" and sends a
    // second envelope to a partner whose statement is already visible.
    for (const w9_received_at of [null, undefined, '', '2026-10-14T00:00:00Z']) {
      const r = w9SignRefusal({ ...US, partner: { ...US.partner!, w9_received_at } })
      expect(r?.status === 409).toBe(holdsW9({ w9_received_at }))
    }
  })

  it('refuses a partner with no email address on the row', () => {
    // DocuSign addresses the recipient by email even when the recipient
    // is embedded, and matches the view request against it. A blank one
    // produces a builder throw several frames later; here it produces an
    // answer, and a log line somebody can act on.
    for (const email of [null, '', '   ']) {
      const r = w9SignRefusal({ ...US, partner: { ...US.partner!, email } })!
      expect(r.status).toBe(409)
      expect(r.message).toContain('Support@shipousa.com')
      expect(r.log).toContain('email')
    }
  })

  it('refuses a foreign entity by naming the form the IRS actually wants', () => {
    const r = w9SignRefusal({
      ...US,
      partner: { ...US.partner!, tax_status: 'foreign_entity' },
    })!
    expect(r.status).toBe(409)
    expect(r.message).toContain('W-8BEN-E')
  })

  it('refuses a foreign individual with the other form', () => {
    const r = w9SignRefusal({
      ...US,
      partner: { ...US.partner!, tax_status: 'foreign_individual' },
    })!
    expect(r.status).toBe(409)
    expect(r.message).toContain('W-8BEN')
    expect(r.message).not.toContain('W-8BEN-E')
  })

  it('refuses an unrecorded tax status without guessing US', () => {
    for (const tax_status of [null, undefined, '', 'something_new']) {
      const r = w9SignRefusal({ ...US, partner: { ...US.partner!, tax_status } })!
      expect(r.status).toBe(409)
    }
  })

  it('tells a foreign partner the wrong-form answer even when nothing is configured', () => {
    // ORDER, AND IT IS LOAD-BEARING. Who a partner is does not depend on
    // whether we have an accountant's address on file. Check configuration
    // first and a foreign partner gets "try again later" forever, while
    // the real answer — we will never send you a W-9 — stays invisible
    // until someone sets an env var it has nothing to do with.
    const r = w9SignRefusal({
      ...US,
      partner: { ...US.partner!, tax_status: 'foreign_entity' },
      accountantEmail: '',
      accountantName: '',
      docusignConfigured: false,
    })!
    expect(r.status).toBe(409)
    expect(r.message).toContain('W-8BEN-E')
  })

  it('refuses with 503 when the accountant address is missing, and says which variable', () => {
    // §2a.5: a W-9 that reaches nobody is the failure. Refusing to send is
    // the only safe answer — the alternative is a tax form sitting in
    // DocuSign that everyone believes the accountant received.
    const r = w9SignRefusal({ ...US, accountantEmail: '' })!
    expect(r.status).toBe(503)
    expect(r.log).toContain('ACCOUNTANT_W9_EMAIL')
  })

  it('refuses with 503 when the accountant has no name', () => {
    const r = w9SignRefusal({ ...US, accountantName: '   ' })!
    expect(r.status).toBe(503)
    expect(r.log).toContain('ACCOUNTANT_W9_NAME')
  })

  it('treats whitespace and undefined configuration as missing', () => {
    for (const accountantEmail of [null, undefined, '', '  ']) {
      expect(w9SignRefusal({ ...US, accountantEmail })!.status).toBe(503)
    }
  })

  it('refuses with 503 when DocuSign itself is not configured', () => {
    const r = w9SignRefusal({ ...US, docusignConfigured: false })!
    expect(r.status).toBe(503)
    expect(r.log).toMatch(/DOCUSIGN/)
  })

  it('never puts the accountant address or a variable name in the partner-facing message', () => {
    // The partner is not the audience for our configuration. Two of these
    // refusals are staff bugs, and the partner's half of a staff bug is a
    // way out of the screen, not a diagnosis.
    const bad = [
      w9SignRefusal({ ...US, accountantEmail: '' })!,
      w9SignRefusal({ ...US, docusignConfigured: false })!,
    ]
    for (const r of bad) {
      expect(r.message).not.toContain('cpa@firm.com')
      expect(r.message).not.toMatch(/ACCOUNTANT_W9|DOCUSIGN|env|process\./i)
      expect(r.message).toContain('Support@shipousa.com')
    }
  })

  it('gives every refusal a way out of the screen', () => {
    // A GATE WITH NO EXIT IS A LOCKOUT, and this gate stands between a
    // partner and money he is owed. Every refusal except the two that are
    // already resolved — no session, W-9 held — must name a human.
    const stuck = [
      w9SignRefusal({ ...US, partner: { ...US.partner!, tax_status: 'foreign_entity' } })!,
      w9SignRefusal({ ...US, partner: { ...US.partner!, tax_status: null } })!,
      w9SignRefusal({ ...US, accountantEmail: '' })!,
      w9SignRefusal({ ...US, docusignConfigured: false })!,
    ]
    for (const r of stuck) expect(r.message).toContain('Support@shipousa.com')
  })

  it('never invites the partner to send a taxpayer number to us', () => {
    // The whole point of signing in DocuSign is that the number never
    // touches our mail, our logs or our database. Copy that says "email us
    // your W-9" undoes that in one sentence, and it is the obvious thing
    // to write when you are trying to be helpful.
    //
    // WHAT THE PATTERNS MEAN. The defect is a sentence that asks the
    // partner to TRANSMIT the form to us, so every pattern requires a
    // marker of that direction — "us", "reply", "attach". An earlier
    // version matched "send your W-9" with no direction at all and failed
    // on "before we can send your W-9", which is us sending it to him:
    // the thing this screen is for. A pattern that cannot tell those
    // apart would be satisfied by deleting the sentence.
    const INBOUND = [
      /email (us )?(your|the) (completed |signed )?(w-9|form|ssn|ein|tin)/i,
      /send us (your|the) (w-9|form|ssn|ein|tin)/i,
      /(reply|respond) with (your|the) (w-9|form|ssn|ein|tin)/i,
      /attach (your|the) (w-9|form)/i,
    ]

    const caught = (s: string) => INBOUND.some((p) => p.test(s))

    // Controls, so a green run means the patterns can still fire.
    expect(caught('Email us your completed W-9 and we will file it.')).toBe(true)
    expect(caught('Please send us the form when you have signed it.')).toBe(true)
    expect(caught('Reply with your EIN and we will do the rest.')).toBe(true)
    expect(caught('before we can send your W-9')).toBe(false)

    const all = [
      w9SignRefusal({ ...US, partner: { ...US.partner!, tax_status: 'foreign_entity' } })!,
      w9SignRefusal({ ...US, partner: { ...US.partner!, tax_status: null } })!,
      w9SignRefusal({ ...US, accountantEmail: '' })!,
      w9SignRefusal({ ...US, docusignConfigured: false })!,
      w9SignRefusal({ ...US, partner: null })!,
    ]
    for (const r of all) expect(caught(r.message)).toBe(false)
    expect(caught(W9_SIGN_FALLBACK)).toBe(false)
  })

  it('logs nothing for the refusals that are nobody’s bug', () => {
    expect(w9SignRefusal({ ...US, partner: null })!.log).toBeNull()
    expect(
      w9SignRefusal({ ...US, partner: { ...US.partner!, w9_received_at: '2026-10-14T00:00:00Z' } })!
        .log,
    ).toBeNull()
  })

  it('logs no taxpayer-identification-shaped value, ever', () => {
    // There is none in the input, and this is the test that keeps it that
    // way when somebody adds the partner's row to the log line for
    // debugging.
    const r = w9SignRefusal({ ...US, accountantEmail: '' })!
    expect(r.log).not.toMatch(/\d{3}-?\d{2}-?\d{4}/)
    expect(r.log).not.toMatch(/\d{2}-?\d{7}/)
  })
})

describe('W9_SIGN_FALLBACK', () => {
  it('is the one sentence the gate shows when signing cannot happen', () => {
    // §2a.9.1. Shared rather than written twice, because the route returns
    // it and the component renders it, and the version a partner acts on
    // must be the version we meant.
    expect(W9_SIGN_FALLBACK).toContain('Support@shipousa.com')
    expect(W9_SIGN_FALLBACK.length).toBeGreaterThan(40)
  })

  it('is what the configuration refusals say', () => {
    expect(w9SignRefusal({ ...US, accountantEmail: '' })!.message).toBe(W9_SIGN_FALLBACK)
    expect(w9SignRefusal({ ...US, docusignConfigured: false })!.message).toBe(W9_SIGN_FALLBACK)
  })
})
