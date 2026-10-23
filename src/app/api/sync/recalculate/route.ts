import { NextResponse } from 'next/server'
import { requireStaff } from '@/lib/require-staff'
import { recalculateShipments } from '@/lib/billing/recalculate'

// Staff-only. The work itself lives in src/lib/billing/recalculate.ts
// so the monitor agent can run it in-process instead of calling this
// endpoint over HTTP without credentials.

// This route reprices the ENTIRE book in one request, and until 2026-10-23 it
// was the only heavy route in the app with no budget declared -- api/agent/
// monitor, api/statements/download and api/statements/data all set 300. On the
// default budget the function was killed partway through every run, and
// nothing said so: each shipment is written as it is priced, so a killed run
// leaves real progress behind and the next one picks up a little more. From
// the outside that looked like a rate-card problem that kept almost being
// fixed, and it cost most of a day to tell the two apart.
//
// 300 is the ceiling rather than a calculation. What makes the run fit inside
// it is the prefetching in recalculate.ts -- the zone chart once per run and
// each client's matrix once per client, instead of two reads per shipment.
export const maxDuration = 300

export async function POST() {
  const denied = await requireStaff()
  if (denied) return denied

  try {
    return NextResponse.json(await recalculateShipments())
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Recalculate failed.'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
