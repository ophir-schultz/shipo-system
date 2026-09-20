import { supabaseAdmin } from '@/lib/supabase'
import { normalise } from '@/lib/rate-sheets-db'
import type { RateSheet } from '@/lib/rate-sheets'
import QuotesManager from '@/components/rate-sheets/QuotesManager'

// Staff screen for building prospect rate sheets. Deliberately at
// /quotes rather than under /rate-sheets: that segment is excluded
// from the proxy so prospects can open their links, and a staff index
// of every quote ever sent must never inherit that exclusion.

export const dynamic = 'force-dynamic'

export default async function QuotesPage() {
  const { data, error } = await supabaseAdmin
    .from('rate_sheets')
    .select('*')
    .order('created_at', { ascending: false })

  // A missing table means the migration has not been applied yet, which
  // is a setup step rather than a failure — say so instead of throwing.
  const migrationApplied = !error
  const sheets: RateSheet[] = (data ?? []).map(normalise)

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Rate Sheets</h1>
        <p className="text-sm text-gray-400 mt-1">
          Build a shareable fulfillment rate sheet for a prospect. Each one gets its own private
          link you can email or paste into a thread.
        </p>
      </div>

      {!migrationApplied && (
        <div className="rounded-xl p-4 border border-yellow-700/50 bg-yellow-950/30">
          <p className="text-yellow-300 text-sm font-medium">⚠ Rate sheet table not created yet</p>
          <p className="text-yellow-500/80 text-xs mt-1">
            Run <span className="font-mono">supabase/rate_sheets.sql</span> in the Supabase SQL
            editor, then reload this page.
          </p>
        </div>
      )}

      <QuotesManager initialSheets={sheets} disabled={!migrationApplied} />
    </div>
  )
}
