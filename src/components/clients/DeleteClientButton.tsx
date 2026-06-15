'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

export default function DeleteClientButton({ clientId, clientName }: { clientId: string; clientName: string }) {
  const router = useRouter()
  const [confirm, setConfirm] = useState(false)
  const [loading, setLoading] = useState(false)

  async function handleDelete() {
    setLoading(true)
    await fetch(`/api/clients/${clientId}`, { method: 'DELETE' })
    router.push('/clients')
    router.refresh()
  }

  return (
    <>
      <button
        onClick={() => setConfirm(true)}
        className="bg-red-900 hover:bg-red-800 text-red-300 px-4 py-2 rounded-lg text-sm font-medium transition"
      >
        Delete Client
      </button>

      {confirm && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
          <div className="bg-gray-800 rounded-xl p-6 max-w-sm w-full mx-4">
            <h4 className="font-semibold text-white mb-2">Delete {clientName}?</h4>
            <p className="text-gray-400 text-sm mb-6">This will permanently delete the client and all their rates. This cannot be undone.</p>
            <div className="flex gap-3">
              <button onClick={() => setConfirm(false)} className="flex-1 bg-gray-700 hover:bg-gray-600 text-white py-2 rounded-lg text-sm transition">
                Cancel
              </button>
              <button onClick={handleDelete} disabled={loading} className="flex-1 bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white py-2 rounded-lg text-sm font-medium transition">
                {loading ? 'Deleting...' : 'Yes, Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
