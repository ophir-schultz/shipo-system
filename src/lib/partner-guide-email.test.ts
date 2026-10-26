import { describe, expect, it } from 'vitest'
import { buildPartnerGuideEmail, type GuideCandidate } from './partner-guide-email'

/**
 * The SECOND email a partner ever gets, and the first that is not a
 * credential.
 *
 * src/lib/partner-signin-email.ts is deliberately the ONE message that
 * carries a way in, so that a partner judging "is this really from
 * Shipo" has exactly one shape to recognise. This one therefore must
 * carry NO credential at all — no code, no sign-in token, no magic
 * link. It points at the portal's front door and lets the partner ask
 * for a code there, where the request is theirs rather than ours.
 *
 * It also must not reach a partner who cannot get in. "Here is how to
 * use your dashboard", mailed to somebody the access gate will refuse,
 * reads as a broken product rather than as an unsigned agreement, and
 * the partner has no way to tell those apart from the outside.
 */

const ORIGIN = 'https://partners.shipousa.com'

const signed: GuideCandidate = {
  id: 'p1',
  name: 'Dana Katz',
  email: 'dana@example.com',
  status: 'active',
  agreement_status: 'signed',
}

const unsigned: GuideCandidate = { ...signed, id: 'p2', name: 'Sam Reed', agreement_status: 'sent' }

describe('who the guide may reach', () => {
  it('refuses a partner whose agreement is not signed', () => {
    expect(buildPartnerGuideEmail(unsigned, ORIGIN)).toBeNull()
  })

  it('refuses a partner with no email address', () => {
    expect(buildPartnerGuideEmail({ ...signed, email: '' }, ORIGIN)).toBeNull()
  })

  it('builds for a signed, active partner (control — the refusals above must be the gate, not a dead builder)', () => {
    expect(buildPartnerGuideEmail(signed, ORIGIN)).not.toBeNull()
  })
})

describe('what the guide says', () => {
  const mail = buildPartnerGuideEmail(signed, ORIGIN)!

  it('points at the origin it was given, in both parts', () => {
    expect(mail.html).toContain(ORIGIN)
    expect(mail.text).toContain(ORIGIN)
  })

  it('names the partner', () => {
    expect(mail.html).toContain('Dana')
  })

  it('tells them how to add a client they referred', () => {
    // The exact words on the button in src/components/partner/ClaimForm.tsx.
    // A guide that invents its own label sends the partner looking for
    // a control that is not there.
    expect(mail.html).toContain('Add a client you referred')
  })

  it('says a person reviews each claim, so an unapproved client is not a bug', () => {
    expect(mail.text.toLowerCase()).toMatch(/review/)
  })

  it('carries a plain-text alternative that is not just stripped markup', () => {
    expect(mail.text.length).toBeGreaterThan(200)
    expect(mail.text).not.toContain('<')
  })

  it('has a subject that names Shipo', () => {
    expect(mail.subject).toMatch(/Shipo/)
  })
})

describe('what the guide must never carry', () => {
  const mail = buildPartnerGuideEmail(signed, ORIGIN)!

  /**
   * A six-digit run is what a login code looks like. This is the check
   * that keeps the guide from quietly becoming a second credential
   * email the day somebody "helpfully" inlines a code.
   */
  const SIX_DIGITS = /\b\d{6}\b/

  it('carries no login code', () => {
    expect(SIX_DIGITS.test(mail.html)).toBe(false)
    expect(SIX_DIGITS.test(mail.text)).toBe(false)
  })

  it('carries no sign-in token in a URL', () => {
    expect(mail.html).not.toMatch(/[?&](token|code|t)=/)
    expect(mail.text).not.toMatch(/[?&](token|code|t)=/)
  })

  it('would catch a code if one were there (control)', () => {
    // Without this, the two checks above pass just as happily over an
    // empty string, and a builder that returned "" would look safe.
    expect(SIX_DIGITS.test('Your code is 481902')).toBe(true)
  })

  /**
   * No square brackets anywhere a reader can see them.
   *
   * Bracketed subject tags — "[Copy of ...]", "[Reminder]", "[Action
   * required]" — are a spam-filter signal and, worse, a reader signal:
   * they read as bulk mail, which is the opposite of what an
   * onboarding message needs to look like. The HTML is checked with
   * tags stripped first, so markup and attributes are not mistaken for
   * visible copy.
   */
  it('shows no square brackets, which read as bulk mail', () => {
    const visible = mail.html.replace(/<[^>]*>/g, ' ')
    expect(/[[\]]/.test(mail.subject), `brackets in subject: ${mail.subject}`).toBe(false)
    expect(/[[\]]/.test(mail.text)).toBe(false)
    expect(/[[\]]/.test(visible)).toBe(false)
  })

  it('would catch a bracketed subject (control)', () => {
    expect(/[[\]]/.test('[Reminder] Your dashboard')).toBe(true)
  })

  it('shows no rate card, per-unit price or per-order cost', () => {
    const banned = [/per[- ]unit/i, /rate card/i, /cost_labour/i, /per[- ]order cost/i]
    for (const re of banned) {
      expect(re.test(mail.html), `${re} appears in the guide`).toBe(false)
      expect(re.test(mail.text), `${re} appears in the guide`).toBe(false)
    }
  })

  it('names no other partner and no client', () => {
    for (const name of ['Jimi', 'MileMogul', 'Hulya', 'TAHIDEM', 'Suteka', 'Orcam', 'SitnStand']) {
      expect(mail.html).not.toContain(name)
    }
  })
})

