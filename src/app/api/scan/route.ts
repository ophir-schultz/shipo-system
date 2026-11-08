import { supabaseAdmin } from '@/lib/supabase'
import { createClient } from '@/lib/supabase-server'
import { NextResponse } from 'next/server'
import { requireStaff } from '@/lib/require-staff'
import { duplicatesWithin } from '@/lib/scan/parse'
import { getCustomerOrders } from '@/lib/api/zenventory'
import { readZenventoryClientCredentials } from '@/lib/zenventory/client-env'
import { NAYAX_SCAN_ONLY, serializationClientAllowed } from '@/lib/scan/nayax-scope'
import { queueDecision, readCustomerOrder } from '@/lib/scan/order-lines'
import { readAllPages } from '@/lib/db/page'
import {
  claimProbeOk,
  decideSerialClaim,
  recordedScansFromRows,
  repeatedSerialKeys,
  type StoredSerialRow,
} from '@/lib/scan/serial-claim'

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
// A real scan goes through record_scan_claimed, after scan_claim_ready
// reports that function's version. record_scan is the production
// writer and is not called here. Until production code is switched,
// production scans do not use this check. The probe is not a constant.
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
  // Read-only preview of the claim decision. Never stores a scan.
  dry_run?: boolean
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

  const { data: client, error: clientError } = await supabaseAdmin
    .from('clients')
    .select('name')
    .eq('id', body.client_id)
    .maybeSingle()
  if (clientError) {
    return NextResponse.json(
      { error: `Could not read the client: ${clientError.message}` },
      { status: 503 },
    )
  }
  if (!client) return NextResponse.json({ error: 'No client has that id.' }, { status: 404 })
  if (!serializationClientAllowed(client.name)) {
    return NextResponse.json({ error: NAYAX_SCAN_ONLY }, { status: 403 })
  }

  // The database rejects this too, but catching it here lets us name
  // the offending values instead of returning a constraint violation.
  const dupes = duplicatesWithin(serials)
  const folded = repeatedSerialKeys(serials)
  if (dupes.length || folded.length) {
    const shown = dupes.length ? dupes : folded
    return bad(
      `The same serial was scanned twice: ${shown.join(', ')}. ` +
        'That is a double-read or a bad split — rescan the carton.',
    )
  }

  const orderRef = body.order_ref?.trim() || null
  const requestedSku = body.sku?.trim() || null
  const dryRun = body.dry_run === true
  const prior = await loadRecordedScans(body.client_id, serials)
  if (prior.error) {
    return NextResponse.json(
      { error: 'Existing serials could not be read. Nothing was recorded.' },
      { status: 503 },
    )
  }
  const claim = decideSerialClaim({
    clientId: body.client_id,
    sku: requestedSku,
    orderRef,
    scanType: body.scan_type,
    serials,
  }, prior.recorded)
  if (dryRun) {
    return NextResponse.json({
      dryRun: true,
      recorded: false,
      pickSent: false,
      action: claim.action,
      scan_event_id: claim.action === 'idempotent' ? claim.scanEventId : null,
      message: claim.action === 'reject'
        ? claim.message
        : claim.action === 'idempotent'
          ? 'This scan was already recorded. Dry run: nothing was billed and nothing was sent.'
          : 'Dry run. Nothing was recorded and nothing was sent.',
    })
  }

  const ready = await supabaseAdmin.rpc('scan_claim_ready')
  if (ready.error || !claimProbeOk(ready.data)) {
    return NextResponse.json({
      error: 'Serial claims are not ready. A scan was not recorded and nothing was sent.',
      recorded: false,
      pickSent: false,
    }, { status: 503 })
  }

  if (claim.action === 'reject') {
    return NextResponse.json({ error: claim.message }, { status: 409 })
  }

  if (claim.action === 'idempotent') {
    return NextResponse.json({
      success: true,
      idempotent: true,
      scan_event_id: claim.scanEventId,
      verification: 'This scan was already recorded. It was not billed again and it was not sent.',
      pickSent: false,
    })
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

  let skuForRecord = requestedSku
  let verification = ''
  if (orderRef && requestedSku) {
    const decision = await decideRecordedSku(body.client_id, orderRef, requestedSku, serials.length)
    if (!decision.record) return bad(decision.reason)
    skuForRecord = decision.queue ? requestedSku : null
    verification = decision.reason
  }

  const { data, error } = await supabaseAdmin.rpc('record_scan_claimed', {
    p_client_id: body.client_id,
    p_scan_type: body.scan_type,
    p_serials: serials,
    p_order_ref: orderRef,
    p_sku: skuForRecord,
    p_box_ref: body.box_ref?.trim() || null,
    p_expected_count: expected,
    p_notes: body.notes?.trim() || null,
    p_scanned_by: scannedBy,
    p_log_date: body.log_date || null,
    p_claim_sku: requestedSku,
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
    if (msg.includes('already been pushed') || msg.includes('already scanned for this client')) {
      return NextResponse.json({ error: msg }, { status: 409 })
    }
    return NextResponse.json({ error: msg }, { status: 500 })
  }

  return NextResponse.json({
    success: true,
    ...(data as Record<string, unknown>),
    verification: verification || null,
    pickSent: false,
  })
}

const SERIAL_SELECT = 'serial, scan_event_id, scan_events!inner(id, client_id, sku, order_ref, scan_type)'

function ilikeTerm(value: string): string {
  const escaped = value.replace(/[\\%_]/g, (ch) => `\\${ch}`)
  if (/[,.()"\s:*]/.test(escaped)) return `"${escaped.replace(/"/g, '""')}"`
  return escaped
}

async function loadRecordedScans(
  clientId: string,
  serials: string[],
): Promise<{ recorded: ReturnType<typeof recordedScansFromRows>; error: string | null }> {
  const chunks: string[][] = []
  for (let i = 0; i < serials.length; i += 20) chunks.push(serials.slice(i, i + 20))
  const matched: StoredSerialRow[] = []
  for (const chunk of chunks) {
    const page = await readAllPages<StoredSerialRow>((from, to) => supabaseAdmin
      .from('scanned_serials')
      .select(SERIAL_SELECT)
      .eq('scan_events.client_id', clientId)
      .or(chunk.map((serial) => `serial.ilike.${ilikeTerm(serial)}`).join(','))
      .order('id')
      .range(from, to))
    if (page.error) return { recorded: [], error: page.error.message }
    matched.push(...(page.data ?? []))
  }
  const ids = [...new Set(recordedScansFromRows(clientId, matched).map((scan) => scan.scanEventId))]
  if (ids.length === 0) return { recorded: [], error: null }
  const full: StoredSerialRow[] = []
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50)
    const page = await readAllPages<StoredSerialRow>((from, to) => supabaseAdmin
      .from('scanned_serials')
      .select(SERIAL_SELECT)
      .in('scan_event_id', chunk)
      .eq('scan_events.client_id', clientId)
      .order('id')
      .range(from, to))
    if (page.error) return { recorded: [], error: page.error.message }
    full.push(...(page.data ?? []))
  }
  return { recorded: recordedScansFromRows(clientId, full), error: null }
}

async function decideRecordedSku(
  clientId: string,
  orderRef: string,
  sku: string,
  serialCount: number,
): Promise<{ record: boolean; queue: boolean; reason: string }> {
  const { data: client, error } = await supabaseAdmin
    .from('clients')
    .select('name')
    .eq('id', clientId)
    .maybeSingle()
  if (error || !client) {
    return queueDecision({
      loaded: { ok: false, reason: error ? `Could not read the client: ${error.message}` : 'No client has that id.' },
      sku,
      serialCount,
    })
  }
  const creds = readZenventoryClientCredentials(client.name ?? '')
  if (!creds.ok) {
    return queueDecision({ loaded: { ok: false, reason: creds.notice }, sku, serialCount })
  }
  try {
    const body = await getCustomerOrders(creds.credentials.apiKey, creds.credentials.apiSecret, {
      page: 1,
      perPage: 100,
      orderNumber: orderRef,
    })
    return queueDecision({ loaded: readCustomerOrder(body, orderRef), sku, serialCount })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return queueDecision({
      loaded: { ok: false, reason: `The order could not be read. ${message}` },
      sku,
      serialCount,
    })
  }
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
