import { supabaseAdmin } from '@/lib/supabase'
import { resolveZone, resolveZoneRate } from '@/lib/billing/zones'
import { calcDimWeightOz, calcBilledWeightOz } from '@/lib/billing/dim-weight'

// Repricing every shipment that has a client assigned.
//
// This lives here rather than inside the route handler because the
// monitor agent needs it too. It used to reach it by HTTP-POSTing its
// own /api/sync/recalculate URL with no credentials, which is why that
// route could not be given an auth guard. Calling the function
// directly removes both the open endpoint and the dependency on
// NEXT_PUBLIC_SITE_URL being set correctly.

export interface RecalculateStats {
  updated: number
  zone_matched: number
  legacy_matched: number
  unmatched: number
}

export async function recalculateShipments(): Promise<RecalculateStats> {
  const { data: shipments, error } = await supabaseAdmin
    .from('shipments')
    .select('id, client_id, actual_cost, weight, length, width, height, carrier, service, recipient_zip, zone, raw_data')
    .not('client_id', 'is', null)

  if (error) throw new Error(error.message)

  // Cache: client_id → { originZip, shippingRates }  (avoid N+1 per client)
  /* eslint-disable @typescript-eslint/no-explicit-any */
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

    // Billed weight (actual vs dim, whichever is higher). Service matters:
    // UPS air applies DIM to every parcel, ground only above 1 cubic foot.
    const dimWeightOz = calcDimWeightOz(l, w, h, s.carrier, s.service)
    const billedWeightOz = calcBilledWeightOz(weightOz, dimWeightOz)

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

  return {
    updated,
    zone_matched: zoneMatched,
    legacy_matched: legacyMatched,
    unmatched,
  }
}
