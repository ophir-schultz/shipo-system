import { supabaseAdmin } from '@/lib/supabase'
import EmployeesClient from './EmployeesClient'
import MfaSetup from '@/components/auth/MfaSetup'

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

export default async function EmployeesPage() {
  const { data: users } = await supabaseAdmin.auth.admin.listUsers()

  const employees = (users?.users ?? []).map(u => ({
    id: u.id,
    email: u.email ?? '',
    name: (u.user_metadata?.full_name as string) ?? '',
    role: (u.user_metadata?.role as string) ?? 'employee',
    created_at: u.created_at,
    last_sign_in: u.last_sign_in_at ?? null,
  }))

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-[#0B1220]">Employees</h2>
        <p className="text-[#4B4F58] text-sm mt-1">{employees.length} user{employees.length !== 1 ? 's' : ''} with access</p>
      </div>
      <EmployeesClient employees={employees} />

      <div>
        <h3 className="text-lg font-semibold text-[#0B1220] mb-3">My Security</h3>
        <div className="max-w-md">
          <MfaSetup />
        </div>
      </div>
    </div>
  )
}
