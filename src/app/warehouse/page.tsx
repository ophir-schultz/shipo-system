'use client'

import { useState, useEffect } from 'react'

const SERVICE_TYPES = [
  { value: 'storage', label: 'Storage' },
  { value: 'receiving', label: 'Receiving' },
  { value: 'returns', label: 'Returns Processing' },
  { value: 'labeling', label: 'Labeling / Repackaging' },
  { value: 'kitting', label: 'Kitting / Assembly' },
  { value: 'pallet_in', label: 'Pallet In' },
  { value: 'pallet_out', label: 'Pallet Out' },
  { value: 'labor_hours', label: 'Labor Hours' },
  { value: 'special_task', label: 'Special Task' },
]

type ServiceRow = { service_type: string; label: string; quantity: string; notes: string }
type ClientEntry = { client_id: string; name: string; rows: ServiceRow[] }
type Unpriced = { client_id: string; service_type: string; reason: string }

function defaultRows(): ServiceRow[] {
  return SERVICE_TYPES.map(s => ({ service_type: s.value, label: s.label, quantity: '', notes: '' }))
}

// `e.rate?.toFixed(2)` was one `?.` away from crashing the panel: optional
// chaining guards `e.rate` being null, not `toFixed` being absent, so a
// numeric column arriving as a string throws "toFixed is not a function" and
// takes the whole list with it. An em-dash is also kept distinct from $0.00 --
// that distinction is the entire point of the column being nullable.
function money(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—'
  const n = Number(v)
  return Number.isFinite(n) ? `$${n.toFixed(2)}` : '—'
}

