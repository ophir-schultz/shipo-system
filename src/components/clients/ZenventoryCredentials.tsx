'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { showError, showSuccess } from '@/components/ui/Toast'

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
  const [tested, setTested] = useState<boolean | null>(null)

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
    const data = await res.json()
    setTested(data.success)
    if (!data.success) showError('Connection failed', data.error ?? 'Check your Zenventory credentials')
    else showSuccess('Connection successful', 'Zenventory API 2.0 credentials are working')
    setLoading(false)
  }

  return (
    <div className="bg-gray-800 rounded-xl p-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-lg font-semibold text-white">Zenventory API</h3>
          <p className="text-gray-400 text-sm mt-0.5">API 2.0 (Basic Auth) for orders · Legacy (SecureKey) for shipments</p>
        </div>
        <div className="flex gap-2">
          {apiKey && !editing && (
            <button onClick={handleTest} disabled={loading} className="bg-gray-700 hover:bg-gray-600 text-white px-3 py-1.5 rounded-lg text-sm transition">
              {loading ? 'Testing...' : 'Test API 2.0'}
            </button>
          )}
          <button onClick={() => setEditing(!editing)} className="bg-[#00AAFF] hover:bg-[#33BBFF] text-white px-3 py-1.5 rounded-lg text-sm transition">
            {editing ? 'Cancel' : apiKey ? 'Update' : 'Add Credentials'}
          </button>
        </div>
      </div>

      {tested !== null && (
        <div className={`mb-4 px-4 py-2 rounded-lg text-sm ${tested ? 'bg-green-900 text-green-300' : 'bg-red-900 text-red-300'}`}>
          {tested ? '✓ API 2.0 connection successful' : '✗ API 2.0 connection failed — check API Key and Secret'}
        </div>
      )}

      {!editing && (
        <div className="space-y-3">
          {apiKey ? (
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-400">API Key (2.0)</span>
                <span className="text-gray-300 font-mono">{apiKey.slice(0, 8)}••••••••</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-400">API Secret (2.0)</span>
                <span className="text-gray-300 font-mono">••••••••</span>
              </div>
            </div>
          ) : (
            <p className="text-gray-500 text-sm">No API 2.0 credentials — add them to enable order syncing.</p>
          )}
          {secureKey ? (
            <div className="flex justify-between text-sm">
              <span className="text-gray-400">SecureKey (Legacy)</span>
              <span className="text-gray-300 font-mono">{secureKey.slice(0, 8)}••••••••</span>
            </div>
          ) : (
            <p className="text-yellow-600 text-sm">No SecureKey — add it to enable Legacy API shipment data.</p>
          )}
        </div>
      )}

      {editing && (
        <div className="space-y-4">
          <div>
            <p className="text-xs text-gray-500 mb-3 uppercase tracking-wider">API 2.0 — Basic Auth (Customer Orders)</p>
            <div className="space-y-3">
              <div>
                <label className="block text-sm text-gray-400 mb-1.5">API Key</label>
                <input
                  value={key}
                  onChange={e => setKey(e.target.value)}
                  className="w-full bg-gray-700 border border-gray-600 rounded-lg px-4 py-2.5 text-white font-mono text-sm focus:outline-none focus:border-[#00AAFF]"
                  placeholder="Zenventory API Key"
                />
              </div>
              <div>
                <label className="block text-sm text-gray-400 mb-1.5">API Secret</label>
                <input
                  value={secret}
                  onChange={e => setSecret(e.target.value)}
                  className="w-full bg-gray-700 border border-gray-600 rounded-lg px-4 py-2.5 text-white font-mono text-sm focus:outline-none focus:border-[#00AAFF]"
                  placeholder="Zenventory API Secret"
                />
              </div>
            </div>
          </div>

          <div>
            <p className="text-xs text-gray-500 mb-3 uppercase tracking-wider">Legacy API — SecureKey (Shipment Data)</p>
            <div>
              <label className="block text-sm text-gray-400 mb-1.5">SecureKey</label>
              <input
                value={sk}
                onChange={e => setSk(e.target.value)}
                className="w-full bg-gray-700 border border-gray-600 rounded-lg px-4 py-2.5 text-white font-mono text-sm focus:outline-none focus:border-[#00AAFF]"
                placeholder="Zenventory SecureKey"
              />
            </div>
          </div>

          <button onClick={handleSave} disabled={loading} className="w-full bg-[#00AAFF] hover:bg-[#33BBFF] disabled:opacity-50 text-white py-2.5 rounded-lg text-sm font-medium transition">
            {loading ? 'Saving...' : 'Save Credentials'}
          </button>
        </div>
      )}
    </div>
  )
}
