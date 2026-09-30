import { supabaseAdmin } from '@/lib/supabase'
import { canStart } from '@/lib/ledger/run-lock'
import { openSyncRun } from '@/lib/ledger/sync-run'
import { buildCharges, type ChargeInput } from '@/lib/ledger/calculate-charges'

export type RecalculateResult =
  | { skipped: true; cause: 'lock' | 'gate-unreadable'; reason: string }
  | {
      skipped: false
      orders: number
      upserted: number
      deleted: number
      failedOrders: number
      unknownCostCharges: number
      unpricedOrders: number
    }

export async function recalculateCharges(
  loadOrders: () => Promise<ChargeInput[]>,
): Promise<RecalculateResult> {
  // DEFENCE 1: the lock. Two runs overlapping would make each delete the
  // other's fresh rows — see run-lock.ts.
  const { data: openRuns, error: openRunsError } = await supabaseAdmin
    .from('sync_runs')
    .select('started_at, status')
    .eq('source', 'charges')
    .eq('status', 'running')

  // A failed read is not "nothing is running". If we cannot tell whether a run
  // is live, the two outcomes are not symmetric: skipping loses one
  // recalculation cycle and the next cron repeats it eight hours later, while
  // running blind can delete a concurrent run's fresh charges. So we skip, and
  // we keep the error rather than swallowing it into `?? []`.
  if (openRunsError) {
    return {
      skipped: true,
      cause: 'gate-unreadable',
      reason: `Could not read sync_runs to check for a live charge run `
            + `(${openRunsError.message}). Skipping rather than risking a `
            + `concurrent stale-delete.`,
    }
  }

  const gate = canStart(openRuns ?? [], new Date())
  if (!gate.ok) return { skipped: true, cause: 'lock', reason: gate.reason }

  // Captured BEFORE the run row is opened, so that no charge this run writes
  // can ever carry a calculated_at earlier than the stale-delete cutoff.
  const runStartedAt = new Date().toISOString()
  const run = await openSyncRun({ source: 'charges', mode: 'live' })

  let orders = 0
  let upserted = 0
  let deleted = 0
  let failedOrders = 0
  let unknownCostCharges = 0
  let unpricedOrders = 0

  try {
    for (const input of await loadOrders()) {
      run.seen()
      orders++

      // Per-order boundary. buildCharges throws a RangeError on a corrupt
      // picked quantity (see cost-rate.ts costOf). That is a data defect that
      // a person has to fix, NOT an unknown cost — an unknown cost means a rate
      // nobody has entered yet, and sending the two to the same place sends the
      // wrong person after the wrong problem. One broken order must not stop
      // the other few thousand, so it is recorded and skipped.
      let charges
      try {
        charges = buildCharges(input)
      } catch (err) {
        failedOrders++
        run.fail(
          err instanceof RangeError
            ? `order ${input.order.id}: corrupt quantity`
            : `order ${input.order.id}: build failed`,
          err,
        )
        // Deliberately skips the stale-delete below. Deleting this order's
        // existing charges on the strength of a calculation that failed would
        // turn a bad line into a missing invoice.
        continue
      }

      if (charges.length > 0) {
        const { error } = await supabaseAdmin
          .from('order_charges')
          .upsert(
            charges.map((c) => ({ ...c, calculated_at: new Date().toISOString() })),
            { onConflict: 'order_id,charge_key' },
          )
        // An order whose charges did not land must keep the charges it already
        // has, so this continues past the stale-delete too.
        if (error) { failedOrders++; run.fail(`upsert ${input.order.id}`, error); continue }
        upserted += charges.length
        unknownCostCharges += charges.filter((c) => c.cost === null).length
        run.wrote(charges.length)
      } else if (!input.order.cancelled
                 && input.items.some((i) => (i.quantityPicked ?? 0) > 0 && i.pickDate)) {
        // Work was done and nothing was billable for it. Almost always a client
        // with no rate card line yet, which is revenue walking out of the door
        // silently. Counted, then reported once at the end rather than per
        // order, so a client with no card cannot flood the warning budget.
        unpricedOrders++
      }

      // DEFENCE 2: the stale-delete is scoped to THIS order, not to the whole
      // table. If the lock is ever bypassed, the damage is one order's charges
      // rather than every charge in the database.
      const { data: removed, error: delError } = await supabaseAdmin
        .from('order_charges')
        .delete()
        .eq('order_id', input.order.id)
        .lt('calculated_at', runStartedAt)
        .select('id')
      if (delError) run.fail(`stale-delete ${input.order.id}`, delError)
      else deleted += removed?.length ?? 0
    }

    // warn(), not fail(): both of these are findings someone should act on, not
    // failures of this run. close() resolves 'ok' only when the error count is
    // zero, so routing either through fail() would leave every run permanently
    // 'partial' and make the status useless as a signal.
    if (unknownCostCharges > 0) {
      run.warn('unknown cost', `${unknownCostCharges} charges have no cost rate `
        + `covering their charge date; they are flagged is_estimate and their `
        + `cost is null, not zero.`)
    }
    if (unpricedOrders > 0) {
      run.warn('unpriced orders', `${unpricedOrders} orders had picked lines but `
        + `produced no charge — most likely a client with no rate card line.`)
    }

    await run.close()
  } catch (err) {
    run.fail('recalculateCharges', err)
    await run.close('failed')
    throw err
  }

  return {
    skipped: false,
    orders, upserted, deleted, failedOrders, unknownCostCharges, unpricedOrders,
  }
}
