'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

// The Continue button. Spec §2.1.
//
// ============================================================
// WHY THERE IS A BUTTON HERE AT ALL
//
// "One click for the partner" could have been zero clicks: a URL that
// signs him in when fetched. That is wrong, and not for a reason about
// cryptography — the token is 32 bytes of CSPRNG and nobody is guessing
// it. It is that mail infrastructure FETCHES links. A single-use
// credential redeemed on GET is spent by a scanner before the partner
// opens the message.
//
// So the redemption is a POST, and a POST needs a human to start it.
// This component is that human's one click.
//
// THE 6-DIGIT FALLBACK IS ON SCREEN FROM THE START, not revealed after
// a failure. The page cannot know whether the token is good — only the
// POST knows — so a partner whose link expired over a long weekend
// would otherwise have to click, be refused, and then find his own way
// out. §8: "An expired link falls back to the 6-digit code without a
// dead end."
// ============================================================

export default function PartnerSignInLink({ token }: { token: string | null }) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function signIn() {
    if (!token) return
    setError(null)
    setBusy(true)
    try {
      const res = await fetch('/api/partner/verify-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      })
      const json = await res.json()
      if (!res.ok) {
        // The route's own sentence, verbatim. It is the only thing
        // that knows WHICH refusal this is — an unknown token, a spent
        // one, a paused partner, a voided agreement — and the wording
        // differs. Substituting a generic message here would throw
        // away the one explanation a partner can act on.
        setError(json.error ?? 'That sign-in link is no longer valid.')
        return
      }
      router.replace('/partner')
      router.refresh()
    } catch {
      setError('Could not reach the server. Check your connection and try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto max-w-sm">
      <h1 className="text-2xl font-bold">Partner sign in</h1>

      {token ? (
        <>
          <p className="text-sm text-gray-600 mt-2 mb-6">
            You followed a sign-in link from Shipo. Click below to open your statement.
          </p>
          {error && <p className="text-sm text-red-700 mb-4">{error}</p>}
          <button
            type="button"
            onClick={signIn}
            disabled={busy}
            className="w-full rounded-lg bg-[var(--brand-action)] px-4 py-2.5 font-semibold text-white disabled:opacity-40"
          >
            {busy ? 'Signing you in…' : 'Continue'}
          </button>
        </>
      ) : (
        // No usable token in the URL. This is what a mail client that
        // wrapped the link across a line looks like from here, and it
        // is not the partner's fault — so it gets a plain description
        // and a way in, not an error.
        <p className="text-sm text-gray-600 mt-2 mb-6">
          This sign-in link is incomplete — some email programs break long links across lines. Use
          the 6-digit code instead.
        </p>
      )}

      {/* Always present, never conditional on a failure. */}
      <p className="mt-6 text-xs text-gray-600 leading-relaxed">
        Link not working?{' '}
        <a href="/partner/login" className="text-[var(--brand-action)] underline">
          Sign in with a 6-digit code
        </a>{' '}
        — we&apos;ll email you a fresh one. Sign-in links expire after seven days and can only be
        used once.
      </p>

      <p className="mt-4 text-xs text-gray-600 leading-relaxed">
        Trouble signing in? Email{' '}
        <a href="mailto:Support@shipousa.com" className="text-gray-600 underline">
          Support@shipousa.com
        </a>{' '}
        and we&apos;ll sort it out.
      </p>
    </div>
  )
}
