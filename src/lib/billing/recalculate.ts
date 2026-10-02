import { supabaseAdmin } from '@/lib/supabase'
import { resolveZone, resolveZoneRate } from '@/lib/billing/zones'
import { calcDimWeightOz, calcBilledWeightOz } from '@/lib/billing/dim-weight'
import { matchLegacyRate, shipmentProfit, type ShippingRateRow } from '@/lib/billing/shipment-rate'

// Repricing every shipment that has a client assigned.
//
// This lives here rather than inside the route handler because the
// monitor agent needs it too. It used to reach it by HTTP-POSTing its
// own /api/sync/recalculate URL with no credentials, which is why that
// route could not be given an auth guard. Calling the function
// directly removes both the open endpoint and the dependency on
// NEXT_PUBLIC_SITE_URL being set correctly.
//
// It runs UNATTENDED, from api/agent/monitor, over every shipment in the
// table. What it used to write when it could not find a rate was
// `client_rate: 0` -- with `profit_loss: 0 - actual_cost` and
// `is_loss: true`. It counted those in `unmatched` and returned the count,
// but the row itself carried a clean, billable zero, and fifteen surfaces
// render `client_rate ?? 0` as $0.00. The count went into a log; the zero went
// into the invoice.
//
// Unknown is now written as NULL, which the column has always allowed. Three
// things had to change with it, and all three are in the same commit as this
// comment, because any one of them left out puts the silence back:
//
//   - api/agent/monitor detected unpriced shipments with
//     `.eq('client_rate', 0)`. A NULL does not equal 0 in SQL, so writing NULL
//     without touching that scan would have switched off the only existing
//     alarm for this exact condition.
//   - a failed rate-card read used to become an empty card, i.e. "no rate
//     agreed", i.e. a stored zero. A read that fails now skips the shipment
//     and leaves the previous value alone: "could not read the card" is not
//     "the card is empty".
//   - the per-row update's error was discarded and `updated` incremented
//     anyway, so the function reported work it had not done.
//
// The zone reads were the last hole of the same shape, and they were the worst
// one: a failed zone-chart or zone-matrix read answered `null`, which is this
// file's signal to reprice off the legacy card, so the row was written with a
// real-looking price from the WRONG card rather than left alone. They are now
// skipped and counted like any other unreadable input.

export interface RecalculateStats {
  updated: number
  zone_matched: number
  legacy_matched: number
  unmatched: number
  /** Rows deliberately not written, because the inputs could not be read. */
  skipped: number
  /** Rows whose write was attempted and failed. */
  failed: number
  /**
   * Why, counted by reason, with an example shipment for each. The point of
   * the fix is that an unpriced shipment says what is missing from the rate
   * card; a bare total would be the old `unmatched` count wearing a new name.
   */
  reasons: Array<{ reason: string; count: number; example: string }>
}

type ClientData =
  | { ok: true; originZip: string | null; rates: ShippingRateRow[] }
  | { ok: false; error: string }

