import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase-server'

// ============================================================
// Staff guard for route handlers.
//
// src/proxy.ts excludes `api/` from its matcher, so NOTHING under
// src/app/api is authenticated by the proxy. Every handler that
// touches internal data has to check for itself, and this is that
// check.
//
// Use it as the first line of any staff-only handler:
//
//   const denied = await requireStaff()
//   if (denied) return denied
//
// It reads the Supabase session from the request cookies, which is
// the same session the proxy checks for pages, so a signed-in
// employee passes and everyone else gets a 401.
// ============================================================

export async function requireStaff(): Promise<NextResponse | null> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Not authorised.' }, { status: 401 })
  }

  return null
}

/**
 * For a route with two legitimate callers: a signed-in employee in the
 * browser, and a scheduled job that has no session at all.
 *
 * Passes if EITHER the request carries `Authorization: Bearer <secret>`
 * matching CRON_SECRET (the name Vercel itself uses) or the older
 * MONITOR_SECRET, OR there is a normal staff session.
 *
 * If neither variable is set the bearer branch is skipped entirely and
 * this collapses to requireStaff() — so an unconfigured deployment
 * fails CLOSED. That is deliberate: the previous `if (SECRET)` pattern
 * failed OPEN, which left the route anonymous whenever the variable was
 * missing, which it currently is. The console.error below exists so the
 * reason shows up in the Vercel logs rather than as a silent 401.
 */
export async function requireStaffOrCron(req: Request): Promise<NextResponse | null> {
  const secret = process.env.CRON_SECRET || process.env.MONITOR_SECRET

  if (secret) {
    const auth = req.headers.get('authorization') ?? ''
    if (auth === `Bearer ${secret}`) return null
  }

  const denied = await requireStaff()

  if (denied && !secret) {
    console.error(
      '[require-staff] Rejected an unauthenticated request and no CRON_SECRET ' +
        'is configured. If this was the Vercel cron, set CRON_SECRET in the ' +
        'project environment variables — otherwise the scheduled run cannot ' +
        'authenticate and will keep failing.',
    )
  }

  return denied
}

/** The signed-in employee's email, or null. Used to stamp `prepared_by`. */
export async function staffEmail(): Promise<string | null> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  return user?.email ?? null
}
