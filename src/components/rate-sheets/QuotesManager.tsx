'use client'

import { useState } from 'react'
import { sheetPath, type RateSheet } from '@/lib/rate-sheets'

// Create a sheet, copy its link, mark it sent, or kill the link.
//
// Everything a prospect will read comes from this one form, so the
// fields map one-to-one onto the estimator on the public page — if a
// number is asked for here it is priced there, and nothing is asked
// for that the card cannot use.

// `step` matters here. An <input type="number"> defaults to step="1" and
// will refuse a fractional value — silently, because the browser blocks
// the submit before React's onSubmit ever runs, so the button just looks
// dead. Average items per order is fractional almost every time (1.8,
// 2.3), and estimateMonthly prices it that way, so that field must take
// any number. The rest really are whole things, so they keep step="1".
const NUMERIC_FIELDS = [
  { key: 'monthly_orders', label: 'Orders per month', step: '1' },
  { key: 'items_per_order', label: 'Avg items per order', step: 'any' },
  { key: 'pallets_stored', label: 'Pallets stored', step: '1' },
  { key: 'pallets_inbound', label: 'Pallets received / month', step: '1' },
  { key: 'fba_units', label: 'FBA prep units / month', step: '1' },
] as const

const CHANNELS = ['DTC ecommerce', 'B2B / retail', 'Amazon FBA', 'Amazon seller-fulfilled', 'International']

const EMPTY = {
  company_name: '',
  contact_name: '',
  contact_email: '',
  monthly_orders: '',
  items_per_order: '',
  pallets_stored: '',
  pallets_inbound: '',
  fba_units: '',
  valid_until: '',
  intro: '',
  notes: '',
}

