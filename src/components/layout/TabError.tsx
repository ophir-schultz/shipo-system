'use client'

import { SUPABASE_ENV_VARS } from '@/lib/lazy-client'

export default function TabError({
  error,
}: {
  error: Error & { digest?: string }
  reset?: () => void
}) {
  const notConnected = error.message.includes('Missing required environment variable')
    || error.message.includes('supabaseUrl is required')

  if (notConnected) {
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 p-5 text-[#0B1220]">
        <h2 className="text-lg font-semibold">Supabase is not connected</h2>
        <p className="mt-2 text-sm text-[#4B4F58]">
          This tab cannot load real data until the Preview environment has these variables. Names only:
        </p>
        <ul className="mt-3 list-disc pl-5 font-mono text-xs text-amber-900">
          {SUPABASE_ENV_VARS.map((name) => <li key={name}>{name}</li>)}
        </ul>
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-red-200 bg-red-50 p-5">
      <h2 className="text-lg font-semibold text-red-800">This tab could not be shown</h2>
      <p className="mt-2 text-sm text-red-700">{error.message}</p>
    </div>
  )
}
