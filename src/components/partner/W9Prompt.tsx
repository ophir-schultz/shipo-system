'use client'

import { useState } from 'react'
import { w9PartnerMessage, type W9Candidate } from '@/lib/partner-w9'

// The W-9 prompt, printed INSIDE the statement where the figures would be.
//
// IT IS NOT A GATE ANY MORE, AND THAT IS THE POINT. This used to be
// W9Gate: src/app/partner/page.tsx returned it INSTEAD of <Statement />,
// so a partner who had signed his agreement and been linked to clients
// saw a request for his taxpayer ID and nothing else. The agreement opens
// the portal; the W-9 opens PAYMENT. So this component now takes the
// place of the four headline tiles, and the rest of the statement — the
// roster, the commission window, the claim form — renders around it.
//
// ORDER IS STILL ENFORCED (§2.1), TRANSITIVELY. The TIN request must come
// after the disclaimer, because the disclaimer is where the partner is
// told what we do with a legal name, an address and a taxpayer ID. This
// component is reachable only from inside <Statement>, which
// src/lib/partner-terms.test.ts pins below the acceptance gate.
//
// A PROMPT WITH NO EXIT IS STILL A DEAD END. Every failure path below
// leaves the button enabled and names a human. The two most likely
// failures are ours, not his: no accountant address configured, or no
// DocuSign credentials — and nothing but the DocuSign webhook can record
// a W-9, so Support@shipousa.com is a route to having the form sent, not
// an invitation to email us a taxpayer ID.
//
// THE TIN NEVER REACHES THIS PROCESS. Signing happens inside DocuSign;
// this component asks a route for a URL and sends the browser there.
// Nothing on this screen may ever collect a number, and the URL it
// receives is a bearer credential for one signing session — it is
// followed, never displayed, stored or logged.

export default function W9Prompt({ partner }: { partner: W9Candidate }) {
  const message = w9PartnerMessage(partner)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function sign() {
    setError(null)
    setBusy(true)
    try {
      const res = await fetch('/api/partner/w9-sign', { method: 'POST' })
      const json = (await res.json().catch(() => ({}))) as { url?: string; error?: string }

      // `!json.url` and not just `!res.ok`: a 200 with no URL is the one
      // shape that would otherwise fall through to the navigation below
      // and set window.location to undefined, which looks to the partner
      // like the button doing nothing at all.
      if (!res.ok || !json.url) {
        // The route's own sentence, which is written for the partner and
        // already names the way out. Preferred over anything invented
        // here so there is one version of each refusal.
        setError(json.error ?? 'We could not open the form. Email Support@shipousa.com and we will send it to you.')
        return
      }

      // Leaving the app entirely. Not router.push: this is a DocuSign URL,
      // and the partner comes back to /partner by DocuSign's returnUrl
      // once he has signed or abandoned it.
      window.location.href = json.url
    } catch {
      setError('We could not reach the server. Check your connection and try again.')
    } finally {
      // Re-enabled even on the success path. The navigation above is not
      // instant, and a button that stays dead after a failed attempt
      // leaves him with no route to his money.
      setBusy(false)
    }
  }

  return (
    <div className="rounded-xl border border-yellow-300 bg-yellow-50 p-5">
      {/* Amber, not red, and the heading answers the question the missing
          tiles put in his head rather than announcing a fault. Nothing is
          broken: a form is outstanding and his commission is accruing
          behind it. */}
      <h2 className="text-base font-semibold text-[var(--brand-ink)]">Your figures are waiting on one form</h2>

      <p className="mt-3 text-sm leading-relaxed text-gray-700">{message}</p>

      {error && <p className="mt-4 text-sm leading-relaxed text-red-700">{error}</p>}

      <button
        type="button"
        onClick={sign}
        disabled={busy}
        className="mt-5 w-full rounded-lg bg-[var(--brand-action)] px-4 py-3 font-semibold text-white disabled:opacity-40 sm:w-auto sm:px-8"
      >
        {busy ? 'Opening DocuSign…' : 'Sign your W-9'}
      </button>

      <p className="mt-4 text-sm leading-relaxed text-gray-600">
        The form opens in DocuSign. You can come straight back here when it is signed — and if anything goes wrong,
        email{' '}
        <a href="mailto:Support@shipousa.com" className="text-gray-700 underline">
          Support@shipousa.com
        </a>{' '}
        and we will send it to you directly.
      </p>

      <p className="mt-4 text-xs leading-relaxed text-gray-600">
        You sign inside DocuSign, not here. Shipo records only the date your form came back — your taxpayer ID stays in
        DocuSign and is never stored on our side. A copy goes to our accountant, who files your 1099.
      </p>
    </div>
  )
}