export default function WarehousePage() {
  const [clients, setClients] = useState<any[]>([])
  const [today] = useState(new Date().toISOString().split('T')[0])
  const [entries, setEntries] = useState<ClientEntry[]>([])
  const [submitted, setSubmitted] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [unpriced, setUnpriced] = useState<Unpriced[]>([])

  useEffect(() => {
    fetch('/api/clients/list')
      .then(r => r.json())
      .then((data: any[]) => {
        setClients(data)
        setEntries(data.map(c => ({ client_id: c.id, name: c.name, rows: defaultRows() })))
      })
  }, [])

  function updateRow(ci: number, ri: number, field: string, value: string) {
    setEntries(e => e.map((entry, i) =>
      i !== ci ? entry : {
        ...entry,
        rows: entry.rows.map((row, j) => j !== ri ? row : { ...row, [field]: value })
      }
    ))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')

    const rows: any[] = []
    for (const entry of entries) {
      for (const row of entry.rows) {
        if (row.quantity && parseFloat(row.quantity) > 0) {
          rows.push({ client_id: entry.client_id, service_type: row.service_type, quantity: row.quantity, notes: row.notes })
        }
      }
    }

    if (!rows.length) { setError('Fill in at least one service quantity'); setLoading(false); return }

    const res = await fetch('/api/warehouse/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: today, rows }),
    })

    // The route's message says whether anything was written, which the old
    // 'Failed to submit' did not. A 503 from the rate-card read means nothing
    // was saved and pressing the button again is safe; a 500 from the insert
    // means something may have been. Those need different next actions, so
    // the server's own wording is shown rather than replaced.
    const payload = await res.json().catch(() => null)
    if (!res.ok) {
      setError(payload?.error ?? `Failed to submit (HTTP ${res.status})`)
      setLoading(false)
      return
    }
    setUnpriced(payload?.unpriced ?? [])
    setSubmitted(true)
    setLoading(false)
  }

  if (submitted) return (
    <div className="flex flex-col items-center justify-center min-h-96 max-w-2xl mx-auto">
      {/* A green tick over a log containing unbilled work is the failure this
          screen is meant to stop. The rows ARE saved either way -- the hours
          are not lost -- but a line whose rate could not be resolved carries
          no total, and only the person who just typed it can fix that. */}
      <div className="text-6xl mb-4">{unpriced.length ? '⚠️' : '✅'}</div>
      <h3 className="text-2xl font-bold text-white mb-2">
        {unpriced.length ? 'Submitted, but not everything could be priced' : 'Daily Log Submitted!'}
      </h3>
      <p className="text-gray-400 mb-6">Warehouse activity for {today} has been saved.</p>

      {unpriced.length > 0 && (
        <div className="w-full bg-amber-500/10 border border-amber-500/40 rounded-xl p-5 mb-6 text-left">
          <p className="text-amber-300 text-sm font-semibold mb-1">
            {unpriced.length} line{unpriced.length === 1 ? '' : 's'} saved with no rate
          </p>
          <p className="text-amber-200/70 text-xs mb-3">
            The work is recorded, but these lines have no total and will not appear
            in any revenue figure until they are priced. They are not $0.
          </p>
          <ul className="space-y-2">
            {unpriced.map((u, i) => (
              <li key={i} className="text-xs text-gray-300">
                <span className="text-white font-medium">
                  {clients.find(c => c.id === u.client_id)?.name ?? u.client_id}
                </span>
                {' — '}
                <span className="text-gray-400">{u.service_type.replace(/_/g, ' ')}</span>
                <br />
                <span className="text-gray-500">{u.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <button
        onClick={() => {
          setSubmitted(false)
          setUnpriced([])
          setEntries(clients.map(c => ({ client_id: c.id, name: c.name, rows: defaultRows() })))
        }}
        className="bg-[#00AAFF] hover:bg-[#33BBFF] text-white px-6 py-2.5 rounded-lg text-sm font-medium transition"
      >
        Submit Another Entry
      </button>
    </div>
  )

  return (
    <div className="max-w-5xl">
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h2 className="text-2xl font-bold text-white">Daily Warehouse Log</h2>
          <p className="text-gray-400 text-sm mt-1">Fill in services for any client — leave quantity blank to skip</p>
        </div>
        <div className="bg-gray-800 rounded-xl px-4 py-2">
          <p className="text-[#00AAFF] font-semibold text-sm">
            📅 {new Date(today + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
          </p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        {entries.map((entry, ci) => (
          <div key={entry.client_id} className="bg-gray-800 rounded-xl overflow-hidden">
            <div className="bg-gray-750 border-b border-gray-700 px-5 py-3 flex items-center justify-between">
              <h3 className="font-semibold text-white text-sm">{entry.name}</h3>
              <span className="text-xs text-gray-500">{entry.rows.filter(r => r.quantity && parseFloat(r.quantity) > 0).length} service{entry.rows.filter(r => r.quantity && parseFloat(r.quantity) > 0).length !== 1 ? 's' : ''} logged</span>
            </div>

            <div className="divide-y divide-gray-700/50">
              <div className="grid grid-cols-[2fr_1fr_2fr] gap-3 px-5 py-2 text-xs text-gray-500">
                <span>Service</span>
                <span>Qty / Hours</span>
                <span>Notes</span>
              </div>
              {entry.rows.map((row, ri) => (
                <div key={row.service_type} className="grid grid-cols-[2fr_1fr_2fr] gap-3 items-center px-5 py-2.5">
                  <span className="text-sm text-gray-300">{row.label}</span>
                  <div className="relative">
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      placeholder={row.service_type === 'labor_hours' ? '0.0' : '0'}
                      value={row.quantity}
                      onChange={e => updateRow(ci, ri, 'quantity', e.target.value)}
                      className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-[#00AAFF]"
                    />
                    {row.service_type === 'labor_hours' && (
                      <span className="absolute right-2 top-2 text-xs text-gray-400">hrs</span>
                    )}
                  </div>
                  <input
                    type="text"
                    placeholder="Optional notes"
                    value={row.notes}
                    onChange={e => updateRow(ci, ri, 'notes', e.target.value)}
                    className="bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-[#00AAFF]"
                  />
                </div>
              ))}
            </div>
          </div>
        ))}

        {error && <p className="text-red-400 text-sm">{error}</p>}

        <div className="pt-2 pb-6">
          <button
            type="submit"
            disabled={loading || entries.length === 0}
            className="w-full bg-[#00AAFF] hover:bg-[#33BBFF] disabled:opacity-50 text-white py-3 rounded-xl text-sm font-semibold transition"
          >
            {loading ? 'Submitting...' : `✓ Submit Daily Log for ${today}`}
          </button>
        </div>
      </form>

      <TodayLog date={today} />
    </div>
  )
}

function TodayLog({ date }: { date: string }) {
  const [entries, setEntries] = useState<any[]>([])
  const [loadError, setLoadError] = useState('')

  useEffect(() => {
    let live = true
    setLoadError('')
    fetch(`/api/warehouse/log?date=${date}`)
      .then(async r => {
        const d = await r.json().catch(() => null)
        if (!live) return
        // A failed read used to land in `entries ?? []`, and an empty list
        // hides this whole panel -- so a day that WAS logged looked unlogged,
        // which invites entering it a second time. Failed is not empty.
        if (!r.ok) { setLoadError(d?.error ?? `HTTP ${r.status}`); return }
        setEntries(d?.entries ?? [])
      })
      .catch(e => { if (live) setLoadError(String(e)) })
    return () => { live = false }
  }, [date])

  if (loadError) return (
    <div className="mt-4 bg-red-500/10 border border-red-500/40 rounded-xl p-5">
      <p className="text-red-300 text-sm font-semibold">Could not load today's entries</p>
      <p className="text-red-200/70 text-xs mt-1">
        {loadError} — this is a read failure, not an empty day. Anything already
        submitted for {date} is still saved; do not re-enter it on the strength
        of this panel being blank.
      </p>
    </div>
  )

  if (!entries.length) return null

  // A null total is an unpriced line, not a free one, so it is counted rather
  // than added. `reduce((s, e) => s + (e.total ?? 0))` on its own reports a
  // day total that silently excludes it and still looks authoritative.
  const unpricedCount = entries.filter((e: any) => e.total === null || e.total === undefined).length

  const byClient: Record<string, any[]> = {}
  for (const e of entries) {
    const name = e.clients?.name ?? 'Unknown'
    if (!byClient[name]) byClient[name] = []
    byClient[name].push(e)
  }

  return (
    <div className="mt-4 bg-gray-800 rounded-xl p-6">
      <h3 className="font-semibold text-white mb-4">Today's Submitted Entries</h3>
      <div className="space-y-6">
        {Object.entries(byClient).map(([clientName, clientEntries]) => (
          <div key={clientName}>
            <p className="text-[#00AAFF] text-sm font-medium mb-2">{clientName}</p>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-gray-400 text-left border-b border-gray-700">
                  <th className="pb-2">Service</th>
                  <th className="pb-2">Qty</th>
                  <th className="pb-2">Notes</th>
                  <th className="pb-2 text-right">Rate</th>
                  <th className="pb-2 text-right">Total</th>
                </tr>
              </thead>
              <tbody>
                {clientEntries.map((e: any) => (
                  <tr key={e.id} className="border-b border-gray-700/40">
                    <td className="py-1.5 text-gray-300">{e.service_type?.replace(/_/g, ' ')}</td>
                    <td className="py-1.5">{e.quantity}</td>
                    <td className="py-1.5 text-gray-500 text-xs">{e.notes ?? '—'}</td>
                    <td className="py-1.5 text-right text-gray-400">{money(e.rate)}</td>
                    <td className={`py-1.5 text-right font-semibold ${e.total === null || e.total === undefined ? 'text-amber-400' : 'text-green-400'}`}>
                      {e.total === null || e.total === undefined ? 'unpriced' : money(e.total)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={4} className="pt-2 text-gray-500 text-xs">
                    Subtotal
                    {clientEntries.some((e: any) => e.total === null || e.total === undefined) && (
                      <span className="text-amber-400"> (excludes unpriced lines)</span>
                    )}
                  </td>
                  <td className="pt-2 text-right font-bold text-white text-sm">
                    ${clientEntries.reduce((s, e) => s + (e.total ?? 0), 0).toFixed(2)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        ))}
      </div>
      <div className="border-t border-gray-600 mt-4 pt-4 flex justify-between">
        <span className="text-gray-400 text-sm font-medium">Day Total</span>
        <div className="text-right">
          <span className="text-white font-bold">${entries.reduce((s, e) => s + (e.total ?? 0), 0).toFixed(2)}</span>
          {unpricedCount > 0 && (
            <p className="text-amber-400 text-xs mt-0.5">
              excludes {unpricedCount} unpriced line{unpricedCount === 1 ? '' : 's'}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
