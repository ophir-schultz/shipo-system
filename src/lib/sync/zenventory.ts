import { supabaseAdmin } from '@/lib/supabase'
import { getCustomerOrders } from '@/lib/api/zenventory'
import { normaliseLines, NegativeQuantityError } from '@/lib/ledger/order-line'
import { watermarkPickDate, watermarkIsEvidence } from '@/lib/ledger/pick-date'
import { openSyncRun } from '@/lib/ledger/sync-run'

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
  const clientErrors: string[] = []

  for (const client of clients) {
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
      clientErrors.push(`${client.name}: could not open a sync_runs row, so this `
        + `client was not synced (${err?.message ?? String(err)})`)
      continue
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
          clientErrors.push(`${client.name}: ${err.message}`)
          run.fail(`pagination page ${page}`, err)
          hasMore = false
          break
        }

        const orders = data.customerOrders ?? data.orders ?? []
        const meta = data.meta ?? {}

        for (const order of orders) {
          const orderNumber = String(order.orderNumber ?? order.order_number ?? '').trim()
          if (!orderNumber) { run.fail('blank order number', order); continue }
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
              run.fail(`order ${orderNumber}`, orderErr ?? 'no row returned')
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
                run.fail(`item lookup ${orderNumber}:${line.line_ordinal}`, existingErr)
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

              if (itemErr) run.fail(`item ${orderNumber}:${line.line_ordinal}`, itemErr)
              else run.wrote()
            }
          } catch (err) {
            if (err instanceof NegativeQuantityError) {
              run.fail(`order ${orderNumber}: bad quantity`, err)
            } else {
              run.fail(`order ${orderNumber}`, err)
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
          run.fail(`shipment lookup ${orderNumber}`, shipErr)
          continue
        }

        if (!shipment) { totalSkipped++; continue }
        if (shipment.client_id === client.id) { totalSkipped++; continue }

        const { error: assignErr } = await supabaseAdmin
          .from('shipments')
          .update({ client_id: client.id })
          .eq('id', shipment.id)

        if (assignErr) {
          run.fail(`assign shipment ${orderNumber} to ${client.name ?? client.id}`, assignErr)
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
      // error list, so an unrecorded throw would close this row 'ok'.
      run.fail(`zenventory sync for ${client.name ?? client.id}`, err)
      clientErrors.push(`${client.name}: ${err?.message ?? String(err)}`)
    } finally {
      await run.close()
    }
  }

  // WAS: if (clientErrors.length === clients.length) throw ...
  //
  // That reported seven successes and one 401 as a clean run. Two clients
  // return 401 today — Nayax and Creative Pea, both awaiting Zenventory 2.0
  // credentials — so a partial failure is the normal state, not an edge case.
  // Each client's outcome is now its own sync_runs row; the throw only remains
  // for the case where nothing at all worked.
  if (clientErrors.length === clients.length) {
    throw new Error(`Zenventory sync failed for every client:\n${clientErrors.join('\n')}`)
  }

  return {
    clients_synced: clients.length - clientErrors.length,
    clients_failed: clientErrors.length,
    mapped: totalMapped,
    updated: totalUpdated,
    skipped: totalSkipped,
    undated_picks: totalUndatedPicks,
    errors: clientErrors,
  }
}
