import { describe, expect, it } from 'vitest'
import {
  deliverJob,
  pickBody,
  pickLinesIn,
  priceKeys,
  type DeliverJobInput,
  type HttpResult,
  type ZenventoryTransport,
} from './zenventory-pick'
import { runPush, type PushStore, type RunnableJob } from './run-push'

const NOW = '2026-11-03T12:00:00.000Z'

const LINE = {
  customerorderitemid: 10,
  itemmaster: { sku: 'R1' },
  location: { id: 3 },
  serialized: true,
  allocatedquantity: 2,
  pickedquantity: 0,
  customerprice: 12.5,
}

function transport(handlers: {
  v2?: HttpResult
  legacyList?: HttpResult
  pickGet?: HttpResult
  pickPut?: HttpResult
}): { transport: ZenventoryTransport; puts: unknown[] } {
  const puts: unknown[] = []
  return {
    puts,
    transport: {
      async getV2() {
        return handlers.v2 ?? { status: 200, body: [{ id: 99, orderNumber: 'SO1' }] }
      },
      async getLegacy(path) {
        if (path.endsWith('/items/pick')) return handlers.pickGet ?? { status: 200, body: [LINE] }
        return handlers.legacyList ?? { status: 200, body: [] }
      },
      async putLegacy(_path, body) {
        puts.push(body)
        return handlers.pickPut ?? { status: 200, body: [] }
      },
    },
  }
}

function job(overrides: Partial<DeliverJobInput['job']> = {}): DeliverJobInput['job'] {
  return {
    id: 'job-1',
    clientId: 'client-1',
    orderRef: 'SO1',
    sku: 'R1',
    status: 'pending',
    serials: ['111', '222'],
    serialRows: [
      { id: 's1', serial: '111' },
      { id: 's2', serial: '222' },
    ],
    ...overrides,
  }
}

function input(overrides: Partial<DeliverJobInput> & { handlers?: Parameters<typeof transport>[0] } = {}): DeliverJobInput & { puts: unknown[] } {
  const built = transport(overrides.handlers ?? {})
  return {
    puts: built.puts,
    job: overrides.job ?? job(),
    credentials: overrides.credentials ?? { apiKey: 'key', apiSecret: 'secret', secureKey: 'secure' },
    transport: overrides.transport ?? built.transport,
    nayaxUrl: overrides.nayaxUrl === undefined ? null : overrides.nayaxUrl,
    nayaxPost: overrides.nayaxPost ?? (async () => ({ status: 200, body: { ok: true } })),
    now: NOW,
  }
}

describe('pick body', () => {
  it('sends serials and quantity and leaves the price on the read line behind', () => {
    const [line] = pickLinesIn([LINE])
    const body = pickBody(line, ['111', '222'])
    expect(body).toEqual([{
      customerorderitemid: 10,
      locationid: 3,
      lotnumber: '',
      expirationdate: null,
      serials: ['111', '222'],
      quantity: 2,
    }])
    expect(priceKeys(body)).toEqual([])
    expect(JSON.stringify(body)).not.toContain('customerprice')
  })
})

