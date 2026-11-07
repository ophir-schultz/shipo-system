import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { deliverOrder, type ZenventoryTransport } from './zenventory-pick'
import {
  claimProbeOk,
  decideSerialClaim,
  recordedScansFromRows,
  settleInLockOrder,
  type ClaimSubmission,
  type RecordedScan,
} from './serial-claim'

const client = '00000000-0000-4000-8000-000000000001'
const other = '00000000-0000-4000-8000-000000000002'

function scan(serials: string[], sku = 'SIM-SKU', orderRef = 'SO-1', who = client): ClaimSubmission {
  return { clientId: who, sku, orderRef, scanType: 'box', serials }
}

function recorded(serials: string[], sku = 'SIM-SKU', orderRef = 'SO-1', who = client): RecordedScan {
  return { scanEventId: 'prior', clientId: who, sku, orderRef, scanType: 'box', serials }
}

describe('claim readiness probe', () => {
  const probe = {
    ready: true,
    rpc: 'record_scan_claimed',
    version: 'client-sku-v1',
    old_record_scan: 'unchanged',
    old_has_claim_safety: false,
    checks: {
      advisory_lock: true,
      unique_claim: true,
      idempotent_retry: true,
      invoker: true,
      old_signature: '10-arg',
      duplicate_serials_shape: 'client_ids',
    },
  }

  it('accepts only the catalog shape for the new function', () => {
    expect(claimProbeOk(probe)).toBe(true)
    expect(claimProbeOk(true)).toBe(false)
    expect(claimProbeOk({ ready: true })).toBe(false)
    expect(claimProbeOk({ ...probe, rpc: 'record_scan' })).toBe(false)
    expect(claimProbeOk({ ...probe, old_has_claim_safety: true })).toBe(false)
  })
})

