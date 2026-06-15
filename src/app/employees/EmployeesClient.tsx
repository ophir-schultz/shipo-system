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
        <p className="text-sm text-gray-400">Manage who has access to the Shipo Operations Platform.</p>
        <button
          onClick={() => setShowInvite(v => !v)}
          className="px-4 py-2 rounded-lg text-sm font-medium text-white transition"
          style={{ background: '#00AAFF' }}
        >
          + Add Employee
        </button>
      </div>

      {/* Add employee form */}
      {showInvite && (
        <form onSubmit={handleInvite} className="bg-gray-800 rounded-xl p-5 space-y-4">
          <h3 className="font-semibold text-white text-sm">New Employee Account</h3>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-gray-400 mb-1">Full Name</label>
              <input
                type="text"
                value={inviteName}
                onChange={e => setInviteName(e.target.value)}
                required
                placeholder="John Smith"
                className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-[#00AAFF]"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Email</label>
              <input
                type="email"
                value={inviteEmail}
                onChange={e => setInviteEmail(e.target.value)}
                required
                placeholder="employee@shipousa.com"
                className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-[#00AAFF]"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Password</label>
              <input
                type="password"
                value={invitePassword}
                onChange={e => setInvitePassword(e.target.value)}
                required
                placeholder="Temporary password"
                className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-[#00AAFF]"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Role</label>
              <select
                value={inviteRole}
                onChange={e => setInviteRole(e.target.value)}
                className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-[#00AAFF]"
              >
                {ROLES.map(r => <option key={r} value={r}>{r.charAt(0).toUpperCase() + r.slice(1)}</option>)}
              </select>
            </div>
          </div>
          <div className="flex gap-3 pt-1">
            <button
              type="submit"
              disabled={loading}
              className="px-4 py-2 rounded-lg text-sm font-medium text-white disabled:opacity-50 transition"
              style={{ background: '#00AAFF' }}
            >
              {loading ? 'Creating…' : 'Create Account'}
            </button>
            <button type="button" onClick={() => setShowInvite(false)} className="px-4 py-2 rounded-lg text-sm text-gray-400 hover:text-white bg-gray-700 hover:bg-gray-600 transition">
              Cancel
            </button>
          </div>
        </form>
      )}

      {/* Employee list */}
      <div className="bg-gray-800 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-gray-400 text-left border-b border-gray-700 text-xs uppercase tracking-wider bg-gray-900">
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
                <td colSpan={6} className="px-5 py-12 text-center text-gray-500">No employees yet</td>
              </tr>
            ) : employees.map(emp => (
              <tr key={emp.id} className="border-b border-gray-700/40 hover:bg-gray-700/20">
                <td className="px-5 py-3 font-medium text-white">{emp.name || <span className="text-gray-500">—</span>}</td>
                <td className="px-4 py-3 text-gray-300">{emp.email}</td>
                <td className="px-4 py-3">
                  <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                    emp.role === 'admin' ? 'bg-purple-900/50 text-purple-300' :
                    emp.role === 'manager' ? 'text-white' :
                    emp.role === 'warehouse' ? 'bg-blue-900/50 text-blue-300' :
                    'bg-gray-700 text-gray-300'
                  }`}
                  style={emp.role === 'manager' ? { background: '#00AAFF33', color: '#00AAFF' } : {}}>
                    {emp.role}
                  </span>
                </td>
                <td className="px-4 py-3 text-gray-500 text-xs">{new Date(emp.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</td>
                <td className="px-4 py-3 text-gray-500 text-xs">{emp.last_sign_in ? new Date(emp.last_sign_in).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'Never'}</td>
                <td className="px-4 py-3 text-right">
                  <button
                    onClick={() => handleDelete(emp.id, emp.email)}
                    className="text-xs text-gray-500 hover:text-red-400 transition px-2 py-1 rounded hover:bg-red-950/30"
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
