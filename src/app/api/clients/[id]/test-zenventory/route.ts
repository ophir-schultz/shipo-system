import { supabaseAdmin } from '@/lib/supabase'
import { testZenventoryCredentials } from '@/lib/api/zenventory'
import { NextResponse } from 'next/server'
import { requireStaff } from '@/lib/require-staff'

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireStaff()
  if (denied) return denied

  const { id } = await params
  const { data: client, error } = await supabaseAdmin
    .from('clients')
    .select('zenventory_api_key, zenventory_api_secret')
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

  if (!client?.zenventory_api_key) {
    return NextResponse.json({ success: false, error: 'No Zenventory credentials saved for this client' })
  }

  const result = await testZenventoryCredentials(client.zenventory_api_key, client.zenventory_api_secret)
  return NextResponse.json({ success: result.ok, status: result.status, error: result.error })
}