describe('serial claim, simulated scans', () => {
  it('refuses the same serial on a later scan of this client and SKU', () => {
    const decision = decideSerialClaim(scan(['SIM-2']), [recorded(['SIM-1', 'SIM-2'])])
    expect(decision.action).toBe('reject')
    if (decision.action !== 'reject') return
    expect(decision.message).toContain('SIM-2')
    expect(decision.message).toContain('this client and SKU')
    expect(decision.message).not.toContain(other)
  })

  it('allows the same text for another client and for another SKU', () => {
    const prior = [recorded(['SIM-1'], 'SIM-SKU', 'SO-1', other), recorded(['SIM-1'], 'OTHER-SKU')]
    expect(decideSerialClaim(scan(['SIM-1']), prior).action).toBe('record')
    const rows = recordedScansFromRows(client, [{
      serial: 'SIM-1',
      scan_events: {
        id: 'theirs',
        client_id: other,
        sku: 'SIM-SKU',
        order_ref: 'THEIR-ORDER',
        scan_type: 'box',
      },
    }])
    expect(rows).toEqual([])
  })

  it('treats a same-event retry, including a case change, as the original scan', () => {
    const prior = [recorded(['SIM-1', 'SIM-2'])]
    const again = decideSerialClaim(scan(['sim-2', 'SIM-1']), prior)
    expect(again).toEqual({ action: 'idempotent', scanEventId: 'prior' })
  })

  it('lets a second carton with new serials through and refuses one that repeats', () => {
    const first = scan(['SIM-1', 'SIM-2'])
    const next = scan(['SIM-3', 'SIM-4'])
    const repeat = scan(['SIM-4'])
    const settled = settleInLockOrder(first, next)
    expect(settled.first.action).toBe('record')
    expect(settled.second.action).toBe('record')
    const afterBoth: RecordedScan[] = [
      { ...recorded(['SIM-1', 'SIM-2']), scanEventId: 'carton-1' },
      { ...recorded(['SIM-3', 'SIM-4']), scanEventId: 'carton-2' },
    ]
    expect(decideSerialClaim(repeat, afterBoth).action).toBe('reject')
  })

  it('lets one of two simultaneous identical submissions win and makes the other a retry', () => {
    const one = scan(['SIM-1'])
    const settled = settleInLockOrder(one, { ...one, serials: ['sim-1'] })
    expect(settled.first.action).toBe('record')
    expect(settled.second.action).toBe('idempotent')
  })

  it('does not send a second pick after a repeated serial is refused', async () => {
    const settled = settleInLockOrder(scan(['AAA', 'BBB']), scan(['AAA']))
    expect(settled.second.action).toBe('reject')
    const puts: unknown[] = []
    const transport: ZenventoryTransport = {
      async getV2(path) {
        if (path.startsWith('/customer-orders/')) {
          return {
            status: 200,
            body: {
              items: [{
                sku: 'SIM-SKU',
                pickedQuantity: 2,
                additionalFields: { pickedSerialNumbers: [{ serial: 'AAA' }, { serial: 'BBB' }] },
              }],
            },
          }
        }
        return { status: 200, body: [{ id: 99, orderNumber: 'SO-1' }] }
      },
      async getLegacy(path) {
        if (path.endsWith('/items/pick')) {
          return {
            status: 200,
            body: [{
              customerorderitemid: 10,
              itemmaster: { sku: 'SIM-SKU' },
              location: { id: 3 },
              serialized: true,
              allocatedquantity: 2,
              pickedquantity: 0,
            }],
          }
        }
        return { status: 200, body: [{ customerorderid: 99, ordernumber: 'SO-1' }] }
      },
      async putLegacy(_path, body) {
        puts.push(body)
        return { status: 200, body: { items: [{ sku: 'SIM-SKU', pickedQuantity: 2, additionalFields: { pickedSerialNumbers: [{ serial: 'AAA' }, { serial: 'BBB' }] } }] } }
      },
    }
    const outcomes = await deliverOrder({
      jobs: [{
        id: 'job-1',
        clientId: client,
        orderRef: 'SO-1',
        sku: 'SIM-SKU',
        status: 'pending',
        serials: ['AAA', 'BBB'],
        serialRows: [{ id: 's1', serial: 'AAA' }, { id: 's2', serial: 'BBB' }],
      }],
      credentials: { apiKey: 'fixture-key', apiSecret: 'fixture-secret', secureKey: 'fixture-secure' },
      transport,
      now: '2026-11-07T12:00:00.000Z',
      shipmentTracking: ['1Z-SIM'],
    })
    expect(puts).toHaveLength(1)
    expect(outcomes.map((row) => row.action)).toEqual(['sent'])
  })

  it('keeps a partial carton unpicked until the line is complete, then picks once', async () => {
    const partial = settleInLockOrder(scan(['AAA', 'BBB']), scan(['CCC', 'DDD']))
    expect(partial.first.action).toBe('record')
    expect(partial.second.action).toBe('record')
    let puts = 0
    const transport = (complete: boolean): ZenventoryTransport => ({
      async getV2(path) {
        if (path === '/customer-orders') return { status: 200, body: [{ id: 99, orderNumber: 'SO-1' }] }
        const serials = complete ? ['AAA', 'BBB', 'CCC', 'DDD'] : ['AAA', 'BBB']
        return {
          status: 200,
          body: {
            items: [{
              sku: 'SIM-SKU',
              pickedQuantity: serials.length,
              additionalFields: { pickedSerialNumbers: serials.map((serial) => ({ serial })) },
            }],
          },
        }
      },
      async getLegacy(path) {
        if (path.endsWith('/items/pick')) {
          return {
            status: 200,
            body: [{
              customerorderitemid: 10,
              itemmaster: { sku: 'SIM-SKU' },
              location: { id: 3 },
              serialized: true,
              allocatedquantity: 4,
              pickedquantity: 0,
            }],
          }
        }
        return { status: 200, body: [{ customerorderid: 99, ordernumber: 'SO-1' }] }
      },
      async putLegacy() {
        puts += 1
        return { status: 200, body: [] }
      },
    })
    const open = {
      id: 'job-1',
      clientId: client,
      orderRef: 'SO-1',
      sku: 'SIM-SKU',
      status: 'pending' as const,
      serialRows: [{ id: 's1', serial: 'AAA' }, { id: 's2', serial: 'BBB' }],
    }
    const waiting = await deliverOrder({
      jobs: [{ ...open, serials: ['AAA', 'BBB'] }],
      credentials: { apiKey: 'fixture-key', apiSecret: 'fixture-secret', secureKey: 'fixture-secure' },
      transport: transport(false),
      now: '2026-11-07T12:00:00.000Z',
      shipmentTracking: ['1Z-SIM'],
    })
    expect(waiting[0].error).toBe('scan incomplete')
    expect(puts).toBe(0)
    const done = await deliverOrder({
      jobs: [{
        ...open,
        serials: ['AAA', 'BBB', 'CCC', 'DDD'],
        serialRows: ['AAA', 'BBB', 'CCC', 'DDD'].map((serial, index) => ({ id: `s${index}`, serial })),
      }],
      credentials: { apiKey: 'fixture-key', apiSecret: 'fixture-secret', secureKey: 'fixture-secure' },
      transport: transport(true),
      now: '2026-11-07T12:00:00.000Z',
      shipmentTracking: ['1Z-SIM'],
    })
    expect(done[0].action).toBe('sent')
    expect(puts).toBe(1)
  })
})

describe('scan_serial_claims.sql, not executed', () => {
  const sql = readFileSync('supabase/scan_serial_claims.sql', 'utf8')

  it('adds a client and SKU claim and does not rewrite stored scans', () => {
    expect(sql).toContain('unique (client_id, sku_key, serial_key)')
    expect(sql).toContain('pg_advisory_xact_lock')
    expect(sql).toContain('idempotent')
    expect(sql).toContain('already scanned for this client and SKU')
    expect(sql).toContain('e.client_id = p_client_id')
    expect(sql).not.toMatch(/delete\s+from\s+scanned_serials/i)
    expect(sql).not.toMatch(/delete\s+from\s+scan_events/i)
    expect(sql).not.toContain('array_agg(distinct e.client_id)')
  })
})
