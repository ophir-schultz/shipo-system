import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { requireStaff } from '@/lib/require-staff'
import { generateToken } from '@/lib/rate-sheets'

// Staff-only. See src/lib/require-staff.ts for why each handler
// authenticates itself rather than relying on the proxy.

type Params = Promise<{ id: string }>

const ALLOWED_STATUS = ['draft', 'sent', 'expired']

export async function PATCH(req: Request, { params }: { params: Params }) {
  const denied = await requireStaff()
  if (denied) return denied

  const { id } = await params
  const body = await req.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 })

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const patch: Record<string, any> = { updated_at: new Date().toISOString() }

  if (typeof body.status === 'string') {
    if (!ALLOWED_STATUS.includes(body.status)) {
      return NextResponse.json({ error: 'Unknown status.' }, { status: 400 })
    }
    patch.status = body.status
  }

  // Rotating the token invalidates the link already in the prospect's
  // inbox. That is the point — it is how a sheet sent to the wrong
  // address, or forwarded somewhere it should not have gone, is killed.
  if (body.rotate_token === true) {
    patch.token = generateToken()
  }

  const { data, error } = await supabaseAdmin
    .from('rate_sheets')
    .update(patch)
    .eq('id', id)
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 400 })

  return NextResponse.json({ sheet: data })
}

export async function DELETE(_req: Request, { params }: { params: Params }) {
  const denied = await requireStaff()
  if (denied) return denied

  const { id } = await params
  const { error } = await supabaseAdmin.from('rate_sheets').delete().eq('id', id)

  if (error) return NextResponse.json({ error: error.message }, { status: 400 })

  return NextResponse.json({ ok: true })
}
