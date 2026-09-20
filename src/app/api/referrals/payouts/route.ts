import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { requireStaff } from '@/lib/require-staff'

// The payout ledger. This records / advances a payout's approval
// state. It NEVER sends money — 'paid' only means Ophir has marked
// it settled outside the system.
//
// Body: {
//   action: 'pending' | 'approve' | 'paid' | 'unrecord',
//   dedupe_key, referral_partner_id, client_id, kind, period, amount,
//   fba_invoice_id?
// }
export async function POST(req: Request) {
  const denied = await requireStaff()
  if (denied) return denied

  const body = await req.json()
  const { action, dedupe_key } = body

  if (!action || !dedupe_key) {
    return NextResponse.json({ error: 'action and dedupe_key are required.' }, { status: 400 })
  }

  if (action === 'unrecord') {
    const { error } = await supabaseAdmin.from('referral_payouts').delete().eq('dedupe_key', dedupe_key)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true })
  }

  const now = new Date().toISOString()
  const row: Record<string, unknown> = {
    dedupe_key,
    referral_partner_id: body.referral_partner_id ?? null,
    client_id: body.client_id ?? null,
    kind: body.kind ?? 'commission',
    period: body.period ?? null,
    amount: Number(body.amount ?? 0),
    fba_invoice_id: body.fba_invoice_id ?? null,
    updated_at: now,
  }

  if (action === 'pending') {
    row.status = 'pending'
  } else if (action === 'approve') {
    row.status = 'approved'
    row.approved_by = 'Ophir'
    row.approved_at = now
  } else if (action === 'paid') {
    row.status = 'paid'
    row.paid_at = now
  } else {
    return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 })
  }

  const { error } = await supabaseAdmin
    .from('referral_payouts')
    .upsert(row, { onConflict: 'dedupe_key' })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}
