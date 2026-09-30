import { supabaseAdmin } from '@/lib/supabase'
import { getShipments } from '@/lib/api/shipstation'
import { calcDimWeightOz, calcBilledWeightOz } from '@/lib/billing/dim-weight'
import { sourceForCarrier } from '@/lib/ledger/carrier'
import { openSyncRun } from '@/lib/ledger/sync-run'

export async function syncShipments(daysBack = 30) {
  const dateFrom = new Date()
  dateFrom.setDate(dateFrom.getDate() - daysBack)
  const dateStr = dateFrom.toISOString().split('T')[0]

  const run = await openSyncRun({
    source: 'shipstation',
    mode: 'live',
    windowStart: dateStr,
    windowEnd: new Date().toISOString().split('T')[0],
  })

  let page = 1
  let hasMore = true
  const results = {
    created: 0, updated: 0, adjustments: 0, refunds: 0,
    errors: 0, unknownCarrier: 0, blankOrderNumber: 0,
  }

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
        // DEFECT 1, FIXED. The old code matched on order_number with
        // .single() and destructured the error away. .single() returns
        // {data: null, error: PGRST116} when several rows match — it does not
        // throw — so a multi-package order fell through to .insert() and
        // duplicated itself on every run. shipmentId is unique per label.
        const shipmentId = Number(s.shipmentId)
        if (!Number.isFinite(shipmentId)) {
          run.fail('missing shipmentId', { orderNumber: s.orderNumber })
          results.errors++
          continue
        }

        const { data: existingShipment, error: matchError } = await supabaseAdmin
          .from('shipments')
          .select('id, actual_cost, client_id')
          .eq('shipstation_shipment_id', shipmentId)
          .maybeSingle()

        // DEFECT 4, FIXED. The error is inspected, not discarded.
        if (matchError) {
          run.fail(`match shipment ${shipmentId}`, matchError)
          results.errors++
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

        const newCost = parseFloat(String(s.shipmentCost ?? 0))

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
          actual_cost: newCost,
          source,
          raw_data: s,
        }

        if (existingShipment) {
          const prevCost = parseFloat(String(existingShipment.actual_cost ?? 0))
          const diff = parseFloat((newCost - prevCost).toFixed(2))

          // DEFECT 2, FIXED. The old guard was `diff > 0.01`, so only cost
          // INCREASES were recorded. A void or a refund is a decrease and was
          // structurally invisible: we could see money leave and never see it
          // come back.
          if (Math.abs(diff) > 0.01 && existingShipment.client_id) {
            const { data: existingAdj, error: adjError } = await supabaseAdmin
              .from('rate_adjustments')
              .select('id')
              .eq('shipment_id', existingShipment.id)
              .eq('adjustment_amount', diff)
              .maybeSingle()

            if (adjError) {
              run.fail(`adjustment lookup ${shipmentId}`, adjError)
              results.errors++
            } else if (!existingAdj) {
              const { error: insError } = await supabaseAdmin
                .from('rate_adjustments').insert({
                  shipment_id: existingShipment.id,
                  client_id: existingShipment.client_id,
                  order_number: orderNumber,
                  original_cost: prevCost,
                  adjusted_cost: newCost,
                  adjustment_amount: diff,
                  reason: diff > 0 ? 'Carrier rate adjustment' : 'Refund or void',
                  adjustment_date: new Date().toISOString(),
                  status: 'pending',
                })
              if (insError) { run.fail(`adjustment insert ${shipmentId}`, insError); results.errors++ }
              else if (diff > 0) results.adjustments++
              else results.refunds++
            }
          }

          const { error: updError } = await supabaseAdmin
            .from('shipments').update(shipmentData).eq('id', existingShipment.id)
          if (updError) { run.fail(`update ${shipmentId}`, updError); results.errors++ }
          else { results.updated++; run.wrote() }
        } else {
          const { error: insError } = await supabaseAdmin
            .from('shipments').insert(shipmentData)
          if (insError) { run.fail(`insert ${shipmentId}`, insError); results.errors++ }
          else { results.created++; run.wrote() }
        }
      } catch (err) {
        // Still a catch, but it keeps what it caught.
        run.fail(`shipment ${s?.shipmentId ?? 'unknown'}`, err)
        results.errors++
      }
    }

    page++
  }

  await run.close()
  return results
}

export async function syncAdjustments() {
  return syncShipments(30)
}
