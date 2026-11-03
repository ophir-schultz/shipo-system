import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { requireStaff } from '@/lib/require-staff'
import { readAllPages } from '@/lib/db/page'
import {
  livePushRefusal,
  pushPayload,
  pushQueueMode,
  type PushJobPlan,
} from '@/lib/scan/push-queue'

export const dynamic = 'force-dynamic'

// Reads zenventory_push_queue. Does not update it and does not call
// Zenventory. Disabled unless ZENVENTORY_PUSH_ENABLED=true. Dry-run
// unless ZENVENTORY_PUSH_EXECUTE=true, and even then the live call is refused.

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
        + 'The default after that is a dry run. ZENVENTORY_PUSH_EXECUTE=true is also required before any write, '
        + 'and this build still does not send serials or update the queue.',
    })
  }

  const jobsRes = await readAllPages<QueueRow>((from, to) => supabaseAdmin
    .from('zenventory_push_queue')
    .select('id, client_id, order_ref, sku, status, attempts')
    .in('status', ['pending', 'failed'])
    .order('created_at')
    .order('id')
    .range(from, to))

  if (jobsRes.error) {
    return NextResponse.json({ enabled: true, mode, wrote: false, error: jobsRes.error.message }, { status: 500 })
  }

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
    if (serialRes.error) {
      return NextResponse.json({ enabled: true, mode, wrote: false, error: serialRes.error.message }, { status: 500 })
    }
    serials.push(...(serialRes.data ?? []))
  }

  const plans: PushJobPlan[] = jobs.map((job) => ({
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

  if (mode === 'execute') {
    return NextResponse.json({
      enabled: true,
      mode,
      wrote: false,
      jobs: plans.map((job) => ({ ...job, payload: pushPayload(job) })),
      message: livePushRefusal(),
    }, { status: 409 })
  }

  return NextResponse.json({
    enabled: true,
    mode,
    wrote: false,
    jobs: plans.map((job) => ({ ...job, payload: pushPayload(job) })),
    message: `Dry run. ${plans.length} job${plans.length === 1 ? '' : 's'} would be pushed. Nothing was sent and nothing was updated.`,
  })
}
