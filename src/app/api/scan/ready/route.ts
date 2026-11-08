import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { requireStaff } from '@/lib/require-staff'
import { claimProbeOk } from '@/lib/scan/serial-claim'

export const dynamic = 'force-dynamic'

// Read-only. Says whether a real scan is allowed to call the claim
// function. It does not record a scan and it does not send a pick.
export async function GET() {
  const denied = await requireStaff()
  if (denied) return denied

  const ready = await supabaseAdmin.rpc('scan_claim_ready')
  const ok = !ready.error && claimProbeOk(ready.data)
  return NextResponse.json({
    ready: ok,
    recorded: false,
    pickSent: false,
    version: ok ? 'client-sku-v1' : null,
    message: ok
      ? 'Claim check client-sku-v1 is ready. Record scan uses that function. This request did not record a scan or send a pick.'
      : 'Claim check is not ready. Record scan is blocked. Nothing was recorded.',
  })
}
