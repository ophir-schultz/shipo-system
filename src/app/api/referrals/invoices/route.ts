import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

// Dedicated FBA-prep invoice entry. The 8% commission is computed
// ONLY off these amounts — never off total client revenue.
// Body: { client_id, month: 'YYYY-MM', amount, notes? }
export async function POST(req: Request) {
  const body = await req.json()
  const { client_id, month, amount, notes } = body

  if (!client_id || !month || amount == null) {
    return NextResponse.json({ error: 'client_id, month and amount are required.' }, { status: 400 })
  }
  const amt = Number(amount)
  if (!Number.isFinite(amt) || amt < 0) {
    return NextResponse.json({ error: 'Amount must be a non-negative number.' }, { status: 400 })
  }
  // normalize 'YYYY-MM' -> first-of-month date
  const period = /^\d{4}-\d{2}$/.test(month) ? `${month}-01` : month

  // upsert on (client_id, period)
  const { error } = await supabaseAdmin
    .from('fba_invoices')
    .upsert({ client_id, period, amount: amt, notes: notes ?? null }, { onConflict: 'client_id,period' })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}

// Delete an FBA invoice. Body: { id }
export async function DELETE(req: Request) {
  const { id } = await req.json()
  if (!id) return NextResponse.json({ error: 'id is required.' }, { status: 400 })
  const { error } = await supabaseAdmin.from('fba_invoices').delete().eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}
