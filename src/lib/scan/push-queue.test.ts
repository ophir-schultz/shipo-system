import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { livePushRefusal, pushPayload, pushQueueMode } from './push-queue'

describe('pushQueueMode', () => {
  it('stays disabled unless the enable flag is exactly true', () => {
    expect(pushQueueMode({})).toBe('disabled')
    expect(pushQueueMode({ ZENVENTORY_PUSH_ENABLED: '1' })).toBe('disabled')
    expect(pushQueueMode({ ZENVENTORY_PUSH_ENABLED: 'TRUE' })).toBe('disabled')
    expect(pushQueueMode({ ZENVENTORY_PUSH_EXECUTE: 'true' })).toBe('disabled')
  })

  it('dry-runs when enabled and does not execute unless that flag is also exactly true', () => {
    expect(pushQueueMode({ ZENVENTORY_PUSH_ENABLED: 'true' })).toBe('dry-run')
    expect(pushQueueMode({
      ZENVENTORY_PUSH_ENABLED: 'true',
      ZENVENTORY_PUSH_EXECUTE: 'false',
    })).toBe('dry-run')
    expect(pushQueueMode({
      ZENVENTORY_PUSH_ENABLED: 'true',
      ZENVENTORY_PUSH_EXECUTE: 'true',
    })).toBe('execute')
  })

  it('describes a payload without sending it', () => {
    const payload = pushPayload({
      id: 'j',
      clientId: 'c',
      orderRef: 'SO1',
      sku: 'R1',
      status: 'pending',
      attempts: 0,
      serials: ['111', '222'],
    })
    expect(payload).toEqual({ orderRef: 'SO1', sku: 'R1', serials: ['111', '222'] })
    expect(livePushRefusal()).toContain('did not send serials')
    expect(livePushRefusal()).toContain('POST /api/scan/push')
  })
})

describe('push route', () => {
  it('keeps GET from sending and keeps a disabled POST off the queue', () => {
    const src = readFileSync(join(__dirname, '../../app/api/scan/push/route.ts'), 'utf8')
    const getFn = src.slice(src.indexOf('export async function GET'), src.indexOf('async function serialRowsFor'))
    expect(getFn).not.toContain('runPush')
    expect(src).toContain("if (mode === 'disabled')")
    expect(src).toContain('createZenventoryTransport')
  })
})
