import { NextResponse } from 'next/server'
import { syncAdjustments } from '@/lib/sync/shipstation'

// This runs on a cron schedule — checks last 30 days for cost changes
export async function GET() {
  try {
    const results = await syncAdjustments()
    return NextResponse.json({ success: true, ...results })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
