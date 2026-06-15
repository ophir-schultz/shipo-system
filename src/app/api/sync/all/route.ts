import { NextResponse } from 'next/server'
import { syncShipments } from '@/lib/sync/shipstation'
import { syncClientAssignments } from '@/lib/sync/zenventory'

export async function POST(req: Request) {
  try {
    const { daysBack = 30 } = await req.json().catch(() => ({}))

    // Step 1: Pull shipments from ShipStation
    const shipmentResults = await syncShipments(daysBack)

    // Step 2: Map orders to clients via Zenventory
    const clientResults = await syncClientAssignments(daysBack)

    return NextResponse.json({
      success: true,
      shipments: shipmentResults,
      clients: clientResults,
    })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
