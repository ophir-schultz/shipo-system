import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { manualChargeRow, moneyAmount, parseManualCharge } from './manual-charge'

const CLIENT = '11111111-1111-4111-8111-111111111111'

describe('manual charge input', () => {
  it('accepts an explicit nonnegative amount and a real calendar day', () => {
    expect(moneyAmount('12.50')).toBe(12.5)
    expect(moneyAmount(0)).toBe(0)
    expect(moneyAmount('0.00')).toBe(0)
    const parsed = parseManualCharge({
      clientId: CLIENT,
      chargeDate: '2026-11-06',
      description: '  Relabel a carton  ',
      amount: '12.50',
      approved: true,
    })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value).toEqual({
      clientId: CLIENT,
      chargeDate: '2026-11-06',
      description: 'Relabel a carton',
      amount: 12.5,
    })
    expect(manualChargeRow(parsed.value, 'user-1', CLIENT)).toEqual({
      client_id: CLIENT,
      charge_date: '2026-11-06',
      description: 'Relabel a carton',
      amount: 12.5,
      added_by: 'user-1',
    })
  })

  it('rejects a missing amount, a negative amount, and extra precision', () => {
    expect(parseManualCharge({ clientId: CLIENT, chargeDate: '2026-11-06', description: 'Fee', amount: '' }).ok).toBe(false)
    expect(parseManualCharge({ clientId: CLIENT, chargeDate: '2026-11-06', description: 'Fee', amount: -1 }).ok).toBe(false)
    expect(parseManualCharge({ clientId: CLIENT, chargeDate: '2026-11-06', description: 'Fee', amount: '1.005' }).ok).toBe(false)
    expect(moneyAmount('1e2')).toBeNull()
    expect(moneyAmount(100000000)).toBeNull()
  })

  it('rejects a shifted timestamp and a day that does not exist', () => {
    expect(parseManualCharge({
      clientId: CLIENT, chargeDate: '2026-11-06T03:30:00.000Z', description: 'Fee', amount: '1.00',
    }).ok).toBe(false)
    expect(parseManualCharge({
      clientId: CLIENT, chargeDate: '2026-02-31', description: 'Fee', amount: '1.00',
    }).ok).toBe(false)
  })

  it('requires a client id and a description', () => {
    expect(parseManualCharge({
      clientId: 'not-a-client', chargeDate: '2026-11-06', description: 'Fee', amount: '1',
    }).ok).toBe(false)
    expect(parseManualCharge({
      clientId: CLIENT, chargeDate: '2026-11-06', description: '   ', amount: '1',
    }).ok).toBe(false)
  })

  it('the page names an empty list and does not invent an amount', () => {
    const page = readFileSync('src/app/manual-charges/page.tsx', 'utf8')
    expect(page).toContain("export const dynamic = 'force-dynamic'")
    expect(page).toContain('No manual charges recorded.')
    expect(page).toContain('No active clients, so a charge cannot be recorded.')
    expect(page).not.toContain('approved: true')
    expect(page).not.toContain('amount: 0')
    const route = readFileSync('src/app/api/manual-charges/route.ts', 'utf8')
    expect(route).toContain('requireStaff()')
    expect(route).not.toContain('warehouse_daily_log')
    expect(route).not.toContain('record_scan')
  })
})
