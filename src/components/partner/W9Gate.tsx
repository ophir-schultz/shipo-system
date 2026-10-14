'use client'

import { useState } from 'react'
import { w9PartnerMessage, type W9Candidate } from '@/lib/partner-w9'

// The W-9 screen, between the disclaimer and the statement. Spec §2.1.
//
// ORDER: the disclaimer comes FIRST and this second, and that is not a
// layout preference. This screen is the one that leads to a form carrying
// a legal name, an address and a taxpayer identification number, and the
// disclaimer is where the partner is told what we do and do not do with
// what he gives us. Asking for a TIN before he has read that is the thing
// §2.1 orders these two gates to prevent.
//
// A GATE WITH NO EXIT IS A LOCKOUT. Every failure path below leaves the
// button enabled and names a human. A partner who has signed his
// agreement and is owed money cannot be shown a dead screen, and the two
// most likely failures here are ours, not his: no accountant address
// configured, or no DocuSign credentials.
//
// THE TIN NEVER REACHES THIS PROCESS. Signing happens inside DocuSign;
// this component asks a route for a URL and sends the browser there.
// Nothing on this screen may ever collect a number, and the URL it
// receives is a bearer credential for one signing session — it is
// followed, never displayed, stored or logged.

export default function W9Gate({ partner }: { partner: W9Candidate }) {
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
      // strands a partner on the one screen he cannot get past.
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-2xl font-bold">One form before your statement</h1>

      <p className="mt-4 text-sm leading-relaxed text-gray-300">{message}</p>

      <div className="mt-8 rounded-lg border border-gray-800 bg-gray-900/40 p-5">
        {error && <p className="mb-4 text-sm leading-relaxed text-red-400">{error}</p>}
        <button
          type="button"
          onClick={sign}
          disabled={busy}
          className="w-full rounded-lg bg-[#00AAFF] px-4 py-3 font-semibold text-[#04121f] disabled:opacity-40 sm:w-auto sm:px-8"
        >
          {busy ? 'Opening DocuSign…' : 'Sign your W-9'}
        </button>
        <p className="mt-4 text-sm leading-relaxed text-gray-400">
          The form opens in DocuSign. You can come straight back here when it is signed — and if anything goes wrong,
          email{' '}
          <a href="mailto:Support@shipousa.com" className="text-gray-300 underline">
            Support@shipousa.com
          </a>{' '}
          and we will send it to you directly.
        </p>
      </div>

      <p className="mt-8 text-xs leading-relaxed text-gray-600">
        You sign inside DocuSign, not here. Shipo records only the date your form came back — your taxpayer ID stays in
        DocuSign and is never stored on our side. A copy goes to our accountant, who files your 1099.
      </p>
    </div>
  )
}
