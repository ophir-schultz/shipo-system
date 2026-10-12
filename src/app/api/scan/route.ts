import { supabaseAdmin } from '@/lib/supabase'
import { createClient } from '@/lib/supabase-server'
import { NextResponse } from 'next/server'
import { requireStaff } from '@/lib/require-staff'
import { duplicatesWithin } from '@/lib/scan/parse'

// ============================================================
// POST /api/scan  — record one serialization scan.
//
// The serials arrive ALREADY SPLIT. The browser parses the box
// label, shows the operator the resulting list, and posts what
// they confirmed. This route deliberately does not re-parse: the
// parser has a fixed-width fallback that guesses, and a guess
// that nobody looked at must never become a billing quantity.
// What gets stored is exactly what a human approved.
//
// Everything then goes through the record_scan() function so the
// billing row, the scan, the serials and the push queue land in
// one transaction or not at all.
//
// GET /api/scan?date=YYYY-MM-DD — recent scans, for the page.
// ============================================================

type ScanBody = {
  client_id?: string
  scan_type?: string
  serials?: unknown
  order_ref?: string
  // Which line of the order these serials belong to. Zenventory keeps
  // scanned serials per line item, so a multi-line order cannot be
  // pushed without it. Optional here — a scan is never blocked — but
  // no push job is opened when it is absent.
  sku?: string
  box_ref?: string
  expected_count?: number | string
  notes?: string
  log_date?: string
}

export async function POST(req: Request) {
  const denied = await requireStaff()
  if (denied) return denied

  const body = (await req.json()) as ScanBody

  const bad = (msg: string) => NextResponse.json({ error: msg }, { status: 400 })

  if (!body.client_id) return bad('Pick a client.')
  if (body.scan_type !== 'box' && body.scan_type !== 'loose') {
    return bad('scan_type must be "box" or "loose".')
  }

  if (!Array.isArray(body.serials)) return bad('serials must be an array.')

  const serials = body.serials
    .map((s) => (typeof s === 'string' ? s.trim() : ''))
    .filter(Boolean)

  if (!serials.length) return bad('No serials in that scan.')

  // The database rejects this too, but catching it here lets us name
  // the offending values instead of returning a constraint violation.
  const dupes = duplicatesWithin(serials)
  if (dupes.length) {
    return bad(
      `The same serial was scanned twice: ${dupes.join(', ')}. ` +
        'That is a double-read or a bad split — rescan the carton.',
    )
  }

  // Stamps who did the work. Non-fatal if it cannot be read: the scan
  // still needs to be billed and stored.
  let scannedBy: string | null = null
  try {
    const supabase = await createClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()
    scannedBy = user?.id ?? null
  } catch {
    scannedBy = null
  }

  const expected =
    body.expected_count === undefined || body.expected_count === null || body.expected_count === ''
      ? null
      : Number(body.expected_count)

  if (expected !== null && (!Number.isFinite(expected) || expected < 1)) {
    return bad('expected_count must be a positive whole number, or left blank.')
  }

  const { data, error } = await supabaseAdmin.rpc('record_scan', {
    p_client_id: body.client_id,
    p_scan_type: body.scan_type,
    p_serials: serials,
    p_order_ref: body.order_ref?.trim() || null,
    p_sku: body.sku?.trim() || null,
    p_box_ref: body.box_ref?.trim() || null,
    p_expected_count: expected,
    p_notes: body.notes?.trim() || null,
    p_scanned_by: scannedBy,
    p_log_date: body.log_date || null,
  })

  if (error) {
    const msg = error.message ?? ''
    // Both of these are conditions the operator can act on, not server
    // faults, and in both cases nothing was billed — record_scan is one
    // transaction, so a raise rolls the whole scan back.
    //
    // A missing rate means the client was never configured for
    // serialization. Saying so plainly beats a constraint violation,
    // because the alternative this codebase uses elsewhere — defaulting
    // a missing rate to zero — writes a $0 line that looks healthy.
    if (msg.includes('no serialization')) {
      return NextResponse.json({ error: msg }, { status: 422 })
    }
    // An already-pushed line means this carton arrived after its order
    // line was sent to Zenventory. Letting it join the job would leave
    // serials sitting in a 'done' job looking shipped when they never
    // were, so it is refused and surfaced.
    if (msg.includes('already been pushed')) {
      return NextResponse.json({ error: msg }, { status: 409 })
    }
    return NextResponse.json({ error: msg }, { status: 500 })
  }

  return NextResponse.json({ success: true, ...(data as Record<string, unknown>) })
}

export async function GET(req: Request) {
  const denied = await requireStaff()
  if (denied) return denied

  const { searchParams } = new URL(req.url)
  const date = searchParams.get('date')

  let query = supabaseAdmin
    .from('scan_events')
    .select('*, clients(name)')
    .order('scanned_at', { ascending: false })
    .limit(100)

  if (date) {
    query = query.gte('scanned_at', `${date}T00:00:00`).lte('scanned_at', `${date}T23:59:59`)
  }

  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ scans: data ?? [] })
}
