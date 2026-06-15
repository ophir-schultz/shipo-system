import { supabaseAdmin } from '@/lib/supabase'
import EmployeesClient from './EmployeesClient'

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
        <h2 className="text-2xl font-bold text-white">Employees</h2>
        <p className="text-gray-400 text-sm mt-1">{employees.length} user{employees.length !== 1 ? 's' : ''} with access</p>
      </div>
      <EmployeesClient employees={employees} />
    </div>
  )
}
