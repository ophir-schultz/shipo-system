'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

export default function SignOutButton() {
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  async function signOut() {
    setBusy(true)
    try {
      await fetch('/api/partner/logout', { method: 'POST' })
    } catch {
      // Either way, send them to the login screen.
    }
    router.replace('/partner/login')
    router.refresh()
  }

  return (
    <button
      onClick={signOut}
      disabled={busy}
      className="shrink-0 rounded-lg border border-gray-700 px-3 py-1.5 text-xs text-gray-300 hover:border-gray-500 disabled:opacity-40"
    >
      {busy ? 'Signing out…' : 'Sign out'}
    </button>
  )
}
