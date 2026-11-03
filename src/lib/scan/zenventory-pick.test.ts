import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  confirmReadBack,
  customerOrderPickPath,
  deliverOrder,
  pickBody,
  pickLinesIn,
  priceKeys,
  SCAN_INCOMPLETE,
  type HttpResult,
  type OrderJob,
  type ZenventoryTransport,
} from './zenventory-pick'
import { runPush, type PushStore, type RunnableJob } from './run-push'

const NOW = '2026-11-03T12:00:00.000Z'

function line(sku: string, id: number, allocated: number, picked = 0) {
  return {
    customerorderitemid: id,
    itemmaster: { sku },
    location: { id: 3 },
    serialized: true,
    allocatedquantity: allocated,
    pickedquantity: picked,
    customerprice: 12.5,
  }
}

function job(overrides: Partial<OrderJob> = {}): OrderJob {
  return {
    id: 'job-1',
    clientId: 'client-1',
    orderRef: 'SO1',
    sku: 'R1',
    status: 'pending',
    serials: ['AAA', 'BBB'],
    serialRows: [
      { id: 's1', serial: 'AAA' },
      { id: 's2', serial: 'BBB' },
    ],
    ...overrides,
  }
}

function harness(options: {
  pick?: unknown
  readBack?: HttpResult
  v2Status?: number
} = {}) {
  const puts: Array<{ path: string; body: unknown }> = []
  const transport: ZenventoryTransport = {
    async getV2(path) {
      if (path === '/customer-orders') return { status: options.v2Status ?? 200, body: [{ id: 99, orderNumber: 'SO1' }] }
      return options.readBack ?? {
        status: 200,
        body: {
          id: 99,
          orderNumber: 'SO1',
          items: [
            { sku: 'R1', pickedQuantity: 2, additionalFields: { pickedSerialNumbers: [{ serial: 'AAA' }, { serial: 'BBB' }] } },
            { sku: 'R2', pickedQuantity: 1, additionalFields: { pickedSerialNumbers: [{ serial: 'CCC' }] } },
          ],
        },
      }
    },
    async getLegacy(path) {
      if (path.endsWith('/items/pick')) return { status: 200, body: options.pick ?? [line('R1', 10, 2)] }
      return { status: 200, body: [{ customerorderid: 99, ordernumber: 'SO1' }] }
    },
    async putLegacy(path, body) {
      puts.push({ path, body })
      return { status: 200, body: [] }
    },
  }
  return { transport, puts }
}

