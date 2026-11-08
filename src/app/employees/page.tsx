import { supabaseAdmin } from '@/lib/supabase'
import { createClient } from '@/lib/supabase-server'
import type { User } from '@supabase/supabase-js'
import EmployeesClient from './EmployeesClient'
import MfaSetup from '@/components/auth/MfaSetup'
import ViewUnreadable from '@/components/ui/ViewUnreadable'
import { isEmployeeAdmin, ownerAdminEmails } from '@/lib/employee-admin'

// Without this line Next prerendered this page at build time, so the staff list
// was the list as of the last deploy: an employee added through this screen did
// not appear on it, and one removed still did. See the long note on the same
// line in src/app/reports/page.tsx for how it was found.
//
// This one is a security consideration and not only a stale-data one. The list
// comes from `auth.admin.listUsers()`, so a revoked account kept showing as
// current staff, and prerendering wrote names and email addresses into a static
// HTML file on disk rather than rendering them per authenticated request.
export const dynamic = 'force-dynamic'

// listUsers defaults to one page. A failed call used to fall through to
// `users?.users ?? []`, and the header then said "0 users with access".
const PER_PAGE = 1000

export default async function EmployeesPage() {
  const employees: Array<{
    id: string
    email: string
    name: string
    role: string
    created_at: string
    last_sign_in: string | null
  }> = []
  let page = 1
  for (;;) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: PER_PAGE })
    if (error) {
      return (
        <div className="space-y-6">
          <div>
            <h2 className="text-2xl font-bold text-[#0B1220]">Employees</h2>
            <p className="text-[#4B4F58] text-sm mt-1">Staff accounts</p>
          </div>
          <ViewUnreadable message={`auth.users: ${error.message}`} />
        </div>
      )
    }
    const batch: User[] = data?.users ?? []
    for (const u of batch) {
      employees.push({
        id: u.id,
        email: u.email ?? '',
        name: (u.user_metadata?.full_name as string) ?? '',
        role: (u.user_metadata?.role as string) ?? 'employee',
        created_at: u.created_at,
        last_sign_in: u.last_sign_in_at ?? null,
      })
    }
    if (batch.length < PER_PAGE) break
    page += 1
  }

  const session = await createClient()
  const { data: { user } } = await session.auth.getUser()
  const canManage = !!user && isEmployeeAdmin(user, ownerAdminEmails(process.env.OWNER_ADMIN_EMAILS))

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-[#0B1220]">Employees</h2>
        <p className="text-[#4B4F58] text-sm mt-1">{employees.length} user{employees.length !== 1 ? 's' : ''} with access</p>
      </div>
      <EmployeesClient employees={employees} canManage={canManage} />

      <div>
        <h3 className="text-lg font-semibold text-[#0B1220] mb-3">My Security</h3>
        <div className="max-w-md">
          <MfaSetup />
        </div>
      </div>
    </div>
  )
}