export async function recalculateShipments(): Promise<RecalculateStats> {
  const { data: shipments, error } = await supabaseAdmin
    .from('shipments')
    .select('id, order_number, client_id, actual_cost, weight, length, width, height, carrier, service, recipient_zip, zone, raw_data')
    .not('client_id', 'is', null)

  if (error) throw new Error(error.message)

  // Cache: client_id → origin zip + rate card  (avoid N+1 per client)
  const clientCache: Record<string, ClientData> = {}

  async function getClientData(clientId: string): Promise<ClientData> {
    if (clientCache[clientId]) return clientCache[clientId]
    const [clientRes, ratesRes] = await Promise.all([
      supabaseAdmin.from('clients').select('origin_zip').eq('id', clientId).maybeSingle(),
      supabaseAdmin.from('client_shipping_rates')
        .select('rate, weight_min, weight_max, carrier, service').eq('client_id', clientId),
    ])
    // The rate card's read error is fatal for this client, and the origin
    // zip's is not: a missing zip only costs the zone lookup, which already
    // reports no zone, whereas a card read that failed is indistinguishable
    // from a client who has agreed no prices -- and that difference is the
    // difference between skipping a row and zeroing it.
    if (ratesRes.error) {
      clientCache[clientId] = {
        ok: false,
        error: `could not read the shipping rate card: ${ratesRes.error.message}`,
      }
      return clientCache[clientId]
    }
    clientCache[clientId] = {
      ok: true,
      originZip: clientRes.data?.origin_zip ?? null,
      rates: (ratesRes.data ?? []) as ShippingRateRow[],
    }
    return clientCache[clientId]
  }

  let updated = 0
  let zoneMatched = 0
  let legacyMatched = 0
  let unmatched = 0
  let skipped = 0
  let failed = 0
  const reasons = new Map<string, { count: number; example: string }>()

  const note = (reason: string, shipment: string) => {
    const seen = reasons.get(reason)
    if (seen) seen.count++
    else reasons.set(reason, { count: 1, example: shipment })
  }

  for (const s of shipments ?? []) {
    const label = s.order_number ?? s.id
    const weightOz = s.weight ?? 0
    const l = s.length ?? 0
    const w = s.width ?? 0
    const h = s.height ?? 0

    // Billed weight (actual vs dim, whichever is higher). Service matters:
    // UPS air applies DIM to every parcel, ground only above 1 cubic foot.
    const dimWeightOz = calcDimWeightOz(l, w, h, s.carrier, s.service)
    const billedWeightOz = calcBilledWeightOz(weightOz, dimWeightOz)

    const client = await getClientData(s.client_id)
    if (!client.ok) {
      // Nothing written. The row keeps whatever it had, which may be a correct
      // price from the last run -- overwriting it with a zero on the strength
      // of a failed read destroys a good number and leaves no trace.
      skipped++
      note(client.error, label)
      continue
    }

    let clientRate: number | null = null
    let resolvedZone: number | null = null
    let rateSource: 'zone' | 'legacy' | 'none' = 'none'

    // ── 1. Zone matrix rate (weight × zone) ──────────────────────────────────
    //
    // Both zone reads are now fatal FOR THIS ROW, and the row is skipped rather
    // than repriced. The reason is the fallback directly below: a null zone or
    // a null zone rate sends the shipment to the legacy carrier/service card,
    // which is a different agreed price. So a failed zone read used to produce
    // the WRONG price and write it -- not "no price", which would have been
    // visible. Skipping leaves whatever the last good run stored and names the
    // reason in `reasons`, which the monitor emails.
    const zone = await resolveZone(
      { recipient_zip: s.recipient_zip, raw_data: s.raw_data, zone: s.zone },
      client.originZip
    )
    if (zone.error) {
      skipped++
      note(zone.error, label)
      continue
    }

    if (zone.zone != null) {
      resolvedZone = zone.zone
      const zoneRate = await resolveZoneRate(
        s.client_id, s.carrier ?? '', s.service ?? '', billedWeightOz, zone.zone)
      if (zoneRate.error) {
        skipped++
        note(zoneRate.error, label)
        continue
      }
      // `!= null` rather than a truthiness test, so a zone cell holding 0 is
      // taken as the agreed price of 0 instead of falling through to the
      // legacy card and being billed at some other number.
      if (zoneRate.rate != null) {
        clientRate = zoneRate.rate
        rateSource = 'zone'
        zoneMatched++
      }
    }

    // ── 2. Legacy carrier/service/weight-range rate card ─────────────────────
    if (rateSource === 'none') {
      const priced = matchLegacyRate(client.rates, s.carrier, s.service, billedWeightOz)
      if (priced.rate !== null) {
        clientRate = priced.rate
        rateSource = 'legacy'
        legacyMatched++
      } else {
        unmatched++
        note(priced.reason ?? 'no rate could be matched', label)
      }
    }

    const { profitLoss, isLoss, reason: profitReason } =
      shipmentProfit(clientRate, s.actual_cost)
    // Only worth reporting when the rate itself was fine; otherwise it just
    // restates the line above in different words.
    if (clientRate !== null && profitReason) note(profitReason, label)

    const { error: updateError } = await supabaseAdmin
      .from('shipments')
      .update({
        dim_weight: dimWeightOz,
        billed_weight: Number.isFinite(billedWeightOz)
          ? parseFloat(billedWeightOz.toFixed(2)) : null,
        client_rate: clientRate,
        profit_loss: profitLoss,
        is_loss: isLoss,
        ...(resolvedZone != null ? { zone: resolvedZone } : {}),
      })
      .eq('id', s.id)

    // Counted as failed, not as updated. The old code incremented `updated`
    // unconditionally, so the stats this function returns -- which the monitor
    // emails -- reported writes that had not happened.
    if (updateError) {
      failed++
      note(`could not write the repriced shipment: ${updateError.message}`, label)
      continue
    }

    updated++
  }

  return {
    updated,
    zone_matched: zoneMatched,
    legacy_matched: legacyMatched,
    unmatched,
    skipped,
    failed,
    reasons: [...reasons.entries()]
      .map(([reason, v]) => ({ reason, count: v.count, example: v.example }))
      .sort((a, b) => b.count - a.count),
  }
}