describe('customer order pick', () => {
  it('builds a pick body with serials and no price', () => {
    const [parsed] = pickLinesIn([line('R1', 10, 2)])
    const body = pickBody(parsed, ['AAA', 'BBB'])
    expect(body[0].quantity).toBe(2)
    expect(priceKeys(body)).toEqual([])
    expect(customerOrderPickPath('99')).toBe('/customerorders/99/items/pick')
  })

  it('refuses a scan that is not linked to an order and does not call Zenventory', async () => {
    let calls = 0
    const { transport } = harness()
    const wrapped: ZenventoryTransport = {
      async getV2() { calls += 1; return { status: 200, body: [] } },
      async getLegacy() { calls += 1; return { status: 200, body: [] } },
      async putLegacy() { calls += 1; return { status: 200, body: [] } },
    }
    const [outcome] = await deliverOrder({
      jobs: [job({ orderRef: '  ' })],
      credentials: { apiKey: 'k', apiSecret: 's', secureKey: 'secure' },
      transport: wrapped,
      now: NOW,
    })
    expect(outcome.action).toBe('failed')
    expect(outcome.error).toContain('not linked to an order')
    expect(calls).toBe(0)
    expect(transport).toBeTruthy()
  })

  it('stays scan incomplete and does not pick until every serialized line is scanned', async () => {
    const sent = harness({
      pick: [line('R1', 10, 2), line('R2', 11, 1)],
    })
    const [outcome] = await deliverOrder({
      jobs: [job()],
      credentials: { apiKey: 'k', apiSecret: 's', secureKey: 'secure' },
      transport: sent.transport,
      now: NOW,
    })
    expect(outcome.action).toBe('waiting')
    expect(outcome.error).toBe(SCAN_INCOMPLETE)
    expect(outcome.queueStatus).toBe('pending')
    expect(outcome.serials[0].zenventoryStatus).toBe(SCAN_INCOMPLETE)
    expect(sent.puts).toEqual([])
  })

  it('sends one pick per order line once the order is complete, then confirms the read-back', async () => {
    const sent = harness({
      pick: [line('R1', 10, 2), line('R2', 11, 1)],
    })
    const outcomes = await deliverOrder({
      jobs: [
        job(),
        job({
          id: 'job-2',
          sku: 'R2',
          serials: ['CCC'],
          serialRows: [{ id: 's3', serial: 'CCC' }],
        }),
      ],
      credentials: { apiKey: 'k', apiSecret: 's', secureKey: 'secure' },
      transport: sent.transport,
      now: NOW,
    })
    expect(sent.puts.map((put) => put.path)).toEqual([
      '/customerorders/99/items/pick',
      '/customerorders/99/items/pick',
    ])
    expect(sent.puts.every((put) => !JSON.stringify(put.path).includes('inventory'))).toBe(true)
    expect(priceKeys(sent.puts[0].body)).toEqual([])
    expect(outcomes.map((row) => row.action)).toEqual(['sent', 'sent'])
    expect(outcomes[0].queueStatus).toBe('done')
    expect(outcomes[0].serials[0]).toMatchObject({ zenventoryStatus: 'sent', zenventorySentAt: NOW })
    expect(outcomes[0].log.every((row) => row.channel === 'zenventory')).toBe(true)
  })

  it('does not pick a line that already has a picked quantity', async () => {
    const sent = harness({ pick: [line('R1', 10, 2, 2)] })
    const [outcome] = await deliverOrder({
      jobs: [job()],
      credentials: { apiKey: 'k', apiSecret: 's', secureKey: 'secure' },
      transport: sent.transport,
      now: NOW,
    })
    expect(sent.puts).toEqual([])
    expect(outcome.serials[0].zenventoryStatus).toBe('skipped')
  })

  it('leaves the queue unconfirmed when the read-back does not show the serials', async () => {
    const sent = harness({
      readBack: { status: 200, body: { id: 99, items: [{ sku: 'R1', pickedQuantity: 0, additionalFields: { pickedSerialNumbers: [] } }] } },
    })
    const [outcome] = await deliverOrder({
      jobs: [job()],
      credentials: { apiKey: 'k', apiSecret: 's', secureKey: 'secure' },
      transport: sent.transport,
      now: NOW,
    })
    expect(sent.puts).toHaveLength(1)
    expect(outcome.queueStatus).toBe('failed')
    expect(outcome.serials[0].zenventoryStatus).toBe('unconfirmed')
  })

  it('confirms by picked quantity when the order payload has no serial list', () => {
    const result = confirmReadBack({ items: [{ sku: 'R1', pickedQuantity: 2, additionalFields: null }] }, 'R1', ['AAA', 'BBB'])
    expect(result.ok).toBe(true)
    expect(result.detail).toContain('picked quantity')
  })

  it('does not mention a Nayax webhook or an inventory adjustment', () => {
    const src = readFileSync(join(__dirname, 'zenventory-pick.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    expect(src).not.toContain('NAYAX_SERIAL_WEBHOOK_URL')
    expect(src).not.toContain('nayaxPost')
    expect(src).not.toContain('/inventory')
    expect(src).not.toContain('adjustment')
  })
})

describe('runPush', () => {
  it('does not claim a job that is already done', async () => {
    const done: RunnableJob = {
      id: 'job-1',
      clientId: 'c',
      orderRef: 'SO1',
      sku: 'R1',
      status: 'done',
      attempts: 1,
      serials: ['AAA'],
      serialRows: [{ id: 's1', serial: 'AAA' }],
    }
    let claims = 0
    const store: PushStore = {
      async claim() { claims += 1; return { ok: true, error: null } },
      async credentials() { return { credentials: null, error: 'no' } },
      async save() { return { error: 'should not save' } },
    }
    const { transport } = harness()
    const results = await runPush({ jobs: [done], store, transport, now: NOW })
    expect(results[0].action).toBe('skipped')
    expect(claims).toBe(0)
  })
})
