import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { requireStaff } from '@/lib/require-staff'
import { getLegacyCustomerOrder, getScanCustomerOrder } from '@/lib/api/zenventory'
import { readOrderReadCredentials, zenventoryEnvNames } from '@/lib/zenventory/client-env'
import { loadScanOrder } from '@/lib/scan/load-order'
import { readCustomerOrder } from '@/lib/scan/order-lines'
import { NAYAX_SCAN_ONLY, serializationClientAllowed } from '@/lib/scan/nayax-scope'

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
  if (!serializationClientAllowed(client.name)) {
    return NextResponse.json({
      loaded: false,
      lines: null,
      secureConfigured: false,
      reason: NAYAX_SCAN_ONLY,
    }, { status: 403 })
  }

  const creds = readOrderReadCredentials(client.name ?? '')
  if (!creds.ok) {
    return NextResponse.json({
      loaded: false,
      lines: null,
      secureConfigured: false,
      reason: creds.notice,
    })
  }

  const names = zenventoryEnvNames(creds.credentials.slug)
  const loaded = await loadScanOrder({
    orderRef,
    credentials: creds.credentials,
    secureLabel: `${names.secure} or ${names.legacySecure}`,
    readV2: (apiKey, apiSecret) => getScanCustomerOrder(apiKey, apiSecret, orderRef),
    readLegacy: (secureKey) => getLegacyCustomerOrder(secureKey, orderRef),
  })
  if (!loaded.loaded) {
    return NextResponse.json({
      loaded: false,
      lines: null,
      secureConfigured: creds.credentials.secureKey != null,
      source: null,
      reason: `${loaded.reason} API 2.0 used ${creds.credentials.keySource} and ${creds.credentials.secretSource}.`
        + (process.env.VERCEL_DEPLOYMENT_ID ? ` Deployment ${process.env.VERCEL_DEPLOYMENT_ID}.` : '')
        + (process.env.VERCEL_GIT_COMMIT_SHA ? ` Build ${process.env.VERCEL_GIT_COMMIT_SHA.slice(0, 7)}.` : ''),
    }, { status: 502 })
  }
  const body = loaded.body

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
    source: loaded.source,
    reason: loaded.source === 'legacy'
      ? 'Order lines were read with the legacy key. No pick was sent.'
      : secureConfigured
        ? ''
        : 'The legacy pick key is not set, so a pick cannot be sent. Order lines are from the read-only API.',
  })
}
