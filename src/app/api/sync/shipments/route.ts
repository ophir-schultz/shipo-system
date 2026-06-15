import { NextResponse } from 'next/server'
import { syncShipments } from '@/lib/sync/shipstation'

export async function POST(req: Request) {
  try {
    const { daysBack = 7 } = await req.json().catch(() => ({}))
    const results = await syncShipments(daysBack)
    return NextResponse.json({ success: true, ...results })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
