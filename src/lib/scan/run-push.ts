import {
  deliverJob,
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
 * Claims each open job, delivers it, then asks the store to persist.
 * A job already marked done is left untouched. The transport is injected
 * so a test never opens a socket.
 */
export async function runPush(input: {
  jobs: RunnableJob[]
  store: PushStore
  transport: ZenventoryTransport
  nayaxUrl: string | null
  nayaxPost: (url: string, body: unknown) => Promise<{ status: number; body: unknown }>
  now: string
}): Promise<PushRunResult[]> {
  const results: PushRunResult[] = []
  for (const job of input.jobs) {
    if (job.status === 'done') {
      results.push({ jobId: job.id, action: 'skipped', error: null, saveError: null, queueStatus: null })
      continue
    }
    const claim = await input.store.claim(job.id)
    if (claim.error || !claim.ok) {
      results.push({
        jobId: job.id,
        action: 'failed',
        error: claim.error ?? 'The job was not claimed',
        saveError: null,
        queueStatus: null,
      })
      continue
    }
    const creds = await input.store.credentials(job.clientId)
    if (creds.error || !creds.credentials) {
      const outcome: PushOutcome = {
        action: 'failed',
        mutate: true,
        queueStatus: 'failed',
        attemptsIncrement: true,
        requestPayload: null,
        responseStatus: null,
        responseBody: null,
        error: creds.error ?? 'Client credentials could not be read',
        serials: [],
        log: [],
      }
      const saved = await input.store.save(job, outcome)
      results.push({
        jobId: job.id,
        action: 'failed',
        error: outcome.error,
        saveError: saved.error,
        queueStatus: 'failed',
      })
      continue
    }
    let outcome: PushOutcome
    try {
      outcome = await deliverJob({
        job,
        credentials: creds.credentials,
        transport: input.transport,
        nayaxUrl: input.nayaxUrl,
        nayaxPost: input.nayaxPost,
        now: input.now,
      })
    } catch (err) {
      outcome = {
        action: 'failed',
        mutate: true,
        queueStatus: 'failed',
        attemptsIncrement: true,
        requestPayload: null,
        responseStatus: null,
        responseBody: null,
        error: err instanceof Error ? err.message : String(err),
        serials: [],
        log: [],
      }
    }
    if (!outcome.mutate) {
      results.push({ jobId: job.id, action: outcome.action, error: outcome.error, saveError: null, queueStatus: null })
      continue
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
  return results
}
