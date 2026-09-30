import { supabaseAdmin } from '@/lib/supabase'
import { canStart } from '@/lib/ledger/run-lock'
import { openSyncRun } from '@/lib/ledger/sync-run'
import { buildCharges, type BuiltCharge, type ChargeInput } from '@/lib/ledger/calculate-charges'

/**
 * How recently a charge run must have SUCCEEDED for this one to be skipped.
 *
 * This route is not called three times a day. AutoSync.tsx calls it on mount
 * and then every five minutes, from every open browser tab, so a 30-day
 * recalculation was being driven ~288 times a day per tab and overlapping
 * routinely. One hour cuts browser-driven recalculations to at most 24 a day.
 * The throttle keys off the last successful run rather than sniffing a Vercel
 * cron header, because a throttle is robust to how the route gets called and a
 * header check is not: a manual curl, a second cron, or a renamed header all
 * bypass a header and none of them bypass this.
 *
 * The syncs and issue checks in the monitor route are unaffected and keep
 * their five-minute cadence; only the charge recalculation is throttled.
 *
 * TWO PROPERTIES THE THROTTLE MUST HOLD, neither of which an earlier version of
 * this file had despite the comment claiming both:
 *
 *   1. ONLY A RUN THAT SUCCEEDED MAY SATISFY IT. The read below filters
 *      `status = 'ok'`, not "the newest row carrying a finished_at" —
 *      sync-run.ts stamps finished_at on every close, including 'failed' and
 *      'partial'. A failed run therefore used to buy the next hour of silence,
 *      and monitor/route.ts treats a `throttled` skip as the healthy case, so
 *      up to eleven consecutive emails could read "✅ All clear" while nothing
 *      was being written. A monitor that reports success because it never ran
 *      is worse than no monitor. A failure makes the next attempt more urgent,
 *      not less.
 *
 *   2. A SCHEDULED RUN IS NEVER THROTTLED OUT. The earlier comment argued this
 *      from cron spacing — the crons are 6-10 hours apart — but the crons are
 *      not the only caller: a browser-driven run at 13:30 leaves the 14:00 cron
 *      inside the window, and that scheduled run then silently does not happen.
 *      chargeRunIsDue() defeats the throttle whenever a scheduled firing has
 *      elapsed since the last success. That is a statement about the SCHEDULE
 *      rather than about the caller, so it cannot be bypassed — or accidentally
 *      claimed — by whoever happens to make the request.
 */
export const CHARGE_THROTTLE_MINUTES = 60

/**
 * The UTC hours at which vercel.json fires /api/agent/monitor.
 *
 * CRON COUPLING: this list must match vercel.json's `crons` entries.
 * src/app/api/agent/monitor/route.ts and src/lib/ledger/pick-date.ts document
 * the same coupling. Being wrong here is bounded but real: an hour missing from
 * the list is an hour whose scheduled run can be throttled out again, which is
 * exactly the defect property 2 exists to close.
 */
export const CHARGE_CRON_HOURS_UTC = [6, 14, 20] as const

/**
 * The most recent scheduled firing at or before `now`, in epoch milliseconds.
 * Derived from the schedule rather than from a request header, so it is true
 * whoever called.
 */
export function lastScheduledFiring(
  now: Date,
  hours: readonly number[] = CHARGE_CRON_HOURS_UTC,
): number {
  let best = Number.NEGATIVE_INFINITY
  for (const hour of hours) {
    const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour)
    // Yesterday's firing when today's has not come round yet, so the answer is
    // always in the past and the first cron of a day is still a real boundary.
    const at = today <= now.getTime() ? today : today - 86_400_000
    if (at > best) best = at
  }
  return best
}

/**
 * Whether a charge run is due in spite of the throttle.
 *
 * `lastOkAt` is when the last SUCCESSFUL run finished; null means there has
 * never been one, which is always due.
 */
export function chargeRunIsDue(lastOkAt: Date | null, now: Date): boolean {
  if (!lastOkAt) return true
  const ageMinutes = (now.getTime() - lastOkAt.getTime()) / 60_000
  // An unparseable or future timestamp is a clock or data defect. Running is
  // the safe answer to both: its cost is redundant work, where the cost of not
  // running is a ledger nobody is updating and an email that says All clear.
  if (!Number.isFinite(ageMinutes) || ageMinutes < 0) return true
  if (ageMinutes >= CHARGE_THROTTLE_MINUTES) return true
  return lastOkAt.getTime() < lastScheduledFiring(now)
}

