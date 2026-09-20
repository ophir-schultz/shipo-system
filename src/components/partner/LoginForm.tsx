'use client'

import { useState, useRef, useEffect } from 'react'
import { useRouter } from 'next/navigation'

// Two-step partner login. Email -> code -> in.
//
// The email step deliberately shows the same confirmation whether or
// not the address belongs to a partner; the API behaves the same way.
// Do not "improve" this by telling the visitor the email is unknown.

export default function PartnerLoginForm() {
  const router = useRouter()
  const [step, setStep] = useState<'email' | 'code'>('email')
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const codeRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (step === 'code') codeRef.current?.focus()
  }, [step])

  async function requestCode(e?: React.FormEvent) {
    e?.preventDefault()
    setError(null)
    setBusy(true)
    try {
      const res = await fetch('/api/partner/request-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      })
      const json = await res.json()
      if (!res.ok) {
        setError(json.error ?? 'Something went wrong. Try again.')
        return
      }
      setCode('')
      setStep('code')
    } catch {
      setError('Could not reach the server. Check your connection and try again.')
    } finally {
      setBusy(false)
    }
  }

  async function verifyCode(e?: React.FormEvent) {
    e?.preventDefault()
    setError(null)
    setBusy(true)
    try {
      const res = await fetch('/api/partner/verify-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, code }),
      })
      const json = await res.json()
      if (!res.ok) {
        setError(json.error ?? 'That code is not valid. Request a new one.')
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

      {step === 'email' ? (
        <>
          <p className="text-sm text-gray-400 mt-2 mb-6">
            Enter the email address Shipo has on file for you. We&apos;ll send you a 6-digit code — there is no password
            to remember.
          </p>
          <form onSubmit={requestCode} className="space-y-4">
            <div>
              <label htmlFor="email" className="block text-xs uppercase tracking-wider text-gray-400 mb-1.5">
                Email address
              </label>
              <input
                id="email"
                type="email"
                required
                autoComplete="email"
                autoFocus
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                className="w-full rounded-lg border border-gray-700 bg-gray-900/60 px-3 py-2.5 text-white placeholder-gray-600 outline-none focus:border-[#00AAFF]"
              />
            </div>
            {error && <p className="text-sm text-red-400">{error}</p>}
            <button
              type="submit"
              disabled={busy || !email}
              className="w-full rounded-lg bg-[#00AAFF] px-4 py-2.5 font-semibold text-[#04121f] disabled:opacity-40"
            >
              {busy ? 'Sending…' : 'Send me a code'}
            </button>
          </form>
        </>
      ) : (
        <>
          <p className="text-sm text-gray-400 mt-2 mb-6">
            If <span className="text-gray-200">{email}</span> is on file, a 6-digit code is on its way. It expires in 10
            minutes.
          </p>
          <form onSubmit={verifyCode} className="space-y-4">
            <div>
              <label htmlFor="code" className="block text-xs uppercase tracking-wider text-gray-400 mb-1.5">
                6-digit code
              </label>
              <input
                id="code"
                ref={codeRef}
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                required
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="000000"
                className="w-full rounded-lg border border-gray-700 bg-gray-900/60 px-3 py-2.5 text-center font-mono text-2xl tracking-[0.5em] text-white placeholder-gray-700 outline-none focus:border-[#00AAFF]"
              />
            </div>
            {error && <p className="text-sm text-red-400">{error}</p>}
            <button
              type="submit"
              disabled={busy || code.length !== 6}
              className="w-full rounded-lg bg-[#00AAFF] px-4 py-2.5 font-semibold text-[#04121f] disabled:opacity-40"
            >
              {busy ? 'Checking…' : 'Sign in'}
            </button>
            <div className="flex items-center justify-between pt-1 text-xs">
              <button
                type="button"
                onClick={() => {
                  setStep('email')
                  setError(null)
                  setCode('')
                }}
                className="text-gray-400 underline"
              >
                Use a different email
              </button>
              <button type="button" onClick={() => requestCode()} disabled={busy} className="text-gray-400 underline">
                Send a new code
              </button>
            </div>
          </form>
        </>
      )}

      <p className="mt-8 text-xs text-gray-600 leading-relaxed">
        Trouble signing in? Email{' '}
        <a href="mailto:Support@shipousa.com" className="text-gray-400 underline">
          Support@shipousa.com
        </a>{' '}
        and we&apos;ll sort it out.
      </p>
    </div>
  )
}
