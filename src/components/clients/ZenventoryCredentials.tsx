'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { showError, showSuccess } from '@/components/ui/Toast'

export default function ZenventoryCredentials({ clientId, apiKey, apiSecret }: {
  clientId: string
  apiKey?: string
  apiSecret?: string
}) {
  const router = useRouter()
  const [editing, setEditing] = useState(false)
  const [key, setKey] = useState(apiKey ?? '')
  const [secret, setSecret] = useState(apiSecret ?? '')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [tested, setTested] = useState<boolean | null>(null)

  async function handleSave() {
    setLoading(true)
    setError('')
    const res = await fetch(`/api/clients/${clientId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ zenventory_api_key: key, zenventory_api_secret: secret }),
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
    if (!data.success) showError('Connection failed', 'Check your Zenventory API key and secret')
    else showSuccess('Connection successful', 'Zenventory credentials are working')
    setLoading(false)
  }

  return (
    <div className="bg-gray-800 rounded-xl p-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-lg font-semibold text-white">Zenventory API</h3>
          <p className="text-gray-400 text-sm mt-0.5">Used to map orders to this client</p>
        </div>
        <div className="flex gap-2">
          {apiKey && !editing && (
            <button onClick={handleTest} disabled={loading} className="bg-gray-700 hover:bg-gray-600 text-white px-3 py-1.5 rounded-lg text-sm transition">
              {loading ? 'Testing...' : 'Test Connection'}
            </button>
          )}
          <button onClick={() => setEditing(!editing)} className="bg-[#00AAFF] hover:bg-[#33BBFF] text-white px-3 py-1.5 rounded-lg text-sm transition">
            {editing ? 'Cancel' : apiKey ? 'Update' : 'Add Credentials'}
          </button>
        </div>
      </div>

      {tested !== null && (
        <div className={`mb-4 px-4 py-2 rounded-lg text-sm ${tested ? 'bg-green-900 text-green-300' : 'bg-red-900 text-red-300'}`}>
          {tested ? '✓ Connection successful' : '✗ Connection failed — check credentials'}
        </div>
      )}

      {!editing && apiKey && (
        <div className="space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-gray-400">API Key</span>
            <span className="text-gray-300 font-mono">{apiKey.slice(0, 8)}••••••••</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-400">API Secret</span>
            <span className="text-gray-300 font-mono">••••••••</span>
          </div>
        </div>
      )}

      {!editing && !apiKey && (
        <p className="text-gray-500 text-sm">No credentials set — add them to enable order syncing for this client.</p>
      )}

      {editing && (
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
          {error && <p className="text-red-400 text-sm">{error}</p>}
          <button onClick={handleSave} disabled={loading} className="w-full bg-[#00AAFF] hover:bg-[#33BBFF] disabled:opacity-50 text-white py-2.5 rounded-lg text-sm font-medium transition">
            {loading ? 'Saving...' : 'Save Credentials'}
          </button>
        </div>
      )}
    </div>
  )
}
