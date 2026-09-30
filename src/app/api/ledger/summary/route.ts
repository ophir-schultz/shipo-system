// This route returns the complete business P&L and every client's margin, so
// it is staff-only. It was previously unauthenticated behind a comment
// claiming that was "consistent with every other route under src/app/api/ —
// none of them check a session". That was not true: 27 of the 36 handlers
// call requireStaff(), and src/lib/require-staff.ts exists for exactly this
// purpose. The comment did more damage than the hole, because it told the
// next person that fixing it would be the inconsistent act.
//
// requireStaffOrCron rather than plain requireStaff, for the reason the rest
// of this comment gives: a later piece of this programme mails a daily digest,
// and that mailer is a Vercel cron with no session. The bearer branch is
// skipped entirely when neither CRON_SECRET nor MONITOR_SECRET is set, so an
// unconfigured deployment fails CLOSED — it collapses to requireStaff().
//
// The route is a thin wrapper over getLedgerSummary(). It is kept — rather
// than deleted along with the page's fetch of it — because that digest reads
// it. /ledger does NOT call this route: a Server Component imports the same
// function directly. See the header of src/lib/ledger/summary.ts for why.

import { NextResponse } from 'next/server'
import { getLedgerSummary } from '@/lib/ledger/summary'
import { requireStaffOrCron } from '@/lib/require-staff'

export async function GET(req: Request) {
  const denied = await requireStaffOrCron(req)
  if (denied) return denied

  return NextResponse.json(await getLedgerSummary())
}
