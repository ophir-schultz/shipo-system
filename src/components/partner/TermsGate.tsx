'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import type { TermsSection } from '@/lib/partner-terms'

// The disclaimer a partner sees once per version, before the statement.
// Spec §2.1 and §2.4.
//
// ONE DELIBERATE ACT, RECORDED. No scroll-to-bottom enforcement and no
// checkbox per section: those make the record look stronger than it is
// (we would be recording that a div scrolled, not that a person read)
// while adding friction to the only screen standing between a partner
// and work he is owed money for. The acceptance row carries the version,
// the timestamp, and the request -- that is the evidence that matters.
//
// This component renders text and POSTs. It never reads ledger data, and
// the page that renders it returns before <Statement> exists, so an
// unaccepted partner's request never touches partner_client_monthly.

export default function TermsGate({
  sections,
  version,
}: {
  sections: ReadonlyArray<TermsSection>
  version: string
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function accept() {
    setError(null)
    setBusy(true)
    try {
      const res = await fetch('/api/partner/accept-terms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version }),
      })
      const json = await res.json().catch(() => ({}))
      if (res.status === 409) {
        // We changed the wording while this tab was open. Reload so he
        // reads the text we are actually standing behind, rather than
        // accepting something we no longer show.
        setError('These terms have changed since this page loaded. Reloading them now…')
        setTimeout(() => window.location.reload(), 1500)
        return
      }
      if (!res.ok) {
        setError(json.error ?? 'Could not record your acceptance. Try again.')
        return
      }
      router.refresh()
    } catch {
      setError('Could not reach the server. Check your connection and try again.')
    } finally {
      // Left enabled on failure on purpose: the partner cannot get to his
      // statement any other way, so a dead button would strand him.
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-2xl font-bold">Before you see your statement</h1>
      <p className="mt-2 text-sm text-gray-600">
        These terms cover what is on the next screen. They do not replace your signed Partner Agreement — if the two
        ever disagree, the agreement governs. Please read them once; we will only ask again if the wording changes.
      </p>

      <div className="mt-8 space-y-6">
        {sections.map((section) => (
          <section key={section.heading}>
            <h2 className="text-sm font-semibold uppercase tracking-wider text-[var(--brand-action)]">{section.heading}</h2>
            <p className="mt-2 text-sm leading-relaxed text-gray-700">{section.body}</p>
          </section>
        ))}
      </div>

      <div className="mt-10 border-t border-gray-200 pt-6">
        {error && <p className="mb-4 text-sm text-red-700">{error}</p>}
        <button
          type="button"
          onClick={accept}
          disabled={busy}
          className="w-full rounded-lg bg-[var(--brand-action)] px-4 py-3 font-semibold text-white disabled:opacity-40 sm:w-auto sm:px-8"
        >
          {busy ? 'Recording…' : 'I accept these terms'}
        </button>
        <p className="mt-4 text-xs leading-relaxed text-gray-600">
          Version {version}. We record which version you accepted and when. Questions about any of it? Email{' '}
          <a href="mailto:Support@shipousa.com" className="text-gray-600 underline">
            Support@shipousa.com
          </a>{' '}
          before you accept.
        </p>
      </div>
    </div>
  )
}
