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
//   units_shipped?, orders_shipped?, cost_freight?, cost_materials?,
//   cost_storage?, cost_processing?, notes?
// }
const COST_FIELDS = ['cost_freight', 'cost_materials', 'cost_storage', 'cost_processing'] as const

// The two service-line volume figures. FBA prep is billed per unit;
// DTC is not, and counts orders instead. A client normally has one of
// the two, not both.
const VOLUME_FIELDS = ['units_shipped', 'orders_shipped'] as const

/**
 * A volume figure, kept NULL when it was not supplied.
 *
 * Deliberately NOT `Number(v ?? 0)`. Blank, missing and null all have
 * to survive as null, because null means "nobody recorded this" while
 * 0 means "recorded, and it was genuinely zero" — and a bonus worth
 * $500 hangs on telling those apart. `Number('')` is 0, so an empty
 * form field would otherwise be written as a hard zero and the
 * qualification would read "does not qualify" forever, silently.
 *
 * Returns `undefined` on a value that is present but not a number, so
 * the caller can reject it rather than storing a wrong figure.
 */
function volume(v: unknown): number | null | undefined {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0) return undefined
  return Math.round(n)
}

export async function POST(req: Request) {
  const denied = await requireStaff()
  if (denied) return denied

  const body = await req.json()
  const { client_id, month, amount, notes } = body

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

  const volumes: Record<string, number | null> = {}
  for (const f of VOLUME_FIELDS) {
    const v = volume(body[f])
    if (v === undefined) {
      return NextResponse.json({ error: `${f} must be a non-negative number, or left blank.` }, { status: 400 })
    }
    volumes[f] = v
  }

  // normalize 'YYYY-MM' -> first-of-month date
  const period = /^\d{4}-\d{2}$/.test(month) ? `${month}-01` : month

  // upsert on (client_id, period)
  const { error } = await supabaseAdmin.from('fba_invoices').upsert(
    {
      client_id,
      period,
      amount: amt,
      ...volumes,
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
