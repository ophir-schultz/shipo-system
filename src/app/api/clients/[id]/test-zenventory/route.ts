import { supabaseAdmin } from '@/lib/supabase'
import { testZenventoryCredentials } from '@/lib/api/zenventory'
import { readZenventoryClientCredentials } from '@/lib/zenventory/client-env'
import { NextResponse } from 'next/server'
import { requireStaff } from '@/lib/require-staff'

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireStaff()
  if (denied) return denied

  const { id } = await params
  const { data: client, error } = await supabaseAdmin
    .from('clients')
    .select('id, name')
    .eq('id', id)
    .single()

  // `error` was discarded here, and the consequence was a lie rather than a
  // crash: a failed read leaves `client` undefined, fell into the guard below,
  // and told the operator "No Zenventory credentials saved for this client" --
  // about a client whose credentials we never managed to look at. Someone acts
  // on that by re-typing a working key.
  if (error) {
    return NextResponse.json(
      { success: false, error: `Could not read this client's credentials: ${error.message}` },
      { status: 503 },
    )
  }

  const creds = readZenventoryClientCredentials(client?.name ?? '')
  if (!creds.ok) {
    return NextResponse.json({ success: false, error: creds.notice })
  }

  const result = await testZenventoryCredentials(creds.credentials.apiKey, creds.credentials.apiSecret)
  return NextResponse.json({ success: result.ok, status: result.status, error: result.error })
}
