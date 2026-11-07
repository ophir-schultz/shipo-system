import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase-server'
import { requireStaff } from '@/lib/require-staff'

// Who may create or delete staff accounts.
//
// requireStaff() only checks that a Supabase Auth session exists. Every
// signed-in employee passed it, including the employee create and delete
// routes. The role label stored on the auth user can be changed by that
// user, so it is not an authorization source.
//
// This gate reads two server-side facts:
//   - app_metadata.role === 'admin', which only the service role can set
//   - an email allowlist
// The allowlist is OWNER_ADMIN_EMAILS when that variable is set. When it is
// unset, the fallback is the incident-contact addresses already written in
// docs/information-security-policy.md and the alert fallback. That keeps the
// current operator from being locked out before the variable is set. A set
// variable replaces the fallback; it does not add to it.
//
// team_members exists in schema.sql and is not read anywhere in the app, so
// it is not an assignment of who may manage employees.

export const OWNER_ADMIN_EMAILS_ENV = 'OWNER_ADMIN_EMAILS'

/** Incident-contact addresses already documented in this repo. */
export const DOCUMENTED_OWNER_EMAILS = [
  'ophir@shipousa.com',
  'ophir@getshipo.com',
] as const

export interface EmployeeAdminUser {
  email?: string | null
  app_metadata?: object | null
}

function appRole(meta: object | null | undefined): unknown {
  if (!meta || !('role' in meta)) return undefined
  return (meta as { role?: unknown }).role
}

export function ownerAdminEmails(envValue: string | undefined): string[] {
  const listed = (envValue ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0)
  if (listed.length > 0) return [...new Set(listed)]
  return [...DOCUMENTED_OWNER_EMAILS]
}

export function isEmployeeAdmin(user: EmployeeAdminUser, allowlist: readonly string[]): boolean {
  if (appRole(user.app_metadata) === 'admin') return true
  const email = user.email?.trim().toLowerCase() ?? ''
  if (!email) return false
  return allowlist.includes(email)
}

export async function requireEmployeeAdmin(): Promise<NextResponse | null> {
  const denied = await requireStaff()
  if (denied) return denied
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isEmployeeAdmin(user, ownerAdminEmails(process.env.OWNER_ADMIN_EMAILS))) {
    return NextResponse.json({ error: 'Not authorised to manage employees.' }, { status: 403 })
  }
  return null
}
