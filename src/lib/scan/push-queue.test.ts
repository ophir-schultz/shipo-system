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
    expect(livePushRefusal()).toContain('No request was sent')
  })
})
