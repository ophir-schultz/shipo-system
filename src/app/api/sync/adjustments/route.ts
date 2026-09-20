import { NextResponse } from 'next/server'
import { syncAdjustments } from '@/lib/sync/shipstation'
import { requireStaff } from '@/lib/require-staff'

// Checks the last 30 days for carrier cost changes.
//
// The comment here used to say this runs on a cron schedule. It does
// not — vercel.json only schedules /api/agent/monitor, and nothing in
// the app calls this route. It is a manual staff tool, so it takes the
// plain staff guard. If it is ever put on a cron, it needs the same
// staff-or-cron treatment as the monitor route.
export async function GET() {
  const denied = await requireStaff()
  if (denied) return denied

  try {
    const results = await syncAdjustments()
    return NextResponse.json({ success: true, ...results })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
