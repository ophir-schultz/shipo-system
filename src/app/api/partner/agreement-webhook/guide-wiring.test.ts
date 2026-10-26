import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Four facts about how the portal guide is wired into the completion
 * webhook. None is visible to a test of the guide builder, because all
 * four are properties of WHERE and HOW the call is written.
 *
 * 1. IT HAPPENS AT ALL. A guide nobody sends is a guide nobody reads,
 *    and the failure is silent: the partner signs, gets a credential,
 *    and is never told what the thing he just got access to does.
 *
 * 2. AFTER THE SIGN-IN EMAIL. The credential is the useful one; the
 *    guide explains what it opens. Reversed, the partner reads about a
 *    dashboard he has no way into yet, and the explanation arrives
 *    before the thing it explains.
 *
 * 3. INSIDE `decision.invites`. That flag is the moment of entitlement
 *    — agreement completed, not a W-9 completion from a partner who is
 *    already signed in and already knows what the portal is.
 *
 * 4. THE ORIGIN COMES FROM CONFIG, NOT THE REQUEST. This is the one
 *    that would actually hurt. The guide carries no credential, so the
 *    reflex is to relax about where it points — but it prints a link
 *    and asks the partner to enter their email there and expect a code.
 *    A forged `Origin:` or `Host:` on a webhook POST (which arrives
 *    from DocuSign, never from the partner) would turn Shipo's own
 *    onboarding mail into a working phishing page, delivered with
 *    Shipo's branding to exactly the people most likely to trust it.
 *    signInLinkOrigin() reads the environment, which an attacker who
 *    can POST to this route cannot set.
 *
 * Read off the SOURCE, with comments stripped first. The prose above
 * names every symbol being asserted on, so an unstripped grep would be
 * satisfied by this very docblock.
 */

const SRC = join(__dirname, 'route.ts')

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

describe('portal guide is wired into the completion webhook', () => {
  const code = stripComments(readFileSync(SRC, 'utf8'))

  it('sends the guide', () => {
    expect(code).toMatch(/sendPartnerGuide\s*\(/)
  })

  it('sends it after the sign-in email, not before', () => {
    const invite = code.indexOf('sendSignInEmail(')
    const guide = code.indexOf('sendPartnerGuide(')

    expect(invite).toBeGreaterThan(-1)
    expect(guide).toBeGreaterThan(-1)
    expect(guide).toBeGreaterThan(invite)
  })

  it('sends it only at the moment of entitlement', () => {
    const invites = code.indexOf('decision.invites')
    const guide = code.indexOf('sendPartnerGuide(')

    expect(invites).toBeGreaterThan(-1)
    expect(guide).toBeGreaterThan(invites)
  })

  it('never takes the portal origin from the request', () => {
    // Any of these would let the POSTer choose where the partner is
    // sent. The webhook's caller is DocuSign, so none of them is a
    // trustworthy source for a link we are about to mail.
    expect(code).not.toMatch(/headers\s*\.\s*get\s*\(\s*['"](origin|host|x-forwarded-host)['"]/i)
    expect(code).not.toMatch(/req\.(url|nextUrl)\b[^\n]*origin/i)
  })

  // ---- controls: each detector must be able to report a problem ----

  it('strips a comment that names the call (control)', () => {
    // Without stripping, the docblock at the top of this file — and the
    // one above the call in the route — would satisfy every assertion
    // above on their own.
    expect(stripComments('// calls sendPartnerGuide( here\nconst x = 1')).not.toMatch(
      /sendPartnerGuide/,
    )
  })

  it('would catch an origin read off the request (control)', () => {
    const bad = "const o = req.headers.get('origin')"
    expect(bad).toMatch(/headers\s*\.\s*get\s*\(\s*['"](origin|host|x-forwarded-host)['"]/i)
  })

  it('reads a route that is not empty (control)', () => {
    // An unreadable or truncated file would make the two "not.toMatch"
    // assertions above pass for the wrong reason.
    expect(code.length).toBeGreaterThan(2000)
    expect(code).toMatch(/export async function POST/)
  })
})
