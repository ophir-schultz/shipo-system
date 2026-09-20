import { supabaseAdmin } from '@/lib/supabase'
import {
  DEFAULT_RATE_CARD,
  MONTHLY_MINIMUM,
  type RateLine,
  type RateSheet,
  type SheetProfile,
} from '@/lib/rate-sheets'

// ============================================================
// Database access for rate sheets. Server only.
//
// Split out of rate-sheets.ts so the pure helpers there can be
// imported by the client-side estimator without pulling the
// service-role client into the browser bundle. Import this module
// from server components and route handlers only.
//
// RLS is on and no policy grants access, so every read below
// depends on the service-role client. The anon key cannot see
// this table even with a valid token.
// ============================================================

/* eslint-disable @typescript-eslint/no-explicit-any */
export function normalise(row: any): RateSheet {
  return {
    ...row,
    profile: (row.profile ?? {}) as SheetProfile,
    // An empty card means nobody customised it, so the published list
    // rates apply. Never render a sheet with no prices on it.
    rate_card: (Array.isArray(row.rate_card) && row.rate_card.length
      ? row.rate_card
      : DEFAULT_RATE_CARD) as RateLine[],
    monthly_minimum: Number(row.monthly_minimum ?? MONTHLY_MINIMUM),
  }
}

/**
 * Length-safe, data-independent comparison, so a near-miss token
 * cannot be walked character by character using response timing.
 */
function safeEquals(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/**
 * Resolve a sheet from its public URL parts.
 *
 * Looks up by public_id, then checks the token in code rather than in
 * the query. A wrong token on a real id and a missing sheet both come
 * back null, so the page 404s identically either way and the URL never
 * confirms that a given sheet number exists.
 */
export async function getSheetByToken(
  publicId: number,
  token: string
): Promise<RateSheet | null> {
  if (!Number.isInteger(publicId) || publicId <= 0 || !token) return null

  const { data, error } = await supabaseAdmin
    .from('rate_sheets')
    .select('*')
    .eq('public_id', publicId)
    .maybeSingle()

  if (error || !data) return null
  if (!safeEquals(data.token, token)) return null

  return normalise(data)
}

export async function listSheets(): Promise<RateSheet[]> {
  const { data, error } = await supabaseAdmin
    .from('rate_sheets')
    .select('*')
    .order('created_at', { ascending: false })

  if (error || !data) return []
  return data.map(normalise)
}

/**
 * Record that a prospect opened the sheet.
 *
 * Best-effort by design: this runs after the page has already been
 * rendered, and a failed analytics write must never turn a working
 * quote into an error page for the prospect reading it.
 */
export async function recordView(sheet: RateSheet): Promise<void> {
  const now = new Date().toISOString()
  try {
    await supabaseAdmin
      .from('rate_sheets')
      .update({
        view_count: (sheet.view_count ?? 0) + 1,
        last_viewed_at: now,
        ...(sheet.view_count ? {} : { first_viewed_at: now }),
      })
      .eq('id', sheet.id)
  } catch {
    // Analytics, not correctness.
  }
}
