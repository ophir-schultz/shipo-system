// Resolving which zone a shipment fell in, and what the client agreed to pay
// for that zone/weight cell.
//
// Both functions used to be written as `const { data } = await supabaseAdmin...`
// and to answer `null` on anything other than a hit. That made one `null` carry
// two opposite meanings:
//
//   - "the chart/matrix has no row for this lane"  -- a finding about the rate
//     card, and the correct trigger for the legacy fallback; and
//   - "the query failed"                           -- no answer at all.
//
// The two must not share a return value here, because of what the CALLERS do
// with it. A null zone rate falls through to the legacy carrier/service rate
// card (recalculate.ts step 2, calculator.ts step 2), which is a DIFFERENT
// agreed price. So a one-second database hiccup did not produce "no price" --
// the safe, visible failure -- it produced the WRONG price, written to
// `shipments.client_rate` by an unattended monitor run, formatted to two
// decimal places, indistinguishable from a correct one. That is the outcome
// this branch exists to remove: a figure nobody can tell is wrong.
//
// So each function now returns the value and the reason side by side, following
// the same convention as `src/lib/db/read.ts`: a non-null `error` means the
// value field means NOTHING, and the caller must refuse rather than fall back.
//
// Note on PGRST116. `supabase/zone_rates.sql` declares a unique constraint over
// exactly the lookup keys of both tables, which would make ".maybeSingle()
// matched several rows" impossible. That file has never been executed from this
// repo -- there is no psql, pg_ctl or docker on the machine it is maintained on
// -- so it is committed text, not a guarantee about the live database. Several
// matching rows therefore reaches the `error` branch below and is treated as
// UNREADABLE rather than absent: two disagreeing cells for one lane is exactly
// the case where picking one, or silently repricing off another card, invents a
// number.

import { supabaseAdmin } from '@/lib/supabase'
import { priceOf } from '@/lib/billing/unpriced'

const MAX_WEIGHT_LB = 20 // matrix tops out at 20 LB

/** The lowest and highest zone the chart is allowed to name. */
const MIN_ZONE = 1
const MAX_ZONE = 8

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

/** A resolved zone, the reason there is none, or neither: no source named one. */
export interface ZoneLookup {
  /** 1..8, or null. Means nothing at all when `error` is set. */
  zone: number | null
  /**
   * null = we got an answer, which may legitimately be "no chart row for this
   * lane". Non-null = we did not, so the caller must not fall back.
   */
  error: string | null
}

/** A matrix cell, the reason it could not be read, or neither: no such cell. */
export interface ZoneRateLookup {
  /**
   * The agreed rate. 0 is a real answer -- a lane somebody priced at nothing on
   * purpose -- so callers must test `!= null` and not truthiness.
   */
  rate: number | null
  /** null = we got an answer. Non-null = `rate` means nothing. */
  error: string | null
}

/**
 * Resolve the delivery zone (1..8) for a shipment, trying every available source:
 *   1. A zone already present in the ShipStation raw payload (raw_data.zone / shipTo.zone)
 *   2. A ZIP-prefix lookup in the zone_chart table (origin prefix -> dest prefix)
 *
 * `{ zone: null, error: null }` means no source could name one, which is a
 * finding: rate matching is then skipped or flagged. A non-null `error` means
 * the chart was not read, which is not a finding about anything.
 */
