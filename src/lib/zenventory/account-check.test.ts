import { describe, expect, it, vi } from 'vitest'
import {
  inventoryCountOf,
  redactSecrets,
  runZenventoryCheck,
  summarizeOrders,
} from './account-check'

const NOW = new Date('2026-11-04T12:00:00.000Z')

describe('zenventory account check', () => {
  it('counts orders in the last 7 days and keeps the latest date', () => {
    const summary = summarizeOrders([
      { orderedDate: '2026-11-03T15:00:00.000Z' },
      { orderDate: '2026-10-20T00:00:00.000Z' },
      { orderedDate: '2026-11-01T08:00:00.000Z' },
      { orderedDate: 'not-a-date' },
    ], '2026-10-28T12:00:00.000Z')
    expect(summary).toEqual({
      count: 2,
      latestOrderDate: '2026-11-03T15:00:00.000Z',
    })
  })

  it('reads the inventory total from meta.count', () => {
    expect(inventoryCountOf({ inventory: [{ item: { sku: 'A' } }], meta: { count: 40, totalPages: 2 } })).toBe(40)
    expect(inventoryCountOf({ inventory: [{ item: { sku: 'A' } }] })).toBe(1)
  })

  it('strips credential text out of an error', () => {
    expect(redactSecrets('HTTP 401: bad fixture-key and fixture-secret', ['fixture-key', 'fixture-secret']))
      .toBe('HTTP 401: bad [redacted] and [redacted]')
  })

  it('returns both counts when both reads succeed', async () => {
    const fetchOrders = vi.fn().mockResolvedValue({
      customerOrders: [
        { orderedDate: '2026-11-02T00:00:00.000Z' },
        { orderedDate: '2026-11-04T01:00:00.000Z' },
      ],
      meta: { totalPages: 1 },
    })
    const fetchInventory = vi.fn().mockResolvedValue({ meta: { count: 18 } })
    const result = await runZenventoryCheck({
      now: NOW,
      secrets: ['fixture-key', 'fixture-secret'],
      fetchOrders,
      fetchInventory,
    })
    expect(fetchOrders).toHaveBeenCalledWith(1, '2026-10-28T12:00:00.000Z')
    expect(result).toEqual({
      ok: true,
      orderCount: 2,
      latestOrderDate: '2026-11-04T01:00:00.000Z',
      inventoryCount: 18,
      error: null,
    })
  })

  it('keeps the order count when inventory fails, and does not repeat a secret', async () => {
    const result = await runZenventoryCheck({
      now: NOW,
      secrets: ['fixture-secret'],
      fetchOrders: async () => ({
        customerOrders: [{ orderedDate: '2026-11-03T00:00:00.000Z' }],
        meta: { totalPages: 1 },
      }),
      fetchInventory: async () => { throw new Error('HTTP 401: fixture-secret') },
    })
    expect(result.ok).toBe(false)
    expect(result.orderCount).toBe(1)
    expect(result.latestOrderDate).toBe('2026-11-03T00:00:00.000Z')
    expect(result.inventoryCount).toBeNull()
    expect(result.error).toContain('Inventory:')
    expect(result.error).not.toContain('fixture-secret')
    expect(result.error).toContain('[redacted]')
  })
})
