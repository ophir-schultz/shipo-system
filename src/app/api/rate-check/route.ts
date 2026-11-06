import { NextResponse } from 'next/server'
import { requireStaff } from '@/lib/require-staff'
import { loadRateCheck } from '@/lib/billing/rate-check-load'
import { DEFAULT_RATE_CHECK_FLAGS } from '@/lib/billing/rate-sheet'

export const dynamic = 'force-dynamic'

// Staff only. Compares shipments with the 2026-11 sheet. No writes, no sync,
// and no carrier cost.

function flag(value: string | null, fallback: boolean): boolean {
  if (value === '1' || value === 'true') return true
  if (value === '0' || value === 'false') return false
  return fallback
}

export async function GET(req: Request) {
  const denied = await requireStaff()
  if (denied) return denied

  const url = new URL(req.url)
  const loaded = await loadRateCheck({
    week: url.searchParams.get('week') ?? '',
    clientId: url.searchParams.get('client') || null,
    flags: {
      roundWeight: flag(url.searchParams.get('round'), DEFAULT_RATE_CHECK_FLAGS.roundWeight),
      useDimensionalWeight: flag(url.searchParams.get('dim'), DEFAULT_RATE_CHECK_FLAGS.useDimensionalWeight),
    },
  })
  if (loaded.error) return NextResponse.json({ error: loaded.error }, { status: 400 })
  return NextResponse.json(loaded.report)
}
