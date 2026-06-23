import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase-server'
import { supabaseAdmin } from '@/lib/supabase'
import { sendEmail } from '@/lib/email'

const MAX_ATTEMPTS = 5
const LOCK_MINUTES = 15

function clientIp(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for')
  if (fwd) return fwd.split(',')[0].trim()
  return req.headers.get('x-real-ip') ?? 'unknown'
}

export async function POST(req: Request) {
  const { email, password, captchaToken } = await req.json().catch(() => ({}))

  if (!email || !password) {
    return NextResponse.json({ error: 'Email and password are required.' }, { status: 400 })
  }

  const normalizedEmail = String(email).toLowerCase().trim()
  const ip = clientIp(req)
  const now = Date.now()

  // 1. Check existing lockout state (service-role bypasses RLS)
  const { data: attempt } = await supabaseAdmin
    .from('login_attempts')
    .select('failed_count, locked_until')
    .eq('email', normalizedEmail)
    .maybeSingle()

  if (attempt?.locked_until) {
    const lockedUntil = new Date(attempt.locked_until).getTime()
    if (lockedUntil > now) {
      const secondsRemaining = Math.ceil((lockedUntil - now) / 1000)
      return NextResponse.json(
        { error: 'Account temporarily locked due to too many failed attempts.', lockedUntil: attempt.locked_until, secondsRemaining },
        { status: 423 }
      )
    }
  }

  // 2. Attempt the actual sign-in (server client sets session cookies on success)
  const supabase = await createClient()
  const { error: signInError } = await supabase.auth.signInWithPassword({
    email: normalizedEmail,
    password,
    options: captchaToken ? { captchaToken } : undefined,
  })

  // 3a. Failure → increment counter, lock + alert at threshold
  if (signInError) {
    const newCount = (attempt?.failed_count ?? 0) + 1
    const willLock = newCount >= MAX_ATTEMPTS
    const lockedUntilIso = willLock ? new Date(now + LOCK_MINUTES * 60 * 1000).toISOString() : null

    await supabaseAdmin.from('login_attempts').upsert({
      email: normalizedEmail,
      failed_count: willLock ? 0 : newCount, // reset counter once locked; lock itself is the gate
      locked_until: lockedUntilIso,
      last_attempt: new Date(now).toISOString(),
      last_ip: ip,
      updated_at: new Date(now).toISOString(),
    })

    if (willLock) {
      const alertTo = process.env.ALERT_EMAIL || 'ophir@shipousa.com'
      const when = new Date(now).toLocaleString('en-US', { timeZone: 'America/New_York' })
      sendEmail({
        to: alertTo,
        subject: '🔒 Shipo login locked — 5 failed attempts',
        text: `The account "${normalizedEmail}" was locked for ${LOCK_MINUTES} minutes after ${MAX_ATTEMPTS} failed login attempts.\n\nTime: ${when} ET\nIP address: ${ip}\n\nIf this wasn't you or a teammate, consider resetting the password.`,
        html: `
          <div style="font-family: -apple-system, Segoe UI, sans-serif; max-width: 480px;">
            <h2 style="color:#b91c1c;margin-bottom:4px;">🔒 Login Locked</h2>
            <p style="color:#374151;">An account on the Shipo Operations Platform was locked after <strong>${MAX_ATTEMPTS} failed login attempts</strong>.</p>
            <table style="font-size:14px;color:#374151;border-collapse:collapse;">
              <tr><td style="padding:4px 12px 4px 0;color:#6b7280;">Account</td><td><strong>${normalizedEmail}</strong></td></tr>
              <tr><td style="padding:4px 12px 4px 0;color:#6b7280;">Locked for</td><td>${LOCK_MINUTES} minutes</td></tr>
              <tr><td style="padding:4px 12px 4px 0;color:#6b7280;">Time</td><td>${when} ET</td></tr>
              <tr><td style="padding:4px 12px 4px 0;color:#6b7280;">IP address</td><td>${ip}</td></tr>
            </table>
            <p style="color:#6b7280;font-size:13px;margin-top:16px;">If this wasn't you or a teammate, consider resetting the password.</p>
          </div>`,
      }).catch(() => {}) // never let email failure affect the response

      return NextResponse.json(
        { error: 'Account temporarily locked due to too many failed attempts.', lockedUntil: lockedUntilIso, secondsRemaining: LOCK_MINUTES * 60 },
        { status: 423 }
      )
    }

    return NextResponse.json(
      { error: 'Invalid email or password.', attemptsRemaining: MAX_ATTEMPTS - newCount },
      { status: 401 }
    )
  }

  // 3b. Success → clear any failed-attempt record
  await supabaseAdmin.from('login_attempts').delete().eq('email', normalizedEmail)

  return NextResponse.json({ success: true })
}
