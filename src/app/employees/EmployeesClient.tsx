'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

const ROLES = ['admin', 'manager', 'employee', 'warehouse']

type Employee = {
  id: string
  email: string
  name: string
  role: string
  created_at: string
  last_sign_in: string | null
}

export default function EmployeesClient({ employees }: { employees: Employee[] }) {
  const router = useRouter()
  const [showInvite, setShowInvite] = useState(false)
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteName, setInviteName] = useState('')
  const [inviteRole, setInviteRole] = useState('employee')
  const [invitePassword, setInvitePassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setMessage(null)
    const res = await fetch('/api/employees/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: inviteEmail, name: inviteName, role: inviteRole, password: invitePassword }),
    })
    const data = await res.json()
    if (res.ok) {
      setMessage({ type: 'success', text: `User ${inviteEmail} created successfully.` })
      setInviteEmail('')
      setInviteName('')
      setInvitePassword('')
      setInviteRole('employee')
      setShowInvite(false)
      router.refresh()
    } else {
      setMessage({ type: 'error', text: data.error ?? 'Failed to create user.' })
    }
    setLoading(false)
  }

  async function handleDelete(id: string, email: string) {
    if (!confirm(`Remove ${email} from the system?`)) return
    const res = await fetch('/api/employees/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    })
    if (res.ok) {
      setMessage({ type: 'success', text: `${email} removed.` })
      router.refresh()
    } else {
      const d = await res.json()
      setMessage({ type: 'error', text: d.error ?? 'Failed to remove user.' })
    }
  }

  return (
    <div className="space-y-4">
      {message && (
        <div className={`px-4 py-3 rounded-lg text-sm ${message.type === 'success' ? 'bg-green-950/40 border border-green-800/40 text-green-400' : 'bg-red-950/40 border border-red-800/40 text-red-400'}`}>
          {message.text}
        </div>
      )}

      <div className="flex justify-between items-center">
        <p className="text-sm text-[#4B4F58]">Manage who has access to the Shipo Operations Platform.</p>
        <button
          onClick={() => setShowInvite(v => !v)}
          className="px-4 py-2 rounded-lg text-sm font-medium text-[#0B1220] transition"
          style={{ background: '#1A73E8' }}
        >
          + Add Employee
        </button>
      </div>

      {/* Add employee form */}
      {showInvite && (
        <form onSubmit={handleInvite} className="bg-white rounded-xl p-5 space-y-4">
          <h3 className="font-semibold text-[#0B1220] text-sm">New Employee Account</h3>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-[#4B4F58] mb-1">Full Name</label>
              <input
                type="text"
                value={inviteName}
                onChange={e => setInviteName(e.target.value)}
                required
                placeholder="John Smith"
                className="w-full bg-[#EEF3FA] border border-[#CBD5E1] rounded-lg px-3 py-2 text-[#0B1220] text-sm focus:outline-none focus:border-[#1A73E8]"
              />
            </div>
            <div>
              <label className="block text-xs text-[#4B4F58] mb-1">Email</label>
              <input
                type="email"
                value={inviteEmail}
                onChange={e => setInviteEmail(e.target.value)}
                required
                placeholder="employee@shipousa.com"
                className="w-full bg-[#EEF3FA] border border-[#CBD5E1] rounded-lg px-3 py-2 text-[#0B1220] text-sm focus:outline-none focus:border-[#1A73E8]"
              />
            </div>
            <div>
              <label className="block text-xs text-[#4B4F58] mb-1">Password</label>
              <input
                type="password"
                value={invitePassword}
                onChange={e => setInvitePassword(e.target.value)}
                required
                placeholder="Temporary password"
                className="w-full bg-[#EEF3FA] border border-[#CBD5E1] rounded-lg px-3 py-2 text-[#0B1220] text-sm focus:outline-none focus:border-[#1A73E8]"
              />
            </div>
            <div>
              <label className="block text-xs text-[#4B4F58] mb-1">Role</label>
              <select
                value={inviteRole}
                onChange={e => setInviteRole(e.target.value)}
                className="w-full bg-[#EEF3FA] border border-[#CBD5E1] rounded-lg px-3 py-2 text-[#0B1220] text-sm focus:outline-none focus:border-[#1A73E8]"
              >
                {ROLES.map(r => <option key={r} value={r}>{r.charAt(0).toUpperCase() + r.slice(1)}</option>)}
              </select>
            </div>
          </div>
          <div className="flex gap-3 pt-1">
            <button
              type="submit"
              disabled={loading}
              className="px-4 py-2 rounded-lg text-sm font-medium text-[#0B1220] disabled:opacity-50 transition"
              style={{ background: '#1A73E8' }}
            >
              {loading ? 'Creating…' : 'Create Account'}
            </button>
            <button type="button" onClick={() => setShowInvite(false)} className="px-4 py-2 rounded-lg text-sm text-[#4B4F58] hover:text-[#0B1220] bg-[#EEF3FA] hover:bg-[#DDE6F2] transition">
              Cancel
            </button>
          </div>
        </form>
      )}

      {/* Employee list */}
      <div className="bg-white rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[#4B4F58] text-left border-b border-[#E2E8F0] text-xs uppercase tracking-wider bg-[#F1F5FB]">
              <th className="px-5 py-3">Name</th>
              <th className="px-4 py-3">Email</th>
              <th className="px-4 py-3">Role</th>
              <th className="px-4 py-3">Added</th>
              <th className="px-4 py-3">Last Sign In</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {employees.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-5 py-12 text-center text-[#6B7A8D]">No employees yet</td>
              </tr>
            ) : employees.map(emp => (
              <tr key={emp.id} className="border-b border-[#E2E8F0]/40 hover:bg-[#EEF3FA]/20">
                <td className="px-5 py-3 font-medium text-[#0B1220]">{emp.name || <span className="text-[#6B7A8D]">—</span>}</td>
                <td className="px-4 py-3 text-[#3A4658]">{emp.email}</td>
                <td className="px-4 py-3">
                  <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                    emp.role === 'admin' ? 'bg-purple-900/50 text-purple-300' :
                    emp.role === 'manager' ? 'text-[#0B1220]' :
                    emp.role === 'warehouse' ? 'bg-blue-900/50 text-blue-300' :
                    'bg-[#EEF3FA] text-[#3A4658]'
                  }`}
                  style={emp.role === 'manager' ? { background: '#1A73E833', color: '#1A73E8' } : {}}>
                    {emp.role}
                  </span>
                </td>
                <td className="px-4 py-3 text-[#6B7A8D] text-xs">{new Date(emp.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</td>
                <td className="px-4 py-3 text-[#6B7A8D] text-xs">{emp.last_sign_in ? new Date(emp.last_sign_in).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'Never'}</td>
                <td className="px-4 py-3 text-right">
                  <button
                    onClick={() => handleDelete(emp.id, emp.email)}
                    className="text-xs text-[#6B7A8D] hover:text-red-400 transition px-2 py-1 rounded hover:bg-red-950/30"
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
