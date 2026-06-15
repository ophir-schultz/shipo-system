import { supabaseAdmin } from '@/lib/supabase'
import { NextResponse } from 'next/server'

export async function POST(req: Request) {
  const { date, rows } = await req.json()

  const entries = []

  for (const row of rows) {
    // Get client's rate for this service
    const { data: rateRow } = await supabaseAdmin
      .from('client_warehouse_rates')
      .select('rate')
      .eq('client_id', row.client_id)
      .eq('service_type', row.service_type)
      .single()

    const rate = rateRow?.rate ?? 0
    const quantity = parseFloat(row.quantity)
    const total = rate * quantity

    entries.push({
      client_id: row.client_id,
      log_date: date,
      service_type: row.service_type,
      quantity,
      rate,
      total,
      notes: row.notes || null,
    })
  }

  const { error } = await supabaseAdmin.from('warehouse_daily_log').insert(entries)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ success: true, count: entries.length })
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const date = searchParams.get('date')

  const { data } = await supabaseAdmin
    .from('warehouse_daily_log')
    .select('*, clients(name)')
    .eq('log_date', date!)
    .order('created_at', { ascending: false })

  return NextResponse.json({ entries: data ?? [] })
}
