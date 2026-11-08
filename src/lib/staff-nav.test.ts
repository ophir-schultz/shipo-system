import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { STAFF_NAV, STAFF_SETTINGS, staffNavGroupFor, staffNavHrefs } from './staff-nav'

const PREVIOUS = [
  '/dashboard', '/clients', '/shipments', '/rate-check', '/data-issues', '/losses',
  '/adjustments', '/warehouse', '/scan', '/serials', '/billing', '/client-report',
  '/serial-report', '/order-pnl', '/profit', '/statements', '/referrals', '/quotes',
  '/reports', '/employees', '/marketing',
]

describe('staff navigation groups', () => {
  it('uses four main groups and tucks settings away', () => {
    expect(STAFF_NAV.map((group) => group.label)).toEqual(['Overview', 'Orders', 'Financials', 'Reports'])
    expect(STAFF_SETTINGS.map((item) => item.href)).toEqual(['/employees', '/marketing'])
  })

  it('keeps every previous route and the full-picture screens', () => {
    const hrefs = staffNavHrefs()
    for (const href of PREVIOUS) expect(hrefs, href).toContain(href)
    expect(hrefs).toContain('/pnl')
    expect(hrefs).toContain('/ledger')
    expect(new Set(hrefs).size).toBe(hrefs.length)
  })

  it('maps a deep client url to Orders and does not send partners here', () => {
    expect(staffNavGroupFor('/clients/abc')).toBe('orders')
    expect(staffNavGroupFor('/pnl')).toBe('financials')
    expect(staffNavGroupFor('/partner')).toBeNull()
    const sidebar = readFileSync('src/components/layout/Sidebar.tsx', 'utf8')
    expect(sidebar).toContain("from '@/lib/staff-nav'")
    const partner = readFileSync('src/app/partner/layout.tsx', 'utf8')
    expect(partner).not.toContain('staff-nav')
    expect(partner).not.toContain('STAFF_NAV')
  })
})
