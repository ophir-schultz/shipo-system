import { NextResponse } from 'next/server'
import { requireStaff } from '@/lib/require-staff'
import { recalculateShipments } from '@/lib/billing/recalculate'

// Staff-only. The work itself lives in src/lib/billing/recalculate.ts
// so the monitor agent can run it in-process instead of calling this
// endpoint over HTTP without credentials.

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
