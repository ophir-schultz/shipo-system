import { supabaseAdmin } from '@/lib/supabase'
import { NextResponse } from 'next/server'

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { data: client } = await supabaseAdmin
    .from('clients')
    .select('zenventory_api_key, zenventory_api_secret')
    .eq('id', id)
    .single()

  if (!client?.zenventory_api_key) return NextResponse.json({ success: false, error: 'No credentials' })

  try {
    const res = await fetch('https://app.zenventory.com/api/customer-orders?page=1&perPage=1', {
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${client.zenventory_api_key}:${client.zenventory_api_secret}`).toString('base64'),
        'Content-Type': 'application/json',
      },
    })
    return NextResponse.json({ success: res.ok, status: res.status })
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message })
  }
}
