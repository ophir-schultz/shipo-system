'use client'

import { useState } from 'react'
import { showError, showSuccess } from '@/components/ui/Toast'
import { testBanner, type TestBanner } from '@/lib/clients/zenventory-test-result'

// Credentials are environment variables, not fields on this form.
// The page passes whether they are present. It does not pass the values.

export default function ZenventoryCredentials({
  clientId,
  configured,
  notice,
  keyVar,
  secretVar,
  secureVar,
}: {
  clientId: string
  configured: boolean
  notice: string | null
  keyVar: string | null
  secretVar: string | null
  secureVar: string | null
}) {
  const [loading, setLoading] = useState(false)
  const [tested, setTested] = useState<TestBanner | null>(null)

  async function handleTest() {
    setLoading(true)
    setTested(null)
    const res = await fetch(`/api/clients/${clientId}/test-zenventory`, { method: 'POST' })
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
          <p className="text-[#4B4F58] text-sm mt-0.5">
            Per-client key and secret, read from the environment when this client syncs or a pick is sent.
          </p>
        </div>
        {configured && (
          <button onClick={handleTest} disabled={loading} className="bg-[#EEF3FA] hover:bg-[#DDE6F2] text-[#0B1220] px-3 py-1.5 rounded-lg text-sm transition">
            {loading ? 'Testing...' : 'Test API 2.0'}
          </button>
        )}
      </div>

      {tested !== null && (
        <div className={`mb-4 px-4 py-2 rounded-lg text-sm ${tested.ok ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'}`}>
          <p>{tested.ok ? '✓' : '✗'} {tested.title}</p>
          {tested.detail && (
            <p className="mt-1 font-mono text-xs opacity-80 break-all">{tested.detail}</p>
          )}
        </div>
      )}

      {configured ? (
        <p className="text-sm text-emerald-700">Configured. The key and secret are not shown.</p>
      ) : (
        <div className="space-y-2 text-sm">
          <p className="text-yellow-700">{notice}</p>
          {keyVar && secretVar && secureVar && (
            <p className="text-[#4B4F58] font-mono text-xs">
              {keyVar}, {secretVar}, {secureVar}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
