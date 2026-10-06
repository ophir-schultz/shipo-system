import { supabaseAdmin } from '@/lib/supabase'
import { NextResponse } from 'next/server'
import { requireStaff } from '@/lib/require-staff'
import { parseClientPatch } from '@/lib/clients/editable-fields'

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireStaff()
  if (denied) return denied

  const { id } = await params
  const { error } = await supabaseAdmin.from('clients').delete().eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}

/**
 * Edit a client.
 *
 * The body goes through parseClientPatch instead of into .update() whole.
 * Which columns that allows, and why each money and referral column is left
 * out, is documented in src/lib/clients/editable-fields.ts.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireStaff()
  if (denied) return denied

  const { id } = await params

  // req.json() REJECTS on a malformed body, and an unhandled rejection here
  // is a 500 -- which reads as a server fault for what is a bad request.
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Body must be a JSON object.' }, { status: 400 })
  }

  const parsed = parseClientPatch(body)
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })

  const { error } = await supabaseAdmin.from('clients').update(parsed.fields).eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}