describe('deliverJob', () => {
  it('does not call Zenventory when the job is already done', async () => {
    let calls = 0
    const { transport: http } = transport({})
    const wrapped: ZenventoryTransport = {
      async getV2() { calls += 1; return http.getV2('', {}, { apiKey: '', apiSecret: '' }) },
      async getLegacy() { calls += 1; return http.getLegacy('', {}, '') },
      async putLegacy() { calls += 1; return http.putLegacy('', {}, '') },
    }
    const outcome = await deliverJob({ ...input(), job: job({ status: 'done' }), transport: wrapped })
    expect(outcome.action).toBe('skipped')
    expect(outcome.mutate).toBe(false)
    expect(calls).toBe(0)
  })

  it('does not pick again when the line already has a picked quantity', async () => {
    const sent = input({
      handlers: { pickGet: { status: 200, body: [{ ...LINE, pickedquantity: 2 }] } },
    })
    const outcome = await deliverJob(sent)
    expect(outcome.action).toBe('failed')
    expect(outcome.queueStatus).toBe('failed')
    expect(outcome.attemptsIncrement).toBe(false)
    expect(sent.puts).toEqual([])
    expect(outcome.serials.map((row) => row.zenventoryStatus)).toEqual(['skipped', 'skipped'])
    expect(outcome.log.every((row) => row.channel === 'zenventory' && row.status === 'skipped')).toBe(true)
  })

  it('waits without a pick when the scanned count is short of the allocation', async () => {
    const sent = input({ job: job({ serials: ['111'], serialRows: [{ id: 's1', serial: '111' }] }) })
    const outcome = await deliverJob(sent)
    expect(outcome.action).toBe('waiting')
    expect(outcome.queueStatus).toBe('pending')
    expect(sent.puts).toEqual([])
    expect(outcome.log).toEqual([])
  })

  it('picks once, records the serials, and leaves Nayax not configured when no URL is set', async () => {
    const posts: unknown[] = []
    const sent = input({
      nayaxPost: async (_url, body) => {
        posts.push(body)
        return { status: 200, body: {} }
      },
    })
    const outcome = await deliverJob(sent)
    expect(outcome.action).toBe('sent')
    expect(outcome.queueStatus).toBe('done')
    expect(sent.puts).toHaveLength(1)
    expect(priceKeys(sent.puts[0])).toEqual([])
    expect(posts).toEqual([])
    expect(outcome.serials[0]).toMatchObject({
      zenventoryStatus: 'sent',
      zenventorySentAt: NOW,
      nayaxStatus: 'not_configured',
      nayaxSentAt: null,
    })
    expect(outcome.log.map((row) => `${row.channel}:${row.status}`)).toEqual([
      'zenventory:sent',
      'zenventory:sent',
      'nayax:not_configured',
      'nayax:not_configured',
    ])
  })

  it('posts the serials to the Nayax URL only after the pick succeeds', async () => {
    const posts: unknown[] = []
    const sent = input({
      nayaxUrl: 'https://nayax.example/serials',
      nayaxPost: async (_url, body) => {
        posts.push(body)
        return { status: 200, body: { accepted: true } }
      },
    })
    const outcome = await deliverJob(sent)
    expect(posts).toEqual([{
      clientId: 'client-1',
      orderRef: 'SO1',
      sku: 'R1',
      serials: ['111', '222'],
    }])
    expect(priceKeys(posts[0])).toEqual([])
    expect(outcome.serials[0].nayaxStatus).toBe('sent')
    expect(outcome.serials[0].nayaxSentAt).toBe(NOW)
    expect(outcome.queueStatus).toBe('done')
  })

  it('keeps the Zenventory send when Nayax answers with an error', async () => {
    const sent = input({
      nayaxUrl: 'https://nayax.example/serials',
      nayaxPost: async () => ({ status: 500, body: { error: 'down' } }),
    })
    const outcome = await deliverJob(sent)
    expect(outcome.queueStatus).toBe('done')
    expect(outcome.serials[0].zenventoryStatus).toBe('sent')
    expect(outcome.serials[0].nayaxStatus).toBe('failed')
    expect(outcome.error).toContain('Nayax')
  })

  it('does not call Nayax when the pick is refused', async () => {
    let posts = 0
    const sent = input({
      handlers: { pickPut: { status: 409, body: { error: 'no' } } },
      nayaxUrl: 'https://nayax.example/serials',
      nayaxPost: async () => {
        posts += 1
        return { status: 200, body: {} }
      },
    })
    const outcome = await deliverJob(sent)
    expect(outcome.queueStatus).toBe('failed')
    expect(outcome.attemptsIncrement).toBe(true)
    expect(posts).toBe(0)
    expect(outcome.serials[0].zenventoryStatus).toBe('failed')
    expect(outcome.serials[0].nayaxStatus).toBeNull()
  })

  it('uses the legacy order list when the 2.0 key is rejected', async () => {
    const sent = input({
      handlers: {
        v2: { status: 401, body: { message: 'Unauthorized' } },
        legacyList: { status: 200, body: [{ customerorderid: 99, ordernumber: 'SO1' }] },
      },
    })
    const outcome = await deliverJob(sent)
    expect(outcome.action).toBe('sent')
    expect(sent.puts).toHaveLength(1)
  })
})

describe('runPush', () => {
  it('does not claim or save a job that is already done', async () => {
    const done: RunnableJob = {
      id: 'job-1',
      clientId: 'c',
      orderRef: 'SO1',
      sku: 'R1',
      status: 'done',
      attempts: 1,
      serials: ['111'],
      serialRows: [{ id: 's1', serial: '111' }],
    }
    let claims = 0
    const store: PushStore = {
      async claim() { claims += 1; return { ok: true, error: null } },
      async credentials() { return { credentials: null, error: 'no' } },
      async save() { return { error: 'should not save' } },
    }
    const { transport: http } = transport({})
    const results = await runPush({
      jobs: [done],
      store,
      transport: http,
      nayaxUrl: null,
      nayaxPost: async () => ({ status: 200, body: {} }),
      now: NOW,
    })
    expect(results).toEqual([{ jobId: 'job-1', action: 'skipped', error: null, saveError: null, queueStatus: null }])
    expect(claims).toBe(0)
  })
})
