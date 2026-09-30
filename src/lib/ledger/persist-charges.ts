import { supabaseAdmin } from '@/lib/supabase'
import { canStart } from '@/lib/ledger/run-lock'
import { openSyncRun } from '@/lib/ledger/sync-run'
import { buildCharges, type BuiltCharge, type ChargeInput } from '@/lib/ledger/calculate-charges'

/**
 * How recently a charge run must have FINISHED for this one to be skipped.
 *
 * This route is not called three times a day. AutoSync.tsx calls it on mount
 * and then every five minutes, from every open browser tab, so a 30-day
 * recalculation was being driven ~288 times a day per tab and overlapping
 * routinely. One hour is well inside the thrice-daily cadence the design
 * targets — no cron run is ever throttled out, because the crons are eight
 * hours apart — while cutting browser-driven recalculations to at most 24 a
 * day. The throttle keys off the last FINISHED run rather than sniffing a
 * Vercel cron header, because a throttle is robust to how the route gets
 * called and a header check is not: a manual curl, a second cron, or a
 * renamed header all bypass the header and none of them bypass this.
 *
 * The syncs and issue checks in the monitor route are unaffected and keep
 * their five-minute cadence; only the charge recalculation is throttled.
 */
export const CHARGE_THROTTLE_MINUTES = 60

/** Charges per upsert round trip. */
const UPSERT_CHUNK = 500
/** Orders per stale-delete round trip. */
const DELETE_CHUNK = 200

export type RecalculateResult =
  | { skipped: true; cause: 'lock' | 'gate-unreadable' | 'throttled'; reason: string }
  | {
      skipped: false
      orders: number
      upserted: number
      deleted: number
      failedOrders: number
      unknownCostCharges: number
      unknownCarrierCharges: number
      unpricedOrders: number
    }

