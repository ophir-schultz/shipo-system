import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { requireStaff } from '@/lib/require-staff'
import { getCustomerOrders, getInventory } from '@/lib/api/zenventory'
import { readZenventoryClientCredentials } from '@/lib/zenventory/client-env'
import { runZenventoryCheck } from '@/lib/zenventory/account-check'

export const dynamic = 'force-dynamic'

// Staff only. One read of this client's Zenventory account: orders from the
// last 7 days and an inventory count. Nothing is written, and nothing is synced.
// The key and secret are used as Basic auth and are not returned or logged.

const EMPTY = {
  orderCount: null,
  latestOrderDate: null,
  inventoryCount: null,
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireStaff()
  if (denied) return denied

  const { id } = await params
  const { data: client, error } = await supabaseAdmin
    .from('clients')
    .select('id, name')
    .eq('id', id)
    .single()

  if (error) {
    return NextResponse.json({
      configured: false,
      ok: false,
      ...EMPTY,
      error: `Could not read the client: ${error.message}`,
    }, { status: 503 })
  }
  if (!client) {
    return NextResponse.json({
      configured: false,
      ok: false,
      ...EMPTY,
      error: 'No client has that id.',
    }, { status: 404 })
  }

  const creds = readZenventoryClientCredentials(client.name ?? '')
  if (!creds.ok) {
    return NextResponse.json({
      configured: false,
      ok: false,
      ...EMPTY,
      error: creds.notice,
    })
  }

  const { apiKey, apiSecret, secureKey } = creds.credentials
  const result = await runZenventoryCheck({
    secrets: [apiKey, apiSecret, secureKey ?? ''],
    fetchOrders: (page, sinceIso) => getCustomerOrders(apiKey, apiSecret, {
      page,
      perPage: 100,
      orderedSince: sinceIso,
    }),
    fetchInventory: () => getInventory(apiKey, apiSecret),
  })

  return NextResponse.json({ configured: true, ...result })
}
