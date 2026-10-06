import { supabaseAdmin } from '@/lib/supabase'
import { NextResponse } from 'next/server'
import { requireStaff } from '@/lib/require-staff'
import { parseNewClient } from '@/lib/clients/editable-fields'

/**
 * Create a client.
 *
 * The guard this replaces was `if (!name)`, which accepts ' ' -- truthy, and
 * accepted by the form's HTML `required` too -- so a client could be created
 * with a whitespace-only name. parseNewClient trims first and refuses what is
 * left blank; see src/lib/clients/editable-fields.ts.
 */
export async function POST(req: Request) {
  const denied = await requireStaff()
  if (denied) return denied

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Body must be a JSON object.' }, { status: 400 })
  }

  const parsed = parseNewClient(body)
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })

  const { data, error } = await supabaseAdmin
    .from('clients')
    .insert(parsed.fields)
    .select()
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}
