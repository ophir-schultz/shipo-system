// Turning a request into a storable terms-acceptance row.
//
// Separate from partner-terms.ts (which is the TEXT and the version) because
// this file is about the request, and from the route (which is the control)
// because `vitest.config.ts` has `include: ['src/**/*.test.ts']` and a route
// handler cannot be covered.
//
// See supabase/partner_terms_acceptances.sql: `ip` and `user_agent` are
// EVIDENCE, NOT TELEMETRY. They exist so an acceptance can be tied to a
// request if it is ever disputed. Never infer a location from the ip.

import { PARTNER_TERMS_VERSION } from './partner-terms'

/**
 * Matches the `.slice(0, 400)` already applied to `user_agent` in
 * `src/app/api/partner/verify-code/route.ts`, so the two partner-side tables
 * truncate at the same place rather than at two numbers that drift apart.
 */
export const USER_AGENT_MAX = 400

/**
 * First hop of an `x-forwarded-for` chain, trimmed. Null when absent or blank.
 *
 * On Vercel this header is a COMMA-SEPARATED CHAIN, not one address: the
 * client, then every proxy that handled the request. The first entry is the
 * closest thing to the partner; the last is our own edge. Storing the whole
 * string, or taking the last hop, makes the acceptance record evidence about
 * our infrastructure rather than about the partner, which is the one job it
 * has.
 */
export function clientIp(forwardedFor: string | null | undefined): string | null {
  if (!forwardedFor) return null
  const first = forwardedFor.split(',')[0]?.trim() ?? ''
  return first.length > 0 ? first : null
}

export interface AcceptanceRowInput {
  partnerId: string
  forwardedFor: string | null | undefined
  userAgent: string | null | undefined
}

export interface AcceptanceRow {
  referral_partner_id: string
  terms_version: string
  ip: string | null
  user_agent: string | null
}

/**
 * The row to insert for an accepted set of terms.
 *
 * `terms_version` is read from `PARTNER_TERMS_VERSION` here and is NOT a
 * parameter. The route validates the version the client claims to be
 * accepting and rejects a mismatch; the row records the version the SERVER
 * was actually serving. Those are two different jobs, and letting a caller
 * pass the version in would collapse them — a stale tab could then write a
 * row saying it accepted text we no longer show.
 */
export function acceptanceRow(input: AcceptanceRowInput): AcceptanceRow {
  const ua = (input.userAgent ?? '').slice(0, USER_AGENT_MAX)
  return {
    referral_partner_id: input.partnerId,
    terms_version: PARTNER_TERMS_VERSION,
    ip: clientIp(input.forwardedFor),
    user_agent: ua.length > 0 ? ua : null,
  }
}
