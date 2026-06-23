'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { showError, showSuccess } from '@/components/ui/Toast'

export default function OriginZipEditor({ clientId, originZip }: { clientId: string; originZip: string }) {
  const router = useRouter()
  const [editing, setEditing] = useState(false)
  const [zip, setZip] = useState(originZip)
  const [loading, setLoading] = useState(false)

  async function handleSave() {
    if (!zip || zip.length < 5) { showError('Invalid ZIP', 'Enter a 5-digit ZIP code'); return }
    setLoading(true)
    const res = await fetch(`/api/clients/${clientId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ origin_zip: zip.trim() }),
    })
    if (!res.ok) {
      showError('Failed to save', 'Could not update origin ZIP')
    } else {
      showSuccess('Origin ZIP saved', `Zone matching will use ZIP prefix ${zip.slice(0, 3)}`)
      setEditing(false)
      router.refresh()
    }
    setLoading(false)
  }

  return (
    <div className="flex items-center gap-3">
      <div className="flex-1">
        <p className="text-sm font-medium text-white">Warehouse Origin ZIP</p>
        <p className="text-xs text-gray-400 mt-0.5">Used to determine delivery zone from recipient ZIP code</p>
      </div>
      {editing ? (
        <div className="flex gap-2 items-center">
          <input
            type="text"
            value={zip}
            onChange={e => setZip(e.target.value.replace(/\D/g, '').slice(0, 10))}
            placeholder="e.g. 07001"
            maxLength={10}
            className="w-32 bg-gray-700 border border-gray-600 rounded-lg px-3 py-1.5 text-white text-sm font-mono focus:outline-none focus:border-[#00AAFF]"
          />
          <button
            onClick={handleSave}
            disabled={loading}
            className="px-3 py-1.5 rounded-lg text-xs font-medium text-white disabled:opacity-50 transition"
            style={{ background: '#00AAFF' }}
          >
            {loading ? 'Saving…' : 'Save'}
          </button>
          <button
            onClick={() => { setZip(originZip); setEditing(false) }}
            className="px-3 py-1.5 rounded-lg text-xs text-gray-400 bg-gray-700 hover:bg-gray-600 transition"
          >
            Cancel
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-3">
          <span className="font-mono text-sm text-white">
            {originZip || <span className="text-gray-500 italic">Not set</span>}
          </span>
          <button
            onClick={() => setEditing(true)}
            className="text-xs text-[#00AAFF] hover:text-[#33BBFF] transition"
          >
            {originZip ? 'Edit' : 'Set ZIP'}
          </button>
        </div>
      )}
    </div>
  )
}
