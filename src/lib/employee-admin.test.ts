import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  DOCUMENTED_OWNER_EMAILS,
  isEmployeeAdmin,
  ownerAdminEmails,
} from './employee-admin'

const STAFF = {
  email: 'staff@example.com',
  app_metadata: {},
  user_metadata: { role: 'admin' },
}

describe('employee admin gate', () => {
  it('does not treat a user_metadata role as admin', () => {
    expect(isEmployeeAdmin(STAFF, ownerAdminEmails(undefined))).toBe(false)
    expect(isEmployeeAdmin({
      email: 'staff@example.com',
      app_metadata: { role: 'employee' },
      user_metadata: { role: 'admin' },
    }, ['staff@example.com'])).toBe(true)
  })

  it('accepts app_metadata admin and an allowlisted email', () => {
    expect(isEmployeeAdmin({
      email: 'staff@example.com',
      app_metadata: { role: 'admin' },
      user_metadata: { role: 'employee' },
    }, [])).toBe(true)
    expect(isEmployeeAdmin({
      email: ' Owner@Example.com ',
      app_metadata: {},
    }, ['owner@example.com'])).toBe(true)
  })

  it('uses OWNER_ADMIN_EMAILS when set and the documented contacts only when it is unset', () => {
    expect(ownerAdminEmails(undefined)).toEqual([...DOCUMENTED_OWNER_EMAILS])
    expect(ownerAdminEmails('   ')).toEqual([...DOCUMENTED_OWNER_EMAILS])
    expect(ownerAdminEmails('owner@example.com, second@example.com')).toEqual([
      'owner@example.com',
      'second@example.com',
    ])
    expect(ownerAdminEmails('owner@example.com')).not.toEqual(expect.arrayContaining([...DOCUMENTED_OWNER_EMAILS]))
  })

  it('the employee routes use this gate and the other staff routes do not', () => {
    const gate = readFileSync('src/lib/employee-admin.ts', 'utf8')
    expect(gate).not.toContain('user_metadata')
    const create = readFileSync('src/app/api/employees/create/route.ts', 'utf8')
    const remove = readFileSync('src/app/api/employees/delete/route.ts', 'utf8')
    expect(create).toContain('requireEmployeeAdmin()')
    expect(remove).toContain('requireEmployeeAdmin()')
    expect(create).not.toContain('app_metadata:')
    const manual = readFileSync('src/app/api/manual-charges/route.ts', 'utf8')
    expect(manual).toContain('requireStaff()')
    expect(manual).not.toContain('requireEmployeeAdmin')
    const page = readFileSync('src/app/manual-charges/page.tsx', 'utf8')
    expect(page).toContain('no approval action')
    expect(page).not.toContain('approved: true')
  })
})