/** Charges per upsert round trip. */
const UPSERT_CHUNK = 500
/** Orders per stale-delete round trip. */
const DELETE_CHUNK = 200

export type RecalculateResult =
  | { skipped: true; cause: 'lock' | 'gate-unreadable' | 'throttled' | 'no-run-row'; reason: string }
  | {
      skipped: false
      orders: number
      upserted: number
      deleted: number
      /**
       * Charges the stale-delete DECLINED to remove because the sweep failed the
       * blast-radius floor (see DEFENCE 3 below). Zero on a healthy run. Any
       * non-zero value means billing history was left in place that the
       * calculator no longer produces, and someone has to look at why.
       */
      staleDeleteRefused: number
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
  // correct answer to those is "we did this successfully, recently".
  //
  // `status = 'ok'` is load-bearing, not tidiness. A 'failed' or 'partial' run
  // also carries a finished_at, and letting one satisfy the throttle means a
  // run that wrote nothing silences the next hour of attempts while the monitor
  // email reports the skip as healthy. See property 1 on CHARGE_THROTTLE_MINUTES.
  const { data: lastOk, error: lastFinishedError } = await supabaseAdmin
    .from('sync_runs')
    .select('finished_at')
    .eq('source', 'charges')
    .eq('status', 'ok')
    .not('finished_at', 'is', null)
    .order('finished_at', { ascending: false })
    .limit(1)

  // An unreadable throttle gate is NOT a reason to skip. Unlike the lock read
  // below, being unable to tell how long ago the last run succeeded risks only
  // doing redundant work; skipping on it would let one broken read stop charges
  // being calculated at all. So the error is kept and reported, and the run
  // proceeds to the lock, which is the defence that actually protects data.
  const lastOkAtRaw = lastOk?.[0]?.finished_at
  const now = new Date()
  if (!lastFinishedError && lastOkAtRaw) {
    const lastOkAt = new Date(lastOkAtRaw)
    if (!chargeRunIsDue(lastOkAt, now)) {
      const ageMinutes = (now.getTime() - lastOkAt.getTime()) / 60_000
      return {
        skipped: true,
        cause: 'throttled',
        reason: `A charge run succeeded ${ageMinutes.toFixed(0)} minutes ago and no `
              + `scheduled run has come round since; the next one is due in `
              + `${(CHARGE_THROTTLE_MINUTES - ageMinutes).toFixed(0)} minutes or at the `
              + `next cron, whichever is sooner.`,
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

  // DEFENCE 1, second half. The 'running' row openSyncRun writes is not
  // bookkeeping for this caller -- it IS the lock the gate above reads. If it
  // cannot be written we do not hold the lock, and proceeding would mean this
  // run's stale-delete competing with any other run that starts while it works.
  // So a failure here is a SKIP, in the same vocabulary as the lock and the
  // gate: nothing was deleted, nothing was written, and the monitor's
  // "Charge calculation did NOT run" branch reports it (monitor/route.ts:113).
  // A skipped cycle costs eight hours of staleness; an unlocked one can delete
  // a concurrent run's fresh charges, which is not recoverable from the app.
  let run: Awaited<ReturnType<typeof openSyncRun>>
  try {
    run = await openSyncRun({ source: 'charges', mode: 'live' })
  } catch (err) {
    return {
      skipped: true,
      cause: 'no-run-row',
      reason: `Could not open the sync_runs row that serves as this run's lock `
            + `(${err instanceof Error ? err.message : String(err)}). Skipping `
            + `rather than recalculating without one.`,
    }
  }

  if (lastFinishedError) {
    run.warn('throttle gate unreadable', `Could not read the last successful charge `
      + `run (${lastFinishedError.message}); proceeding without the throttle.`)
  }

  let orders = 0
  let upserted = 0
  let deleted = 0
  let staleDeleteRefused = 0
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

    // ---- DEFENCE 3: the blast-radius floor ----------------------------------
    // Count what the sweep WOULD remove before removing any of it, and refuse
    // the whole sweep if that number is implausible.
    //
    // WHY THIS IS NEEDED. The order-id scope above bounds the damage to the
    // orders this run touched, but on a live run that is EVERY order in the
    // window — so on the one failure mode that matters the scope bounds nothing.
    // buildCharges emits a charge only where a rate-card line covers the charge
    // date, and rate-card lines expire. A client whose lines lapsed at midnight,
    // an effective_to typed a year early, a bad rate-card edit: in all three the
    // calculator cheerfully builds ZERO charges, the upsert writes nothing, and
    // the sweep then deletes every charge in the window because none of them got
    // a fresh calculated_at. That is the business's billing history, and nothing
    // in this app can put it back — order_charges is the record, not a cache of
    // one. Re-running does not restore it, because the calculator that produces
    // nothing is exactly why it went.
    //
    // THE THRESHOLD, and why this one. Refuse when the run would delete MORE
    // rows than it just built. After the upsert, the deletable orders hold
    // roughly `rows.length` charges carrying this run's calculated_at, so
    // candidates > rows.length means the sweep would leave those orders with
    // less than half the charges they had. A rate card that genuinely stopped
    // covering a charge type shrinks the ledger by a fraction and passes; a rate
    // card that stopped covering ANYTHING zeroes rows.length and is caught by
    // the same comparison without needing a separate zero case. Picking a
    // percentage instead would have meant inventing a number; this one is
    // derived from the run itself and states a property worth holding — a single
    // recalculation should not be able to halve the ledger unattended.
    //
    // WHICH WAY IT ERRS. A false refusal leaves charges the calculator no longer
    // produces sitting in the table: visible, loud (run.fail below forces the
    // run non-'ok', which also stops the throttle from silencing the next
    // attempt), and removable by hand once someone has confirmed it is right. A
    // false deletion is unrecoverable. Given that asymmetry the guard is set to
    // trip early and the operator is asked to confirm, rather than the reverse.
    //
    // An unreadable count refuses too, for the same reason the lock read does:
    // "I could not check" is not "it is fine".
    let staleCandidates = 0
    let candidatesCounted = true
    for (let i = 0; i < deletable.length && candidatesCounted; i += DELETE_CHUNK) {
      const ids = deletable.slice(i, i + DELETE_CHUNK)
      // count:'exact' with limit(1): PostgREST reports the full number of
      // matching rows in the count regardless of how many it returns, so this
      // cannot be understated by the server's row cap the way a bare
      // .select('id').length could be. Understating it is the dangerous
      // direction — it would let the guard wave through the sweep it exists to
      // stop — so the count must come from the database's own tally.
      const { count, error: countError } = await supabaseAdmin
        .from('order_charges')
        .select('id', { count: 'exact' })
        .in('order_id', ids)
        .lt('calculated_at', runStartedAt)
        .limit(1)
      if (countError) {
        candidatesCounted = false
        run.fail(`stale-delete blast-radius count (${ids.length} orders)`, countError)
      } else {
        staleCandidates += count ?? 0
      }
    }

    const refuseSweep = !candidatesCounted || staleCandidates > rows.length
    if (refuseSweep && staleCandidates > 0) staleDeleteRefused = staleCandidates

    if (!candidatesCounted) {
      run.fail('stale-delete refused', new Error(
        `Could not count the charges this run's stale-delete would remove, so the `
        + `sweep was skipped. Charges the calculator no longer produces remain in `
        + `order_charges for ${deletable.length} orders.`))
    } else if (staleCandidates > rows.length) {
      run.fail('stale-delete refused', new Error(
        `The stale-delete would have removed ${staleCandidates} charges across `
        + `${deletable.length} orders while this run built only ${rows.length}. `
        + `That is a net loss of billing history, not a correction, so nothing was `
        + `deleted. Check the rate cards for expired or mis-dated effective_to `
        + `values before re-running.`))
    } else {
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
        + `absent from margin rather than counted as pure profit. On an at-cost `
        + `rate the REVENUE is unknown for the same reason and amount is null `
        + `too, so billable revenue is understated until the carrier reports — `
        + `these are labels to chase, not labels that shipped free.`)
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
    orders, upserted, deleted, staleDeleteRefused, failedOrders,
    unknownCostCharges, unknownCarrierCharges, unpricedOrders,
  }
}
