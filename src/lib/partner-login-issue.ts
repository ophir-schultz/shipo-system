import { LINK_TTL_DAYS } from './partner-login-link'

// Issuing the sign-in link. Spec §2.1.
//
// ============================================================
// This file holds the two decisions that have nothing to do with
// transport, so they can be tested without one: WHEN a failed insert
// is the missing migration rather than a real failure, and WHAT the
// email says about the link.
//
// The database work itself stays in request-code, where the rest of
// the issuance already lives — one insert, one place to forget
// `is null` on consumed_at.
// ============================================================

/**
 * Is this insert failure the hand-applied migration not having run?
 *
 * supabase/partner_login_link.sql is applied by a human in the
 * Supabase SQL editor, and nothing sequences it against a deploy. So
 * the code that writes link_token_hash can reach production before the
 * column exists — and request-code is the live front door for every
 * partner. PostgREST answers a write naming an unknown column with
 * 42703 (undefined_column), or with a schema-cache message and no code
 * at all, so a route that treated either as fatal would turn "the
 * migration is a day late" into "no partner can log in".
 *
 * NARROW ON PURPOSE. A unique violation, a dropped connection or an
 * RLS refusal are real failures that must surface: retrying code-only
 * on those would hand a partner a working login built on a database
 * that is misbehaving, and hide the reason. The match is on the two
 * column names this migration adds, never on the word "link", which
 * appears in plenty of unrelated prose.
 */
export function isMissingLinkColumn(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const { code, message } = error as { code?: unknown; message?: unknown }

  if (code === '42703') return true
  if (typeof message !== 'string') return false

  return /link_token_hash|link_expires_at/.test(message)
}

/**
 * Where a sign-in link may point, from server-side configuration only.
 *
 * TAKES NO ARGUMENT, AND THAT IS THE SECURITY PROPERTY.
 *
 * src/lib/partner-invite.ts resolves its base as
 * `NEXT_PUBLIC_SITE_URL ?? origin ?? VERCEL_PROJECT_PRODUCTION_URL`,
 * where `origin` is a request header. That is correct there, because the
 * invite email "carries the portal address and nothing else" — a forged
 * origin yields a useless link to a stranger's site.
 *
 * This email carries a CREDENTIAL. A request arriving with
 * `Origin: https://evil.example` would otherwise make Shipo email the
 * real partner a real single-use token pointed at an attacker's host,
 * and the attacker would need no reply: the partner's own click delivers
 * it. So the origin here comes from config, and the arity is the
 * enforcement — there is no parameter to pass a header into.
 *
 * VERCEL_PROJECT_PRODUCTION_URL is injected by the platform (host only,
 * no scheme) and is kept as a fallback for the reason partner-invite
 * records: with no env var set, the link would be silently ABSENT from
 * every login email, and a degradation nobody can see is worse than one
 * that announces itself.
 *
 * Null rather than a guess. signInLinkUrl refuses null, the email omits
 * the link, and the 6-digit code in the same message still works.
 */
export function signInLinkOrigin(): string | null {
  const configured = process.env.NEXT_PUBLIC_SITE_URL
  if (configured) return configured

  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL
  return vercel ? `https://${vercel}` : null
}

/**
 * The two lines the login email carries, or two empty strings.
 *
 * Empty and not undefined so the caller can concatenate
 * unconditionally: a missing link must not leave a dangling heading or
 * an empty paragraph in the body.
 *
 * WHAT THIS DELIBERATELY DOES NOT SAY. Not "no code needed", not
 * "instead of the code". The code in the same email is the fallback for
 * every way a link can fail — a scanner that mangles it, a client that
 * wraps it across a line, seven days of an unread inbox — and a partner
 * who was told the code was redundant, and then meets a dead link, has
 * been told the only remaining way in does not apply to him.
 *
 * The URL is shown as well as linked. A label reading "click here" is
 * unverifiable by the person being asked to click it, and this is an
 * email about access to his earnings; a visible shipousa.com href is
 * what lets him check before he trusts it.
 */
export function loginLinkLines(url: string | null): { text: string; html: string } {
  if (!url) return { text: '', html: '' }

  return {
    text:
      `Or open your statement directly:\n${url}\n\n` +
      `That link works for 7 days and can be used once.\n\n`,
    html:
      `<p style="margin:0 0 8px">Or open your statement directly:</p>` +
      `<p style="margin:0 0 16px;word-break:break-all">` +
      `<a href="${url}" style="color:#1a73e8">${url}</a></p>` +
      `<p style="margin:0 0 24px;color:#555">That link works for ${LINK_TTL_DAYS} days and can be used once.</p>`,
  }
}
