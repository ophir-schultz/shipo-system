import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { requireStaff } from '@/lib/require-staff'

// Monthly account figures for a referred client. The 5% commission
// is computed off NET PROFIT — `amount` less the four direct costs
// below. Warehouse labor is deliberately NOT one of them.
//
// These numbers are the only thing a partner ever sees about their
// referred client. No rate card, no line items, no per-unit prices.
//
// Body: {
//   client_id, month: 'YYYY-MM', amount,
//   units_shipped?, cost_freight?, cost_materials?,
//   cost_storage?, cost_processing?, notes?
// }
const COST_FIELDS = ['cost_freight', 'cost_materials', 'cost_storage', 'cost_processing'] as const

export async function POST(req: Request) {
  const denied = await requireStaff()
  if (denied) return denied

  const body = await req.json()
  const { client_id, month, amount, units_shipped, notes } = body

  if (!client_id || !month || amount == null) {
    return NextResponse.json({ error: 'client_id, month and amount are required.' }, { status: 400 })
  }
  const amt = Number(amount)
  if (!Number.isFinite(amt) || amt < 0) {
    return NextResponse.json({ error: 'Amount must be a non-negative number.' }, { status: 400 })
  }

  const costs: Record<string, number> = {}
  for (const f of COST_FIELDS) {
    const v = Number(body[f] ?? 0)
    if (!Number.isFinite(v) || v < 0) {
      return NextResponse.json({ error: `${f} must be a non-negative number.` }, { status: 400 })
    }
    costs[f] = v
  }

  const totalCosts = COST_FIELDS.reduce((s, f) => s + costs[f], 0)
  if (totalCosts > amt) {
    return NextResponse.json(
      { error: 'Direct costs exceed the amount invoiced. Check the figures — this would compute a negative profit.' },
      { status: 400 },
    )
  }

  const units = Number(units_shipped ?? 0)
  if (!Number.isFinite(units) || units < 0) {
    return NextResponse.json({ error: 'units_shipped must be a non-negative number.' }, { status: 400 })
  }

  // normalize 'YYYY-MM' -> first-of-month date
  const period = /^\d{4}-\d{2}$/.test(month) ? `${month}-01` : month

  // upsert on (client_id, period)
  const { error } = await supabaseAdmin.from('fba_invoices').upsert(
    {
      client_id,
      period,
      amount: amt,
      units_shipped: Math.round(units),
      ...costs,
      notes: notes ?? null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'client_id,period' },
  )
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}

// Delete an FBA invoice. Body: { id }
export async function DELETE(req: Request) {
  const denied = await requireStaff()
  if (denied) return denied

  const { id } = await req.json()
  if (!id) return NextResponse.json({ error: 'id is required.' }, { status: 400 })
  const { error } = await supabaseAdmin.from('fba_invoices').delete().eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}
