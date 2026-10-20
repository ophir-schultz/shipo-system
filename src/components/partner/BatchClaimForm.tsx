'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { BATCH_MAX_ROWS } from '@/lib/partner-batch'

// The box a partner pastes his whole book into. Spec 2026-10-20 §3.
//
// THE ANSWER TO "i have close to 100 clients". The single-claim form
// beside this one is five fields and one company; a partner onboarding an
// existing book would fill it in a hundred times, and the daily cap would
// flag or throw away everything past the fifth.
//
// IT LOOKS UP NOTHING, for the same reason ClaimForm looks up nothing: a
// suggestion list that completes "Acme" tells him Acme is a Shipo client
// without the server ever saying so.
//
// IT COUNTS BUT NEVER TRIMS. The line count under the box is a fact about
// his own paste, and over the limit the Send button is disabled with the
// honest number — it does NOT cut the list to 150 and send that. A
// partial accept is the one outcome the whole feature is shaped to
// prevent: he would believe 203 were filed and 53 would be gone, and
// nothing on his screen would ever say so. The server refuses the same
// way, so this is a courtesy, not the gate.
//
// IT RENDERS THE SERVER'S SENTENCE, including both counts. "203 pasted,
// 187 after removing duplicates" is the server's wording and this
// component must not improve on it — a count we compute here could
// disagree with what was stored.

export default function BatchClaimForm() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [list, setList] = useState('')

  // Blank lines are not rows — the server counts the same way, so a
  // paste out of a spreadsheet with a trailing newline reads as the size
  // he actually sent.
  const lineCount = list.split(/\r?\n/).filter((l) => l.trim().length > 0).length
  const overLimit = lineCount > BATCH_MAX_ROWS

  async function readFile(file: File) {
    setError(null)
    try {
      const text = await file.text()
      // Appended, not replaced: a partner who pasted some names and then
      // picked a file did not ask us to throw the paste away.
      setList((prev) => (prev.trim().length === 0 ? text : `${prev.replace(/\s+$/, '')}\n${text}`))
    } catch {
      setError('We could not read that file. You can paste the list in instead.')
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setDone(null)
    setBusy(true)
    try {
      const res = await fetch('/api/partner/claims/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ list }),
      })
      const json = await res.json().catch(() => ({}))

      if (!res.ok) {
        // Every refusal from this route is about the shape of his own
        // paste — too long, empty, a line that is not a company, too
        // many lists today — or about a write that failed. None of them
        // says anything about any company, and none of them is improved
        // by being reworded here.
        setError(json.error ?? 'Could not send that. Please try again.')
        return
      }

      setDone(json.message ?? 'Received.')
      setList('')
      // AND COLLAPSE, because the collapsed branch is the only thing
      // that renders `done` — same reasoning as ClaimForm. A box
      // emptying itself with no confirmation is indistinguishable from a
      // submission that was thrown away, and the next thing he does is
      // paste a hundred companies again.
      setOpen(false)
      // Brings the newly stored claims into the panel above.
      router.refresh()
    } catch {
      // NOT "received". We do not know that it was.
      setError('Could not reach the server. Check your connection and try again.')
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    return (
      <div className="border-t border-gray-200 p-4">
        {done && <p className="text-sm text-green-700 mb-3">{done}</p>}
        <button
          onClick={() => {
            setOpen(true)
            setDone(null)
          }}
          // Navy + underline, not the action blue: this renders inside
          // the roster card, whose background is --brand-surface, where
          // the blue is 4.22:1. See partner-brand.test.ts.
          className="text-sm text-[var(--brand-ink)] underline"
        >
          + Add several clients at once
        </button>
        <p className="text-xs text-gray-500 mt-2">
          Paste a list of companies you brought to Shipo, one per line, or upload a CSV. We review
          every one by hand.
        </p>
      </div>
    )
  }

  return (
    <form onSubmit={submit} className="border-t border-gray-200 p-4 space-y-4">
      <div>
        <p className="text-sm font-medium text-[var(--brand-ink)]">Add several clients at once</p>
        <p className="text-xs text-gray-500 mt-1">
          One company per line. Up to {BATCH_MAX_ROWS} at a time. If your file has a header row with
          a company column we will read the website, contact and email columns too.
        </p>
      </div>

      <label className="block">
        <span className="block text-xs text-gray-600 mb-1">Companies</span>
        <textarea
          value={list}
          onChange={(e) => setList(e.target.value)}
          rows={10}
          // No autocomplete and no suggestions: the browser's own are the
          // partner's history, and ours would be a lookup against
          // Shipo's client list.
          autoComplete="off"
          placeholder={'Acme Widgets\nBeta Supply Co\nGamma Brands'}
          className="w-full bg-[var(--brand-surface-2)] border border-gray-300 rounded px-3 py-2 text-sm font-mono placeholder-gray-400"
        />
      </label>

      <div className="flex flex-wrap items-center gap-3 text-xs">
        <label className="text-gray-600">
          <span className="underline cursor-pointer">Upload a CSV instead</span>
          <input
            type="file"
            accept=".csv,.txt,text/csv,text/plain"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) void readFile(file)
              // Cleared so picking the same file twice still fires.
              e.target.value = ''
            }}
          />
        </label>
        <span className={overLimit ? 'text-red-700' : 'text-gray-500'}>
          {lineCount} {lineCount === 1 ? 'line' : 'lines'}
          {overLimit && ` — that is over ${BATCH_MAX_ROWS}. Please split the list.`}
        </span>
      </div>

      {error && <p className="text-sm text-red-700">{error}</p>}

      <div className="flex items-center gap-3">
        <button
          type="submit"
          // Disabled over the limit, NEVER truncated. The server refuses
          // the whole list for the same reason.
          disabled={busy || lineCount === 0 || overLimit}
          className="px-4 py-2 rounded bg-[var(--brand-action)] text-white text-sm font-medium disabled:opacity-50"
        >
          {busy ? 'Sending…' : 'Send list'}
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false)
            setError(null)
          }}
          className="text-sm text-gray-600 hover:text-[var(--brand-ink)]"
        >
          Cancel
        </button>
      </div>
    </form>
  )
}
