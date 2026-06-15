import { supabaseAdmin } from '@/lib/supabase'
import { getShipments } from '@/lib/api/shipstation'

export async function syncShipments(daysBack = 30) {
  const dateFrom = new Date()
  dateFrom.setDate(dateFrom.getDate() - daysBack)
  const dateStr = dateFrom.toISOString().split('T')[0]

  let page = 1
  let hasMore = true
  const results = { created: 0, updated: 0, adjustments: 0, errors: 0 }

  while (hasMore) {
    const data = await getShipments({
      shipDateStart: dateStr,
      page,
      pageSize: 100,
      carrierCode: 'stamps_com',
    })

    const shipments = data.shipments ?? []
    if (shipments.length === 0 || page >= (data.pages ?? 1)) hasMore = false

    for (const s of shipments) {
      try {
        // Try to match client by ShipStation store/tag — for now match by order source
        const { data: existingShipment } = await supabaseAdmin
          .from('shipments')
          .select('id, actual_cost, client_id')
          .eq('order_number', String(s.orderNumber))
          .single()

        // Dimensions from ShipStation
        const dims = s.dimensions ?? {}
        const lengthIn = dims.length ?? 0
        const widthIn = dims.width ?? 0
        const heightIn = dims.height ?? 0

        // Weight — normalize to ounces
        const weightRaw = s.weight?.value ?? 0
        const weightUnit = s.weight?.units ?? 'ounces'
        const weightOz = weightUnit === 'pounds' ? weightRaw * 16 : weightRaw

        // Dimensional weight: (L × W × H) / 166 → lbs → oz (USPS DIM divisor)
        const dimWeightOz = (lengthIn > 0 && widthIn > 0 && heightIn > 0)
          ? parseFloat(((lengthIn * widthIn * heightIn) / 166 * 16).toFixed(2))
          : null

        // Billed weight = higher of actual vs dimensional
        const billedWeightOz = dimWeightOz ? Math.max(weightOz, dimWeightOz) : weightOz

        const shipmentData = {
          order_number: String(s.orderNumber),
          order_date: s.orderDate,
          ship_date: s.shipDate,
          carrier: s.carrierCode?.toUpperCase() ?? '',
          service: s.serviceCode ?? '',
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
          actual_cost: parseFloat(s.shipmentCost ?? 0),
          source: 'stamps',
          raw_data: s,
        }

        if (existingShipment) {
          // Check for rate adjustment — cost changed after the fact
          const prevCost = parseFloat(existingShipment.actual_cost ?? 0)
          const newCost = parseFloat(s.shipmentCost ?? 0)
          const diff = parseFloat((newCost - prevCost).toFixed(2))

          if (diff > 0.01 && existingShipment.client_id) {
            // Rate adjustment detected
            const { data: existingAdj } = await supabaseAdmin
              .from('rate_adjustments')
              .select('id')
              .eq('order_number', String(s.orderNumber))
              .eq('adjustment_amount', diff)
              .single()

            if (!existingAdj) {
              await supabaseAdmin.from('rate_adjustments').insert({
                shipment_id: existingShipment.id,
                client_id: existingShipment.client_id,
                order_number: String(s.orderNumber),
                original_cost: prevCost,
                adjusted_cost: newCost,
                adjustment_amount: diff,
                reason: 'Carrier rate adjustment',
                adjustment_date: new Date().toISOString(),
                status: 'pending',
              })
              results.adjustments++
            }
          }

          // Update shipment cost
          await supabaseAdmin
            .from('shipments')
            .update({ ...shipmentData, actual_cost: newCost })
            .eq('id', existingShipment.id)
          results.updated++
        } else {
          await supabaseAdmin.from('shipments').insert(shipmentData)
          results.created++
        }
      } catch {
        results.errors++
      }
    }

    page++
  }

  return results
}

export async function syncAdjustments() {
  // Pull shipments from last 30 days and check for cost changes
  return syncShipments(30)
}
