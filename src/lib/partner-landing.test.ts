import { describe, expect, it } from 'vitest'
import { PARTNER_SESSION_COOKIE, partnerLandingFor } from '../proxy'
import { SESSION_COOKIE } from './partner-auth'

/**
 * Where the front door sends a partner.
 *
 * THE PORTAL WAS CORRECT AND THE ROOT WAS NOT. /partner redirects a
 * signed-out visitor to /partner/login, which is right. But `/` fell
 * through to the staff guard and redirected to /login — the operations
 * system's sign-in — and it did so even for a browser carrying a valid
 * partner session. So a partner who trimmed the URL, typed the bare
 * domain or used a root bookmark landed on Shipo's internal login screen
 * and reasonably concluded the portal had dumped him in the ops system.
 *
 * Nothing was exposed: every staff route refuses a partner cookie (307 to
 * /login, 401 on the staff API, verified against production). It was the
 * wrong door, not an open one. But "the wrong door looks exactly like a
 * breach" is a good enough reason to fix it.
 *
 * Deliberately narrow: only `/`. A partner who asks for /clients still
 * meets the staff login, because that is a screen he has no business on
 * and a redirect would imply otherwise.
 */

describe('the front door', () => {
  it('sends a partner session at the root to the portal', () => {
    expect(partnerLandingFor('/', true)).toBe('/partner')
  })

  // THE PARTNER HOSTNAME IS ITSELF THE SIGNAL. partners.shipousa.com
  // exists so a partner never meets an ops URL; serving him Shipo's
  // internal login at its root defeats the entire point of the domain,
  // and on a host called "partners" it reads worse than the shared
  // hostname did. No cookie is required: anyone arriving there is a
  // partner by construction, and a signed-out one belongs at
  // /partner/login, which /partner already redirects to.
  it('sends everyone at the partner host to the portal, cookie or not', () => {
    expect(partnerLandingFor('/', false, 'partners.shipousa.com')).toBe('/partner')
    expect(partnerLandingFor('/', true, 'partners.shipousa.com')).toBe('/partner')
  })

  it('ignores the port when matching the host', () => {
    // Vercel passes host with no port, but a local build and a preview
    // both can carry one, and a host check that misses is a redirect
    // that silently stops happening.
    expect(partnerLandingFor('/', false, 'partners.shipousa.com:3000')).toBe('/partner')
  })

  it('is not fooled by a lookalike host', () => {
    // endsWith on the bare name would match
    // partners.shipousa.com.evil.example.
    expect(partnerLandingFor('/', false, 'partners.shipousa.com.evil.example')).toBeNull()
    expect(partnerLandingFor('/', false, 'notpartners.shipousa.com')).toBeNull()
  })

  it('still leaves staff screens alone on the partner host', () => {
    // The host decides the ROOT only. A staff URL is still a staff URL.
    expect(partnerLandingFor('/clients', false, 'partners.shipousa.com')).toBeNull()
  })

  it('leaves the root alone when there is no partner cookie', () => {
    // A staff member, or a stranger. The staff guard handles both.
    expect(partnerLandingFor('/', false)).toBeNull()
  })

  it('does not rescue a partner from a staff screen', () => {
    // Redirecting /clients to /partner would tell a partner that URL
    // means something for him. It does not, and the staff login saying so
    // is the honest answer.
    for (const path of ['/clients', '/pnl', '/referrals', '/adjustments']) {
      expect(partnerLandingFor(path, true), path).toBeNull()
    }
  })

  it('leaves the portal’s own routes to the portal', () => {
    // These never reach the staff guard anyway — proxy's matcher excludes
    // them — but a redirect here would loop.
    for (const path of ['/partner', '/partner/login', '/partner/signin']) {
      expect(partnerLandingFor(path, true), path).toBeNull()
    }
  })

  // The cookie name is written twice: once in partner-auth.ts, where the
  // portal sets and reads it, and once in proxy.ts, which runs in the
  // middleware and must not import server-only code to learn it. Two
  // spellings of one name is how a rename half-lands, so they are
  // compared here rather than trusted.
  it('uses the same cookie name the portal actually sets', () => {
    expect(PARTNER_SESSION_COOKIE).toBe(SESSION_COOKIE)
  })
})
