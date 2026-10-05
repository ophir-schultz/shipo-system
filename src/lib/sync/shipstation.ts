import { supabaseAdmin } from '@/lib/supabase'
import { getShipments } from '@/lib/api/shipstation'
import { calcDimWeightOz, calcBilledWeightOz } from '@/lib/billing/dim-weight'
import { sourceForCarrier } from '@/lib/ledger/carrier'
import { isSyncRunLocked, openSyncRun } from '@/lib/ledger/sync-run'
import { loadStoreMap, decideAttribution } from '@/lib/sync/store-attribution'

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

  // ATTRIBUTION. Six counters rather than one, and none of them is `errors`.
  //
  // This sync has never answered which client a label belongs to. Until this
  // commit `shipmentData` carried no client_id key at all -- the comment said
  // "for now match by order source" and nothing ever replaced it -- so every
  // shipment it wrote landed with client_id null and stayed there unless
  // zenventory.ts happened to match it by order_number. Measured 2026-10-05:
  // 599 of 890 shipments unattributed, carrying $8,980.99 of carrier cost
  // billed to nobody, 94% of everything unbilled. The gap was not historical;
  // it grew three times a day, because the sync that records the cost could not
  // name the payer.
  //
  // WHY NOT `errors`. monitor/route.ts renders that counter as "N ShipStation
  // shipments could not be recorded ... Their revenue and carrier cost are
  // missing from the ledger until the next successful run picks them up." Every
  // clause of that is false for all six cases below: the row IS recorded, the
  // cost IS stored, and no later run picks anything up, because an unmapped
  // store stays unmapped until a person inserts a row. An alert that is wrong
  // about whether money is missing is worse than no alert -- it spends the
  // attention a real one needs.
  //
  // And they are separated from EACH OTHER because each names a different piece
  // of work. "Attribution problems: 47" cannot be acted on; "3 unmapped stores,
  // ids 12345/12346/98765" is one INSERT per store.
  /** client_id written where there was none. The only case that changes a row. */
  attributed: number
  /** Real store, nobody has mapped it. One client_store_ids row fixes every shipment from it. */
  unmappedStore: number
  /** WHICH stores, deduplicated. The entire actionable content of that finding. */
  unmappedStoreIds: string[]
  /** No store key on the label. No SQL can attribute these; someone reads ShipStation. */
  noStoreId: number
  /** A stored attribution and the store map name DIFFERENT clients. Nothing written. */
  attributionConflicts: number
  /**
   * The store map could not be READ, so attribution did not run this pass.
   *
   * A boolean, not a count, and that is the whole point of its shape. One
   * failed select would otherwise be reported as 890 problems -- and worse,
   * reported as 890 of the WRONG problem, because an empty map makes every
   * store look unmapped and would send someone to map stores already mapped.
   */
  storeMapUnavailable: boolean
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
    attributed: 0, unmappedStore: 0, unmappedStoreIds: [],
    noStoreId: 0, attributionConflicts: 0, storeMapUnavailable: false,
  }
  // Deduplicated as it is collected rather than at the end, because the useful
  // number is "3 stores need mapping", not "412 shipments came from stores that
  // need mapping" -- the second reads like 412 pieces of work.
  const unmappedStores = new Set<string>()

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

  // The store -> client map, read ONCE for the whole run.
  //
  // Once, and not per shipment, for two reasons. The obvious one is that a
  // 30-day window is ~900 labels and the table has a handful of rows. The one
  // that matters is consistency: a map re-read mid-run could attribute the
  // first half of a page to one client and the second half to another if
  // somebody edited client_store_ids while the pull was in flight, and the two
  // halves would be indistinguishable afterwards.
  //
  // Placed AFTER openSyncRun on purpose. A run that lost the lock has already
  // returned above, and a run that is doing nothing should not be reading
  // lookup tables -- nor reporting a store map problem it has no shipments to
  // apply the map to.
  //
  // A FAILED READ DOES NOT FAIL THE RUN. The shipments still need recording:
  // their carrier cost is the largest variable cost in the business and it
  // arrives from this pull alone. So the pull proceeds, every row is written
  // with its cost, and attribution is skipped for the pass with one flag set.
  // `storeMap` stays null, which is exactly the value decideAttribution reads as
  // 'map-unavailable' -- the null is carried into the decision rather than
  // being flattened to an empty Map here, because an empty Map is a legitimate
  // state meaning "nobody has mapped a store yet" and would make every label
  // report its store as needing a mapping row.
  const { map: storeMap, error: storeMapError } = await loadStoreMap()
  if (storeMapError) {
    results.storeMapUnavailable = true
    // warn(), not failItem(): nothing failed to be RECORDED. Every shipment in
    // this pull is written with its cost; what is missing is the client_id on
    // the new ones, which the next pass picks up for free because the backfill
    // rule and the live rule are the same function. fail() would close the row
    // 'failed' and drive the monitor's "could not be recorded" alert, which
    // would be false about which money is at risk.
    run.warn('store map unreadable, so no shipment was attributed this pass', storeMapError)
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
          //
          // THE GUARD IS isInteger AND > 0, NOT isFinite, and the difference is
          // a lost carrier cost. `Number(null)` is 0 -- not NaN -- and
          // `Number.isFinite(0)` is true, so the isFinite version admitted a
          // label with no identity under the identity 0. So did '', false, []
          // and '0'. Every id-less label in every run then shared that one key,
          // which is exactly the collapse the paragraph above says this guard
          // prevents: measured 2026-10-05, two null-id labels at $11.11 and
          // $22.22 wrote ONE row holding $22.22, reported `created: 1,
          // updated: 1`, and closed the run `ok` with no errors recorded. The
          // first cost was overwritten, silently, and row 0 persists so every
          // later run overwrites it again.
          //
          // `> 0` rather than `!== 0` because a negative id is not a
          // ShipStation id either, and isInteger rejects NaN, the infinities
          // and any fractional value in one predicate. Real ids are positive
          // integers, so nothing legitimate is refused -- there is a test that
          // a valid id still lands, because a guard drawn too wide would
          // satisfy every assertion about collapse by recording nothing at all.
          const shipmentId = Number(s.shipmentId)
          if (!Number.isInteger(shipmentId) || shipmentId <= 0) {
            // orderNumber is the only handle left on a label with no id, so it
            // goes on the run row: refusing the label is only better than
            // collapsing it if the cost can still be recovered by hand.
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

          // WHICH CLIENT IS THIS? The question this sync has never asked.
          //
          // The whole rule lives in store-attribution.ts, shared verbatim with
          // supabase/backfill_store_attribution_2026_10.sql, because a rule
          // implemented twice is a rule that will eventually disagree with
          // itself and the disagreement would be over who gets invoiced.
          //
          // `s`, the raw payload, is passed whole: storeIdOf reads
          // advancedOptions.storeId with a top-level storeId fallback, and `s`
          // is the same object stored as raw_data below, so the live decision
          // and the backfill's SQL read the same bytes.
          const attribution = decideAttribution({
            storeMap,
            payload: s,
            existingClientId: existingShipment?.client_id,
          })

          // The client this shipment belongs to as of THIS pass: the one already
          // stored, or the one we are about to store.
          //
          // It exists because of the rate_adjustments gate forty lines down,
          // which read `existingShipment.client_id` -- the value from BEFORE
          // attribution. With that gate, a refund or void arriving on a
          // shipment this very run is attributing was dropped on the floor: the
          // row gained its client_id and the adjustment was computed, found no
          // client, and was never written. Nor would a later run recover it,
          // because once actual_cost holds the new value the diff is 0 for ever
          // and this branch is never re-entered. That is the mechanism by which
          // every refund and void on the 599 unattributed shipments was lost,
          // and leaving it in place would have kept losing them for one more
          // pass per newly-mapped store.
          //
          // A conflict contributes the STORED id, not the mapped one. The stored
          // attribution stands until a person resolves it, so the adjustment
          // belongs to the same client the shipment is currently billed to --
          // writing it against the mapped client would put a refund on the
          // invoice of a client who was never charged the original.
          const attributedClientId = attribution.action === 'attribute'
            ? attribution.clientId
            : (existingShipment?.client_id ?? null)

          switch (attribution.action) {
            case 'attribute':
              // Counted here rather than after the write, and that is a known
              // imprecision worth naming: if the update or insert below fails,
              // this counter has already incremented. It is the same shape as
              // blankOrderNumber above, which counts the finding and not the
              // write, and the failure is separately counted and reported by
              // failItem. Counting after the write would mean threading the
              // decision through both branches to no benefit.
              results.attributed++
              break
            case 'unmapped-store':
              results.unmappedStore++
              unmappedStores.add(attribution.storeId)
              break
            case 'no-store-id':
              results.noStoreId++
              break
            case 'conflict':
              // The one case that gets a per-shipment warn as well as a count.
              // A conflict means one store maps to two clients somewhere -- the
              // invariant client_store_ids is unique on store_id ALONE to
              // prevent (ledger_01_orders.sql) -- so it cannot be resolved by a
              // rule, and whoever resolves it needs the shipment, not a total.
              results.attributionConflicts++
              run.warn(`attribution conflict on shipment ${shipmentId}`, {
                orderNumber,
                storedClientId: attribution.existingClientId,
                storeMapSays: attribution.mappedClientId,
              })
              break
            case 'keep':
            case 'map-unavailable':
              // Nothing. 'keep' is the ordinary case for the 291 rows attributed
              // by hand and everything zenventory.ts matched. 'map-unavailable'
              // is already reported once for the whole run by the flag above;
              // counting it per shipment would turn one failed select into ~900
              // findings.
              break
          }

          const shipmentData = {
            // Written ONLY on 'attribute', which decideAttribution returns only
            // when the stored client_id is blank. So neither branch below can
            // overwrite an existing attribution: on the update path the key is
            // absent from the object and PostgREST leaves the column alone.
            //
            // This is the property the whole module exists for. 291 of the 890
            // rows in this database were attributed by hand, and a sync running
            // three times a day that "corrected" one of them would move a real
            // invoice from one client to another with no record that it moved.
            // Where the map disagrees with a stored value, the stored value
            // stands and the conflict is announced.
            ...(attribution.action === 'attribute'
              ? { client_id: attribution.clientId }
              : {}),
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

            // attributedClientId, not existingShipment.client_id -- see the
            // note where it is defined. The gate still refuses to write an
            // adjustment with no client, because rate_adjustments.client_id
            // feeds billing/calculator.ts straight into a client's weekly bill
            // and there is no such thing as an adjustment belonging to nobody.
            if (diff !== null && Math.abs(diff) > 0.01 && attributedClientId) {
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
                  client_id: attributedClientId,
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
    // Published in the finally, not after the return, because the throw path
    // above is reached. A pull that died on page 6 of 11 has still LEARNED
    // which stores need mapping from pages 1-5, and that is a finding worth
    // keeping even though this `results` object never reaches a caller on that
    // path -- the run row's own warn() record below is what survives.
    //
    // Sorted so two runs that found the same stores print the same line, which
    // is what makes "the same three stores again" readable as a standing
    // problem rather than as new information every eight hours.
    results.unmappedStoreIds = [...unmappedStores].sort()
    if (results.unmappedStoreIds.length > 0) {
      // One warn for the whole run naming every store, rather than one per
      // shipment. The actionable unit is the STORE: a single client_store_ids
      // row attributes every shipment that store has ever sent and every one it
      // will send, so 412 identical warnings would bury the three ids that are
      // the entire content of the finding.
      run.warn('stores with no client_store_ids row', {
        storeIds: results.unmappedStoreIds,
        shipmentsAffectedThisRun: results.unmappedStore,
      })
    }
    await run.close()
  }

  return results
}

export async function syncAdjustments() {
  return syncShipments(30)
}
