'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

export default function NewClientPage() {
  const router = useRouter()
  const [form, setForm] = useState({ name: '', email: '', phone: '' })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')
    const res = await fetch('/api/clients', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form),
    })
    const data = await res.json()
    if (!res.ok) { setError(data.error); setLoading(false); return }
    router.push(`/clients/${data.id}`)
  }

  return (
    <div className="max-w-lg">
      <div className="mb-8">
        <h2 className="text-2xl font-bold text-[#0B1220]">Add New Client</h2>
        <p className="text-[#4B4F58] text-sm mt-1">After creating the client you can upload their price list</p>
      </div>
      <form onSubmit={handleSubmit} className="bg-white rounded-xl p-6 space-y-5">
        <div>
          <label className="block text-sm text-[#4B4F58] mb-1.5">Client Name *</label>
          <input
            required
            value={form.name}
            onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
            className="w-full bg-[#EEF3FA] border border-[#CBD5E1] rounded-lg px-4 py-2.5 text-[#0B1220] placeholder-[#6B7A8D] focus:outline-none focus:border-[#1A73E8]"
            placeholder="e.g. Acme Corp"
          />
        </div>
        <div>
          <label className="block text-sm text-[#4B4F58] mb-1.5">Email</label>
          <input
            type="email"
            value={form.email}
            onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
            className="w-full bg-[#EEF3FA] border border-[#CBD5E1] rounded-lg px-4 py-2.5 text-[#0B1220] placeholder-[#6B7A8D] focus:outline-none focus:border-[#1A73E8]"
            placeholder="billing@client.com"
          />
        </div>
        <div>
          <label className="block text-sm text-[#4B4F58] mb-1.5">Phone</label>
          <input
            value={form.phone}
            onChange={e => setForm(f => ({ ...f, phone: e.target.value }))}
            className="w-full bg-[#EEF3FA] border border-[#CBD5E1] rounded-lg px-4 py-2.5 text-[#0B1220] placeholder-[#6B7A8D] focus:outline-none focus:border-[#1A73E8]"
            placeholder="+1 (555) 000-0000"
          />
        </div>
        {error && <p className="text-red-400 text-sm">{error}</p>}
        <div className="flex gap-3 pt-2">
          <button
            type="button"
            onClick={() => router.back()}
            className="flex-1 bg-[#EEF3FA] hover:bg-[#DDE6F2] text-[#0B1220] py-2.5 rounded-lg text-sm font-medium transition"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={loading}
            className="flex-1 bg-[#1A73E8] hover:bg-[#63B3FF] disabled:opacity-50 text-white py-2.5 rounded-lg text-sm font-medium transition"
          >
            {loading ? 'Creating...' : 'Create Client →'}
          </button>
        </div>
      </form>
    </div>
  )
}
