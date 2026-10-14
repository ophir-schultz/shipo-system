import { cookies } from 'next/headers'
import { supabaseAdmin } from '@/lib/supabase'
import { canAccessPortal } from '@/lib/partner-access'

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
  // Carried because getPartnerFromSession gates on it. A partner holding
  // a session has necessarily signed, so this always reads 'signed'
  // downstream — it is here so the field the gate reads is part of the
  // type, rather than selected by a query nothing declares.
  agreement_status: string | null
  // Carried for §4.4: the partner's own account panel states WHEN he
  // signed. Same select, no second query. Absent from the select it
  // arrives as undefined, which the panel renders as "—" — telling the
  // one person who did sign that we have no record of it.
  agreement_signed_at: string | null
  // Carried for the W-9 gate on /partner (spec §2.1), which runs after the
  // disclaimer and before the statement. One more column on a select the
  // session already performs, NOT a second query: the gate is asked on
  // every page load, and a separate read would double the round trips on
  // the hot path to save nothing.
  w9_received_at: string | null
  // Carried for §2a.7: the W-9 envelope the dashboard offers is the wrong
  // IRS form for a non-US person, so the screen that offers it has to know.
  // Typed loose because it comes straight off the row; partner-tax-status.ts
  // narrows it, and null — the state every existing row is in — is a refusal,
  // not a US person.
  tax_status: string | null
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
 * partner who no longer passes the portal gate — inactive, or an
 * agreement since declined or voided.
 *
 * The gate is re-asked on EVERY request rather than trusted from login.
 * A session lasts SESSION_DAYS, so checking only at the door would mean
 * a partner whose agreement is voided on day 2 keeps reading their
 * statement until day 30. The cheap read is worth it: this is the
 * difference between revoking access and asking someone to log out.
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
    // prettier-ignore
    .select('id, name, company, email, status, agreement_status, agreement_signed_at, w9_received_at, tax_status')
    .eq('id', session.referral_partner_id)
    .maybeSingle()

  if (!partner) return null

  // Deactivating a partner in the Referrals screen, or a DocuSign void,
  // kills their access immediately — no need to hunt down sessions.
  //
  // Same function the login routes ask, so there is exactly one answer
  // to "may this person see a statement". No reason is returned here:
  // this is a cookie being read on a page load, not someone typing a
  // code, and the caller's only sensible response is to show the login
  // screen, where requesting a code produces the explanation.
  if (!canAccessPortal(partner)) return null

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
