import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { requireStaff, staffEmail } from '@/lib/require-staff'
import {
  DEFAULT_RATE_CARD,
  MONTHLY_MINIMUM,
  buildSlug,
  generateToken,
  type SheetProfile,
} from '@/lib/rate-sheets'
import { listSheets } from '@/lib/rate-sheets-db'

// Staff-only. The proxy does not cover `api/`, so both handlers below
// authenticate themselves — see src/lib/require-staff.ts.

export async function GET() {
  const denied = await requireStaff()
  if (denied) return denied

  return NextResponse.json({ sheets: await listSheets() })
}

/** Accept a number from a form field, or undefined when it was left blank. */
function num(value: unknown): number | undefined {
  if (value === '' || value === null || value === undefined) return undefined
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

export async function POST(req: Request) {
  const denied = await requireStaff()
  if (denied) return denied

  const body = await req.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 })

  const companyName = String(body.company_name ?? '').trim()
  if (!companyName) {
    return NextResponse.json({ error: 'Company name is required.' }, { status: 400 })
  }

  const profile: SheetProfile = {
    monthly_orders: num(body.monthly_orders),
    items_per_order: num(body.items_per_order),
    pallets_stored: num(body.pallets_stored),
    pallets_inbound: num(body.pallets_inbound),
    fba_units: num(body.fba_units),
    channels: Array.isArray(body.channels) ? body.channels.map(String) : undefined,
    notes: body.notes ? String(body.notes) : undefined,
  }

  const { data, error } = await supabaseAdmin
    .from('rate_sheets')
    .insert({
      slug: buildSlug(companyName),
      token: generateToken(),
      company_name: companyName,
      contact_name: body.contact_name ? String(body.contact_name).trim() : null,
      contact_email: body.contact_email ? String(body.contact_email).trim() : null,
      prepared_by: await staffEmail(),
      profile,
      // Snapshot the card onto the row now. A sheet must keep showing
      // what it showed when it was sent, even if list rates move later.
      rate_card: DEFAULT_RATE_CARD,
      monthly_minimum: num(body.monthly_minimum) ?? MONTHLY_MINIMUM,
      intro: body.intro ? String(body.intro) : null,
      valid_until: body.valid_until || null,
      status: 'draft',
    })
    .select()
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 })
  }

  return NextResponse.json({ sheet: data })
}
