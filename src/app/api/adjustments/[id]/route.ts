import { supabaseAdmin } from '@/lib/supabase'
import { NextResponse } from 'next/server'

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { status } = await req.json()

  const allowed = ['approved', 'waived', 'billed']
  if (!allowed.includes(status)) {
    return NextResponse.json({ error: `Invalid status. Allowed: ${allowed.join(', ')}` }, { status: 400 })
  }

  const { error } = await supabaseAdmin
    .from('rate_adjustments')
    .update({ status })
    .eq('id', id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}
