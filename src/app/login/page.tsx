'use client'

import { useState, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import Image from 'next/image'
import Script from 'next/script'
import { createClient } from '@/lib/supabase-browser'

type Step = 'credentials' | 'mfa'

const TURNSTILE_SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? ''

declare global {
  interface Window {
    turnstile?: {
      render: (el: HTMLElement, opts: Record<string, unknown>) => string
      reset: (id?: string) => void
      remove: (id?: string) => void
    }
  }
}

const TRUST_KEY = 'shipo_trusted_device'
const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000

function isTrustedDevice(userId: string): boolean {
  try {
    const raw = localStorage.getItem(TRUST_KEY)
    if (!raw) return false
    const data = JSON.parse(raw)
    if (data.userId !== userId) return false
    if (Date.now() > data.expiry) {
      localStorage.removeItem(TRUST_KEY)
      return false
    }
    return true
  } catch {
    return false
  }
}

function trustDevice(userId: string) {
  try {
    localStorage.setItem(TRUST_KEY, JSON.stringify({
      userId,
      expiry: Date.now() + THIRTY_DAYS,
    }))
  } catch {}
}

export default function LoginPage() {
  const router = useRouter()
  const [step, setStep] = useState<Step>('credentials')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [factorId, setFactorId] = useState('')
  const [userId, setUserId] = useState('')
  const [trustChecked, setTrustChecked] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [captchaToken, setCaptchaToken] = useState('')
  const [scriptLoaded, setScriptLoaded] = useState(false)
  const captchaRef = useRef<HTMLDivElement>(null)
  const widgetId = useRef<string | null>(null)

  // Render the Turnstile widget once the script is ready and we're on the credentials step
  useEffect(() => {
    if (!TURNSTILE_SITE_KEY || !scriptLoaded || step !== 'credentials') return
    if (!captchaRef.current || !window.turnstile) return
    if (widgetId.current) return
    widgetId.current = window.turnstile.render(captchaRef.current, {
      sitekey: TURNSTILE_SITE_KEY,
      theme: 'dark',
      callback: (token: string) => setCaptchaToken(token),
      'expired-callback': () => setCaptchaToken(''),
      'error-callback': () => setCaptchaToken(''),
    })
    return () => {
      if (widgetId.current && window.turnstile) {
        window.turnstile.remove(widgetId.current)
        widgetId.current = null
      }
    }
  }, [scriptLoaded, step])

  function resetCaptcha() {
    setCaptchaToken('')
    if (widgetId.current && window.turnstile) window.turnstile.reset(widgetId.current)
  }

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault()
    if (TURNSTILE_SITE_KEY && !captchaToken) {
      setError('Please complete the verification challenge.')
      return
    }
    setLoading(true)
    setError('')

    // Server-side login: enforces lockout (5 fails → 15 min) and sends alert email
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, captchaToken: captchaToken || undefined }),
    })
    const result = await res.json().catch(() => ({}))

    if (!res.ok) {
      if (res.status === 423) {
        const mins = Math.ceil((result.secondsRemaining ?? 900) / 60)
        setError(`Too many failed attempts. Login is locked for about ${mins} minute${mins !== 1 ? 's' : ''}.`)
      } else {
        const left = typeof result.attemptsRemaining === 'number'
          ? ` ${result.attemptsRemaining} attempt${result.attemptsRemaining !== 1 ? 's' : ''} left before lockout.`
          : ''
        setError('Invalid email or password.' + left)
      }
      resetCaptcha()
      setLoading(false)
      return
    }

    const supabase = createClient()
    const { data: userData } = await supabase.auth.getUser()
    const uid = userData.user?.id ?? ''
    setUserId(uid)

    // Check if MFA is required
    const { data: aalData } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
    if (aalData?.nextLevel === 'aal2' && aalData.nextLevel !== aalData.currentLevel) {
      // Check if this device is already trusted
      if (isTrustedDevice(uid)) {
        // Device trusted — skip MFA, go straight in
        router.push('/dashboard')
        router.refresh()
        return
      }

      // MFA enrolled — need to verify
      const { data: factorsData } = await supabase.auth.mfa.listFactors()
      const totp = factorsData?.totp?.[0]
      if (totp) {
        setFactorId(totp.id)
        setStep('mfa')
        setLoading(false)
        return
      }
    }

    router.push('/dashboard')
    router.refresh()
  }

  async function handleMfa(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')
    const supabase = createClient()

    const { data: challengeData, error: challengeError } = await supabase.auth.mfa.challenge({ factorId })
    if (challengeError) {
      setError(challengeError.message)
      setLoading(false)
      return
    }

    const { error: verifyError } = await supabase.auth.mfa.verify({
      factorId,
      challengeId: challengeData.id,
      code: code.replace(/\s/g, ''),
    })

    if (verifyError) {
      setError('Invalid code. Please try again.')
      setLoading(false)
      return
    }

    if (trustChecked && userId) {
      trustDevice(userId)
    }

    router.push('/dashboard')
    router.refresh()
  }

  return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: '#0a0f1a' }}>
      {TURNSTILE_SITE_KEY && (
        <Script
          src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"
          onLoad={() => setScriptLoaded(true)}
        />
      )}
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="flex justify-center mb-8">
          <div className="rounded-2xl px-6 py-5" style={{ background: '#00AAFF' }}>
            <Image src="/shipo-logo.jpg" alt="Shipo" width={180} height={60} className="rounded-xl" priority />
          </div>
        </div>

        <div className="rounded-2xl p-8" style={{ background: '#0d1420', border: '1px solid #1a2540' }}>
          {step === 'credentials' ? (
            <>
              <h1 className="text-xl font-bold text-white mb-1">Welcome back</h1>
              <p className="text-sm text-gray-400 mb-6">Sign in to Shipo Operations Platform</p>

              <form onSubmit={handleLogin} className="space-y-4">
                <div>
                  <label className="block text-xs text-gray-400 mb-1.5">Email</label>
                  <input
                    type="email"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    required
                    autoComplete="email"
                    placeholder="you@shipousa.com"
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-white text-sm focus:outline-none focus:border-[#00AAFF] transition"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-400 mb-1.5">Password</label>
                  <input
                    type="password"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    required
                    autoComplete="current-password"
                    placeholder="••••••••"
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-white text-sm focus:outline-none focus:border-[#00AAFF] transition"
                  />
                </div>

                {/* Cloudflare Turnstile bot-protection widget */}
                {TURNSTILE_SITE_KEY && (
                  <div ref={captchaRef} className="flex justify-center" />
                )}

                {error && (
                  <p className="text-sm text-red-400 bg-red-950/30 border border-red-800/40 rounded-lg px-3 py-2">{error}</p>
                )}

                <button
                  type="submit"
                  disabled={loading || (!!TURNSTILE_SITE_KEY && !captchaToken)}
                  className="w-full py-2.5 rounded-lg text-white font-semibold text-sm transition disabled:opacity-50"
                  style={{ background: '#00AAFF' }}
                >
                  {loading ? 'Signing in…' : 'Sign In'}
                </button>
              </form>
            </>
          ) : (
            <>
              <div className="flex items-center gap-3 mb-6">
                <div className="w-10 h-10 rounded-full flex items-center justify-center text-xl" style={{ background: '#00AAFF22' }}>
                  🔐
                </div>
                <div>
                  <h1 className="text-xl font-bold text-white">Two-Factor Auth</h1>
                  <p className="text-sm text-gray-400">Enter the code from your authenticator app</p>
                </div>
              </div>

              <form onSubmit={handleMfa} className="space-y-4">
                <div>
                  <label className="block text-xs text-gray-400 mb-1.5">6-digit code</label>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={code}
                    onChange={e => setCode(e.target.value.replace(/[^0-9]/g, '').slice(0, 6))}
                    required
                    autoFocus
                    autoComplete="one-time-code"
                    placeholder="000000"
                    maxLength={6}
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-3 text-white text-2xl font-mono tracking-widest text-center focus:outline-none focus:border-[#00AAFF] transition"
                  />
                </div>

                {/* Trust this device */}
                <label className="flex items-center gap-3 cursor-pointer group">
                  <div className="relative">
                    <input
                      type="checkbox"
                      checked={trustChecked}
                      onChange={e => setTrustChecked(e.target.checked)}
                      className="sr-only"
                    />
                    <div
                      className="w-4 h-4 rounded border-2 flex items-center justify-center transition"
                      style={{
                        borderColor: trustChecked ? '#00AAFF' : '#4B5563',
                        background: trustChecked ? '#00AAFF' : 'transparent',
                      }}
                    >
                      {trustChecked && <span className="text-white text-xs leading-none">✓</span>}
                    </div>
                  </div>
                  <span className="text-sm text-gray-400 group-hover:text-gray-300 transition">
                    Trust this device for 30 days
                  </span>
                </label>

                {error && (
                  <p className="text-sm text-red-400 bg-red-950/30 border border-red-800/40 rounded-lg px-3 py-2">{error}</p>
                )}

                <button
                  type="submit"
                  disabled={loading || code.length !== 6}
                  className="w-full py-2.5 rounded-lg text-white font-semibold text-sm transition disabled:opacity-50"
                  style={{ background: '#00AAFF' }}
                >
                  {loading ? 'Verifying…' : 'Verify'}
                </button>

                <button
                  type="button"
                  onClick={() => { setStep('credentials'); setCode(''); setError('') }}
                  className="w-full py-2 text-sm text-gray-500 hover:text-gray-300 transition"
                >
                  ← Back to login
                </button>
              </form>
            </>
          )}
        </div>

        <p className="text-center text-xs text-gray-600 mt-6">ShipoLLC Operations Platform · Internal Use Only</p>
      </div>
    </div>
  )
}
