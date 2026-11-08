import { supabaseAdmin } from '@/lib/supabase'
import { NextResponse } from 'next/server'
import { requireStaff, staffUserId } from '@/lib/require-staff'
import { manualChargeRow, parseManualCharge, RECENT_MANUAL_CHARGES } from '@/lib/billing/manual-charge'

const CHARGE_COLUMNS = 'id, client_id, charge_date, description, amount, added_by, approved, created_at, clients(name)'

export async function GET() {
  const denied = await requireStaff()
  if (denied) return denied

  const { data, error } = await supabaseAdmin
    .from('manual_charges')
    .select(CHARGE_COLUMNS)
    .order('charge_date', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(RECENT_MANUAL_CHARGES)

  if (error) {
    return NextResponse.json(
      { error: `Could not read manual charges: ${error.message}` },
      { status: 503 },
    )
  }
  return NextResponse.json({ entries: data ?? [] })
}

export async function POST(req: Request) {
  const denied = await requireStaff()
  if (denied) return denied

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Body is not valid JSON.' }, { status: 400 })
  }

  const parsed = parseManualCharge(body)
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 })
  }

  const addedBy = await staffUserId()
  if (!addedBy) {
    return NextResponse.json({ error: 'Not authorised.' }, { status: 401 })
  }

  const { data: client, error: clientError } = await supabaseAdmin
    .from('clients')
    .select('id, active')
    .eq('id', parsed.value.clientId)
    .maybeSingle()

  if (clientError) {
    return NextResponse.json({
      error: `Could not verify the client, so nothing was saved: ${clientError.message}`,
    }, { status: 503 })
  }
  if (!client || client.active !== true) {
    return NextResponse.json({
      error: 'That client is not an active client. Nothing was saved.',
    }, { status: 400 })
  }

  const row = manualChargeRow(parsed.value, addedBy, client.id)
  const { data, error } = await supabaseAdmin
    .from('manual_charges')
    .insert(row)
    .select(CHARGE_COLUMNS)
    .single()

  if (error) {
    return NextResponse.json({
      error: `The charge was not saved: ${error.message}`,
    }, { status: 500 })
  }

  return NextResponse.json({
    charge: data,
    billing: 'Recorded and not approved, so this amount is not in a bill yet.',
  }, { status: 201 })
}
