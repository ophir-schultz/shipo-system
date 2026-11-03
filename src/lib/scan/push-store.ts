import { supabaseAdmin } from '@/lib/supabase'
import type { PushOutcome } from './zenventory-pick'
import type { PushStore, RunnableJob } from './run-push'

function clean(value: string | null | undefined): string | null {
  if (value == null) return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * Persists a delivery only after deliverJob returns. The queue is marked
 * done only when the outcome says so, which is only after a 2xx pick.
 * A serial-row write that fails after that 2xx still leaves the queue
 * failed, so a later run sees pickedquantity > 0 and does not pick again.
 */
export function createSupabasePushStore(): PushStore {
  return {
    async claim(jobId) {
      const res = await supabaseAdmin
        .from('zenventory_push_queue')
        .update({ status: 'in_flight' })
        .eq('id', jobId)
        .in('status', ['pending', 'failed'])
        .select('id')
      if (res.error) return { ok: false, error: res.error.message }
      return { ok: (res.data ?? []).length > 0, error: null }
    },

    async credentials(clientId) {
      const res = await supabaseAdmin
        .from('clients')
        .select('zenventory_api_key, zenventory_api_secret, zenventory_secure_key')
        .eq('id', clientId)
        .limit(1)
      if (res.error) return { credentials: null, error: res.error.message }
      const row = res.data?.[0]
      if (!row) return { credentials: null, error: 'Client was not found' }
      return {
        credentials: {
          apiKey: clean(row.zenventory_api_key),
          apiSecret: clean(row.zenventory_api_secret),
          secureKey: clean(row.zenventory_secure_key),
        },
        error: null,
      }
    },

    async save(job, outcome) {
      return saveOutcome(job, outcome)
    },
  }
}

async function saveOutcome(job: RunnableJob, outcome: PushOutcome): Promise<{ error: string | null }> {
  let serialError: string | null = null
  for (const serial of outcome.serials) {
    if (!serial.scannedSerialId) continue
    const fields: {
      zenventory_status: string | null
      zenventory_sent_at: string | null
      zenventory_response: string | null
      tracking_number?: string
    } = {
      zenventory_status: serial.zenventoryStatus,
      zenventory_sent_at: serial.zenventorySentAt,
      zenventory_response: serial.zenventoryResponse,
    }
    // A blank snapshot must not wipe a tracking number stored earlier.
    if (serial.trackingNumber) fields.tracking_number = serial.trackingNumber
    const res = await supabaseAdmin
      .from('scanned_serials')
      .update(fields)
      .eq('id', serial.scannedSerialId)
    if (res.error) {
      serialError = res.error.message
      break
    }
  }

  if (!serialError && outcome.log.length > 0) {
    const res = await supabaseAdmin.from('serial_delivery_log').insert(outcome.log.map((entry) => ({
      scanned_serial_id: entry.scannedSerialId,
      client_id: job.clientId,
      order_ref: job.orderRef,
      sku: job.sku,
      serial: entry.serial,
      channel: entry.channel,
      status: entry.status,
      response_status: entry.responseStatus,
      response_body: entry.responseBody,
    })))
    if (res.error) serialError = res.error.message
  }

  const sentButUnrecorded = outcome.queueStatus === 'done' && serialError
  const status = sentButUnrecorded ? 'failed' : outcome.queueStatus
  const error = sentButUnrecorded
    ? `Zenventory accepted the pick, and the serial row was not updated (${serialError}). It was not marked done, so a later run must not pick it again.`
    : outcome.error

  if (!status) return { error: serialError }

  const res = await supabaseAdmin
    .from('zenventory_push_queue')
    .update({
      status,
      request_payload: outcome.requestPayload,
      response_status: outcome.responseStatus,
      response_body: outcome.responseBody,
      last_error: error,
      pushed_at: status === 'done' ? new Date().toISOString() : null,
      attempts: outcome.attemptsIncrement ? job.attempts + 1 : job.attempts,
    })
    .eq('id', job.id)
  if (res.error) return { error: res.error.message }
  return { error: serialError ?? null }
}
