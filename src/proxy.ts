import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

/**
 * The portal's session cookie, spelled here because middleware must not
 * import partner-auth.ts — that module reaches for supabaseAdmin and the
 * service-role key, which has no business in the edge runtime.
 * src/lib/partner-landing.test.ts compares the two spellings.
 */
export const PARTNER_SESSION_COOKIE = 'shipo_partner_session'

/**
 * Where to send someone who is carrying a partner session, or null to
 * leave the staff guard to it.
 *
 * `/` used to fall through to the staff guard and redirect to /login —
 * the operations system's sign-in — even for a browser holding a valid
 * partner session. A partner who trimmed the URL or used a root bookmark
 * landed on Shipo's internal login screen. Nothing was exposed (every
 * staff route refuses a partner cookie, verified against production), but
 * the wrong door looks exactly like an open one.
 *
 * ONLY the root. A partner who asks for /clients still meets the staff
 * login: redirecting him to his statement would imply that URL means
 * something for him, and it does not.
 */
export const PARTNER_HOST = 'partners.shipousa.com'

/**
 * True when this request arrived on the partner hostname.
 *
 * Compared against the host with any port stripped, and as a WHOLE name
 * rather than a suffix: `endsWith(PARTNER_HOST)` would also match
 * partners.shipousa.com.evil.example, which is a domain an attacker can
 * register. The port matters because a local build and a preview both
 * carry one, and a host check that quietly stops matching is a redirect
 * that quietly stops happening.
 */
function isPartnerHost(host: string | null | undefined): boolean {
  if (!host) return false
  return host.split(':')[0].toLowerCase() === PARTNER_HOST
}

export function partnerLandingFor(
  pathname: string,
  hasPartnerCookie: boolean,
  host?: string | null
): string | null {
  if (pathname !== '/') return null
  // The hostname is itself the signal: partners.shipousa.com exists so a
  // partner never meets an ops URL, and serving Shipo's internal login at
  // its root defeats the whole point of the domain. No cookie needed —
  // anyone arriving there is a partner by construction, and a signed-out
  // one lands at /partner, which redirects him to /partner/login.
  return isPartnerHost(host) || hasPartnerCookie ? '/partner' : null
}

export async function proxy(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  const { data: { user } } = await supabase.auth.getUser()

  const { pathname } = request.nextUrl

  if (!user && pathname !== '/login') {
    // A partner at the front door goes to his own front door, not Shipo's.
    // Checked before the staff redirect, and only for the root.
    const partnerTarget = partnerLandingFor(
      pathname,
      request.cookies.has(PARTNER_SESSION_COOKIE),
      request.headers.get('host')
    )
    if (partnerTarget) return NextResponse.redirect(new URL(partnerTarget, request.url))

    return NextResponse.redirect(new URL('/login', request.url))
  }

  if (user && pathname === '/login') {
    // Check MFA — if MFA enrolled and not at AAL2, send back to login (client handles MFA step)
    const { data: aalData } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
    if (aalData?.nextLevel === 'aal2' && aalData.nextLevel !== aalData.currentLevel) {
      // Still needs MFA — let login page handle it
      return supabaseResponse
    }
    return NextResponse.redirect(new URL('/dashboard', request.url))
  }

  // Enforce MFA for authenticated users who have it enrolled but haven't completed it
  if (user && pathname !== '/login') {
    const { data: aalData } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
    if (aalData?.nextLevel === 'aal2' && aalData.nextLevel !== aalData.currentLevel) {
      return NextResponse.redirect(new URL('/login', request.url))
    }
  }

  return supabaseResponse
}

// `api/` is excluded because this proxy answers an unauthenticated
// request with a 307 to /login, which is the right answer for a page
// and the wrong one for a fetch() — the browser follows the redirect
// and the caller gets an HTML login page with status 200 instead of an
// error it can act on. Several routes under api/ also have to stay
// open to strangers: the chat widget, the partner portal's own login,
// and the referral intake webhook.
//
// The consequence is that NOTHING under src/app/api is authenticated by
// this file. Every staff-only handler calls requireStaff() itself — see
// src/lib/require-staff.ts. Adding a route under api/ without that call
// publishes it to the internet. Do not "fix" this by deleting `api/`
// from the matcher; that breaks the public routes silently.
//
// `partner` is excluded on purpose. The referral-partner portal has
// its own login (email + 6-digit code) and its own session cookie,
// checked in src/lib/partner-auth.ts. Partners are deliberately NOT
// Supabase Auth users, so they can never satisfy the staff check
// above — and without this exclusion they would be bounced to the
// staff /login screen instead of reaching /partner/login.
//
// Listed twice as `partner$|partner/` — not once as `partner/` — so
// the bare /partner path is excluded too, since /partner is the
// statement page itself. It has to be two alternatives rather than a
// group: Next rejects capturing groups in a matcher, and a
// non-capturing group here is not worth the subtlety.
//
// `chat.js` is excluded because it is the website chat widget, loaded
// by a <script> tag on shipousa.com by anonymous visitors. Without the
// exclusion this file 307s to /login and the widget never appears —
// with no error anywhere, because a redirected script just doesn't run.
// Any future file in public/ that the outside world has to fetch needs
// the same treatment.
//
// `rate-sheets/` is the prospect-facing pricing sheet. Note it is
// written WITHOUT the `rate-sheets$` alternative that `partner` has,
// and that asymmetry is the whole point:
//
//   /rate-sheets/<slug>/<id>/<token>  → excluded, public, no login
//   /rate-sheets                      → NOT excluded, still staff-only
//
// So a deep link opens for a prospect, while anyone who trims the URL
// back to the bare path lands on /login instead of an index of every
// quote we have ever sent. Authorisation for the deep link is the
// token itself, checked in getSheetByToken() — a wrong token 404s.
// The staff screen that creates these lives at /quotes, deliberately
// outside this segment so it can never inherit the exclusion.
export const config = {
  matcher: [
    // shipo-logo.png is the PARTNER header's asset and must be excluded
    // for the same reason /partner is: a partner has no staff session, so
    // a guarded asset answers 307 to /login and the browser renders a
    // broken image. That is what shipped — /shipo-logo.svg was guarded
    // and every partner saw a broken logo, because the brand tests asked
    // whether the layout referenced the file, never whether anyone could
    // fetch it. src/lib/partner-public-assets.test.ts now compares this
    // list against the assets the partner layout actually requests.
    // shipo-logo.jpg stays: it is the staff login and sidebar mark.
    '/((?!_next/static|_next/image|favicon.ico|shipo-logo.jpg|shipo-logo.svg|shipo-logo-white.png|shipo-logo.png|chat.js|api/|partner$|partner/|rate-sheets/).*)',
  ],
}
