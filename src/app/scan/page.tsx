'use client'

import { useState, useEffect, useMemo } from 'react'
import { parseScan, duplicatesWithin } from '@/lib/scan/parse'
// Whether the client list is a list, or a read that failed, is decided in
// lib/ because vitest excludes `.test.tsx`. See client-list.ts for why an
// empty dropdown on this screen is worse than an error on it.
import { readClientList, type Client } from '@/lib/clients/client-list'

// ============================================================
// SERIALIZATION SCAN STATION
//
// One box label in, the serials inside it out, billed on submit.
//
// The split happens here, in front of the operator, and what gets
// posted is the list they can see. That is deliberate: the parser
// falls back to guessing when a label carries no separator, and a
// guess that nobody looked at must never become a billing line.
// ============================================================

type Recorded = {
  serial_count: number
  quantity: number
  rate: number
  total: number
  service_type: string
  queued: boolean
}

export default function ScanPage() {
  const [clients, setClients] = useState<Client[]>([])
  const [clientId, setClientId] = useState('')
  const [scanType, setScanType] = useState<'box' | 'loose'>('box')
  const [raw, setRaw] = useState('')
  const [orderRef, setOrderRef] = useState('')
  const [sku, setSku] = useState('')
  const [boxRef, setBoxRef] = useState('')
  const [expected, setExpected] = useState('')
  const [notes, setNotes] = useState('')

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [last, setLast] = useState<Recorded | null>(null)
  // Kept apart from `error`, which is about a scan that failed to record.
  // This one is about not knowing who the clients are, and it REPLACES the
  // station rather than appearing beside it -- see the refusal below.
  const [loadError, setLoadError] = useState('')
  // Set only on a successful read, so an empty list can be reported as empty
  // rather than as still loading. `clients.length === 0` cannot tell those
  // apart, and the dropdown said "Select a client…" for both.
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let live = true
    fetch('/api/clients/list')
      .then(async (r) => {
        // Parsed here and handed over, so readClientList stays pure and
        // testable. `.catch(() => null)` because a body that is not JSON at
        // all -- a proxy's HTML error page -- must not throw past the status
        // check and land in the network `.catch` as an unexplained refusal.
        const body = await r.json().catch(() => null)
        if (!live) return
        const list = readClientList(r, body)
        if (!list.ok) {
          setLoadError(list.error)
          return
        }
        setClients(list.data)
        setLoaded(true)
      })
      // A network failure is a failure, not a client list with nobody on it.
      // This used to be `.catch(() => setClients([]))`.
      .catch((e) => { if (live) setLoadError(String(e)) })
    return () => { live = false }
  }, [])

  const result = useMemo(
    () => parseScan(raw, expected ? Number(expected) : undefined),
    [raw, expected],
  )
  const serials = result.serials
  const dupes = useMemo(() => duplicatesWithin(serials), [serials])

  // A loose scan is billed per serial, a box is one flat charge however
  // many are inside it. Shown before submit so nobody is surprised by
  // the invoice line.
  const billedAs =
    scanType === 'box'
      ? '1 box (flat)'
      : `${serials.length} serial${serials.length === 1 ? '' : 's'}`

  const short =
    expected !== '' && serials.length > 0 && serials.length < Number(expected)

  async function submit() {
    setError('')
    if (!clientId) return setError('Pick a client.')
    if (!serials.length) return setError('Nothing scanned yet.')
    if (dupes.length) return setError(`Duplicate serial in this scan: ${dupes.join(', ')}`)

    setSaving(true)
    try {
      const res = await fetch('/api/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: clientId,
          scan_type: scanType,
          serials,
          order_ref: orderRef,
          sku,
          box_ref: boxRef,
          expected_count: expected || null,
          notes,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || 'Could not record that scan.')
        return
      }
      setLast(data as Recorded)
      // Clear only what belongs to this carton. The client, order and SKU
      // carry over: a 120-unit line is six cartons of the same SKU scanned
      // back to back, and they all accumulate into one push job.
      setRaw('')
      setBoxRef('')
      setNotes('')
    } catch {
      setError('Could not reach the server. Nothing was recorded — scan again.')
    } finally {
      setSaving(false)
    }
  }

  const field =
    'w-full bg-[#EEF3FA] border border-[#CBD5E1] rounded-lg px-3 py-2 text-[#0B1220] text-sm focus:outline-none focus:border-[#1A73E8]'

  // No scan station at all when the client list could not be read. Every scan
  // is posted against a client_id that can only come from that dropdown, so
  // the form has no usable function without it -- and a station that renders
  // anyway invites an operator to work through a pallet of cartons, which the
  // submit will then refuse one at a time with "Pick a client."
  if (loadError) return (
    <div className="max-w-5xl pb-10">
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-[#0B1220]">Serialization Scan</h2>
      </div>
      <div className="bg-red-500/10 border border-red-500/40 rounded-xl p-5">
        <p className="text-red-300 text-sm font-semibold">
          Could not load the client list
        </p>
        <p className="text-red-200/70 text-xs mt-1">
          {loadError}
        </p>
        <p className="text-red-200/70 text-xs mt-2">
          This is a read failure, not a sign that there are no clients set up.
          Nothing already recorded has been lost or changed. A scan cannot be
          saved without a client, so do not work through the cartons on this
          screen until it loads — reload, and if it keeps failing, leave the
          boxes unsealed and scan them once this is fixed. The serials are
          still on them; a scan that was never recorded is not billed.
        </p>
      </div>
    </div>
  )

  return (
    <div className="max-w-5xl pb-10">
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-[#0B1220]">Serialization Scan</h2>
        <p className="text-[#4B4F58] text-sm mt-1">
          Scan a box label to pull out the serials inside it, or scan loose units one at a
          time. Submitting records the work and bills it.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* ---- input ---- */}
        <div className="bg-white rounded-xl p-5 space-y-4">
          <div>
            <label className="block text-xs text-[#6B7A8D] mb-1">Client</label>
            <select
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              className={field}
            >
              {/* Three states, not one. "Select a client…" over a list that
                  has not arrived yet tells the operator to pick from nothing,
                  and over a SUCCESSFUL read that returned nobody it tells
                  them to keep waiting for a list that is never coming. A read
                  FAILURE does not reach here at all -- loadError returns
                  above, in place of the whole station. */}
              <option value="">
                {!loaded
                  ? 'Loading clients…'
                  : clients.length === 0
                    ? 'No active clients'
                    : 'Select a client…'}
              </option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs text-[#6B7A8D] mb-1">Input method</label>
            <div className="grid grid-cols-2 gap-2">
              {(['box', 'loose'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setScanType(t)}
                  className={`rounded-lg px-3 py-2 text-sm font-medium transition border ${
                    scanType === t
                      ? 'bg-[#1A73E8] border-[#1A73E8] text-white'
                      : 'bg-[#EEF3FA] border-[#CBD5E1] text-[#3A4658] hover:border-gray-500'
                  }`}
                >
                  {t === 'box' ? 'Box label' : 'Loose serials'}
                </button>
              ))}
            </div>
            <p className="text-xs text-[#6B7A8D] mt-1.5">
              {scanType === 'box'
                ? 'One flat charge per box, whatever it holds.'
                : 'Charged per serial.'}
            </p>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-xs text-[#6B7A8D] mb-1">Order ref</label>
              <input
                type="text"
                value={orderRef}
                onChange={(e) => setOrderRef(e.target.value)}
                placeholder="Zenventory order"
                className={field}
              />
            </div>
            <div>
              <label className="block text-xs text-[#6B7A8D] mb-1">SKU</label>
              <input
                type="text"
                value={sku}
                onChange={(e) => setSku(e.target.value)}
                placeholder="Line item"
                className={field}
              />
            </div>
            <div>
              <label className="block text-xs text-[#6B7A8D] mb-1">Box ref</label>
              <input
                type="text"
                value={boxRef}
                onChange={(e) => setBoxRef(e.target.value)}
                placeholder="Optional"
                className={field}
              />
            </div>
          </div>

          {/* Zenventory holds scanned serials per line item, not per
              order, and real orders are multi-line. Without the SKU the
              scan is still billed and stored, but there is no safe way
              to push it — so say that here rather than letting it look
              queued. */}
          {orderRef.trim() && !sku.trim() && (
            <p className="text-xs text-amber-400">
              No SKU — this scan will be billed and stored, but not queued for
              Zenventory. The serials go onto a specific order line, so the line
              has to be named.
            </p>
          )}

          <div>
            <label className="block text-xs text-[#6B7A8D] mb-1">
              Expected count <span className="text-[#6B7A8D]">— optional</span>
            </label>
            <input
              type="number"
              min="1"
              value={expected}
              onChange={(e) => setExpected(e.target.value)}
              placeholder="e.g. 20"
              className={field}
            />
          </div>

          <div>
            <label className="block text-xs text-[#6B7A8D] mb-1">Scan</label>
            {/* Must be a textarea. <input type=text> silently strips newlines,
                which destroys the likeliest separator before it is ever parsed. */}
            <textarea
              id="scan"
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              rows={6}
              autoFocus
              placeholder="Click here, then scan the box label…"
              className={field + ' font-mono resize-y'}
            />
          </div>

          <div>
            <label className="block text-xs text-[#6B7A8D] mb-1">Notes</label>
            <input
              type="text"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Optional"
              className={field}
            />
          </div>
        </div>

        {/* ---- what came out ---- */}
        <div className="bg-white rounded-xl p-5 space-y-4">
          <div className="flex items-baseline justify-between">
            <div>
              <span className="text-3xl font-bold text-[#0B1220]">{serials.length}</span>
              <span className="text-[#4B4F58] text-sm ml-2">
                serial{serials.length === 1 ? '' : 's'}
              </span>
            </div>
            <span className="text-xs text-[#6B7A8D]">
              bills as {billedAs}
            </span>
          </div>

          {result.method !== 'empty' && (
            <p className="text-xs text-[#6B7A8D]">Split rule: {result.method}</p>
          )}

          {/* The three states worth interrupting for. */}
          {dupes.length > 0 && (
            <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">
              The same serial appears twice: {dupes.join(', ')}. That is a double-read or a
              bad split — clear the field and scan again.
            </p>
          )}

          {serials.length > 0 && result.method === 'single' && (
            <p className="text-sm text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2">
              Only ONE value came out of that scan. No separator was found, so this is
              either a single serial or a box label in a format this tool does not
              recognise yet. Do not assume it is a whole box.
            </p>
          )}

          {result.guess && (
            <p className="text-sm text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2">
              Split by fixed width — a GUESS, not a detected separator. Check a few serials
              by eye before submitting.
            </p>
          )}

          {short && (
            <p className="text-sm text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2">
              Short box: {serials.length} of {expected} expected. It still bills as one box —
              the shortfall is recorded for review, not repriced.
            </p>
          )}

          <ul className="text-sm text-[#3A4658] font-mono max-h-72 overflow-auto divide-y divide-[#E2E8F0]/50">
            {serials.map((s, i) => (
              <li key={i} className="py-1.5 flex gap-3">
                <span className="text-[#6B7A8D] w-6 text-right shrink-0">{i + 1}</span>
                <span className="break-all">{s}</span>
              </li>
            ))}
          </ul>

          {error && (
            <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">
              {error}
            </p>
          )}

          <button
            type="button"
            onClick={submit}
            disabled={saving || !serials.length || dupes.length > 0}
            className="w-full bg-[#1A73E8] hover:bg-[#63B3FF] disabled:opacity-50 text-white py-3 rounded-xl text-sm font-semibold transition"
          >
            {saving ? 'Recording…' : 'Record scan'}
          </button>

          {last && (
            <div className="text-sm text-green-300 bg-green-500/10 border border-green-500/30 rounded-lg px-3 py-2">
              Recorded {last.serial_count} serial{last.serial_count === 1 ? '' : 's'} —
              billed ${Number(last.total).toFixed(2)} ({last.service_type}).{' '}
              {last.queued
                ? 'Queued for Zenventory.'
                : 'Not queued — no order ref, so there is nothing to match against.'}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
