import { supabaseAdmin } from '@/lib/supabase'
import { getCustomerOrders } from '@/lib/api/zenventory'
import { normaliseLines, NegativeQuantityError } from '@/lib/ledger/order-line'
import { watermarkPickDate } from '@/lib/ledger/pick-date'
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
  const clientErrors: string[] = []

  for (const client of clients) {
    // Each client gets its own sync_runs row so a 401 on one client is
    // recordable without condemning or absolving the whole run. Two clients
    // (Nayax and Creative Pea) currently return 401 while their Zenventory 2.0
    // credentials are being restored; their rows will resolve to 'failed' while
    // the other clients' rows resolve to 'ok'.
    const run = await openSyncRun({
      source: 'zenventory',
      clientId: client.id,
      mode: 'live',
      windowStart: modifiedFromISO.split('T')[0],
      windowEnd: new Date().toISOString().split('T')[0],
    })

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

            if (line.picked && !pickDate) {
              pickDate = watermarkPickDate(new Date())
              pickSource = 'watermark'
            }
            if (!line.picked && pickDate) {
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

    await run.close()
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
    errors: clientErrors,
  }
}