export async function recalculateCharges(
  loadOrders: (warn: (context: string, detail: string) => void) => Promise<ChargeInput[]>,
): Promise<RecalculateResult> {
  // THROTTLE. Checked before the lock because it is the common case: most
  // invocations of this route are a browser tab polling, and the cheapest
  // correct answer to those is "we did this recently".
  const { data: lastFinished, error: lastFinishedError } = await supabaseAdmin
    .from('sync_runs')
    .select('finished_at')
    .eq('source', 'charges')
    .not('finished_at', 'is', null)
    .order('finished_at', { ascending: false })
    .limit(1)

  // An unreadable throttle gate is NOT a reason to skip. Unlike the lock read
  // below, being unable to tell how long ago the last run finished risks only
  // doing redundant work; skipping on it would let one broken read stop charges
  // being calculated at all. So the error is kept and reported, and the run
  // proceeds to the lock, which is the defence that actually protects data.
  const lastFinishedAt = lastFinished?.[0]?.finished_at
  if (!lastFinishedError && lastFinishedAt) {
    const ageMinutes = (Date.now() - new Date(lastFinishedAt).getTime()) / 60_000
    if (Number.isFinite(ageMinutes) && ageMinutes >= 0 && ageMinutes < CHARGE_THROTTLE_MINUTES) {
      return {
        skipped: true,
        cause: 'throttled',
        reason: `A charge run finished ${ageMinutes.toFixed(0)} minutes ago; the `
              + `next one is due in ${(CHARGE_THROTTLE_MINUTES - ageMinutes).toFixed(0)}.`,
      }
    }
  }

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

  if (lastFinishedError) {
    run.warn('throttle gate unreadable', `Could not read the last finished charge `
      + `run (${lastFinishedError.message}); proceeding without the throttle.`)
  }

  let orders = 0
  let upserted = 0
  let deleted = 0
  let failedOrders = 0
  let unknownCostCharges = 0
  let unknownCarrierCharges = 0
  let unpricedOrders = 0

  try {
    // ---- 1. build -------------------------------------------------------
    // Everything is calculated first so the writes can be batched. The route
    // has a finite time budget and the previous shape issued TWO sequential
    // round trips PER ORDER over a few thousand orders — minutes of latency
    // after three other syncs had already run, so the function was killed
    // mid-run and left its sync_runs row 'running' for ever.
    const rows: Array<BuiltCharge & { calculated_at: string }> = []
    const builtOk: string[] = []                  // orders safe to stale-delete

    for (const input of await loadOrders((ctx, detail) => run.warn(ctx, detail))) {
      run.seen()
      orders++

      // Per-order boundary. buildCharges throws a RangeError on a corrupt
      // picked quantity (see cost-rate.ts costOf). That is a data defect that
      // a person has to fix, NOT an unknown cost — an unknown cost means a rate
      // nobody has entered yet, and sending the two to the same place sends the
      // wrong person after the wrong problem. One broken order must not stop
      // the other few thousand, so it is recorded and skipped.
      let charges: BuiltCharge[]
      try {
        charges = buildCharges(input, (ctx, detail) => run.warn(ctx, detail))
      } catch (err) {
        failedOrders++
        run.fail(
          err instanceof RangeError
            ? `order ${input.order.id}: corrupt quantity`
            : `order ${input.order.id}: build failed`,
          err,
        )
        // Deliberately omitted from builtOk below. Deleting this order's
        // existing charges on the strength of a calculation that failed would
        // turn a bad line into a missing invoice.
        continue
      }

      builtOk.push(input.order.id)

      // An order is unpriced when it is missing charges it SHOULD have, which
      // is not the same as having none at all. The previous test lived in the
      // `else` of `charges.length > 0`, so any order carrying a shipping charge
      // — which is almost every order — could never be counted, and the leak
      // detector this project is justified by was inert in the common case.
      const picked = !input.order.cancelled
        && input.items.some((i) => (i.quantityPicked ?? 0) > 0 && i.pickDate)
      if (picked && !charges.some((c) => c.charge_type === 'pick')) unpricedOrders++

      const calculatedAt = new Date().toISOString()
      for (const c of charges) rows.push({ ...c, calculated_at: calculatedAt })

      // Counted only where findCostRate actually missed. is_estimate is true
      // exactly when the cost lookup failed, so this excludes the peak
      // surcharge (cost null by design — a surcharge is pure revenue) and a
      // shipping row whose carrier cost has not been reported yet. Counting
      // those under "no cost rate covers their charge date" was a permanent
      // false alarm in both sync_runs and the monitor email, and it named the
      // wrong cause for both.
      unknownCostCharges += charges.filter((c) => c.cost === null && c.is_estimate).length
      unknownCarrierCharges += charges.filter(
        (c) => c.charge_type === 'shipping' && c.cost === null).length
    }

    // ---- 2. write -------------------------------------------------------
    const failedOrderIds = new Set<string>()

    for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
      const batch = rows.slice(i, i + UPSERT_CHUNK)
      const { error } = await supabaseAdmin
        .from('order_charges')
        .upsert(batch, { onConflict: 'order_id,charge_key' })
      if (!error) { upserted += batch.length; run.wrote(batch.length); continue }

      // A chunk spans several orders, so a chunk-level failure says nothing
      // about WHICH order is bad. Retrying it order by order keeps the
      // per-order boundary the batching was in danger of losing: one order with
      // an unwritable row must not cost the other 499 their charges.
      const chunkOrderIds = Array.from(new Set(batch.map((r) => r.order_id)))
      for (const orderId of chunkOrderIds) {
        const single = batch.filter((r) => r.order_id === orderId)
        const { error: rowError } = await supabaseAdmin
          .from('order_charges')
          .upsert(single, { onConflict: 'order_id,charge_key' })
        if (rowError) {
          // An order's charges can straddle a chunk boundary, so guard against
          // counting the same order twice if both of its chunks fail.
          if (!failedOrderIds.has(orderId)) failedOrders++
          failedOrderIds.add(orderId)
          run.fail(`upsert ${orderId}`, rowError)
        } else {
          upserted += single.length
          run.wrote(single.length)
        }
      }
    }

    // ---- 3. DEFENCE 2: the stale-delete -------------------------------------
    // Scoped to the orders THIS RUN processed, never to the whole table. If the
    // lock is ever bypassed, the blast radius is those orders' charges rather
    // than every charge in the database. Batching changed how many order ids
    // ride on one statement; it must never change the fact that there is an
    // order-id filter at all.
    //
    // Orders whose build or upsert failed are excluded, so a failed order keeps
    // the charges it already has.
    const deletable = builtOk.filter((id) => !failedOrderIds.has(id))
    for (let i = 0; i < deletable.length; i += DELETE_CHUNK) {
      const ids = deletable.slice(i, i + DELETE_CHUNK)
      const { data: removed, error: delError } = await supabaseAdmin
        .from('order_charges')
        .delete()
        .in('order_id', ids)
        .lt('calculated_at', runStartedAt)
        .select('id')
      if (delError) run.fail(`stale-delete ${ids.length} orders`, delError)
      else deleted += removed?.length ?? 0
    }

    // warn(), not fail(): these are findings someone should act on, not
    // failures of this run. close() resolves 'ok' only when the error count is
    // zero, so routing any of them through fail() would leave every run
    // permanently 'partial' and make the status useless as a signal.
    if (unknownCostCharges > 0) {
      run.warn('unknown cost', `${unknownCostCharges} charges have no cost rate `
        + `covering their charge date; they are flagged is_estimate and their `
        + `cost is null, not zero.`)
    }
    if (unknownCarrierCharges > 0) {
      run.warn('unknown carrier cost', `${unknownCarrierCharges} shipping charges `
        + `have no carrier cost reported yet; cost is null, not zero, so they are `
        + `absent from margin rather than counted as pure profit.`)
    }
    if (unpricedOrders > 0) {
      run.warn('unpriced orders', `${unpricedOrders} orders had picked lines but `
        + `produced no pick charge — most likely a client with no rate card line.`)
    }

    await run.close()
  } catch (err) {
    run.fail('recalculateCharges', err)
    await run.close('failed')
    throw err
  }

  return {
    skipped: false,
    orders, upserted, deleted, failedOrders,
    unknownCostCharges, unknownCarrierCharges, unpricedOrders,
  }
}
