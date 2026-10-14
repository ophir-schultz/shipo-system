import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { requireStaff } from '@/lib/require-staff'
import { partnerWriteFields } from '@/lib/referral-partner-fields'

// Create or update a referral partner (manual entry / review of a
// website-form sign-up). No money moves here.
//
// ⚠️ THIS ROUTE NO LONGER STAMPS ANY BONUS TERMS.
//
// It used to admit "Founding Partners" by writing signup_bonus_amount
// = 500 and a pair of volume bars onto the partner row, capped at 10
// partners. That model was wrong about the money: 10 partners each
// referring an unlimited number of clients at $500 a head is an
// unbounded liability, not the $2,000 the old comment claimed.
//
// The offer was then re-scoped to the CLIENT — the first 10 referred
// clients to clear a volume bar earned $500 — and was WITHDRAWN
// entirely on 2026-10-12, before any partner was signed and before any
// bonus was paid. There is no promotional tier now: every referred
// client earns the standing bonus in REFERRAL_TERMS.
//
// The per-partner bar columns still exist and are still honoured by
// qualifyBars(), so a bespoke deal can be written by hand in the DB.
// Nothing in the UI writes them any more.
export async function POST(req: Request) {
  const denied = await requireStaff()
  if (denied) return denied

  const body = (await req.json()) as Record<string, unknown>
  const id = typeof body.id === 'string' ? body.id : null

  // Which columns to write is decided in partnerWriteFields, under test.
  // It used to be decided here, with `company: company ?? null` followed by
  // a strip of the undefined keys -- which removed nothing, because `??
  // null` had already replaced them. A partial POST therefore wrote nulls
  // across the row, and the approve button below sends exactly that.
  const write = partnerWriteFields(body)
  if ('error' in write) {
    return NextResponse.json({ error: write.error }, { status: 400 })
  }
  const { fields } = write

  if (id) {
    const { error } = await supabaseAdmin.from('referral_partners').update(fields).eq('id', id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true, id })
  }

  const { data, error } = await supabaseAdmin.from('referral_partners').insert(fields).select('id').single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, id: data?.id })
}
