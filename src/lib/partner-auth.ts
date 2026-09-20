import { cookies } from 'next/headers'
import { supabaseAdmin } from '@/lib/supabase'

// ============================================================
// Partner portal authentication — email + 6-digit code.
//
// Partners are deliberately NOT Supabase Auth users. `src/proxy.ts`
// authorises staff pages on "is there a Supabase session", so a
// partner holding a Supabase user would be handed /dashboard,
// /clients and /billing. This is a completely separate session
// mechanism that can never satisfy that check.
//
// Nothing here is stored in the clear. The 6-digit code and the
// session token are only ever written to the database as SHA-256
// hashes, so a leaked row cannot be replayed as a login.
//
// Never log or print a code or a session token.
// ============================================================

export const SESSION_COOKIE = 'shipo_partner_session'
export const CODE_TTL_MINUTES = 10
export const SESSION_DAYS = 30
export const MAX_CODE_ATTEMPTS = 5
export const MAX_CODES_PER_WINDOW = 5
export const RATE_WINDOW_MINUTES = 15

export interface SessionPartner {
  id: string
  name: string
  company: string | null
  email: string | null
  status: string | null
}

/** SHA-256, lowercase hex. Used for both codes and session tokens. */
export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * A 6-digit code, uniformly distributed over 000000-999999.
 * Rejection sampling — `% 1000000` on a 32-bit draw would bias the
 * low codes slightly.
 */
export function generateCode(): string {
  const buf = new Uint32Array(1)
  const limit = Math.floor(0xffffffff / 1000000) * 1000000
  let n: number
  do {
    crypto.getRandomValues(buf)
    n = buf[0]
  } while (n >= limit)
  return String(n % 1000000).padStart(6, '0')
}

/** 24 random bytes as base64url — the value that goes in the cookie. */
export function generateSessionToken(): string {
  const bytes = new Uint8Array(24)
  crypto.getRandomValues(bytes)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * Constant-time string comparison. Both arguments here are hex
 * digests of the same length, so an early-exit `===` would leak
 * timing about how many leading characters matched.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export function normalizeEmail(email: unknown): string {
  return typeof email === 'string' ? email.trim().toLowerCase() : ''
}

export function isEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)
}

/**
 * Resolve the current partner from the session cookie.
 * Returns null for: no cookie, unknown token, revoked, expired, or a
 * partner who has since been marked inactive.
 *
 * Safe to call from a Server Component — it only reads the cookie.
 */
export async function getPartnerFromSession(): Promise<SessionPartner | null> {
  const jar = await cookies()
  const raw = jar.get(SESSION_COOKIE)?.value
  if (!raw) return null

  const tokenHash = await sha256Hex(raw)

  const { data: session, error } = await supabaseAdmin
    .from('partner_sessions')
    .select('id, referral_partner_id, expires_at, revoked_at')
    .eq('token_hash', tokenHash)
    .maybeSingle()

  if (error || !session) return null
  if (session.revoked_at) return null
  if (new Date(session.expires_at).getTime() <= Date.now()) return null

  const { data: partner } = await supabaseAdmin
    .from('referral_partners')
    .select('id, name, company, email, status')
    .eq('id', session.referral_partner_id)
    .maybeSingle()

  if (!partner) return null
  // Deactivating a partner in the Referrals screen kills their access
  // immediately — no need to hunt down their sessions.
  if (partner.status === 'inactive') return null

  // Touch, but never block the request on it.
  const now = new Date().toISOString()
  void supabaseAdmin
    .from('partner_sessions')
    .update({ last_seen_at: now })
    .eq('id', session.id)
    .then(() => undefined, () => undefined)
  void supabaseAdmin
    .from('referral_partners')
    .update({ portal_last_seen_at: now })
    .eq('id', partner.id)
    .then(() => undefined, () => undefined)

  return partner as SessionPartner
}
