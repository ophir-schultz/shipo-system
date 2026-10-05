import { supabaseAdmin } from '@/lib/supabase'
import { getCustomerOrders } from '@/lib/api/zenventory'
import { normaliseLines, NegativeQuantityError } from '@/lib/ledger/order-line'
import { watermarkPickDate, watermarkIsEvidence } from '@/lib/ledger/pick-date'
import { isSyncRunLocked, openSyncRun } from '@/lib/ledger/sync-run'

/**
 * Each client has their own Zenventory account.
 * We pull orders from each client's API key — every order returned belongs to that client.
 * No name-matching needed.
 */
export async function syncClientAssignments(daysBack = 30) {
  // Load all active clients that have Zenventory credentials
  const { data: clients, error: clientsErr } = await supabaseAdmin
    .from('clients')
    .select('id, name, zenventory_api_key, zenventory_api_secret')
    .eq('active', true)
    .not('zenventory_api_key', 'is', null)
    .not('zenventory_api_secret', 'is', null)

  // The error is raised separately from the empty case on purpose. This query
  // used to discard it, so a database outage or a permissions problem left
  // clients null and produced the message below -- telling Ophir to go and add
  // API keys that are already there, and hiding the real fault behind an errand.
  if (clientsErr) {
    throw new Error(`Could not load clients for the Zenventory sync: ${clientsErr.message}`)
  }

  if (!clients?.length) {
    throw new Error('No active clients have Zenventory credentials. Add API keys on each client\'s page.')
  }

  const modifiedFrom = new Date()
  modifiedFrom.setDate(modifiedFrom.getDate() - daysBack)
  const modifiedFromISO = modifiedFrom.toISOString()

  let totalMapped = 0
  let totalUpdated = 0
  let totalSkipped = 0
  // Picked lines seen for the first time during a discontinuity, left undated.
  // See watermarkIsEvidence(). Surfaced in the return value because an undated
  // picked line produces no pick charge at all, and a number nobody is shown is
  // the same as revenue quietly not being billed.
  let totalUndatedPicks = 0
  // Failure MESSAGES, which is not the same thing as failed CLIENTS, and
  // conflating the two was a real defect until 2026-10-05. This list names what
  // went wrong and may hold more than one entry for the same client; the set
  // below is what counts clients. Read the note there before using `.length` of
  // this for anything.
  const clientErrors: string[] = []
  // Failed CLIENTS, by id, and the reason this is a Set rather than a count.
  //
  // One client can fail twice in a single pass: page 1 of its order list
  // succeeds, page 2 rejects (which ends pagination), execution carries on into
  // the shipment assignment loop with the partial list, and that throws into the
  // per-client catch. Two real failures, two messages -- but one client.
  //
  // clients_failed used to be clientErrors.length and clients_synced used to
  // subtract it, so that pass reported arithmetic that cannot happen. Measured
  // 2026-10-05 on a one-client pass: clients_failed 2, clients_synced -1.
  //
  // The guard below is the part that actually hurt, and it broke BOTH ways:
  // with one client it compared 2 !== 1, so the single pass where the only
  // client failed completely returned normally instead of throwing -- silence
  // on a total outage. With two clients and one of them double-failing it
  // compared 2 === 2 and threw 'failed for every client', alerting a total
  // outage while the other client had synced perfectly. A count of messages
  // can be both too high and, as a proxy for clients, never right.
  //
  // Keyed on client.id, not client.name: id is the primary key the clients
  // query selects, and name is nullable and not guaranteed unique (every other
  // site here already writes `client.name ?? client.id` for that reason).
  const failedClients = new Set<string>()

  // Per-ITEM failures, which clients_failed cannot see and therefore nobody
  // downstream could.
  //
  // close() resolves the row's status from the error count (sync-run.ts:155-157),
  // so a single run.fail() moves this client's sync_runs row off 'ok'. But a
  // client that finished its loop having lost ten shipment assignments is not a
  // failed CLIENT: it left clientErrors empty, so `clients_failed: 0` went back
  // to the monitor, which only reports when that count is non-zero
  // (api/agent/monitor/route.ts) — and so painted the sync indicator green over
  // a row that says 'failed'. Production, 2026-10-03 ~08:07 UTC: status
  // 'failed', error_count 1, context 'shipment lookup #2500-2', reported as all
  // clear.
  //
  // Not counted here: the pagination failure and the per-client catch below.
  // Both go through failClient() instead, so clients_failed reports them;
  // counting them again would alert twice on one incident. That split is the
  // reason there are two helpers rather than one -- failItem() for a client that
  // synced but lost rows, failClient() for a client that did not sync.
  let totalItemsFailed = 0
  // Names what failed, so the alert can say 'shipment lookup #2500-2' rather
  // than only '1'. Capped for the reason sync-run.ts caps stored errors — one
  // bad client must not make the alert email unreadable — and the count above
  // stays complete, so the list is examples and never the figure.
  const itemFailures: string[] = []
  const MAX_NAMED_ITEM_FAILURES = 10

  // Clients this invocation stepped over because a concurrent invocation
  // already holds their per-client lock. Kept SEPARATE from clientErrors, and
  // the separation is the whole point: a locked client is being synced right
  // now by the sibling run, so it is neither a failure nor something for the
  // alert email. But it is also NOT a success of this run's, and
  // clients_synced below is computed by subtraction -- so without this list a
  // wholly locked-out invocation would report every client as synced while
  // having touched none of them, which is a worse lie than the failure it
  // avoided.
  const lockedClients: string[] = []

  for (const client of clients) {
    // Marks THIS CLIENT failed, in both of the places that have to know: the
    // set that counts clients and the list that names failures. Calling it
    // twice for one client adds a second message and leaves the count at one,
    // which is the whole fix -- idempotent per client, by construction, so no
    // call site has to know whether it is the first failure of the pass.
    //
    // Separate from failClient() below, and deliberately above the openSyncRun
    // try: this closes over `client` only, so the branch where openSyncRun threw
    // can still reach it. That branch is a failed client too, and leaving it out
    // of the set would have traded the overcount for an undercount.
    //
    // Owns the `${client.name}: ` prefix so both call sites cannot drift on it.
    const recordClientFailure = (message: string) => {
      failedClients.add(client.id)
      clientErrors.push(`${client.name}: ${message}`)
    }

    // Each client gets its own sync_runs row so a 401 on one client is
    // recordable without condemning or absolving the whole run. Two clients
    // (Nayax and Creative Pea) currently return 401 while their Zenventory 2.0
    // credentials are being restored; their rows will resolve to 'failed' while
    // the other clients' rows resolve to 'ok'.
    //
    // openSyncRun now THROWS if it cannot write that row. Here the row is audit
    // only -- nothing gates on a 'zenventory' run being live, unlike the
    // 'charges' run whose row is the lock itself -- but a client whose run
    // cannot be recorded must not be silently skipped either, since attributable
    // failure is the entire reason for the per-client rows. So it is caught at
    // the same per-client boundary the 401s use: this client is named in
    // clientErrors and the rest still sync. Letting it propagate would abandon
    // every client after the first failure.
    //
    // Asked BEFORE openSyncRun, so the answer cannot depend on the row this run
    // is about to insert. (That row is 'running' with a null finished_at and
    // would be filtered out anyway; asking first means nobody has to verify
    // that in order to read this.)
    //
    // 'ok' and 'partial' both count as continuity. A partial run pulled orders
    // and wrote rows -- it observed the warehouse -- it merely also hit errors
    // on some of them. A 'failed' run observed nothing, so it proves nothing
    // about the gap.
    const now = new Date()
    const { data: previousRun, error: previousRunErr } = await supabaseAdmin
      .from('sync_runs')
      .select('finished_at')
      .eq('source', 'zenventory')
      .eq('client_id', client.id)
      .in('status', ['ok', 'partial'])
      .not('finished_at', 'is', null)
      .order('finished_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    // An unreadable sync_runs table is not proof of continuity. Falling through
    // to `true` here would restore the exact bug this guard exists to stop, on
    // the one day the database is unhealthy.
    const watermarkUsable = !previousRunErr
      && watermarkIsEvidence(previousRun?.finished_at, now)
    let undatedPicks = 0

    let run: Awaited<ReturnType<typeof openSyncRun>>
    try {
      run = await openSyncRun({
        source: 'zenventory',
        clientId: client.id,
        mode: 'live',
        windowStart: modifiedFromISO.split('T')[0],
        windowEnd: new Date().toISOString().split('T')[0],
      })
    } catch (err: any) {
      // A lock conflict is the mutex working, so it is recorded but not
      // reported as a failure. It can only happen when a second invocation of
      // this whole function is in flight for the SAME client -- the loop is
      // sequential, so a client cannot collide with itself -- and in that case
      // the sibling invocation is mid-sync for this client and will write
      // everything this one would have. Pushing it to clientErrors would send
      // a 🚨 email naming a client that is at that moment syncing correctly.
      //
      // Checked before the generic branch so that it cannot be swallowed by
      // it, and `continue` either way: without a run row there is nothing to
      // fail() against and nothing to close().
      if (isSyncRunLocked(err)) {
        lockedClients.push(client.name ?? client.id)
        continue
      }
      // recordClientFailure and NOT failClient, which is the one deliberate
      // exception here: failClient() closes over `run`, and the whole reason we
      // are in this branch is that `run` does not exist -- openSyncRun threw.
      // There is no row to fail() against, which is also why the message has to
      // say the client was not synced rather than leaving that to be inferred
      // from a sync_runs row that was never written. Do not "fix" this into
      // failClient(); it would throw on `run`. It does still count the client,
      // which is what recordClientFailure is for.
      recordClientFailure(`could not open a sync_runs row, so this `
        + `client was not synced (${err?.message ?? String(err)})`)
      continue
    }

    // One call, not two. Pairing `run.fail()` with the caller-visible counter
    // by hand is exactly how these sites came to be unpaired — the row recorded
    // the failure and nothing the caller reads did. Recording both from a
    // single function is what stops the pairing drifting again the next time a
    // fail() site is added.
    //
    // sync/shipstation.ts did pair by hand, and was the file this note used to
    // point at as the counter-example; it now has a failItem() of its own, so
    // the two sources are structurally the same shape.
    const failItem = (context: string, err: unknown) => {
      run.fail(context, err)
      totalItemsFailed++
      if (itemFailures.length < MAX_NAMED_ITEM_FAILURES) {
        itemFailures.push(`${client.name ?? client.id}: ${context}`)
      }
    }

    // The CLIENT-level counterpart, and the distinction between the two is the
    // whole reason there are two. failItem() means "this client synced, but it
    // lost N individual rows"; failClient() means "this client did not sync".
    // They feed different counters that different readers consume --
    // items_failed/item_failures versus clients_failed/errors[], and only the
    // latter reaches the 🚨 alert email -- so routing a failure through the
    // wrong one is a reporting defect even though both record against the row.
    //
    // Pairing by hand is what this replaces: two sites below each wrote
    // run.fail() and clientErrors.push() as separate statements, which is the
    // same drift hazard the 2026-10-03 incident came from, one level up.
    //
    // `any` rather than `unknown` so the message expression stays byte-identical
    // to the two sites it replaces; both already catch with `err: any`.
    //
    // Calling this twice for one client is SAFE, and that was once a defect
    // rather than a property. Both of the sites below can fire in a single pass
    // -- page 1 succeeds, page 2 rejects (which ends pagination), then the
    // assignment loop runs on the partial order list and throws into the
    // per-client catch -- which used to count the client twice, because
    // clients_failed was clientErrors.length and clients_synced subtracted it.
    // Measured on a one-client pass: clients_failed 2, clients_synced -1, and
    // the all-failed guard silently not firing. Fixed 2026-10-05 by counting
    // clients in a Set via recordClientFailure; see the note on failedClients
    // for both of the ways that guard misreported.
    //
    // run.fail() is still called per FAILURE, not per client, and that is
    // deliberate: the row is the forensic record, and 'pagination page 2' plus
    // 'zenventory sync for X' says more than either alone. Only the caller's
    // client count had to become per-client.
    const failClient = (context: string, err: any) => {
      run.fail(context, err)
      recordClientFailure(err?.message ?? String(err))
    }

    // Everything this client's run does is inside the try, so that close()
    // runs whether it finishes, errors or throws. close() is what writes the
    // fail() and warn() records to the row; a row left at 'running' keeps all
    // of them out of sync_runs, and the 'undated picks' warn() below is the
    // ONLY place a fortnight of unbillable picks is ever announced.
    try {
      let page = 1
      let hasMore = true
      const orderNumbers: string[] = []

      // Pull all orders from this client's Zenventory account
      while (hasMore) {
        let data: any
        try {
          data = await getCustomerOrders(client.zenventory_api_key, client.zenventory_api_secret, {
            page,
            perPage: 100,
            modifiedSince: modifiedFromISO,
          })
        } catch (err: any) {
          // A page that cannot be fetched ends this client, not this page: the
          // order list is incomplete from here on, so there is nothing to be
          // gained by asking for page n+1. failClient(), not failItem(), for
          // that reason -- the client did not sync.
          failClient(`pagination page ${page}`, err)
          hasMore = false
          break
        }

        const orders = data.customerOrders ?? data.orders ?? []
        const meta = data.meta ?? {}

        for (const order of orders) {
          const orderNumber = String(order.orderNumber ?? order.order_number ?? '').trim()
          if (!orderNumber) { failItem('blank order number', order); continue }
          orderNumbers.push(orderNumber)

          run.seen()
          try {
            const { data: orderRow, error: orderErr } = await supabaseAdmin
              .from('orders')
              .upsert({
                client_id: client.id,
                order_key: orderNumber.toUpperCase(),
                order_number: orderNumber,
                source: 'zenventory',
                order_date: order.orderDate ?? order.order_date ?? null,
                cancelled: Boolean(order.cancelled ?? false),
              }, { onConflict: 'client_id,order_key' })
              .select('id')
              .single()

            if (orderErr || !orderRow) {
              failItem(`order ${orderNumber}`, orderErr ?? 'no row returned')
              continue
            }

            const lines = normaliseLines(
              order.items ?? order.orderItems ?? order.lineItems ?? []
            )

            for (const line of lines) {
              // pick_date is set ONCE and never moved. Read the existing row
              // first so an established date survives a re-sync.
              const { data: existing, error: existingErr } = await supabaseAdmin
                .from('order_items')
                .select('id, pick_date, pick_date_source, quantity_picked')
                .eq('order_id', orderRow.id)
                .eq('source', 'zenventory')
                .eq('line_ordinal', line.line_ordinal)
                .maybeSingle()

              if (existingErr) {
                failItem(`item lookup ${orderNumber}:${line.line_ordinal}`, existingErr)
                continue
              }

              let pickDate = existing?.pick_date ?? null
              let pickSource = existing?.pick_date_source ?? null

              // `pickSource !== 'unknown'` is what makes the null STICKY, and it
              // is the whole point. Without it, a line left undated during an
              // outage re-enters this branch on the next healthy run and gets
              // stamped with THAT day's date -- later, and so more wrong, than the
              // date we declined to write in the first place. 'unknown' records
              // that we have already looked at this line and found its date
              // unknowable, so no later run will guess at it. A real observation
              // (pickprintdate, modified_date) or a manual backfill can still
              // fill it; nothing automatic will invent it.
              if (line.picked && !pickDate && pickSource !== 'unknown') {
                if (watermarkUsable) {
                  pickDate = watermarkPickDate(now)
                  pickSource = 'watermark'
                } else {
                  // NULL, not today. See watermarkIsEvidence() in
                  // src/lib/ledger/pick-date.ts for why, and note the cost this
                  // accepts: calculate-charges.ts skips an item with no pickDate,
                  // so this line produces no pick charge until it is dated. That
                  // is the recoverable direction -- unknown revenue can be found
                  // and billed later; a fabricated pick date silently misstates
                  // the daily labour cost forever, in the one report that exists
                  // to make daily labour cost legible.
                  pickDate = null
                  pickSource = 'unknown'
                  undatedPicks++
                }
              }
              // `|| pickSource` so an unpick also clears the 'unknown' marker.
              // Testing pickDate alone would leave the sticky flag behind on a
              // line that is no longer picked, and if it were picked again during
              // a healthy run the flag would block the watermark that run had
              // every right to write.
              if (!line.picked && (pickDate || pickSource)) {
                pickDate = null
                pickSource = null
              }

              const { error: itemErr } = await supabaseAdmin
                .from('order_items')
                .upsert({
                  order_id: orderRow.id,
                  source: 'zenventory',
                  line_ordinal: line.line_ordinal,
                  sku: line.sku,
                  description: line.description,
                  quantity_ordered: line.quantity_ordered,
                  quantity_picked: line.quantity_picked,
                  is_component: line.is_component,
                  classification_source: line.classification_source,
                  pick_date: pickDate,
                  pick_date_source: pickSource,
                  is_estimate: pickSource === 'watermark',
                }, { onConflict: 'order_id,source,line_ordinal' })

              if (itemErr) failItem(`item ${orderNumber}:${line.line_ordinal}`, itemErr)
              else run.wrote()
            }
          } catch (err) {
            if (err instanceof NegativeQuantityError) {
              failItem(`order ${orderNumber}: bad quantity`, err)
            } else {
              failItem(`order ${orderNumber}`, err)
            }
          }
        }

        hasMore = page < (meta.totalPages ?? meta.total_pages ?? 1)
        page++
      }

      totalMapped += orderNumbers.length

      // Assign each order's shipment to this client.
      //
      // Still one order number at a time. That is slow but correct, and widening
      // it is out of scope here. What is NOT out of scope is that both calls used
      // to throw their error away. Client attribution is what makes every
      // per-client revenue and cost figure land on the right client, so a failure
      // here is not cosmetic: the shipment keeps its old client_id -- or none --
      // while totalUpdated counts an update that never happened, and the run
      // reports a clean pass over a ledger that now attributes money to the wrong
      // business. Spec: "Nothing in this design may discard an error object."
      for (const orderNumber of orderNumbers) {
        const { data: shipment, error: shipErr } = await supabaseAdmin
          .from('shipments')
          .select('id, client_id')
          .eq('order_number', orderNumber)
          .maybeSingle()

        if (shipErr) {
          failItem(`shipment lookup ${orderNumber}`, shipErr)
          continue
        }

        if (!shipment) { totalSkipped++; continue }
        if (shipment.client_id === client.id) { totalSkipped++; continue }

        const { error: assignErr } = await supabaseAdmin
          .from('shipments')
          .update({ client_id: client.id })
          .eq('id', shipment.id)

        if (assignErr) {
          failItem(`assign shipment ${orderNumber} to ${client.name ?? client.id}`, assignErr)
          continue
        }

        totalUpdated++
        run.wrote()
      }

      // warn(), not fail(): this is a correct outcome, not a broken one, and it
      // must not push the run to 'partial'. But it is recorded against the run so
      // that the client and the count are findable later, when somebody asks why
      // a fortnight of picks carries no pick revenue.
      if (previousRunErr) {
        run.warn('pick date continuity unknown', `could not read the previous `
          + `zenventory sync_runs row for this client, so the pick-date watermark `
          + `was not trusted: ${previousRunErr.message}`)
      }
      if (undatedPicks > 0) {
        run.warn('undated picks', `${undatedPicks} picked line`
          + `${undatedPicks > 1 ? 's were' : ' was'} seen for the first time with no `
          + `continuous sync to date ${undatedPicks > 1 ? 'them' : 'it'} from `
          + `(previous finished run: ${previousRun?.finished_at ?? 'none'}). `
          + `pick_date left null rather than stamped with today. These lines `
          + `produce no pick charge until a real pick date is supplied.`)
        totalUndatedPicks += undatedPicks
      }
    } catch (err: any) {
      // Whatever the per-page and per-order handlers did not already catch --
      // a fetch that rejects rather than returning a PostgREST error, most
      // likely. Caught at the per-client boundary for the same reason
      // openSyncRun's failure is, forty lines up: one client's bad minute must
      // not abandon every client after it in the list. The function still
      // throws below if EVERY client failed.
      //
      // fail() before close(), not after: close() picks the status from the
      // error list, so an unrecorded throw would close this row 'ok'. failClient
      // records both halves, and it runs before the finally, so the ordering
      // this note describes still holds.
      failClient(`zenventory sync for ${client.name ?? client.id}`, err)
    } finally {
      await run.close()
    }
  }

  // Why the guard is this NARROW: it fires only when nothing at all worked.
  // Throwing whenever any client failed reported seven successes and one 401 as
  // a dead run, and two clients return 401 today — Nayax and Creative Pea, both
  // awaiting Zenventory 2.0 credentials — so partial failure is the normal
  // state here, not an edge case. Each client's outcome is its own sync_runs
  // row; this throw is only for the total-outage case.
  //
  // Why it counts the SET: both sides have to be client counts. This compared
  // clientErrors.length to clients.length until 2026-10-05 -- a message count
  // against a client count -- and a double-failing client broke it in both
  // directions at once: it both suppressed the throw on a real total outage and
  // invented one on a partial. See the note on failedClients. The messages are
  // still what the thrown error CARRIES, since naming both halves of a double
  // failure is the useful part; they are just no longer what it counts.
  if (failedClients.size === clients.length) {
    throw new Error(`Zenventory sync failed for every client:\n${clientErrors.join('\n')}`)
  }

  return {
    // Locked clients subtracted as well as failed ones. They were not synced
    // BY THIS RUN, and this count is the only thing the monitor uses to say
    // how many clients a pass covered.
    //
    // Both subtrahends count CLIENTS, which is what makes the subtraction
    // sound. failedClients and lockedClients are disjoint by construction: the
    // lock check `continue`s before anything can record a failure, and a client
    // that got a run row never reaches the locked branch. So these three
    // partition the client list and cannot imply a negative.
    clients_synced: clients.length - failedClients.size - lockedClients.length,
    clients_failed: failedClients.size,
    // Separate from clients_failed so the monitor can say "skipped" rather
    // than "FAILED". Nothing is missing when this is non-zero -- the sibling
    // run that holds the locks is doing the work.
    clients_locked: lockedClients.length,
    locked_clients: lockedClients,
    // Deliberately NOT folded into clients_failed. A client with one lost
    // shipment assignment did sync, and calling it a failed client would
    // misreport the other orders it mapped correctly; the two counts answer
    // different questions and the monitor reports them separately.
    items_failed: totalItemsFailed,
    item_failures: itemFailures,
    mapped: totalMapped,
    updated: totalUpdated,
    skipped: totalSkipped,
    undated_picks: totalUndatedPicks,
    errors: clientErrors,
  }
}
