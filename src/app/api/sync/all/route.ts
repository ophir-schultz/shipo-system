import { NextResponse } from 'next/server'
import { syncShipments } from '@/lib/sync/shipstation'
import { syncClientAssignments } from '@/lib/sync/zenventory'

export async function POST(req: Request) {
  const { daysBack = 30 } = await req.json().catch(() => ({}))

  // Step 1: Pull shipments from ShipStation (must succeed)
  let shipmentResults: any
  try {
    shipmentResults = await syncShipments(daysBack)
  } catch (err: any) {
    return NextResponse.json({ error: `ShipStation sync failed: ${err.message}` }, { status: 500 })
  }

  // Step 2: Map orders to clients via Zenventory (non-fatal — sync still succeeds without it)
  let clientResults: any = null
  let clientError: string | null = null
  try {
    clientResults = await syncClientAssignments(daysBack)
  } catch (err: any) {
    clientError = err.message
  }

  return NextResponse.json({
    success: true,
    shipments: shipmentResults,
    clients: clientResults,
    client_sync_error: clientError,
  })
}
