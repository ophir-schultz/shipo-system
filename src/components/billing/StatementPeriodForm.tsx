'use client'

import { GRAINS, GRAIN_LABELS } from '@/lib/billing/statement'

// One period per request. A filled calendar month is used alone. Otherwise
// From/To. Otherwise the relative period. The server still refuses a URL
// that sends more than one.
export default function StatementPeriodForm({
  clients,
  selectedId,
  grain,
  month,
  from,
  to,
}: {
  clients: { id: string; name: string }[]
  selectedId: string
  grain: string
  month: string
  from: string
  to: string
}) {
  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const params = new URLSearchParams()
    const client = String(data.get('client') || '')
    const pickedMonth = String(data.get('month') || '')
    const pickedFrom = String(data.get('from') || '')
    const pickedTo = String(data.get('to') || '')
    const pickedGrain = String(data.get('grain') || '')
    if (client) params.set('client', client)
    if (pickedMonth) params.set('month', pickedMonth)
    else if (pickedFrom || pickedTo) {
      if (pickedFrom) params.set('from', pickedFrom)
      if (pickedTo) params.set('to', pickedTo)
    } else if (pickedGrain) params.set('grain', pickedGrain)
    window.location.assign(`/statements?${params.toString()}`)
  }

  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-3 rounded-xl bg-slate-800 p-4 sm:p-5">
      <label className="flex w-full flex-col gap-1 text-xs uppercase text-slate-500 sm:w-auto">
        Client
        <select
          name="client"
          defaultValue={selectedId}
          className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200 sm:min-w-48"
        >
          <option value="">Choose a client…</option>
          {clients.map((client) => <option key={client.id} value={client.id}>{client.name}</option>)}
        </select>
      </label>
      <label className="flex w-full flex-col gap-1 text-xs uppercase text-slate-500 sm:w-auto">
        Relative period
        <select
          name="grain"
          defaultValue={grain}
          className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200"
        >
          <option value="">None</option>
          {GRAINS.map((item) => <option key={item} value={item}>{GRAIN_LABELS[item]}</option>)}
        </select>
      </label>
      <label className="flex w-full flex-col gap-1 text-xs uppercase text-slate-500 sm:w-auto">
        Calendar month
        <input
          type="month"
          name="month"
          defaultValue={month}
          className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200"
        />
      </label>
      <label className="flex w-full flex-col gap-1 text-xs uppercase text-slate-500 sm:w-auto">
        From
        <input
          type="date"
          name="from"
          defaultValue={from}
          className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200"
        />
      </label>
      <label className="flex w-full flex-col gap-1 text-xs uppercase text-slate-500 sm:w-auto">
        To
        <input
          type="date"
          name="to"
          defaultValue={to}
          className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200"
        />
      </label>
      <button
        type="submit"
        className="w-full rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-500 sm:w-auto"
      >
        Show statement
      </button>
    </form>
  )
}
