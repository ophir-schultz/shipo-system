import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { requireStaff, staffEmail } from '@/lib/require-staff'

export const dynamic = 'force-dynamic'

// Records that finance approved a client report for a date range.
// Insert only. Does not email the report and does not send it anywhere.

const ISO = /^\d{4}-\d{2}-\d{2}$/

export async function POST(req: Request) {
  const denied = await requireStaff()
  if (denied) return denied

  const body = await req.json().catch(() => null) as {
    clientId?: unknown
    dateFrom?: unknown
    dateTo?: unknown
  } | null
  const clientId = typeof body?.clientId === 'string' ? body.clientId : ''
  const dateFrom = typeof body?.dateFrom === 'string' ? body.dateFrom : ''
  const dateTo = typeof body?.dateTo === 'string' ? body.dateTo : ''
  if (!clientId) return NextResponse.json({ error: 'Choose a client.' }, { status: 400 })
  if (!ISO.test(dateFrom) || !ISO.test(dateTo) || dateFrom > dateTo) {
    return NextResponse.json({ error: 'dateFrom and dateTo must be YYYY-MM-DD, from before to' }, { status: 400 })
  }

  const { error } = await supabaseAdmin.from('client_report_approvals').insert({
    client_id: clientId,
    period_from: dateFrom,
    period_to: dateTo,
    status: 'approved',
    approved_by: await staffEmail(),
  })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}
