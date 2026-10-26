import { supabaseAdmin } from '@/lib/supabase'
import { normalise } from '@/lib/rate-sheets-db'
import type { RateSheet } from '@/lib/rate-sheets'
import { read, loaded, isMigrationMissing } from '@/lib/db/read'
import ViewUnreadable from '@/components/ui/ViewUnreadable'
import QuotesManager from '@/components/rate-sheets/QuotesManager'

// Staff screen for building prospect rate sheets. Deliberately at
// /quotes rather than under /rate-sheets: that segment is excluded
// from the proxy so prospects can open their links, and a staff index
// of every quote ever sent must never inherit that exclusion.

export const dynamic = 'force-dynamic'

export default async function QuotesPage() {
  const res = await supabaseAdmin
    .from('rate_sheets')
    .select('*')
    .order('created_at', { ascending: false })

  // A missing table means the migration has not been applied yet, which is a
  // setup step rather than a failure — say so instead of throwing.
  //
  // This used to be `const migrationApplied = !error`, which said so for EVERY
  // failure. A one-second timeout printed "Rate sheet table not created yet ·
  // Run supabase/rate_sheets.sql" over a table full of quotes already sent to
  // prospects, and the instruction under it is to go and run DDL. Keyed on the
  // error code now, so the yellow banner only appears when its advice is true.
  const migrationMissing = isMigrationMissing(res)
  const sheets = read('rate_sheets', res)
  // Asked in this order on purpose: a missing relation is also a failed read,
  // so checking `sheets.error` first would bury the one banner that tells the
  // operator what to do. See the note on isMigrationMissing.
  const unreadable = migrationMissing ? null : sheets.error
  // On `loaded` rather than a bare `rows` array so that the branch below is
  // enforced by the compiler: `QuotesManager.initialSheets` is `RateSheet[]`,
  // so deleting the check makes `RateSheet[] | undefined` fail to assign
  // instead of quietly handing the index an empty list to call "no quotes yet".
  const page = loaded(unreadable, (): RateSheet[] => sheets.rows.map(normalise))

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Rate Sheets</h1>
        <p className="text-sm text-[#4B4F58] mt-1">
          Build a shareable fulfillment rate sheet for a prospect. Each one gets its own private
          link you can email or paste into a thread.
        </p>
      </div>

      {migrationMissing && (
        <div className="rounded-xl p-4 border border-amber-200 bg-amber-50">
          <p className="text-amber-700 text-sm font-medium">⚠ Rate sheet table not created yet</p>
          <p className="text-yellow-500/80 text-xs mt-1">
            Run <span className="font-mono">supabase/rate_sheets.sql</span> in the Supabase SQL
            editor, then reload this page.
          </p>
        </div>
      )}

      {!page.ok
        ? <ViewUnreadable message={page.error} />
        /* Still disabled on a missing table -- there is nowhere to save to --
           but the index is no longer presented as "no quotes yet" when the
           read simply failed. */
        : <QuotesManager initialSheets={page.data} disabled={migrationMissing} />}
    </div>
  )
}
