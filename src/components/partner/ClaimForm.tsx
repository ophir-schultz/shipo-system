'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { CLAIM_FIELD_MAX, CLAIM_NOTE_MAX } from '@/lib/partner-claims'

// The form a partner uses to claim a client he says he referred.
// Spec §3.1-§3.2, §3.5.
//
// THE ANSWER TO "How can i add a partner i dont see the option to add
// more of my clients". Before this, a partner with a client we had not
// linked had no way to say so from his own screen.
//
// IT LOOKS UP NOTHING. No autocomplete, no "is this company already
// with Shipo?" check, no debounced validate-on-blur. Each of those
// would be a lookup against Shipo's client list with a partner's hands
// on the keyboard, which is exactly what §3.2 exists to prevent: a
// suggestion list that completes "Acme" tells him Acme is a client
// without the server ever saying so.
//
// IT RENDERS THE SERVER'S SENTENCE, whatever happened. The route
// answers the same body for a new company, an existing Shipo client, a
// company another partner already claimed, and a submission past the
// daily cap — so this component must not improve on it. The one case it
// treats differently is the one the route also treats differently: a
// 500, which means the claim was NOT stored. A partner told "received"
// over a failed write has silently lost a claim worth $300 plus twelve
// months of share and will never resubmit something he watched succeed.

export default function ClaimForm() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const [company, setCompany] = useState('')
  const [website, setWebsite] = useState('')
  const [contactName, setContactName] = useState('')
  const [contactEmail, setContactEmail] = useState('')
  const [note, setNote] = useState('')

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setDone(null)
    setBusy(true)
    try {
      const res = await fetch('/api/partner/claims', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          company_name: company,
          website,
          contact_name: contactName,
          contact_email: contactEmail,
          note,
        }),
      })
      const json = await res.json().catch(() => ({}))

      if (!res.ok) {
        // A 400 is about this form (an empty company name) and a 500 says
        // the claim was not recorded. Both are the server's own sentence:
        // neither one says anything about any company.
        setError(json.error ?? 'Could not send that. Please try again.')
        return
      }

      // The server's message, not ours. Whatever it decided — stored,
      // or refused by the cap — the partner reads one sentence.
      setDone(json.message ?? 'Received.')
      setCompany('')
      setWebsite('')
      setContactName('')
      setContactEmail('')
      setNote('')
      // AND COLLAPSE, because the collapsed branch is the only thing that
      // renders `done`. Setting the message and staying open showed him
      // five fields emptying themselves and no confirmation — which is
      // indistinguishable from a submission that was thrown away, and the
      // next thing he does is type it all again. That duplicate then
      // lands on a human in the staff queue.
      setOpen(false)
      // Brings a newly stored claim into the list above. A claim refused
      // by the cap simply is not there, which is the same screen as
      // before — the concealment holds across the refresh.
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
          // Navy + underline, not the action blue. This button renders
          // inside the roster card, whose background is --brand-surface,
          // and the blue is only 4.22:1 there. See partner-brand.test.ts.
          className="text-sm text-[var(--brand-ink)] underline"
        >
          + Add a client you referred
        </button>
        <p className="text-xs text-gray-500 mt-2">
          Tell us about a client you brought to Shipo who isn&apos;t listed above. We review every
          one by hand before it is added.
        </p>
      </div>
    )
  }

  return (
    <form onSubmit={submit} className="border-t border-gray-200 p-4 space-y-4">
      <div>
        <p className="text-sm font-medium text-[var(--brand-ink)]">Add a client you referred</p>
        <p className="text-xs text-gray-500 mt-1">
          A person reviews this. Only the company name is required — anything else you can tell us
          makes it quicker to confirm.
        </p>
      </div>

      <div className="grid md:grid-cols-2 gap-3">
        <Field label="Company name" required>
          <input
            value={company}
            onChange={(e) => setCompany(e.target.value)}
            maxLength={CLAIM_FIELD_MAX}
            required
            // No autocomplete and no list: see the header. The browser's
            // own suggestions are the partner's history, not ours.
            autoComplete="off"
            className="w-full bg-[var(--brand-surface-2)] border border-gray-300 rounded px-3 py-2 text-sm"
          />
        </Field>
        <Field label="Website">
          <input
            value={website}
            onChange={(e) => setWebsite(e.target.value)}
            maxLength={CLAIM_FIELD_MAX}
            autoComplete="off"
            className="w-full bg-[var(--brand-surface-2)] border border-gray-300 rounded px-3 py-2 text-sm"
          />
        </Field>
        <Field label="Who you dealt with">
          <input
            value={contactName}
            onChange={(e) => setContactName(e.target.value)}
            maxLength={CLAIM_FIELD_MAX}
            autoComplete="off"
            className="w-full bg-[var(--brand-surface-2)] border border-gray-300 rounded px-3 py-2 text-sm"
          />
        </Field>
        <Field label="Their email">
          <input
            // `type="text"`, not `type="email"`: the browser's validator
            // would block a submission over a typo in an OPTIONAL field
            // and the partner would not be told which field stopped him.
            value={contactEmail}
            onChange={(e) => setContactEmail(e.target.value)}
            maxLength={CLAIM_FIELD_MAX}
            autoComplete="off"
            className="w-full bg-[var(--brand-surface-2)] border border-gray-300 rounded px-3 py-2 text-sm"
          />
        </Field>
      </div>

      <Field label="What you did for this referral">
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={CLAIM_NOTE_MAX}
          rows={3}
          className="w-full bg-[var(--brand-surface-2)] border border-gray-300 rounded px-3 py-2 text-sm"
        />
      </Field>

      {error && <p className="text-sm text-red-700">{error}</p>}

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={busy || company.trim().length === 0}
          className="px-4 py-2 rounded bg-[var(--brand-action)] text-white text-sm font-medium disabled:opacity-50"
        >
          {busy ? 'Sending…' : 'Send'}
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

function Field({
  label,
  required,
  children,
}: {
  label: string
  required?: boolean
  children: React.ReactNode
}) {
  return (
    <label className="block">
      <span className="block text-xs text-gray-600 mb-1">
        {label}
        {required && <span className="text-red-700"> *</span>}
      </span>
      {children}
    </label>
  )
}
