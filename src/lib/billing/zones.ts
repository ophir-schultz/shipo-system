import { supabaseAdmin } from '@/lib/supabase'

const MAX_WEIGHT_LB = 20 // matrix tops out at 20 LB

/**
 * Convert a weight in ounces to the matrix row (whole pounds, rounded UP).
 * 17 oz -> 2 LB. Anything above the chart max is capped to the top row.
 */
export function weightToLb(weightOz: number): number {
  const lb = Math.ceil((weightOz || 0) / 16)
  if (lb < 1) return 1
  if (lb > MAX_WEIGHT_LB) return MAX_WEIGHT_LB
  return lb
}

/**
 * Resolve the delivery zone (1..8) for a shipment, trying every available source:
 *   1. A zone already present in the ShipStation raw payload (raw_data.zone / shipTo.zone)
 *   2. A ZIP-prefix lookup in the zone_chart table (origin prefix -> dest prefix)
 * Returns null when no source can determine it (rate matching is then skipped/flagged).
 */
export async function resolveZone(
  shipment: { recipient_zip?: string | null; raw_data?: unknown; zone?: number | null },
  originZip?: string | null
): Promise<number | null> {
  // 0. Already resolved
  if (shipment.zone && shipment.zone >= 1 && shipment.zone <= 8) return shipment.zone

  // 1. From ShipStation raw payload, if the carrier returned one
  const raw = shipment.raw_data as Record<string, unknown> | undefined
  if (raw) {
    const candidates = [
      (raw as any).zone,
      (raw as any).shippingZone,
      (raw as any).advancedOptions?.zone,
      (raw as any).shipTo?.zone,
    ]
    for (const c of candidates) {
      const n = Number(c)
      if (Number.isFinite(n) && n >= 1 && n <= 8) return n
    }
  }

  // 2. ZIP-prefix zone chart
  if (originZip && shipment.recipient_zip) {
    const originPrefix = String(originZip).replace(/\D/g, '').slice(0, 3)
    const destPrefix = String(shipment.recipient_zip).replace(/\D/g, '').slice(0, 3)
    if (originPrefix.length === 3 && destPrefix.length === 3) {
      const { data } = await supabaseAdmin
        .from('zone_chart')
        .select('zone')
        .eq('origin_prefix', originPrefix)
        .eq('dest_prefix', destPrefix)
        .maybeSingle()
      if (data?.zone && data.zone >= 1 && data.zone <= 8) return data.zone
    }
  }

  return null
}

/**
 * Look up the client's zone-matrix rate for a given weight/zone.
 * Prefers an exact carrier/service match, then falls back to the blanket
 * rate card (carrier='' , service=''). Returns null if no matrix cell matches.
 */
export async function resolveZoneRate(
  clientId: string,
  carrier: string,
  service: string,
  weightOz: number,
  zone: number
): Promise<number | null> {
  const weightLb = weightToLb(weightOz)

  // Try specific carrier/service first, then blanket card
  const attempts: Array<{ carrier: string; service: string }> = [
    { carrier, service },
    { carrier: '', service: '' },
  ]

  for (const a of attempts) {
    const { data } = await supabaseAdmin
      .from('client_zone_rates')
      .select('rate')
      .eq('client_id', clientId)
      .eq('carrier', a.carrier)
      .eq('service', a.service)
      .eq('weight_lb', weightLb)
      .eq('zone', zone)
      .maybeSingle()
    if (data?.rate != null) return Number(data.rate)
  }

  return null
}
