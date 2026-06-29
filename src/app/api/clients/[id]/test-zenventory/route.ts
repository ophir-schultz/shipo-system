import { supabaseAdmin } from '@/lib/supabase'
import { testZenventoryCredentials } from '@/lib/api/zenventory'
import { NextResponse } from 'next/server'

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { data: client } = await supabaseAdmin
    .from('clients')
    .select('zenventory_api_key, zenventory_api_secret')
    .eq('id', id)
    .single()

  if (!client?.zenventory_api_key) {
    return NextResponse.json({ success: false, error: 'No Zenventory credentials saved for this client' })
  }

  const result = await testZenventoryCredentials(client.zenventory_api_key, client.zenventory_api_secret)
  return NextResponse.json({ success: result.ok, status: result.status, error: result.error })
}
