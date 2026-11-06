'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { showError, showSuccess } from '@/components/ui/Toast'

/**
 * Uploads a per-client price list (JSON). The server inserts a new row.
 * It does not replace the warehouse rate card or the zone matrix above.
 */
export default function PriceListUpload({ clientId }: { clientId: string }) {
  const router = useRouter()
  const fileRef = useRef<HTMLInputElement>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setLoading(true)
    setError('')
    try {
      const text = await file.text()
      const document = JSON.parse(text)
      const res = await fetch(`/api/clients/${clientId}/price-lists`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ document, filename: file.name }),
      })
      const data = await res.json().catch(() => ({} as { error?: string }))
      if (!res.ok) throw new Error(data.error ?? `Server error ${res.status}`)
      showSuccess('Price list saved', `${file.name} was added for this client`)
      router.refresh()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not read that file'
      setError(message)
      showError('Price list not saved', message)
    } finally {
      setLoading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <label className="px-4 py-2 bg-[#1A73E8] hover:bg-[#0B5ED7] disabled:opacity-50 text-white text-sm font-semibold rounded-lg cursor-pointer transition">
        {loading ? 'Uploading…' : 'Upload price list'}
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          disabled={loading}
          onChange={handleFile}
        />
      </label>
      {error && <p className="text-xs text-red-700 max-w-xs text-right">{error}</p>}
    </div>
  )
}