describe('it looks like Shipo', () => {
  const mail = buildPartnerGuideEmail(signed, ORIGIN)!

  it('uses the navy bar and the lime rule, as literal hexes', () => {
    // Literal, not a CSS variable: mail clients do not resolve
    // var(--brand-ink), and a guide that silently lost its colours is
    // exactly the kind of thing nobody reports.
    expect(mail.html).toContain('#0b3361')
    expect(mail.html).toContain('#e0ee47')
    expect(mail.html).not.toContain('var(--brand')
  })

  it('loads the logo over an absolute https URL', () => {
    // A mail client has no origin to resolve "/shipo-logo.png" against,
    // so a root-relative src renders as a broken image everywhere.
    expect(mail.html).toMatch(/<img[^>]+src="https:\/\/[^"]+shipo-logo\.png"/)
  })

  it('sets the wordmark bold', () => {
    expect(mail.html).toMatch(/font-weight:\s*(700|bold)/)
  })

  it('uses inline styles rather than a stylesheet', () => {
    // Gmail strips <style> blocks in several of its clients.
    expect(mail.html).not.toContain('<style')
  })
})

/**
 * MOJIBAKE. Caught by rendering the thing and looking at it, after
 * sixteen green tests that all passed over it.
 *
 * The body contained literal em dashes and curly quotes and the
 * document declared no character set, so a client that guesses
 * Latin-1 — which several do — renders "—" as "â€" and "" as "â€œ".
 * Every assertion above still passed, because they all search the
 * SOURCE string, where the characters are perfectly correct. The
 * damage happens in the reader's client, which no string check here
 * can see.
 *
 * Two defences, because either alone is thin: declare the charset,
 * AND emit nothing outside ASCII so there is nothing to misdecode
 * even when a client ignores the declaration. The second is the one
 * that holds for a partner whose NAME is not ASCII, which is why the
 * escaping has to cover interpolated values and not just the template.
 */
describe('it survives a client that guesses the character set', () => {
  const mail = buildPartnerGuideEmail(signed, ORIGIN)!

  it('declares utf-8', () => {
    expect(mail.html).toMatch(/<meta[^>]+charset=["']?utf-8/i)
  })

  it('emits no character outside ASCII', () => {
    const offenders = [...mail.html].filter((c) => c.charCodeAt(0) > 127)
    expect(offenders.join(''), 'non-ASCII in the HTML body').toBe('')
  })

  it('escapes a non-ASCII partner name rather than passing it through', () => {
    const turkish = buildPartnerGuideEmail({ ...signed, name: 'Hülya Çelik' }, ORIGIN)!
    expect([...turkish.html].filter((c) => c.charCodeAt(0) > 127).join('')).toBe('')
    // and the name is still THERE, as entities — not silently dropped
    expect(turkish.html).toMatch(/H&#252;lya|H&#xfc;lya/i)
  })

  it('would notice a stray em dash (control)', () => {
    // Without this, the ASCII check passes just as happily over an
    // empty string or a builder that stopped emitting a body.
    expect([...'a — b'].filter((c) => c.charCodeAt(0) > 127).join('')).toBe('—')
  })

  it('keeps the subject ASCII too, so no client has to decode it', () => {
    expect([...mail.subject].filter((c) => c.charCodeAt(0) > 127).join('')).toBe('')
  })
})
