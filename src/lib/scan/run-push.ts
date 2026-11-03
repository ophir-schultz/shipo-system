import {
  deliverOrder,
  type ClientZenventoryCredentials,
  type PushOutcome,
  type PushSerialRef,
  type ZenventoryTransport,
} from './zenventory-pick'

export interface RunnableJob {
  id: string
  clientId: string
  orderRef: string
  sku: string
  status: string
  attempts: number
  serials: string[]
  serialRows: PushSerialRef[]
}

export interface PushStore {
  claim(jobId: string): Promise<{ ok: boolean; error: string | null }>
  credentials(clientId: string): Promise<{ credentials: ClientZenventoryCredentials | null; error: string | null }>
  save(job: RunnableJob, outcome: PushOutcome): Promise<{ error: string | null }>
}

export interface PushRunResult {
  jobId: string
  action: PushOutcome['action']
  error: string | null
  saveError: string | null
  queueStatus: PushOutcome['queueStatus']
}

/**
 * Groups open jobs by customer order, claims that order together, then
 * picks each serialized line once the order is fully scanned. A done job
 * is left untouched. The transport is injected so a test never opens a socket.
 */
export async function runPush(input: {
  jobs: RunnableJob[]
  store: PushStore
  transport: ZenventoryTransport
  now: string
  /** Label numbers already on our shipments rows, keyed by order ref. Not sent to Zenventory. */
  shipmentTracking?: Record<string, string[]>
}): Promise<PushRunResult[]> {
  const results: PushRunResult[] = []
  const open: RunnableJob[] = []
  for (const job of input.jobs) {
    if (job.status === 'done') {
      results.push({ jobId: job.id, action: 'skipped', error: null, saveError: null, queueStatus: null })
      continue
    }
    open.push(job)
  }

  const groups = new Map<string, RunnableJob[]>()
  for (const job of open) {
    const key = job.orderRef.trim()
      ? `${job.clientId}\n${job.orderRef.trim()}`
      : `unlinked\n${job.id}`
    groups.set(key, [...(groups.get(key) ?? []), job])
  }

  for (const group of groups.values()) {
    const claimed: RunnableJob[] = []
    let claimFailed = false
    for (const job of group) {
      const claim = await input.store.claim(job.id)
      if (claim.error || !claim.ok) {
        claimFailed = true
        results.push({
          jobId: job.id,
          action: 'failed',
          error: claim.error ?? 'The job was not claimed',
          saveError: null,
          queueStatus: null,
        })
        continue
      }
      claimed.push(job)
    }
    if (claimFailed) {
      for (const job of claimed) {
        const saved = await input.store.save(job, {
          action: 'waiting',
          mutate: true,
          queueStatus: 'pending',
          attemptsIncrement: false,
          requestPayload: null,
          responseStatus: null,
          responseBody: null,
          error: 'scan incomplete',
          serials: [],
          log: [],
        })
        results.push({
          jobId: job.id,
          action: 'waiting',
          error: 'scan incomplete',
          saveError: saved.error,
          queueStatus: 'pending',
        })
      }
      continue
    }
    if (claimed.length === 0) continue

    const creds = await input.store.credentials(claimed[0].clientId)
    if (creds.error || !creds.credentials) {
      const notConfigured = (creds.error ?? '').includes('not configured')
      for (const job of claimed) {
        const outcome: PushOutcome = {
          action: notConfigured ? 'waiting' : 'failed',
          mutate: true,
          queueStatus: notConfigured ? 'pending' : 'failed',
          attemptsIncrement: !notConfigured,
          requestPayload: null,
          responseStatus: null,
          responseBody: creds.error,
          error: creds.error ?? 'Client credentials could not be read',
          serials: [],
          log: [],
        }
        const saved = await input.store.save(job, outcome)
        results.push({
          jobId: job.id,
          action: outcome.action,
          error: outcome.error,
          saveError: saved.error,
          queueStatus: outcome.queueStatus,
        })
      }
      continue
    }

    let outcomes: PushOutcome[]
    try {
      outcomes = await deliverOrder({
        jobs: claimed,
        credentials: creds.credentials,
        transport: input.transport,
        now: input.now,
        shipmentTracking: input.shipmentTracking?.[claimed[0].orderRef.trim()] ?? [],
      })
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      outcomes = claimed.map(() => ({
        action: 'failed' as const,
        mutate: true,
        queueStatus: 'failed' as const,
        attemptsIncrement: true,
        requestPayload: null,
        responseStatus: null,
        responseBody: null,
        error,
        serials: [],
        log: [],
      }))
    }
    for (let i = 0; i < claimed.length; i++) {
      const outcome = outcomes[i]
      if (!outcome?.mutate) {
        results.push({
          jobId: claimed[i].id,
          action: outcome?.action ?? 'failed',
          error: outcome?.error ?? null,
          saveError: null,
          queueStatus: null,
        })
        continue
      }
      const saved = await input.store.save(claimed[i], outcome)
      results.push({
        jobId: claimed[i].id,
        action: outcome.action,
        error: outcome.error,
        saveError: saved.error,
        queueStatus: outcome.queueStatus,
      })
    }
  }
  return results
}