export async function resolveZone(
  shipment: { recipient_zip?: string | null; raw_data?: unknown; zone?: number | null },
  originZip?: string | null
): Promise<ZoneLookup> {
  // 0. Already resolved
  if (shipment.zone && shipment.zone >= MIN_ZONE && shipment.zone <= MAX_ZONE) {
    return { zone: shipment.zone, error: null }
  }

  // 1. From ShipStation raw payload, if the carrier returned one.
  //
  // No read happens here, so nothing can fail: an unusable candidate is simply
  // not a candidate, and the chart below is still tried.
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
      if (Number.isFinite(n) && n >= MIN_ZONE && n <= MAX_ZONE) {
        return { zone: n, error: null }
      }
    }
  }

  // 2. ZIP-prefix zone chart
  if (originZip && shipment.recipient_zip) {
    const originPrefix = String(originZip).replace(/\D/g, '').slice(0, 3)
    const destPrefix = String(shipment.recipient_zip).replace(/\D/g, '').slice(0, 3)
    if (originPrefix.length === 3 && destPrefix.length === 3) {
      const { data, error } = await supabaseAdmin
        .from('zone_chart')
        .select('zone')
        .eq('origin_prefix', originPrefix)
        .eq('dest_prefix', destPrefix)
        .maybeSingle()

      // Reported, where it used to be dropped. The lane is named because the
      // caller loops over every shipment in the table, and "could not read the
      // zone chart" for one lane is a different operational problem from the
      // same message for all of them.
      if (error) {
        return {
          zone: null,
          error: `could not read the zone chart for ${originPrefix}->${destPrefix}: `
            + error.message,
        }
      }

      if (data?.zone != null) {
        // A chart row exists but names something outside 1..8. The old code let
        // this fall through to `return null`, i.e. reported it as "this lane has
        // no zone" -- so a corrupt chart row silently became the legacy rate
        // card. A row we cannot use is not the absence of a row.
        if (data.zone < MIN_ZONE || data.zone > MAX_ZONE) {
          return {
            zone: null,
            error: `the zone chart gives zone ${data.zone} for `
              + `${originPrefix}->${destPrefix}, outside ${MIN_ZONE}..${MAX_ZONE}`,
          }
        }
        return { zone: data.zone, error: null }
      }
    }
  }

  return { zone: null, error: null }
}

/**
 * Look up the client's zone-matrix rate for a given weight/zone.
 *
 * Prefers an exact carrier/service match, then falls back to the blanket rate
 * card (carrier='', service=''). `{ rate: null, error: null }` means no matrix
 * cell matched either; a non-null `error` means one of the two reads did not
 * answer, and the caller must not price the shipment off another card.
 */
export async function resolveZoneRate(
  clientId: string,
  carrier: string,
  service: string,
  weightOz: number,
  zone: number
): Promise<ZoneRateLookup> {
  const weightLb = weightToLb(weightOz)

  // Try specific carrier/service first, then blanket card
  const attempts: Array<{ carrier: string; service: string }> = [
    { carrier, service },
    { carrier: '', service: '' },
  ]

  for (const a of attempts) {
    const { data, error } = await supabaseAdmin
      .from('client_zone_rates')
      .select('rate')
      .eq('client_id', clientId)
      .eq('carrier', a.carrier)
      .eq('service', a.service)
      .eq('weight_lb', weightLb)
      .eq('zone', zone)
      .maybeSingle()

    // Returned immediately rather than continuing to the next attempt. The
    // attempts are ORDERED BY PRECEDENCE: a specific carrier/service cell
    // overrides the blanket card. If the specific read failed we do not know
    // whether such a cell exists, so answering with the blanket rate would bill
    // a price the client did not agree for this carrier -- the same
    // wrong-price-rather-than-no-price failure as falling through to the legacy
    // card.
    if (error) {
      const which = a.carrier === '' && a.service === ''
        ? 'blanket rate card'
        : `${a.carrier || '(any)'}/${a.service || '(any)'}`
      return {
        rate: null,
        error: `could not read the zone matrix (${which}, ${weightLb} LB, `
          + `zone ${zone}): ${error.message}`,
      }
    }

    if (data?.rate != null) {
      // `numeric(10,2)` arrives over PostgREST as a quoted string, so the cell
      // goes through priceOf rather than `Number()`. priceOf answers null for
      // anything that is not a finite amount, and that case is reported as
      // UNREADABLE and not as a miss: the cell exists, it just does not hold a
      // number, and calling that "no agreed rate" would reprice the shipment off
      // a different card.
      const rate = priceOf(data.rate)
      if (rate === null) {
        return {
          rate: null,
          error: `the zone matrix cell for ${weightLb} LB / zone ${zone} holds `
            + `${JSON.stringify(data.rate)}, which is not a readable amount`,
        }
      }
      return { rate, error: null }
    }
  }

  return { rate: null, error: null }
}
