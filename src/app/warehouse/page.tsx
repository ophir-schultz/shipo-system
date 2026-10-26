'use client'

import { useState, useEffect } from 'react'
import {
  FBA_PREP_SERVICE, FBA_PREP_STEPS,
  composeServiceNotes, overlapWarning,
} from '@/lib/billing/warehouse-rate-card'
// The form's shape -- which rows exist, their labels, their sections, and
// which ones submit writes -- lives in lib/ because vitest excludes
// `.test.tsx`: logic held in this file cannot be tested at all, and that is
// logic deciding what a client gets billed for. See
// lib/billing/warehouse-log-form.test.ts.
//
// The short version of why it is card-derived rather than a fixed list: a
// read-only probe against production found the fixed list priced almost
// nothing -- across 9 active clients and the 5 most recently added actions,
// ZERO combinations were billable, because the cards use the price list's
// names and the constant used its own. The long version is in the lib header.
import {
  rowsFromCard, rowsInGroup, groupsToRender, filledRows, clearedEntries, money,
  cardStateNotice, structuredNote, type ClientEntry,
} from '@/lib/billing/warehouse-log-form'
import type { ClientCard } from '@/lib/billing/warehouse-priced-services'

type Unpriced = { client_id: string; service_type: string; reason: string }

/** One entry in GET /api/warehouse/services. Spelled as the route's own
 *  ClientCard plus the client's identity rather than re-declared, so a change
 *  to the card shape fails the typecheck here instead of silently handing
 *  rowsFromCard a field that no longer exists. */
type ServicesRow = { id: string; name: string } & ClientCard

