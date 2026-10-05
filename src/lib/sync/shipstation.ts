import { supabaseAdmin } from '@/lib/supabase'
import { getShipments } from '@/lib/api/shipstation'
import { calcDimWeightOz, calcBilledWeightOz } from '@/lib/billing/dim-weight'
import { sourceForCarrier } from '@/lib/ledger/carrier'
import { isSyncRunLocked, openSyncRun } from '@/lib/ledger/sync-run'

// `skipped` exists so that "this run did nothing because another one is
// already doing it" is distinguishable from "this run did nothing because
// there was nothing to do". Both return all-zero counters, and without the
// flag the monitor prints the same cheerful line for each.
export interface ShipStationSyncResult {
  created: number
  updated: number
  adjustments: number
  refunds: number
  errors: number
  unknownCarrier: number
  blankOrderNumber: number
  skipped: boolean
  skipReason: string | null
}

export async function syncShipments(daysBack = 30): Promise<ShipStationSyncResult> {
  const dateFrom = new Date()
  dateFrom.setDate(dateFrom.getDate() - daysBack)
  const dateStr = dateFrom.toISOString().split('T')[0]

  let page = 1
  let hasMore = true
  const results: ShipStationSyncResult = {
    created: 0, updated: 0, adjustments: 0, refunds: 0,
    errors: 0, unknownCarrier: 0, blankOrderNumber: 0,
    skipped: false, skipReason: null,
  }

  // Still deliberately NOT caught, with ONE exception. openSyncRun throws if
  // the sync_runs row cannot be written, and this sync is the one that writes
  // shipment cost rows -- running it with no record of the run is how a partial
  // ingest becomes invisible. All three callers already wrap this function in
  // try/catch and surface the message (agent/monitor, api/sync/shipments,
  // api/sync/all), so the throw is reported rather than lost. Contrast
  // zenventory.ts, which catches at its per-client boundary so one client
  // cannot abandon the others.
  //
  // THE EXCEPTION is a lock conflict, which this source could not have before:
  // until ledger_03d_sync_runs_mutex.sql it opened its row unconditionally.
  // Now the loser of an overlapping pair gets 23505, and if that propagated it
  // would surface as a 500 from api/sync/all and a 🚨 line from the monitor --
  // an alarm raised because the system successfully prevented the problem it
  // was built to prevent. Overlap here is routine, not exceptional: the monitor
  // route budgets 300s and AutoSync polls it every five minutes from every open
  // tab, so this is the ordinary case rather than a rare collision.
  //
  // Returned rather than thrown, every counter left at zero, because zero is
  // the truth: this invocation created nothing, updated nothing, and failed at
  // nothing. The sibling run holding the lock is doing the work and will report
  // it against its own sync_runs row.
  let run: Awaited<ReturnType<typeof openSyncRun>>
  try {
    run = await openSyncRun({
      source: 'shipstation',
      mode: 'live',
      windowStart: dateStr,
      windowEnd: new Date().toISOString().split('T')[0],
    })
  } catch (err) {
    if (!isSyncRunLocked(err)) throw err
    results.skipped = true
    results.skipReason = err.message
    return results
  }

  // One call, not two. The row's status and the counter the CALLER reads are
  // two different readers of the same fact, and until this helper existed every
  // fail site had to remember to feed both by hand. On 2026-10-03 one of them
  // did not: a run closed 'failed' with error_count 1 on 'shipment lookup
  // #2500-2' while /api/agent/monitor reported has_issues:false, so the
  // dashboard's sync indicator stayed green over a failed run. The pairing was
  // the defect, so the pairing is now unforgettable rather than merely correct.
  //
  // run.fail() drives the row's status via close(); results.errors is what the
  // three callers read. Recording both from one function is what stops them
  // drifting again the next time a fail site is added. sync/zenventory.ts has
  // a failItem() of its own, for the same reason and with the same name.
  //
  // NOT for the pull-level failure in the catch at the bottom -- see the note
  // there on why that one is deliberately unpaired.
  const failItem = (context: string, err: unknown) => {
    run.fail(context, err)
    results.errors++
  }

  // The whole pull lives in a try/finally so the 'running' row cannot outlive
  // the function. getShipments() throws on a 401, a timeout or a rate limit,
  // and that throw is MEANT to propagate -- see the note on openSyncRun above:
  // all three callers surface it. What must not escape with it is an open run
  // row. close() is the only thing that writes the fail() and wrote() records
  // this run accumulated, so a pull that died on page 6 of 11 used to leave a
  // row that said 'running' and nothing else: no trace that it had already
  // ingested half the window, and no trace of the shipments it failed on.
  try {
    while (hasMore) {
      const data = await getShipments({
        shipDateStart: dateStr,
        page,
        pageSize: 100,
        // DO NOT re-add carrierCode. Filtering to 'stamps_com' hid 776 of 1,095
        // shipments in a 30-day window — about $12,500/month of UPS label cost,
        // roughly 80% of the largest variable cost in the business. Every P&L
        // figure depends on this call returning all carriers.
        // Spec: docs/superpowers/specs/2026-09-29-complete-the-ledger-design.md §3.1
      })

      const shipments = data.shipments ?? []
      if (shipments.length === 0 || page >= (data.pages ?? 1)) hasMore = false

      for (const s of shipments) {
        run.seen()
        try {
          // DEFECT 1, FIXED. The old code matched on order_number, which is not
          // the identity of a label: a multi-package order has several, and a
          // blank order number gives every such label the same empty key.
          //
          // Corrected by mutation test, because the first version of this note
          // claimed the wrong mechanism. Restoring the order_number match makes
          // the second label of an order find its SIBLING's row and update it,
          // so the two labels COLLAPSE onto one -- one carrier cost lost, the
          // survivor overwritten. Measured cost comes out too low and margin
          // too high. The PGRST116 fall-through-to-insert runaway needs the
          // table to already hold two rows for one order number, which this
          // path cannot produce on its own (every ambiguity collapses first);
          // it needs a second writer or a backfill to seed it. Both failures
          // are undetected by the leak views, which look at whether work was
          // billed, never at whether a cost was recorded exactly once.
          //
          // shipmentId is unique per label, so it is the identity. The error is
          // still inspected below rather than discarded, because a key being
          // correct today is not a reason to read PGRST116 as "no row".
          const shipmentId = Number(s.shipmentId)
          if (!Number.isFinite(shipmentId)) {
            failItem('missing shipmentId', { orderNumber: s.orderNumber })
            continue
          }

          const { data: existingShipment, error: matchError } = await supabaseAdmin
            .from('shipments')
            .select('id, actual_cost, client_id')
            .eq('shipstation_shipment_id', shipmentId)
            .maybeSingle()

          // DEFECT 4, FIXED. The error is inspected, not discarded.
          if (matchError) {
            failItem(`match shipment ${shipmentId}`, matchError)
            continue
          }

          const orderNumber = String(s.orderNumber ?? '').trim()
          if (!orderNumber) results.blankOrderNumber++

          const dims = s.dimensions ?? {}
          const lengthIn = dims.length ?? 0
          const widthIn = dims.width ?? 0
          const heightIn = dims.height ?? 0

          const weightRaw = s.weight?.value ?? 0
          const weightUnit = s.weight?.units ?? 'ounces'
          const weightOz = weightUnit === 'pounds' ? weightRaw * 16 : weightRaw

          const carrier = s.carrierCode?.toUpperCase() ?? ''
          const service = s.serviceCode ?? ''
          const dimWeightOz = calcDimWeightOz(lengthIn, widthIn, heightIn, carrier, service)
          const billedWeightOz = calcBilledWeightOz(weightOz, dimWeightOz)

          // DEFECT 3, FIXED. source is derived from the carrier code instead of
          // being hardcoded to 'stamps'. Unknown carriers are counted, not
          // guessed at.
          const { source, known } = sourceForCarrier(s.carrierCode ?? '')
          if (!known) {
            results.unknownCarrier++
            // warn(), not fail(): an unknown carrier is a reportable finding, not
            // a failure. The shipment is still written with source stored verbatim;
            // piece 4 reads kind:'warning' entries to surface carrier codes that
            // need adding to the carrier map. Spec line 963.
            run.warn(`unknown carrier ${s.carrierCode}`, { shipmentId })
          }

          // A cost ShipStation has not reported is UNKNOWN, not zero. `?? 0` made
          // the null branch in calculate-charges unreachable, so every label that
          // has not been rated yet was recorded as free — and a free label reads
          // downstream as pure profit, overstating margin by exactly the carrier
          // spend we have not been told about yet. parseFloat is also replaced:
          // it returns NaN on a non-numeric string, and NaN is rejected by
          // numeric(10,2), which would fail the whole shipment.
          const rawCost = s.shipmentCost
          const parsedCost = rawCost === null || rawCost === undefined || rawCost === ''
            ? NaN
            : Number(rawCost)
          const newCost = Number.isFinite(parsedCost) ? parsedCost : null

          // A value that was sent but could not be read is a different finding
          // from one that was never sent, and only the first needs a person.
          if (newCost === null && rawCost !== null && rawCost !== undefined && rawCost !== '') {
            run.warn('unreadable shipment cost', { shipmentId, shipmentCost: rawCost })
          }

          const shipmentData = {
            shipstation_shipment_id: shipmentId,
            order_number: orderNumber,
            order_date: s.orderDate,
            ship_date: s.shipDate,
            carrier,
            service,
            tracking_number: s.trackingNumber ?? '',
            recipient_name: s.shipTo?.name ?? '',
            recipient_city: s.shipTo?.city ?? '',
            recipient_state: s.shipTo?.state ?? '',
            recipient_zip: s.shipTo?.postalCode ?? '',
            weight: parseFloat(weightOz.toFixed(2)),
            weight_unit: 'ounces',
            length: lengthIn || null,
            width: widthIn || null,
            height: heightIn || null,
            dim_unit: dims.units ?? 'inches',
            dim_weight: dimWeightOz,
            billed_weight: parseFloat(billedWeightOz.toFixed(2)),
            // Never overwrite a cost we have with one we no longer know. An
            // unknown cost is an absence of information; letting it replace a
            // measured figure would delete carrier spend that was already
            // reported. On an insert there is nothing to preserve, so it is null.
            actual_cost: newCost ?? existingShipment?.actual_cost ?? null,
            source,
            raw_data: s,
          }

          if (existingShipment) {
            const prevParsed = existingShipment.actual_cost === null
              || existingShipment.actual_cost === undefined
              ? NaN
              : Number(existingShipment.actual_cost)
            const prevCost = Number.isFinite(prevParsed) ? prevParsed : null

            // A rate adjustment is the difference between two costs we KNOW.
            // `?? 0` on either side invented one: a cost arriving for the first
            // time looked like an increase of the entire label price, and a cost
            // going unknown looked like a full refund. Neither is money moving,
            // so neither is recorded.
            //
            // DEFECT 2, FIXED. The old guard was `diff > 0.01`, so only cost
            // INCREASES were recorded. A void or a refund is a decrease and was
            // structurally invisible: we could see money leave and never see it
            // come back.
            const diff = prevCost !== null && newCost !== null
              ? parseFloat((newCost - prevCost).toFixed(2))
              : null

            if (diff !== null && Math.abs(diff) > 0.01 && existingShipment.client_id) {
              // DEFECT 5, FIXED. This used to be a select on
              // (shipment_id, adjustment_amount) followed by an insert when the
              // select came back empty -- a check-then-act with NO constraint
              // underneath it, because rate_adjustments carried no index at all
              // beyond its primary key.
              //
              // The race is between this block and the shipments update forty
              // lines down. Two overlapping syncs both read the OLD actual_cost
              // at the select above, so both compute the same diff, both find no
              // existing adjustment, and both insert. Overlap is reachable:
              // /api/agent/monitor declares maxDuration = 300 and AutoSync polls
              // it every five minutes, and the single-flight guard it relies on
              // is a React ref -- it dedupes within one browser TAB, not across
              // tabs and not against the cron.
              //
              // The duplicate never heals. Once actual_cost holds the new value
              // the diff is 0 on every later run and this branch is never
              // re-entered, so the pair sits there for ever. billing/calculator.ts
              // sums adjustment_amount where status = 'approved' into the client's
              // weekly bill, so an approved duplicate DOUBLE-BILLS a real client.
              //
              // The fix is the unique index in
              // supabase/ledger_03c_rate_adjustments_uniq.sql, which enforces the
              // pair that verify/ledger_03b_verify.sql query 2 was already
              // asserting. The dedup rule has not changed -- it has moved from
              // application code that could be raced to a constraint that cannot.
              //
              // ignoreDuplicates IS LOAD-BEARING, not a default being spelled
              // out. Without it this is ON CONFLICT DO UPDATE, which would
              // overwrite the stored row -- resetting an adjustment a person had
              // already moved to 'approved' back to 'pending' and moving its
              // adjustment_date to today, three times a day. DO NOTHING keeps
              // the existing row exactly as it is, which is what the old
              // select-then-skip did.
              const { data: insertedAdj, error: insError } = await supabaseAdmin
                .from('rate_adjustments')
                .upsert({
                  shipment_id: existingShipment.id,
                  client_id: existingShipment.client_id,
                  order_number: orderNumber,
                  original_cost: prevCost,
                  adjusted_cost: newCost,
                  adjustment_amount: diff,
                  reason: diff > 0 ? 'Carrier rate adjustment' : 'Refund or void',
                  adjustment_date: new Date().toISOString(),
                  status: 'pending',
                }, {
                  // Must match rate_adjustments_shipment_amount_key, which is
                  // deliberately NON-PARTIAL: PostgREST emits a bare column list
                  // here and Postgres cannot infer a partial index from it, so a
                  // predicate on that index turns every one of these into 42P10
                  // and no adjustment is ever recorded. See the migration.
                  onConflict: 'shipment_id,adjustment_amount',
                  ignoreDuplicates: true,
                })
                .select('id')

              // `insert ... on conflict do nothing returning id` returns only the
              // rows it actually inserted, so an empty array means the adjustment
              // was already recorded. That is now the counter's signal, and it is
              // EXACT where the old pre-check was racy: under the overlap above,
              // both runs used to count an adjustment and only one of them was
              // telling the truth. The run that loses the conflict now reports
              // nothing, which is what it did.
              if (insError) failItem(`adjustment insert ${shipmentId}`, insError)
              else if ((insertedAdj ?? []).length > 0) {
                if (diff > 0) results.adjustments++
                else results.refunds++
              }
            }

            const { error: updError } = await supabaseAdmin
              .from('shipments').update(shipmentData).eq('id', existingShipment.id)
            if (updError) failItem(`update ${shipmentId}`, updError)
            else { results.updated++; run.wrote() }
          } else {
            const { error: insError } = await supabaseAdmin
              .from('shipments').insert(shipmentData)

            // 23505 here is NOT this run's failure. It is the same overlap the
            // rate-adjustment note above describes, seen from the other side:
            // two syncs both matched no existing row at the select near the top,
            // and the slower one arrives to find the label already inserted.
            //
            // shipments_shipstation_id_key (ledger_03_charges.sql:24) is the only
            // unique index on this table apart from the uuid primary key, which
            // is generated and cannot collide, so a 23505 can only mean this
            // shipmentId is already present -- recorded, by the sibling run, from
            // the same ShipStation payload this run is holding.
            //
            // Counting that as an error was actively misleading, not merely
            // noisy. It drove monitor/route.ts:75 to email "N ShipStation
            // shipments could not be recorded ... their revenue and carrier cost
            // are missing from the ledger until the next successful run picks
            // them up", which is false in every clause: the row is there, the
            // cost is there, and there is nothing for a later run to pick up.
            // An alert that is wrong about whether money is missing is worse
            // than no alert, because it spends the attention that a real one
            // needs.
            //
            // warn(), so it is still recorded against the run and findable --
            // a sudden rise in these is real evidence of how often the syncs
            // overlap -- but it does not move the row off 'ok' and does not
            // reach the alert email. Not counted in results.created either:
            // this run did not create it. Any drift between the two runs'
            // payloads is reconciled by the next run's update path, which is the
            // same guarantee the ordinary re-sync relies on.
            if (insError?.code === '23505') {
              run.warn(`insert ${shipmentId}`, 'already inserted by a concurrent run')
            }
            else if (insError) failItem(`insert ${shipmentId}`, insError)
            else { results.created++; run.wrote() }
          }
        } catch (err) {
          // Still a catch, but it keeps what it caught.
          failItem(`shipment ${s?.shipmentId ?? 'unknown'}`, err)
        }
      }

      page++
    }
  } catch (err) {
    // Recorded BEFORE close(), because close() derives the status from the
    // error list. An unrecorded throw would close this row 'ok' -- a clean-
    // looking row sitting on top of a half-finished ingest, which is the one
    // outcome worse than no row at all.
    //
    // run.fail() and NOT failItem(), which is the one deliberate exception to
    // the pairing rule above. The next line throws, so `results` never reaches
    // a caller: nobody can read a counter bumped here, which makes the bump
    // dead code rather than a safeguard. Audited 2026-10-05 -- this asymmetry
    // is correct, not an instance of the 2026-10-03 defect. What reports this
    // failure is the throw itself: the monitor route's step-1 catch turns it
    // into the '✗ ShipStation sync FAILED' line and pushes it to the errors
    // array the alert email reads (src/app/api/agent/monitor/route.ts -- grep
    // that string rather than trusting a line number; this file has already
    // outlived one). That, plus this fail() record on the row, is the whole
    // report. Do not "fix" it by routing it through failItem.
    run.fail('shipstation pull', err)
    throw err
  } finally {
    await run.close()
  }

  return results
}

export async function syncAdjustments() {
  return syncShipments(30)
}
