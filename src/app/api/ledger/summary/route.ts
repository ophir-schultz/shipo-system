// SECURITY NOTE: This route has no authentication. It returns the complete
// business P&L and per-client margins. This is consistent with every other
// route under src/app/api/ — none of them check a session; all use the
// service-role key. Adding auth here alone would be inconsistent. This
// exposure is unresolved app-wide and is a decision for the project owner,
// not this task. Do not add auth here without auditing and updating the other
// ~20 routes at the same time.
//
// The route is a thin wrapper over getLedgerSummary(). It is kept — rather
// than deleted along with the page's fetch of it — because a later piece of
// this programme mails a daily digest from it. /ledger does NOT call this
// route: a Server Component imports the same function directly. See the header
// of src/lib/ledger/summary.ts for why.

import { NextResponse } from 'next/server'
import { getLedgerSummary } from '@/lib/ledger/summary'

export async function GET() {
  return NextResponse.json(await getLedgerSummary())
}