export default function WarehousePage() {
  const [clients, setClients] = useState<any[]>([])
  const [today] = useState(new Date().toISOString().split('T')[0])
  // Every client stays in state even though one is on screen. Switching the
  // dropdown must not discard what was already typed for another client, and
  // submit covers all of them -- see the summary above the button.
  const [entries, setEntries] = useState<ClientEntry[]>([])
  const [selected, setSelected] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [unpriced, setUnpriced] = useState<Unpriced[]>([])
  // Kept apart from `error`, which is about a submit that failed. This one is
  // about not knowing what to render at all, and it REPLACES the form rather
  // than appearing beside it -- a form built from a card we could not read
  // would offer rates nobody agreed to.
  const [loadError, setLoadError] = useState('')
  // Set only on a successful read, so an empty list can be reported as empty
  // rather than as still loading. `entries.length === 0` cannot tell those
  // apart, and the dropdown said "Loading clients…" for both.
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let live = true
    // The date goes in the request. The menu and the save must be asked about
    // the SAME day: `today` is fixed once in state above and is what the POST
    // carries, so sending it here is what stops the screen offering one rate
    // and the save billing another across midnight.
    fetch(`/api/warehouse/services?date=${today}`)
      .then(async res => {
        const payload = await res.json().catch(() => null)
        if (!live) return
        // A failed read is REFUSED, not emptied. The route answers 503 when
        // the database cannot be asked, and the `.then(r => r.json())` this
        // replaced would have fed that error body straight to `.map` -- a
        // blank screen with a console error, which an operator reads as
        // "there is no work to log today".
        if (!res.ok) {
          setLoadError(payload?.error ?? `HTTP ${res.status}`)
          return
        }
        const list: ServicesRow[] = payload?.clients ?? []
        setClients(list.map(c => ({ id: c.id, name: c.name })))
        setEntries(list.map(c => ({
          client_id: c.id,
          name: c.name,
          rows: rowsFromCard(c.services ?? []),
          state: c.state,
          // `?? 0` only for a route that predates the field. Not a default
          // meaning "none": a card we could not count is counted as nothing to
          // say, which is the silent behaviour this note exists to replace --
          // so the route is typed to require it (ServicesRow above) and this
          // coalesce should be unreachable.
          structuredCount: c.structuredCount ?? 0,
        })))
        setSelected(prev => prev === '' ? (list[0]?.id ?? '') : prev)
        setLoaded(true)
      })
      .catch(e => { if (live) setLoadError(String(e)) })
    return () => { live = false }
  }, [today])

  // Keyed on client_id and service_type rather than array indices. The form
  // renders a filtered, grouped subset, so a row's position on screen is not
  // its position in `rows` -- index-based updates would write to whichever
  // service happened to sit at that offset in the full list.
  function updateRow(clientId: string, serviceType: string, field: 'quantity' | 'notes', value: string) {
    setEntries(e => e.map(entry =>
      entry.client_id !== clientId ? entry : {
        ...entry,
        rows: entry.rows.map(row =>
          row.service_type !== serviceType ? row : { ...row, [field]: value }),
      }
    ))
  }

  function toggleStep(clientId: string, serviceType: string, step: string) {
    setEntries(e => e.map(entry =>
      entry.client_id !== clientId ? entry : {
        ...entry,
        rows: entry.rows.map(row =>
          row.service_type !== serviceType ? row : {
            ...row,
            steps: row.steps.includes(step)
              ? row.steps.filter(s => s !== step)
              : [...row.steps, step],
          }),
      }
    ))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')

    // Every client with something typed, not just the one on screen. The
    // dropdown is a focus control; it must not decide what gets saved, or work
    // typed for client A disappears the moment the operator looks at client B.
    const rows: any[] = []
    for (const entry of entries) {
      for (const row of filledRows(entry.rows)) {
        rows.push({
          client_id: entry.client_id,
          service_type: row.service_type,
          quantity: row.quantity,
          // Ticked steps land here, in the one column a human reads. They
          // cannot affect the charge: the route computes total = rate x
          // quantity from the single rate named by service_type.
          notes: composeServiceNotes(row.steps, row.notes),
        })
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
      <h3 className="text-2xl font-bold text-[#0B1220] mb-2">
        {unpriced.length ? 'Submitted, but not everything could be priced' : 'Daily Log Submitted!'}
      </h3>
      <p className="text-[#4B4F58] mb-6">Warehouse activity for {today} has been saved.</p>

      {unpriced.length > 0 && (
        <div className="w-full bg-amber-500/10 border border-amber-500/40 rounded-xl p-5 mb-6 text-left">
          <p className="text-amber-700 text-sm font-semibold mb-1">
            {unpriced.length} line{unpriced.length === 1 ? '' : 's'} saved with no rate
          </p>
          <p className="text-amber-700 text-xs mb-3">
            The work is recorded, but these lines have no total and will not appear
            in any revenue figure until they are priced. They are not $0.
          </p>
          <ul className="space-y-2">
            {unpriced.map((u, i) => (
              <li key={i} className="text-xs text-[#3A4658]">
                <span className="text-[#0B1220] font-medium">
                  {clients.find(c => c.id === u.client_id)?.name ?? u.client_id}
                </span>
                {' — '}
                <span className="text-[#4B4F58]">{u.service_type.replace(/_/g, ' ')}</span>
                <br />
                <span className="text-[#6B7A8D]">{u.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <button
        onClick={() => {
          setSubmitted(false)
          setUnpriced([])
          setEntries(clearedEntries)
          // `selected` is deliberately left alone: the operator is most likely
          // to log the next entry against the client they were just on.
        }}
        className="bg-[#1A73E8] hover:bg-[#63B3FF] text-white px-6 py-2.5 rounded-lg text-sm font-medium transition"
      >
        Submit Another Entry
      </button>
    </div>
  )

  // No form at all when the cards could not be read. Every row on this screen
  // carries a rate taken from a card; without the cards there is nothing
  // honest to render, and a form that shrugs and shows blank rates is how work
  // gets logged against prices nobody agreed to.
  if (loadError) return (
    <div className="max-w-2xl">
      <h2 className="text-2xl font-bold text-[#0B1220] mb-4">Daily Warehouse Log</h2>
      <div className="bg-red-500/10 border border-red-500/40 rounded-xl p-5">
        <p className="text-red-700 text-sm font-semibold">
          Could not load the clients and their rates
        </p>
        <p className="text-red-700 text-xs mt-1">
          {loadError}
        </p>
        <p className="text-red-700 text-xs mt-2">
          This is a read failure, not an empty day and not a list of clients
          with no rates. Nothing already submitted for {today} has been lost.
          Reload; if it keeps failing, the log needs to be taken on paper and
          entered once this is fixed, rather than entered here against rates
          that could not be checked.
        </p>
      </div>
      <TodayLog date={today} />
    </div>
  )

  const current = entries.find(e => e.client_id === selected) ?? null

  // Derived from the SELECTED client only. The warning is about one client's
  // day; summing it across clients would fire for a combination no single
  // client has.
  const currentOverlap = current === null
    ? null
    : overlapWarning(filledRows(current.rows).map(r => r.service_type))

  // null when the card is usable. `today` is passed in because the notice for
  // `none-priced` names the day the rates were checked against -- the same day
  // the menu was fetched for and the same day the save will use.
  const currentNotice = current === null
    ? null
    : cardStateNotice(current.state, current.name, today)

  // Not a refusal: the form below works. This says what is NOT in it, for a
  // card whose structured lines outnumber its loggable ones. Null for most
  // clients. See structuredNote for why it is not a fifth CardState.
  const currentStructured = current === null
    ? null
    : structuredNote(current.state, current.structuredCount)

  // Everything submit will write, which is deliberately not scoped to the
  // dropdown. Computed from the same filledRows() the submit loop uses, so the
  // count cannot promise a different set than the one written.
  const pending = entries.filter(e => filledRows(e.rows).length > 0)
  const pendingRowCount = pending.reduce((n, e) => n + filledRows(e.rows).length, 0)

  return (
    <div className="max-w-5xl">
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h2 className="text-2xl font-bold text-[#0B1220]">Daily Warehouse Log</h2>
          <p className="text-[#4B4F58] text-sm mt-1">
            Pick a client, then fill in the services — leave quantity blank to skip.
            Work typed for other clients is kept and submitted together.
          </p>
        </div>
        <div className="bg-white rounded-xl px-4 py-2">
          <p className="text-[#1A73E8] font-semibold text-sm">
            📅 {new Date(today + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
          </p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="bg-white rounded-xl px-5 py-4">
          <label htmlFor="wh-client" className="block text-xs text-[#4B4F58] mb-2">
            Client
          </label>
          <select
            id="wh-client"
            value={selected}
            onChange={e => setSelected(e.target.value)}
            className="w-full bg-[#EEF3FA] border border-[#CBD5E1] rounded-lg px-3 py-2.5 text-[#0B1220] text-sm focus:outline-none focus:border-[#1A73E8]"
          >
            {/* Three states, not two. "Loading clients…" is true only before
                the fetch resolves; leaving it up after a SUCCESSFUL read that
                returned nothing tells the operator to keep waiting for a list
                that is never coming. A read FAILURE does not reach here at
                all -- loadError returns above, in place of the whole form. */}
            {entries.length === 0 && (
              <option value="">
                {loaded ? 'No active clients' : 'Loading clients…'}
              </option>
            )}
            {entries.map(entry => {
              const n = filledRows(entry.rows).length
              return (
                <option key={entry.client_id} value={entry.client_id}>
                  {entry.name}{n > 0 ? `  •  ${n} filled in` : ''}
                </option>
              )
            })}
          </select>
        </div>

        {current && (
          <div className="bg-white rounded-xl overflow-hidden">
            <div className="bg-[#F8FAFC] border-b border-[#E2E8F0] px-5 py-3 flex items-center justify-between">
              <h3 className="font-semibold text-[#0B1220] text-sm">{current.name}</h3>
              <span className="text-xs text-[#6B7A8D]">
                {filledRows(current.rows).length} service
                {filledRows(current.rows).length !== 1 ? 's' : ''} logged
              </span>
            </div>

            {/* The banner, not an empty form. A client with no usable rate
                card used to get the same twenty boxes as everyone else, and
                every line typed into them saved unpriced -- work recorded and
                never invoiced. The four states send the operator to four
                different places, so they are not collapsed into one message. */}
            {currentNotice && (
              <div className="px-5 py-4 bg-amber-500/10 border-b border-amber-500/40">
                <p className="text-amber-700 text-sm font-semibold mb-1">
                  {currentNotice.title}
                </p>
                <p className="text-amber-700 text-xs">{currentNotice.body}</p>
              </div>
            )}

            {/* Grey, not amber, and deliberately quieter than the banner
                above: this form IS usable. It is here because `priced` fires
                on one billable line, so a card that is 18 structured lines and
                1 loggable action showed a single box and said nothing about
                the other eighteen. Mutually exclusive with the banner by
                construction -- structuredNote returns null unless `priced`. */}
            {currentStructured && (
              <div className="px-5 py-3 bg-white/40 border-b border-[#E2E8F0]">
                <p className="text-[#4B4F58] text-xs">{currentStructured}</p>
              </div>
            )}

            {groupsToRender(current.rows).map(group => {
              const groupRows = rowsInGroup(current.rows, group)
              if (groupRows.length === 0) return null
              return (
                <div key={group}>
                  <div className="bg-white/60 border-y border-[#E2E8F0]/50 px-5 py-1.5">
                    <span className="text-[11px] uppercase tracking-wide text-[#6B7A8D] font-medium">
                      {group}
                    </span>
                  </div>
                  <div className="divide-y divide-[#E2E8F0]/50">
                    {groupRows.map(row => (
                      <div key={row.service_type} className="px-5 py-2.5">
                        <div className="grid grid-cols-[2fr_1fr_2fr] gap-3 items-center">
                          <span className="text-sm text-[#3A4658]">
                            {row.label}
                            {/*
                              The agreed rate, shown where the quantity is
                              typed. This is the number the save will multiply
                              -- it came from priceServiceLine, the same
                              function POST /api/warehouse/log calls -- so it
                              cannot promise a price the save would not use.

                              The unit is printed only when the card says one.
                              A bare "7.00" beside a quantity box is how a
                              per-pallet rate gets entered as though it were
                              per-carton, and inventing "per_unit" to fill the
                              gap would put a unit on screen that nobody
                              agreed to.
                            */}
                            <span className="block text-[11px] text-[#6B7A8D] mt-0.5">
                              {money(row.rate)}
                              {row.unit ? ` ${row.unit.replace(/_/g, ' ')}` : ''}
                            </span>
                          </span>
                          <div className="relative">
                            <input
                              type="number"
                              min="0"
                              step="0.01"
                              placeholder={row.service_type === 'labor_hours' ? '0.0' : '0'}
                              value={row.quantity}
                              onChange={e => updateRow(current.client_id, row.service_type, 'quantity', e.target.value)}
                              className="w-full bg-[#EEF3FA] border border-[#CBD5E1] rounded-lg px-3 py-2 text-[#0B1220] text-sm focus:outline-none focus:border-[#1A73E8]"
                            />
                            {row.service_type === 'labor_hours' && (
                              <span className="absolute right-2 top-2 text-xs text-[#4B4F58]">hrs</span>
                            )}
                          </div>
                          <input
                            type="text"
                            placeholder="Optional notes"
                            value={row.notes}
                            onChange={e => updateRow(current.client_id, row.service_type, 'notes', e.target.value)}
                            className="bg-[#EEF3FA] border border-[#CBD5E1] rounded-lg px-3 py-2 text-[#0B1220] text-sm focus:outline-none focus:border-[#1A73E8]"
                          />
                        </div>

                        {/*
                          Prep steps, shown only once FBA prep has a quantity --
                          an unfilled row does not need five checkboxes.

                          The wording says these do not change the price, because
                          a row of tickboxes next to a quantity reads like a
                          price list. They are recorded detail: the charge is the
                          single blended FBA prep rate x quantity, computed
                          server-side, so ticking all five bills exactly what
                          ticking one does.
                        */}
                        {row.service_type === FBA_PREP_SERVICE
                          && row.quantity !== ''
                          && parseFloat(row.quantity) > 0 && (
                          <div className="mt-2.5 pl-1">
                            <p className="text-[11px] text-[#6B7A8D] mb-1.5">
                              Steps performed — recorded on the line, does not change the price
                            </p>
                            <div className="flex flex-wrap gap-2">
                              {FBA_PREP_STEPS.map(step => {
                                const on = row.steps.includes(step)
                                return (
                                  <button
                                    key={step}
                                    type="button"
                                    onClick={() => toggleStep(current.client_id, row.service_type, step)}
                                    aria-pressed={on}
                                    className={`px-2.5 py-1 rounded-lg text-xs border transition ${
                                      on
                                        ? 'bg-[#1A73E8]/20 border-[#1A73E8] text-[#66CCFF]'
                                        : 'bg-[#EEF3FA] border-[#CBD5E1] text-[#4B4F58] hover:border-gray-500'
                                    }`}
                                  >
                                    {on ? '✓ ' : ''}{step}
                                  </button>
                                )
                              })}
                            </div>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {/* Shown before submit, not after. Afterwards the rows are written and
            the only remedy is an edit. */}
        {currentOverlap && (
          <div className="bg-amber-500/10 border border-amber-500/40 rounded-xl px-5 py-3">
            <p className="text-amber-700 text-xs font-semibold mb-1">Check this before submitting</p>
            <p className="text-amber-700 text-xs">{currentOverlap}</p>
          </div>
        )}

        {error && <p className="text-red-700 text-sm">{error}</p>}

        <div className="pt-2 pb-6">
          {/*
            What submit will write, across every client and not just the one on
            screen. The dropdown hides the other clients' rows, so without this
            line the button's scope is invisible -- and an operator who typed
            for three clients has no way to tell whether switching the dropdown
            kept or dropped the other two.
          */}
          {pending.length > 0 && (
            <p className="text-xs text-[#4B4F58] mb-2">
              Submitting {pendingRowCount} line{pendingRowCount === 1 ? '' : 's'} for{' '}
              <span className="text-[#3A4658]">{pending.map(p => p.name).join(', ')}</span>
            </p>
          )}
          <button
            type="submit"
            disabled={loading || entries.length === 0}
            className="w-full bg-[#1A73E8] hover:bg-[#63B3FF] disabled:opacity-50 text-white py-3 rounded-xl text-sm font-semibold transition"
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
      <p className="text-red-700 text-sm font-semibold">Could not load today's entries</p>
      <p className="text-red-700 text-xs mt-1">
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
    <div className="mt-4 bg-white rounded-xl p-6">
      <h3 className="font-semibold text-[#0B1220] mb-4">Today's Submitted Entries</h3>
      <div className="space-y-6">
        {Object.entries(byClient).map(([clientName, clientEntries]) => (
          <div key={clientName}>
            <p className="text-[#1A73E8] text-sm font-medium mb-2">{clientName}</p>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[#4B4F58] text-left border-b border-[#E2E8F0]">
                  <th className="pb-2">Service</th>
                  <th className="pb-2">Qty</th>
                  <th className="pb-2">Notes</th>
                  <th className="pb-2 text-right">Rate</th>
                  <th className="pb-2 text-right">Total</th>
                </tr>
              </thead>
              <tbody>
                {clientEntries.map((e: any) => (
                  <tr key={e.id} className="border-b border-[#E2E8F0]/40">
                    <td className="py-1.5 text-[#3A4658]">{e.service_type?.replace(/_/g, ' ')}</td>
                    <td className="py-1.5">{e.quantity}</td>
                    <td className="py-1.5 text-[#6B7A8D] text-xs">{e.notes ?? '—'}</td>
                    <td className="py-1.5 text-right text-[#4B4F58]">{money(e.rate)}</td>
                    <td className={`py-1.5 text-right font-semibold ${e.total === null || e.total === undefined ? 'text-amber-700' : 'text-emerald-700'}`}>
                      {e.total === null || e.total === undefined ? 'unpriced' : money(e.total)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={4} className="pt-2 text-[#6B7A8D] text-xs">
                    Subtotal
                    {clientEntries.some((e: any) => e.total === null || e.total === undefined) && (
                      <span className="text-amber-700"> (excludes unpriced lines)</span>
                    )}
                  </td>
                  <td className="pt-2 text-right font-bold text-[#0B1220] text-sm">
                    ${clientEntries.reduce((s, e) => s + (e.total ?? 0), 0).toFixed(2)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        ))}
      </div>
      <div className="border-t border-[#CBD5E1] mt-4 pt-4 flex justify-between">
        <span className="text-[#4B4F58] text-sm font-medium">Day Total</span>
        <div className="text-right">
          <span className="text-[#0B1220] font-bold">${entries.reduce((s, e) => s + (e.total ?? 0), 0).toFixed(2)}</span>
          {unpricedCount > 0 && (
            <p className="text-amber-700 text-xs mt-0.5">
              excludes {unpricedCount} unpriced line{unpricedCount === 1 ? '' : 's'}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
