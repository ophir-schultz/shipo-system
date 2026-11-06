import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { requireStaff } from '@/lib/require-staff'
import { getCustomerOrders } from '@/lib/api/zenventory'
import { readZenventoryClientCredentials } from '@/lib/zenventory/client-env'
import { readCustomerOrder } from '@/lib/scan/order-lines'

export const dynamic = 'force-dynamic'

// Staff only. One read of one customer order. No pick is sent, and the
// credentials are not returned.

export async function GET(req: Request) {
  const denied = await requireStaff()
  if (denied) return denied

  const url = new URL(req.url)
  const clientId = url.searchParams.get('client_id')?.trim() ?? ''
  const orderRef = url.searchParams.get('order_ref')?.trim() ?? ''
  if (!clientId || !orderRef) {
    return NextResponse.json({
      loaded: false,
      lines: null,
      secureConfigured: false,
      reason: 'Choose a client and enter an order reference.',
    }, { status: 400 })
  }

  const { data: client, error } = await supabaseAdmin
    .from('clients')
    .select('id, name')
    .eq('id', clientId)
    .maybeSingle()
  if (error) {
    return NextResponse.json({
      loaded: false,
      lines: null,
      secureConfigured: false,
      reason: `Could not read the client: ${error.message}`,
    }, { status: 503 })
  }
  if (!client) {
    return NextResponse.json({
      loaded: false,
      lines: null,
      secureConfigured: false,
      reason: 'No client has that id.',
    }, { status: 404 })
  }

  const creds = readZenventoryClientCredentials(client.name ?? '')
  if (!creds.ok) {
    return NextResponse.json({
      loaded: false,
      lines: null,
      secureConfigured: false,
      reason: creds.notice,
    })
  }

  let body: unknown
  try {
    body = await getCustomerOrders(creds.credentials.apiKey, creds.credentials.apiSecret, {
      page: 1,
      perPage: 100,
      orderNumber: orderRef,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({
      loaded: false,
      lines: null,
      secureConfigured: creds.credentials.secureKey != null,
      reason: `The order could not be read. ${message}`,
    }, { status: 502 })
  }

  const read = readCustomerOrder(body, orderRef)
  if (!read.ok) {
    return NextResponse.json({
      loaded: false,
      lines: null,
      secureConfigured: creds.credentials.secureKey != null,
      reason: read.reason,
    })
  }

  const secureConfigured = creds.credentials.secureKey != null
  return NextResponse.json({
    loaded: true,
    orderNumber: read.orderNumber,
    lines: read.lines,
    secureConfigured,
    reason: secureConfigured
      ? ''
      : 'The legacy pick key is not set, so a pick cannot be sent. Order lines are from the read-only API.',
  })
}
