import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

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
    '/((?!_next/static|_next/image|favicon.ico|shipo-logo.jpg|chat.js|api/|partner$|partner/|rate-sheets/).*)',
  ],
}
