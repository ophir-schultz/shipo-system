'use client'

import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase-browser'
import { showError, showSuccess } from '@/components/ui/Toast'
import Image from 'next/image'

type SetupStep = 'idle' | 'enrolling' | 'verifying' | 'done'

interface MfaFactor {
  id: string
  friendly_name?: string
  factor_type: string
  status: string
}

export default function MfaSetup() {
  const [factors, setFactors] = useState<MfaFactor[]>([])
  const [step, setStep] = useState<SetupStep>('idle')
  const [qrCode, setQrCode] = useState('')
  const [secret, setSecret] = useState('')
  const [factorId, setFactorId] = useState('')
  const [code, setCode] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    loadFactors()
  }, [])

  async function loadFactors() {
    const supabase = createClient()
    const { data } = await supabase.auth.mfa.listFactors()
    setFactors((data?.totp ?? []) as MfaFactor[])
  }

  async function handleEnroll() {
    setLoading(true)
    setError('')
    const supabase = createClient()
    const { data, error: enrollError } = await supabase.auth.mfa.enroll({
      factorType: 'totp',
      friendlyName: 'Authenticator App',
    })
    if (enrollError || !data) {
      showError('Enrollment failed', enrollError?.message)
      setLoading(false)
      return
    }
    setFactorId(data.id)
    setQrCode(data.totp.qr_code)
    setSecret(data.totp.secret)
    setStep('enrolling')
    setLoading(false)
  }

  async function handleVerify(e: React.FormEvent) {
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
      setError('Invalid code. Make sure your authenticator app is synced correctly.')
      setLoading(false)
      return
    }

    showSuccess('2FA enabled', 'Two-factor authentication is now active for your account')
    setStep('done')
    setLoading(false)
    loadFactors()
  }

  async function handleRemove(id: string) {
    if (!confirm('Are you sure you want to remove two-factor authentication? This will make your account less secure.')) return
    setLoading(true)
    const supabase = createClient()
    const { error: unenrollError } = await supabase.auth.mfa.unenroll({ factorId: id })
    if (unenrollError) {
      showError('Failed to remove 2FA', unenrollError.message)
    } else {
      showSuccess('2FA removed', 'Two-factor authentication has been disabled')
      loadFactors()
    }
    setLoading(false)
  }

  const verifiedFactors = factors.filter(f => f.status === 'verified')
  const has2FA = verifiedFactors.length > 0

  return (
    <div className="rounded-xl p-6" style={{ background: '#0d1420', border: '1px solid #1a2540' }}>
      <div className="flex items-center gap-3 mb-4">
        <span className="text-2xl">🔐</span>
        <div>
          <h3 className="font-semibold text-white">Two-Factor Authentication</h3>
          <p className="text-xs text-gray-400">Add an extra layer of security to your account</p>
        </div>
        {has2FA && (
          <span className="ml-auto text-xs font-medium px-2 py-1 rounded-full" style={{ background: '#00AAFF22', color: '#00AAFF' }}>
            ✓ Enabled
          </span>
        )}
      </div>

      {has2FA ? (
        <div className="space-y-3">
          {verifiedFactors.map(f => (
            <div key={f.id} className="flex items-center justify-between p-3 rounded-lg bg-gray-800/50">
              <div>
                <p className="text-sm text-white">{f.friendly_name || 'Authenticator App'}</p>
                <p className="text-xs text-gray-500">TOTP · Active</p>
              </div>
              <button
                onClick={() => handleRemove(f.id)}
                disabled={loading}
                className="text-xs text-red-400 hover:text-red-300 transition disabled:opacity-50"
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      ) : step === 'idle' ? (
        <div>
          <p className="text-sm text-gray-400 mb-4">
            Use an authenticator app like <strong className="text-gray-300">Google Authenticator</strong> or <strong className="text-gray-300">Authy</strong> to get a 6-digit code every time you log in.
          </p>
          <button
            onClick={handleEnroll}
            disabled={loading}
            className="px-4 py-2 rounded-lg text-sm font-medium text-white transition disabled:opacity-50"
            style={{ background: '#00AAFF' }}
          >
            {loading ? 'Setting up…' : 'Enable 2FA'}
          </button>
        </div>
      ) : step === 'enrolling' ? (
        <div className="space-y-4">
          <p className="text-sm text-gray-400">
            Scan this QR code with your authenticator app, then enter the 6-digit code below to confirm.
          </p>
          {qrCode && (
            <div className="flex justify-center">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={qrCode} alt="QR Code" className="w-48 h-48 rounded-xl bg-white p-2" />
            </div>
          )}
          {secret && (
            <div className="text-center">
              <p className="text-xs text-gray-500 mb-1">Or enter this key manually:</p>
              <code className="text-xs text-gray-300 bg-gray-800 px-3 py-1.5 rounded-lg break-all">{secret}</code>
            </div>
          )}
          <form onSubmit={handleVerify} className="space-y-3">
            <div>
              <label className="block text-xs text-gray-400 mb-1.5">Verification code</label>
              <input
                type="text"
                inputMode="numeric"
                value={code}
                onChange={e => setCode(e.target.value.replace(/[^0-9]/g, '').slice(0, 6))}
                required
                placeholder="000000"
                maxLength={6}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-3 text-white text-xl font-mono tracking-widest text-center focus:outline-none focus:border-[#00AAFF] transition"
              />
            </div>
            {error && (
              <p className="text-sm text-red-400 bg-red-950/30 border border-red-800/40 rounded-lg px-3 py-2">{error}</p>
            )}
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => { setStep('idle'); setCode(''); setError('') }}
                className="flex-1 py-2 rounded-lg text-sm text-gray-400 bg-gray-700 hover:bg-gray-600 transition"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={loading || code.length !== 6}
                className="flex-1 py-2 rounded-lg text-sm font-medium text-white transition disabled:opacity-50"
                style={{ background: '#00AAFF' }}
              >
                {loading ? 'Verifying…' : 'Confirm & Enable'}
              </button>
            </div>
          </form>
        </div>
      ) : (
        <div className="text-center py-4">
          <div className="text-4xl mb-2">✅</div>
          <p className="text-white font-medium">2FA is now active</p>
          <p className="text-sm text-gray-400 mt-1">You&apos;ll be asked for a code on every login</p>
        </div>
      )}
    </div>
  )
}
