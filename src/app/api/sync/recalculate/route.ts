import { supabaseAdmin } from '@/lib/supabase'
import { NextResponse } from 'next/server'
import { resolveZone, resolveZoneRate, weightToLb } from '@/lib/billing/zones'

const DIM_DIVISOR = 166 // USPS standard

export async function POST() {
  // Pull all shipments that have a client assigned
  const { data: shipments, error } = await supabaseAdmin
    .from('shipments')
    .select('id, client_id, actual_cost, weight, length, width, height, carrier, service, recipient_zip, zone, raw_data')
    .not('client_id', 'is', null)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Cache: client_id → { originZip, shippingRates }  (avoid N+1 per client)
  const clientCache: Record<string, { originZip: string | null; rates: any[] }> = {}

  async function getClientData(clientId: string) {
    if (clientCache[clientId]) return clientCache[clientId]
    const [clientRes, ratesRes] = await Promise.all([
      supabaseAdmin.from('clients').select('origin_zip').eq('id', clientId).single(),
      supabaseAdmin.from('client_shipping_rates').select('rate, weight_min, weight_max, carrier, service').eq('client_id', clientId),
    ])
    clientCache[clientId] = {
      originZip: clientRes.data?.origin_zip ?? null,
      rates: ratesRes.data ?? [],
    }
    return clientCache[clientId]
  }

  let updated = 0
  let zoneMatched = 0
  let legacyMatched = 0
  let unmatched = 0

  for (const s of shipments ?? []) {
    const weightOz = s.weight ?? 0
    const l = s.length ?? 0
    const w = s.width ?? 0
    const h = s.height ?? 0

    // Billed weight (actual vs dim, whichever is higher)
    const dimWeightOz = (l > 0 && w > 0 && h > 0)
      ? parseFloat(((l * w * h) / DIM_DIVISOR * 16).toFixed(2))
      : null
    const billedWeightOz = dimWeightOz ? Math.max(weightOz, dimWeightOz) : weightOz

    const { originZip, rates } = await getClientData(s.client_id)

    let clientRate = 0
    let resolvedZone: number | null = null
    let rateSource: 'zone' | 'legacy' | 'none' = 'none'

    // ── 1. Zone matrix rate (weight × zone) ──────────────────────────────────
    const zone = await resolveZone(
      { recipient_zip: s.recipient_zip, raw_data: s.raw_data, zone: s.zone },
      originZip
    )

    if (zone != null) {
      resolvedZone = zone
      const zoneRate = await resolveZoneRate(s.client_id, s.carrier ?? '', s.service ?? '', billedWeightOz, zone)
      if (zoneRate != null) {
        clientRate = zoneRate
        rateSource = 'zone'
        zoneMatched++
      }
    }

    // ── 2. Legacy carrier/service/weight-range rate card ─────────────────────
    if (rateSource === 'none' && rates.length > 0) {
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
        rateSource = 'legacy'
        legacyMatched++
      } else {
        const sorted = [...pool].sort((a, b) => (a.weight_min ?? 0) - (b.weight_min ?? 0))
        const fallback = sorted[sorted.length - 1]?.rate ?? pool[0]?.rate
        if (fallback != null) {
          clientRate = fallback
          rateSource = 'legacy'
          legacyMatched++
        }
      }
    }

    if (rateSource === 'none') unmatched++

    const profitLoss = parseFloat((clientRate - (s.actual_cost ?? 0)).toFixed(2))

    await supabaseAdmin
      .from('shipments')
      .update({
        dim_weight: dimWeightOz,
        billed_weight: parseFloat(billedWeightOz.toFixed(2)),
        client_rate: clientRate,
        profit_loss: profitLoss,
        is_loss: profitLoss < 0,
        ...(resolvedZone != null ? { zone: resolvedZone } : {}),
      })
      .eq('id', s.id)

    updated++
  }

  return NextResponse.json({
    updated,
    zone_matched: zoneMatched,
    legacy_matched: legacyMatched,
    unmatched,
  })
}
