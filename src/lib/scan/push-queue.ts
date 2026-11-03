// Whether the serialization push queue is allowed to run.
//
// Off unless ZENVENTORY_PUSH_ENABLED is exactly "true". Even then the
// default is a dry run: the route may read the queue and describe the
// serials it would send, and it does not call Zenventory and does not
// update a row. ZENVENTORY_PUSH_EXECUTE must also be exactly "true"
// before a live push is even considered, and this build still refuses
// the live call — no confirmed serial-write endpoint is wired, so a
// flag cannot be turned into an inventory write by accident.

export const ZENVENTORY_PUSH_ENABLED = 'ZENVENTORY_PUSH_ENABLED'
export const ZENVENTORY_PUSH_EXECUTE = 'ZENVENTORY_PUSH_EXECUTE'

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
 * Live Zenventory writes stay closed. Returning this instead of calling
 * the API is the guard: execute mode can be requested, and it still
 * changes nothing.
 */
export function livePushRefusal(): string {
  return 'Live Zenventory push is not performed. No request was sent and no queue row was updated. '
    + 'A confirmed serial-write endpoint is not wired in this build.'
}
