'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

interface ClientOption {
  id: string
  name: string | null
}

export default function ManualChargeForm({ clients, today }: { clients: ClientOption[]; today: string }) {
  const router = useRouter()
  const [clientId, setClientId] = useState('')
  const [chargeDate, setChargeDate] = useState(today)
  const [description, setDescription] = useState('')
  const [amount, setAmount] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault()
    setPending(true)
    setError('')
    setNotice('')
    try {
      const res = await fetch('/api/manual-charges', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientId, chargeDate, description, amount }),
      })
      const body = await res.json().catch(() => null) as { error?: string; billing?: string } | null
      if (!res.ok) {
        setError(body?.error || `The charge was not saved (HTTP ${res.status}).`)
        return
      }
      setDescription('')
      setAmount('')
      setNotice(body?.billing || 'Recorded.')
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The charge was not saved.')
    } finally {
      setPending(false)
    }
  }

  return (
    <form onSubmit={onSubmit} className="rounded-2xl border border-slate-200 bg-white p-4 space-y-3">
      <label className="block text-sm text-[#4B4F58]">
        Client
        <select
          value={clientId}
          onChange={(event) => setClientId(event.target.value)}
          required
          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-[#0B1220]"
        >
          <option value="">Select a client</option>
          {clients.map((client) => (
            <option key={client.id} value={client.id}>{client.name || client.id}</option>
          ))}
        </select>
      </label>
      <label className="block text-sm text-[#4B4F58]">
        Charge date (America/New_York)
        <input
          type="date"
          value={chargeDate}
          onChange={(event) => setChargeDate(event.target.value)}
          required
          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-[#0B1220]"
        />
      </label>
      <label className="block text-sm text-[#4B4F58]">
        Description
        <input
          type="text"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          required
          maxLength={240}
          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-[#0B1220]"
        />
      </label>
      <label className="block text-sm text-[#4B4F58]">
        Amount
        <input
          type="text"
          inputMode="decimal"
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          required
          placeholder=""
          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-[#0B1220]"
        />
      </label>
      <button
        type="submit"
        disabled={pending}
        className="rounded-lg bg-[#1A73E8] px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
      >
        {pending ? 'Saving...' : 'Record charge'}
      </button>
      {notice ? <p className="text-sm text-[#0B1220]">{notice}</p> : null}
      {error ? <p className="text-sm text-red-700">{error}</p> : null}
    </form>
  )
}
