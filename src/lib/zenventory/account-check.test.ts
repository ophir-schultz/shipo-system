import { describe, expect, it, vi } from 'vitest'
import {
  inventoryCountOf,
  orderDateForImport,
  redactSecrets,
  runZenventoryCheck,
  summarizeOrders,
  zenventoryFailureKind,
  zenventoryFailureLabel,
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

  it('stores orderedDate, and still accepts the older field names', () => {
    expect(orderDateForImport({ orderedDate: '2026-11-03T15:00:00.000Z' })).toBe('2026-11-03')
    expect(orderDateForImport({ orderDate: '2026-09-01' })).toBe('2026-09-01')
    expect(orderDateForImport({ order_date: '2026-08-15T04:30:00.000Z' })).toBe('2026-08-15')
    expect(orderDateForImport({ orderNumber: 'A-1' })).toBeNull()
    expect(orderDateForImport({ orderedDate: 'not-a-date', orderDate: '2026-07-04' })).toBe('2026-07-04')
  })

  it('names a rejected credential separately from a timeout', () => {
    expect(zenventoryFailureKind('Zenventory API error: HTTP 401: unauthorized')).toBe('credentials')
    expect(zenventoryFailureKind('timeout of 15000ms exceeded')).toBe('timeout')
    expect(zenventoryFailureLabel('credentials')).toContain('not a timeout')
    expect(zenventoryFailureLabel('credentials')).toContain('No new credentials')
    expect(zenventoryFailureLabel('timeout')).toContain('did not answer in time')
    expect(zenventoryFailureLabel('credentials')).not.toMatch(/sk_|secret/i)
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
