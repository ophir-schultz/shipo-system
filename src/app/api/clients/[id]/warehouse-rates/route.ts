import { supabaseAdmin } from '@/lib/supabase'
import { NextResponse } from 'next/server'
import { requireStaff } from '@/lib/require-staff'
import { validateLegacyRates } from '@/lib/billing/warehouse-rate-card'

// Replaces a client's LEGACY warehouse rate card -- the service_type/rate/unit
// rows written by WarehouseRatesUpload.tsx -- and nothing else.
//
// It used to be three lines:
//
//     await supabaseAdmin.from('client_warehouse_rates').delete().eq('client_id', id)
//     const { error } = await supabaseAdmin.from('client_warehouse_rates').insert(rates)
//     if (error) return NextResponse.json({ error: error.message }, { status: 500 })
//
// with four problems, two of which destroy data:
//
//   1. The delete was not scoped. ledger_05_seed_nayax.sql writes eighteen
//      structured charge_type/variant rows for a real client, and the charge
//      calculator looks a rate up by (charge_type, variant) -- so uploading a
//      CSV for that client removed every line the calculator reads, and the
//      replacements carry no charge_type, so it finds nothing and the client
//      silently stops being billed. That seed file carries a prose warning
//      about this exact route at ledger_05_seed_nayax.sql:29-33. A warning is
//      not a guard: it is something a person has to remember while using a
//      button on the client detail page.
//
//   2. Delete-then-insert with no transaction. If the insert failed, the
//      client had NO rate card at all, and the 500 reported only the insert's
//      error with nothing to say the old card was already gone.
//
//   3. The delete's own error was discarded, so a failed delete followed by a
//      successful insert doubled the card and reported success.
//
//   4. `rates` went from the request body into `insert()` verbatim. Nothing
//      checked that the rows' client_id matched the one in the URL, and
//      nothing stopped a caller setting charge_type/variant/effective_from --
//      i.e. authoring the structured rows the seed files own, from an endpoint
//      whose entire contract is that it does not.
//
// (2) is fixed by ORDER rather than by a transaction, which cannot be had
// through PostgREST from here. Insert first, then delete the ids read before
// the insert:
//
//   - insert fails  -> the old card is untouched. Nothing is lost.
//   - delete fails  -> old and new rows coexist. Visible and recoverable, and
//                      lib/billing/warehouse-log-rate.ts refuses to price an
//                      ambiguous service rather than picking a row, so it
//                      announces itself instead of quietly invoicing one of
//                      two rates.
//
// The irrecoverable outcome is removed outright, and the one that remains is
// already detected by name downstream.
//
// The delete is by CAPTURED ID, not by predicate, and that is load-bearing
// twice over: a predicate delete running after the insert would match the rows
// just inserted -- they are charge_type-null too -- and empty the card
// completely, and a row added by someone else between the two statements is
// left alone rather than swept up.

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireStaff()
  if (denied) return denied

  const { id } = await params

  let body: { rates?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Body is not valid JSON' }, { status: 400 })
  }

  const checked = validateLegacyRates(body.rates, id)
  if ('error' in checked) {
    return NextResponse.json({ error: checked.error }, { status: 400 })
  }
  const rates = checked.rates
  // Carried through to the response rather than logged. These are rates that
  // save successfully and can never be billed from, so the only person who can
  // act on them is the one looking at the form right now.
  const warnings = checked.warnings

  // Read the rows this replace is allowed to remove, BEFORE writing anything.
  // `is('charge_type', null)` is the mirror of the seed file's own
  // `charge_type is not null` delete, which is what keeps the two writers off
  // each other's rows.
  const { data: existing, error: readError } = await supabaseAdmin
    .from('client_warehouse_rates')
    .select('id')
    .eq('client_id', id)
    .is('charge_type', null)

  // Nothing has been written yet, so refusing here costs a retry and no data.
  // The alternative -- proceeding on a failed read -- means deleting by
  // predicate instead, which after the insert takes the new rows with it.
  if (readError) {
    return NextResponse.json({
      error: `Could not read the existing rate card, so nothing was changed: `
        + `${readError.message}. The card is as it was; try again.`,
    }, { status: 503 })
  }

  const oldIds = (existing ?? []).map((r) => (r as { id: string }).id)

  const { error: insertError } = await supabaseAdmin
    .from('client_warehouse_rates').insert(rates)
  if (insertError) {
    return NextResponse.json({
      error: `${insertError.message}. The existing rate card has NOT been `
        + `changed -- the new rates are inserted before the old ones are `
        + `removed, so a failure here leaves the card as it was.`,
    }, { status: 500 })
  }

  if (oldIds.length > 0) {
    const { error: deleteError } = await supabaseAdmin
      .from('client_warehouse_rates').delete().in('id', oldIds)

    // 409, with the message saying precisely what state the card is in. This
    // is the one branch that leaves work for a person: both sets are present,
    // so any service in both is ambiguous and the warehouse log will refuse
    // to price it. Reporting this as a plain 500 would be a lie by omission
    // -- the new rates ARE saved, so re-uploading adds a third copy.
    if (deleteError) {
      return NextResponse.json({
        error: `The ${rates.length} new rate(s) were saved, but the `
          + `${oldIds.length} old one(s) could not be removed: `
          + `${deleteError.message}. Both are now on the card, so any service `
          + `appearing in both is ambiguous and will not be priced until one `
          + `is deleted. DO NOT re-upload -- that adds a third copy. Remove `
          + `rate ids ${oldIds.join(', ')}.`,
        inserted: rates.length,
        staleIds: oldIds,
        warnings,
      }, { status: 409 })
    }
  }

  return NextResponse.json({
    success: true, count: rates.length, replaced: oldIds.length, warnings,
  })
}
