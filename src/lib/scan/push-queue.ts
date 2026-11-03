// Whether the serialization push queue is allowed to run.
//
// Off unless ZENVENTORY_PUSH_ENABLED is exactly "true". Even then the
// default is a dry run: GET and POST may read the queue and describe
// the serials, and they do not call Zenventory and do not update a row.
// ZENVENTORY_PUSH_EXECUTE must also be exactly "true", and only POST
// /api/scan/push sends the legacy pick. GET never writes.

export const ZENVENTORY_PUSH_ENABLED = 'ZENVENTORY_PUSH_ENABLED'
export const ZENVENTORY_PUSH_EXECUTE = 'ZENVENTORY_PUSH_EXECUTE'
export { NAYAX_SERIAL_WEBHOOK_URL } from './zenventory-pick'

export type PushQueueMode = 'disabled' | 'dry-run' | 'execute'

export function pushQueueMode(
  env: Record<string, string | undefined> = process.env,
): PushQueueMode {
  if (env[ZENVENTORY_PUSH_ENABLED] !== 'true') return 'disabled'
  if (env[ZENVENTORY_PUSH_EXECUTE] === 'true') return 'execute'
  return 'dry-run'
}

export interface PushJobPlan {
  id: string
  clientId: string
  orderRef: string
  sku: string
  status: string
  attempts: number
  serials: string[]
}

/** The body a live push would send. Built here so dry-run and execute agree. */
export function pushPayload(job: PushJobPlan): { orderRef: string; sku: string; serials: string[] } {
  return { orderRef: job.orderRef, sku: job.sku, serials: job.serials }
}

/**
 * Shown by GET even when execute is armed. GET never sends the pick.
 * POST /api/scan/push is the call that does, and only when both flags
 * are exactly "true".
 */
export function livePushRefusal(): string {
  return 'This request did not send serials and did not update the queue. '
    + 'POST /api/scan/push sends the legacy Zenventory pick when ZENVENTORY_PUSH_ENABLED and ZENVENTORY_PUSH_EXECUTE are both true.'
}