export default function QuotesManager({
  initialSheets,
  disabled,
}: {
  initialSheets: RateSheet[]
  disabled: boolean
}) {
  const [sheets, setSheets] = useState(initialSheets)
  const [form, setForm] = useState({ ...EMPTY })
  const [channels, setChannels] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)

  function set(key: string, value: string) {
    setForm((f) => ({ ...f, [key]: value }))
  }

  async function create(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      const res = await fetch('/api/rate-sheets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, channels }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Could not create the sheet.')
      setSheets((s) => [json.sheet, ...s])
      setForm({ ...EMPTY })
      setChannels([])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.')
    } finally {
      setBusy(false)
    }
  }

  async function patch(id: string, body: Record<string, unknown>) {
    const res = await fetch(`/api/rate-sheets/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const json = await res.json()
    if (res.ok) setSheets((s) => s.map((x) => (x.id === id ? { ...x, ...json.sheet } : x)))
  }

  async function copy(sheet: RateSheet) {
    const url = `${window.location.origin}${sheetPath(sheet)}`
    try {
      await navigator.clipboard.writeText(url)
      setCopiedId(sheet.id)
      setTimeout(() => setCopiedId(null), 2000)
      // Copying the link is the moment it goes out, so record it as sent
      // rather than asking staff to remember a second click.
      if (sheet.status === 'draft') patch(sheet.id, { status: 'sent' })
    } catch {
      window.prompt('Copy this link:', url)
    }
  }

  const input =
    'w-full rounded-lg px-3 py-2 text-sm bg-[#0d1420] border border-[#1a2540] text-white ' +
    'placeholder:text-gray-600 focus:outline-none focus:border-[#00AAFF]'

  return (
    <div className="space-y-8">
      <form
        onSubmit={create}
        className="rounded-xl border border-[#1a2540] bg-[#0d1420] p-6 space-y-5"
      >
        <h2 className="font-semibold">New rate sheet</h2>

        <div className="grid sm:grid-cols-3 gap-4">
          <label className="block sm:col-span-1">
            <span className="text-xs text-gray-400">Company name *</span>
            <input
              required
              className={input + ' mt-1'}
              value={form.company_name}
              onChange={(e) => set('company_name', e.target.value)}
              placeholder="Acme Supplements"
            />
          </label>
          <label className="block">
            <span className="text-xs text-gray-400">Contact name</span>
            <input
              className={input + ' mt-1'}
              value={form.contact_name}
              onChange={(e) => set('contact_name', e.target.value)}
            />
          </label>
          <label className="block">
            <span className="text-xs text-gray-400">Contact email</span>
            <input
              type="email"
              className={input + ' mt-1'}
              value={form.contact_email}
              onChange={(e) => set('contact_email', e.target.value)}
            />
          </label>
        </div>

        <div className="grid sm:grid-cols-5 gap-4">
          {NUMERIC_FIELDS.map((f) => (
            <label key={f.key} className="block">
              <span className="text-xs text-gray-400">{f.label}</span>
              <input
                type="number"
                min={0}
                step={f.step}
                className={input + ' mt-1'}
                value={form[f.key]}
                onChange={(e) => set(f.key, e.target.value)}
              />
            </label>
          ))}
        </div>

        <div>
          <span className="text-xs text-gray-400">Channels</span>
          <div className="flex flex-wrap gap-2 mt-2">
            {CHANNELS.map((c) => {
              const on = channels.includes(c)
              return (
                <button
                  key={c}
                  type="button"
                  onClick={() =>
                    setChannels((cs) => (on ? cs.filter((x) => x !== c) : [...cs, c]))
                  }
                  className={`rounded-full px-3 py-1 text-xs border transition ${
                    on
                      ? 'text-white border-transparent'
                      : 'text-gray-400 border-[#1a2540] hover:text-white'
                  }`}
                  style={on ? { background: '#00AAFF' } : {}}
                >
                  {c}
                </button>
              )
            })}
          </div>
        </div>

        <div className="grid sm:grid-cols-2 gap-4">
          <label className="block">
            <span className="text-xs text-gray-400">Rates held until</span>
            <input
              type="date"
              className={input + ' mt-1'}
              value={form.valid_until}
              onChange={(e) => set('valid_until', e.target.value)}
            />
          </label>
          <label className="block">
            <span className="text-xs text-gray-400">Profile notes (shown to the prospect)</span>
            <input
              className={input + ' mt-1'}
              value={form.notes}
              onChange={(e) => set('notes', e.target.value)}
              placeholder="Two SKUs, both under 2 lb, shipping mostly East Coast."
            />
          </label>
        </div>

        <label className="block">
          <span className="text-xs text-gray-400">
            Opening paragraph (optional — leave blank for the standard one)
          </span>
          <textarea
            rows={3}
            className={input + ' mt-1'}
            value={form.intro}
            onChange={(e) => set('intro', e.target.value)}
          />
        </label>

        {error && <p className="text-sm text-red-400">{error}</p>}

        <button
          type="submit"
          disabled={busy || disabled}
          className="rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
          style={{ background: '#00AAFF' }}
        >
          {busy ? 'Creating…' : 'Create rate sheet'}
        </button>
      </form>

      <div className="space-y-3">
        <h2 className="font-semibold">
          Sheets <span className="text-gray-500 font-normal">({sheets.length})</span>
        </h2>

        {sheets.length === 0 && (
          <p className="text-sm text-gray-500">No rate sheets yet.</p>
        )}

        {sheets.map((sheet) => (
          <div
            key={sheet.id}
            className="rounded-xl border border-[#1a2540] bg-[#0d1420] p-4 flex flex-wrap items-center gap-x-6 gap-y-3 justify-between"
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-medium">{sheet.company_name}</span>
                <span className="text-xs text-gray-600 tabular-nums">#{sheet.public_id}</span>
                <span
                  className={`text-xs rounded-full px-2 py-0.5 ${
                    sheet.status === 'sent'
                      ? 'bg-sky-950 text-sky-300'
                      : sheet.status === 'expired'
                        ? 'bg-gray-800 text-gray-400'
                        : 'bg-amber-950 text-amber-300'
                  }`}
                >
                  {sheet.status}
                </span>
              </div>
              <p className="text-xs text-gray-500 mt-1">
                {sheet.contact_name ? `${sheet.contact_name} · ` : ''}
                {sheet.profile.monthly_orders
                  ? `${sheet.profile.monthly_orders.toLocaleString()} orders/mo · `
                  : ''}
                {sheet.view_count > 0
                  ? `Opened ${sheet.view_count} time${sheet.view_count === 1 ? '' : 's'}`
                  : 'Not opened yet'}
              </p>
            </div>

            <div className="flex items-center gap-2">
              <a
                href={sheetPath(sheet)}
                target="_blank"
                rel="noreferrer"
                className="rounded-lg border border-[#1a2540] px-3 py-1.5 text-xs text-gray-300 hover:text-white"
              >
                Preview
              </a>
              <button
                type="button"
                onClick={() => copy(sheet)}
                className="rounded-lg px-3 py-1.5 text-xs font-medium text-white"
                style={{ background: '#00AAFF' }}
              >
                {copiedId === sheet.id ? 'Copied' : 'Copy link'}
              </button>
              <button
                type="button"
                onClick={() => {
                  if (
                    confirm(
                      `Replace the link for ${sheet.company_name}?\n\nThe link already sent will stop working immediately and cannot be restored. Use this if the sheet went to the wrong person.`
                    )
                  ) {
                    patch(sheet.id, { rotate_token: true })
                  }
                }}
                className="rounded-lg border border-[#1a2540] px-3 py-1.5 text-xs text-gray-400 hover:text-white"
              >
                Replace link
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
