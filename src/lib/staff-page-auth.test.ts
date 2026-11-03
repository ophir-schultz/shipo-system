// Staff password login already exists. src/proxy.ts sends anyone without a
// Supabase Auth session to /login, and /login signs in with a password.
// New pages have to stay inside that guard. API routes are outside the
// proxy matcher on purpose, so each one calls requireStaff() itself.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { config } from '../proxy'

const MATCHER = config.matcher[0]

function guarded(path: string): boolean {
  return new RegExp(`^${MATCHER}$`).test(path)
}

const STAFF_PAGES = ['/dashboard', '/pnl', '/client-report', '/order-pnl', '/profit', '/clients', '/data-issues']

describe('staff password login still covers the new pages', () => {
  it('keeps Supabase password sign-in on /login', () => {
    const login = readFileSync(join(__dirname, '../app/login/page.tsx'), 'utf8')
    const route = readFileSync(join(__dirname, '../app/api/auth/login/route.ts'), 'utf8')
    expect(login).toContain('/api/auth/login')
    expect(login).toContain('type="password"')
    expect(route).toContain('signInWithPassword')
  })

  it('logs the Supabase auth error without the password or keys', () => {
    const route = readFileSync(join(__dirname, '../app/api/auth/login/route.ts'), 'utf8')
    const logStart = route.indexOf("console.error('[auth/login] sign-in failed'")
    const log = route.slice(logStart, route.indexOf('})', logStart) + 2)
    expect(log).toContain('signInError.message')
    expect(log).toContain('signInError.status')
    expect(log).not.toContain('password')
    expect(log).not.toContain('process.env')
    expect(log).not.toContain('signInError)')
    expect(route).toContain("error: 'Invalid email or password.'")
  })

  it('runs the staff proxy on the new pages and not on the partner portal', () => {
    for (const path of STAFF_PAGES) expect(guarded(path)).toBe(true)
    expect(guarded('/partner')).toBe(false)
    expect(guarded('/partner/login')).toBe(false)
  })

  it('does not exclude the new pages from the matcher', () => {
    expect(MATCHER).not.toContain('client-report')
    expect(MATCHER).not.toContain('order-pnl')
  })
})
