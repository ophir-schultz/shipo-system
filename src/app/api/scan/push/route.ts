import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { requireStaff } from '@/lib/require-staff'
import { readAllPages } from '@/lib/db/page'
import {
  livePushRefusal,
  pushPayload,
  pushQueueMode,
  type PushJobPlan,
  NAYAX_SERIAL_WEBHOOK_URL,
} from '@/lib/scan/push-queue'
import { createSupabasePushStore } from '@/lib/scan/push-store'
import { runPush, type RunnableJob } from '@/lib/scan/run-push'
import { createZenventoryTransport } from '@/lib/scan/zenventory-transport'
import type { PushSerialRef } from '@/lib/scan/zenventory-pick'

export const dynamic = 'force-dynamic'

// GET reads zenventory_push_queue and never updates it.
// POST is the send. It stays a dry run unless both
// ZENVENTORY_PUSH_ENABLED and ZENVENTORY_PUSH_EXECUTE are exactly "true".

interface QueueRow {
  id: string
  client_id: string
  order_ref: string
  sku: string
  status: string
  attempts: number
}

interface SerialRow {
  push_job_id: string
  serial: string
  position: number
}

interface EventSerial {
  id: string
  serial: string
  position: number | null
}

interface EventRow {
  id: string
  push_job_id: string
  scanned_at: string | null
  scanned_serials: EventSerial[] | EventSerial | null
}

async function loadPlans(): Promise<{ plans: PushJobPlan[]; error: string | null }> {
  const jobsRes = await readAllPages<QueueRow>((from, to) => supabaseAdmin
    .from('zenventory_push_queue')
    .select('id, client_id, order_ref, sku, status, attempts')
    .in('status', ['pending', 'failed'])
    .order('created_at')
    .order('id')
    .range(from, to))

  if (jobsRes.error) return { plans: [], error: jobsRes.error.message }

  const jobs = jobsRes.data ?? []
  const ids = jobs.map((job) => job.id)
  const serials: SerialRow[] = []
  if (ids.length > 0) {
    const serialRes = await readAllPages<SerialRow>((from, to) => supabaseAdmin
      .from('push_job_serials')
      .select('push_job_id, serial, position')
      .in('push_job_id', ids)
      .order('position')
      .order('scan_event_id')
      .range(from, to))
    if (serialRes.error) return { plans: [], error: serialRes.error.message }
    serials.push(...(serialRes.data ?? []))
  }

  const plans = jobs.map((job) => ({
    id: job.id,
    clientId: job.client_id,
    orderRef: job.order_ref,
    sku: job.sku,
    status: job.status,
    attempts: job.attempts,
    serials: serials
      .filter((row) => row.push_job_id === job.id)
      .sort((a, b) => a.position - b.position)
      .map((row) => row.serial),
  }))
  return { plans, error: null }
}

function describe(plans: PushJobPlan[], mode: string) {
  const message = mode === 'execute'
    ? livePushRefusal()
    : `Dry run. ${plans.length} job${plans.length === 1 ? '' : 's'} would be pushed. Nothing was sent and nothing was updated.`
  return {
    enabled: true,
    mode,
    wrote: false,
    jobs: plans.map((job) => ({ ...job, payload: pushPayload(job) })),
    message,
  }
}

export async function GET() {
  const denied = await requireStaff()
  if (denied) return denied

  const mode = pushQueueMode()
  if (mode === 'disabled') {
    return NextResponse.json({
      enabled: false,
      mode,
      wrote: false,
      jobs: [],
      message: 'Zenventory push queue is not enabled. Set ZENVENTORY_PUSH_ENABLED=true to inspect it. '
        + 'The default after that is a dry run. POST /api/scan/push sends the pick only when ZENVENTORY_PUSH_EXECUTE=true as well.',
    })
  }

  const loaded = await loadPlans()
  if (loaded.error) {
    return NextResponse.json({ enabled: true, mode, wrote: false, error: loaded.error }, { status: 500 })
  }
  return NextResponse.json(describe(loaded.plans, mode))
}

async function serialRowsFor(ids: string[]): Promise<{ rows: Map<string, PushSerialRef[]>; error: string | null }> {
  const grouped = new Map<string, Array<PushSerialRef & { scannedAt: string; position: number }>>()
  if (ids.length === 0) return { rows: new Map(), error: null }
  const events = await readAllPages<EventRow>((from, to) => supabaseAdmin
    .from('scan_events')
    .select('id, push_job_id, scanned_at, scanned_serials(id, serial, position)')
    .in('push_job_id', ids)
    .order('id')
    .range(from, to))
  if (events.error) return { rows: new Map(), error: events.error.message }
  for (const event of events.data ?? []) {
    const nested = Array.isArray(event.scanned_serials)
      ? event.scanned_serials
      : event.scanned_serials ? [event.scanned_serials] : []
    const list = grouped.get(event.push_job_id) ?? []
    for (const serial of nested) {
      list.push({
        id: serial.id,
        serial: serial.serial,
        scannedAt: event.scanned_at ?? '',
        position: serial.position ?? 0,
      })
    }
    grouped.set(event.push_job_id, list)
  }
  const rows = new Map<string, PushSerialRef[]>()
  for (const [jobId, list] of grouped) {
    list.sort((a, b) => a.scannedAt.localeCompare(b.scannedAt) || a.position - b.position)
    rows.set(jobId, list.map((serial) => ({ id: serial.id, serial: serial.serial })))
  }
  return { rows, error: null }
}

export async function POST() {
  const denied = await requireStaff()
  if (denied) return denied

  const mode = pushQueueMode()
  if (mode === 'disabled') {
    return NextResponse.json({
      enabled: false,
      mode,
      wrote: false,
      jobs: [],
      message: 'Zenventory push queue is not enabled. Nothing was sent and nothing was updated.',
    }, { status: 403 })
  }

  const loaded = await loadPlans()
  if (loaded.error) {
    return NextResponse.json({ enabled: true, mode, wrote: false, error: loaded.error }, { status: 500 })
  }
  if (mode === 'dry-run') return NextResponse.json(describe(loaded.plans, mode))

  const serials = await serialRowsFor(loaded.plans.map((job) => job.id))
  if (serials.error) {
    return NextResponse.json({ enabled: true, mode, wrote: false, error: serials.error }, { status: 500 })
  }

  const jobs: RunnableJob[] = loaded.plans.map((job) => {
    const rows = serials.rows.get(job.id) ?? job.serials.map((serial) => ({ id: '', serial }))
    return {
      ...job,
      serialRows: rows,
      serials: rows.map((row) => row.serial),
    }
  })

  const results = await runPush({
    jobs,
    store: createSupabasePushStore(),
    transport: createZenventoryTransport(),
    nayaxUrl: process.env[NAYAX_SERIAL_WEBHOOK_URL] ?? null,
    nayaxPost: async (url, body) => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const text = await res.text()
      return { status: res.status, body: text.slice(0, 2000) }
    },
    now: new Date().toISOString(),
  })

  const wrote = results.some((result) => result.queueStatus != null && result.saveError == null)
  return NextResponse.json({
    enabled: true,
    mode,
    wrote,
    jobs: results,
    message: wrote
      ? 'The pick ran. Queue rows were updated only for jobs that finished, and a job is marked done only after Zenventory accepted it.'
      : 'Nothing was marked done.',
  })
}
