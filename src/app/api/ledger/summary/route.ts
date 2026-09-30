// SECURITY NOTE: This route has no authentication. It returns the complete
// business P&L and per-client margins. This is consistent with every other
// route under src/app/api/ — none of them check a session; all use the
// service-role key. Adding auth here alone would be inconsistent. This
// exposure is unresolved app-wide and is a decision for the project owner,
// not this task. Do not add auth here without auditing and updating the other
// ~20 routes at the same time.

import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export async function GET() {
  // Build the three-month window arithmetically. Do NOT use setMonth() — on
  // long-month days (e.g. 31 May) `since.setMonth(getMonth() - 3)` produces
  // 31 February, which normalises to 3 March, silently narrowing the window
  // to two months on those days.
  const now = new Date()
  const y = now.getFullYear()
  const m = now.getMonth() + 1 // 1-based
  // Subtract 3 months as integers, carrying the year when month underflows.
  const fromMonth = m - 3 <= 0 ? m - 3 + 12 : m - 3
  const fromYear  = m - 3 <= 0 ? y - 1       : y
  const from = `${fromYear}-${String(fromMonth).padStart(2, '0')}-01`

  const [leaks, monthly, clients, picks] = await Promise.all([
    supabaseAdmin.from('leaks_monthly').select('*')
      .gte('period_month', from).order('period_month', { ascending: false }),
    supabaseAdmin.from('pnl_monthly').select('*')
      .gte('period_month', from).order('period_month', { ascending: false }),
    supabaseAdmin.from('pnl_client_monthly').select('*')
      .gte('period_month', from).order('period_month', { ascending: false }),
    supabaseAdmin.from('pick_days').select('*')
      .gte('pick_date', from).order('pick_date', { ascending: false }).limit(200),
  ])

  // Errors are surfaced, not swallowed. A view that fails to load must not
  // render as an empty table — empty and broken look identical otherwise.
  const errors = [leaks, monthly, clients, picks]
    .map((r) => r.error?.message).filter(Boolean)

  return NextResponse.json({
    leaks:   leaks.data   ?? [],
    monthly: monthly.data ?? [],
    clients: clients.data ?? [],
    picks:   picks.data   ?? [],
    errors,
  })
}
