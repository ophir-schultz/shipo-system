import { supabaseAdmin } from '@/lib/supabase'
import { NextResponse } from 'next/server'

const DIM_DIVISOR = 166 // USPS standard

export async function POST() {
  // Pull all shipments that have a client assigned
  const { data: shipments, error } = await supabaseAdmin
    .from('shipments')
    .select('id, client_id, actual_cost, weight, length, width, height, carrier, service')
    .not('client_id', 'is', null)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  let updated = 0
  let repriced = 0

  for (const s of shipments ?? []) {
    const weightOz = s.weight ?? 0
    const l = s.length ?? 0
    const w = s.width ?? 0
    const h = s.height ?? 0

    // Calculate dim weight in oz
    const dimWeightOz = (l > 0 && w > 0 && h > 0)
      ? parseFloat(((l * w * h) / DIM_DIVISOR * 16).toFixed(2))
      : null

    const billedWeightOz = dimWeightOz ? Math.max(weightOz, dimWeightOz) : weightOz

    // Look up client rate based on billed weight + carrier/service
    const { data: rates } = await supabaseAdmin
      .from('client_shipping_rates')
      .select('rate, weight_min, weight_max, carrier, service')
      .eq('client_id', s.client_id)

    let clientRate = 0
    if (rates?.length) {
      const carrier = (s.carrier ?? '').toLowerCase()
      const service = (s.service ?? '').toLowerCase()

      const byCarrierService = rates.filter(r =>
        (!r.carrier || carrier.includes(r.carrier.toLowerCase()) || r.carrier.toLowerCase().includes(carrier)) &&
        (!r.service || service.includes(r.service.toLowerCase()) || r.service.toLowerCase().includes(service))
      )
      const pool = byCarrierService.length > 0 ? byCarrierService : rates

      const match = pool.find(r =>
        (r.weight_min == null || billedWeightOz >= r.weight_min) &&
        (r.weight_max == null || billedWeightOz <= r.weight_max)
      )

      if (match) {
        clientRate = match.rate
        repriced++
      } else {
        const sorted = [...pool].sort((a, b) => (a.weight_min ?? 0) - (b.weight_min ?? 0))
        clientRate = sorted[sorted.length - 1]?.rate ?? pool[0]?.rate ?? 0
      }
    }

    const profitLoss = parseFloat((clientRate - (s.actual_cost ?? 0)).toFixed(2))

    await supabaseAdmin
      .from('shipments')
      .update({
        dim_weight: dimWeightOz,
        billed_weight: parseFloat(billedWeightOz.toFixed(2)),
        client_rate: clientRate,
        profit_loss: profitLoss,
        is_loss: profitLoss < 0,
      })
      .eq('id', s.id)

    updated++
  }

  return NextResponse.json({ updated, repriced })
}
