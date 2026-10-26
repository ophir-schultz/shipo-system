'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { showError, showSuccess } from '@/components/ui/Toast'
import { testBanner, missingKeyNotice, type TestBanner } from '@/lib/clients/zenventory-test-result'

export default function ZenventoryCredentials({ clientId, apiKey, apiSecret, secureKey }: {
  clientId: string
  apiKey?: string
  apiSecret?: string
  secureKey?: string
}) {
  const router = useRouter()
  const [editing, setEditing] = useState(false)
  const [key, setKey] = useState(apiKey ?? '')
  const [secret, setSecret] = useState(apiSecret ?? '')
  const [sk, setSk] = useState(secureKey ?? '')
  const [loading, setLoading] = useState(false)
  // The whole banner, not a boolean. A boolean could only ever select between
  // two hardcoded sentences, and the failing one was a diagnosis ("check API
  // Key and Secret") that is wrong for a 403, a 5xx, a timeout, and for a
  // client with no credentials at all. See lib/clients/zenventory-test-result.
  const [tested, setTested] = useState<TestBanner | null>(null)

  async function handleSave() {
    setLoading(true)
    const res = await fetch(`/api/clients/${clientId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ zenventory_api_key: key, zenventory_api_secret: secret, zenventory_secure_key: sk }),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      showError('Failed to save credentials', data.error ?? 'Please try again')
      setLoading(false)
      return
    }
    showSuccess('Credentials saved')
    setEditing(false)
    setLoading(false)
    router.refresh()
  }

  async function handleTest() {
    setLoading(true)
    setTested(null)
    const res = await fetch(`/api/clients/${clientId}/test-zenventory`, { method: 'POST' })
    // `.json()` on a 503 with an HTML body throws, and the throw used to leave
    // `loading` stuck on "Testing..." for ever with no banner. A test that
    // cannot report its own failure is worse than one that fails.
    const data = await res.json().catch(() => ({
      success: false,
      error: `The test endpoint answered HTTP ${res.status} with no JSON body`,
    }))
    const banner = testBanner(data)
    setTested(banner)
    if (banner.ok) showSuccess('Connection successful', 'Zenventory API 2.0 credentials are working')
    else showError(banner.title, banner.detail || 'No further detail was returned')
    setLoading(false)
  }

  return (
    <div className="bg-white rounded-xl p-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-lg font-semibold text-[#0B1220]">Zenventory API</h3>
          <p className="text-[#4B4F58] text-sm mt-0.5">API 2.0 (Basic Auth) for orders · Legacy (SecureKey) for shipments</p>
        </div>
        <div className="flex gap-2">
          {apiKey && !editing && (
            <button onClick={handleTest} disabled={loading} className="bg-[#EEF3FA] hover:bg-[#DDE6F2] text-[#0B1220] px-3 py-1.5 rounded-lg text-sm transition">
              {loading ? 'Testing...' : 'Test API 2.0'}
            </button>
          )}
          <button onClick={() => setEditing(!editing)} className="bg-[#1A73E8] hover:bg-[#63B3FF] text-white px-3 py-1.5 rounded-lg text-sm transition">
            {editing ? 'Cancel' : apiKey ? 'Update' : 'Add Credentials'}
          </button>
        </div>
      </div>

      {tested !== null && (
        <div className={`mb-4 px-4 py-2 rounded-lg text-sm ${tested.ok ? 'bg-green-900 text-green-300' : 'bg-red-900 text-red-300'}`}>
          <p>{tested.ok ? '✓' : '✗'} {tested.title}</p>
          {/* The server's own words, kept in the banner rather than a toast
              that vanishes. `break-all` because the body is JSON from
              Zenventory and can be one long unbroken string. */}
          {tested.detail && (
            <p className="mt-1 font-mono text-xs opacity-80 break-all">{tested.detail}</p>
          )}
        </div>
      )}

      {!editing && (
        <div className="space-y-3">
          {apiKey ? (
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-[#4B4F58]">API Key (2.0)</span>
                <span className="text-[#3A4658] font-mono">{apiKey.slice(0, 8)}••••••••</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[#4B4F58]">API Secret (2.0)</span>
                <span className="text-[#3A4658] font-mono">••••••••</span>
              </div>
            </div>
          ) : (
            // Not one sentence for both. `null` is "not configured"; `''` is
            // "configured as empty and failing every scheduled run". See
            // missingKeyNotice.
            <p className={missingKeyNotice(apiKey)?.tone === 'warn'
              ? 'text-yellow-500 text-sm'
              : 'text-[#6B7A8D] text-sm'}>
              {missingKeyNotice(apiKey)?.text}
            </p>
          )}
          {secureKey ? (
            <div className="flex justify-between text-sm">
              <span className="text-[#4B4F58]">SecureKey (Legacy)</span>
              <span className="text-[#3A4658] font-mono">{secureKey.slice(0, 8)}••••••••</span>
            </div>
          ) : (
            <p className="text-yellow-600 text-sm">No SecureKey — add it to enable Legacy API shipment data.</p>
          )}
        </div>
      )}

      {editing && (
        <div className="space-y-4">
          <div>
            <p className="text-xs text-[#6B7A8D] mb-3 uppercase tracking-wider">API 2.0 — Basic Auth (Customer Orders)</p>
            <div className="space-y-3">
              <div>
                <label className="block text-sm text-[#4B4F58] mb-1.5">API Key</label>
                <input
                  value={key}
                  onChange={e => setKey(e.target.value)}
                  className="w-full bg-[#EEF3FA] border border-[#CBD5E1] rounded-lg px-4 py-2.5 text-[#0B1220] font-mono text-sm focus:outline-none focus:border-[#1A73E8]"
                  placeholder="Zenventory API Key"
                />
              </div>
              <div>
                <label className="block text-sm text-[#4B4F58] mb-1.5">API Secret</label>
                <input
                  value={secret}
                  onChange={e => setSecret(e.target.value)}
                  className="w-full bg-[#EEF3FA] border border-[#CBD5E1] rounded-lg px-4 py-2.5 text-[#0B1220] font-mono text-sm focus:outline-none focus:border-[#1A73E8]"
                  placeholder="Zenventory API Secret"
                />
              </div>
            </div>
          </div>

          <div>
            <p className="text-xs text-[#6B7A8D] mb-3 uppercase tracking-wider">Legacy API — SecureKey (Shipment Data)</p>
            <div>
              <label className="block text-sm text-[#4B4F58] mb-1.5">SecureKey</label>
              <input
                value={sk}
                onChange={e => setSk(e.target.value)}
                className="w-full bg-[#EEF3FA] border border-[#CBD5E1] rounded-lg px-4 py-2.5 text-[#0B1220] font-mono text-sm focus:outline-none focus:border-[#1A73E8]"
                placeholder="Zenventory SecureKey"
              />
            </div>
          </div>

          <button onClick={handleSave} disabled={loading} className="w-full bg-[#1A73E8] hover:bg-[#63B3FF] disabled:opacity-50 text-white py-2.5 rounded-lg text-sm font-medium transition">
            {loading ? 'Saving...' : 'Save Credentials'}
          </button>
        </div>
      )}
    </div>
  )
}
