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
import { billedWeightOf, cardRowCovers } from '@/lib/billing/shipment-rate'

/** The lowest and highest zone the chart is allowed to name. */
const MIN_ZONE = 1
const MAX_ZONE = 8

/**
 * Convert a weight in ounces to the matrix row (whole pounds, rounded UP), or
 * null when no row can be named for it.
 *
 * 17 oz -> 2 LB. There is NO upper cap, and the absence of one is the point of
 * the paragraph below.
 *
 * THERE USED TO BE A CAP: `const MAX_WEIGHT_LB = 20 // matrix tops out at 20
 * LB`, with `if (lb > MAX_WEIGHT_LB) return MAX_WEIGHT_LB`. Both halves of its
 * justification were measured false on 2026-10-05.
 *
 *   1. The matrix does not top out at 20. client_zone_rates holds rows to
 *      100 LB for Orcam and to 27 LB for Crisp Power. 640 of Orcam's 800 cells
 *      were unreachable through this function, so a 25 LB parcel was billed the
 *      20 LB cell while the 25 LB cell its contract names sat in the table
 *      unread -- an under-bill, in the client's favour, invisible because the
 *      number produced is a real agreed rate for a real row.
 *   2. "Without the cap this would ask for a row that cannot exist, miss, and
 *      reprice off the legacy card" -- the old test comment. A miss does not
 *      reprice wrongly. resolveZoneRate answers a miss as
 *      `{ rate: null, error: null }`, the caller falls through to
 *      matchLegacyRate, and that function REFUSES a weight outside every band
 *      with the bands named in the reason (shipment-rate.ts: "The heaviest band
 *      is NOT used as a fallback"). So the uncapped failure is an unpriced
 *      shipment with an explanation, which is the fact.
 *
 * Capping was therefore the one thing the legacy path was fixed to stop doing:
 * billing the heaviest row to a parcel that is heavier than it, off a ceiling
 * hardcoded at 20 that matches neither card in the database.
 *
 * It used to be `Math.ceil((weightOz || 0) / 16)` with `if (lb < 1) return 1`,
 * which sent an absent, zero or NaN weight to row 1 -- the CHEAPEST row of the
 * matrix. So an unweighed shipment was not reported as unpriceable; it was
 * quietly billed the 1 LB rate, which is a real price, correct for a real
 * parcel, and impossible to tell apart from one afterwards. `|| 0` and the
 * `< 1` floor were each individually reasonable and together they turned
 * missing data into the lowest invoice line the card allows.
 *
 * The same judgement as matchLegacyRate's, imported rather than re-stated: two
 * copies of "which weights may be priced from" would drift, and they would
 * drift between the two cards a shipment can be priced off.
 */
export function weightToLb(weightOz: unknown): number | null {
  const oz = billedWeightOf(weightOz)
  if (oz === null) return null
  return Math.ceil(oz / 16)
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

/** One row of the zone matrix, as the lookup needs to see it. */
export interface ZoneRateCell {
  /** Admits string because numeric(10,2) arrives over PostgREST quoted. */
  rate: number | string | null
  /** Empty or null means "any", which is how the blanket card is written. */
  carrier?: string | null
  service?: string | null
}

/**
 * Choose the cell that applies, as a pure function.
 *
 * Split out of resolveZoneRate so the DECISION can be tested without a
 * database -- the same reason shipment-rate.ts is pure. There is no test
 * database here and the live one holds the figures the business invoices from.
 *
 * Carrier/service matching is cardRowCovers, i.e. EXACTLY what the legacy rate
 * card uses, and that is the point of this function existing. Until 2026-10-13
 * this lookup compared with `.eq()` while the legacy path it falls back to used
 * case-insensitive bidirectional substring. A client whose matrix was keyed on
 * display names ('UPS', 'Ground') could not be matched by shipments carrying
 * ShipStation's codes ('UPS_WALLET', 'ups_ground_saver'), so an 800-cell matrix
 * was unreachable and 46 shipments were written UNPRICED. The stricter rule ran
 * first and shadowed the looser one behind it.
 *
 * @param where  the lane, e.g. "1 LB / zone 3", for the messages only.
 */
export function pickZoneCell(
  cells: ZoneRateCell[],
  carrier: string,
  service: string,
  where: string,
): ZoneRateLookup {
  const c = carrier.toLowerCase()
  const s = service.toLowerCase()
  const isBlanket = (cell: ZoneRateCell) => !(cell.carrier ?? '') && !(cell.service ?? '')

  // Two TIERS, not one pool, and the tiers are what keep the ambiguity check
  // below honest. A blanket row covers every carrier by definition, so a single
  // pool would find a blanket cell covering alongside every specific cell and
  // call a perfectly well-specified matrix ambiguous. Precedence is unchanged
  // from the `.eq()` version: a specific cell overrides the blanket card.
  const specific = cells.filter((cell) => !isBlanket(cell) && cardRowCovers(cell, c, s))
  const chosen = specific.length > 0 ? specific : cells.filter(isBlanket)

  // A genuine miss. Distinct from a failed read, which never reaches here.
  if (chosen.length === 0) return { rate: null, error: null }

  // Coerced BEFORE the ambiguity check and compared as numbers. numeric(10,2)
  // can arrive as 9.5 from one row and '9.50' from another; on strings those
  // are two different rates and the shipment would be refused as ambiguous
  // when the matrix in fact agrees with itself.
  const parsed = chosen.map((cell) => priceOf(cell.rate))

  const badIndex = parsed.findIndex((n) => n === null)
  if (badIndex !== -1) {
    // The cell EXISTS, it just does not hold a number. Calling that "no agreed
    // rate" sends the shipment to a different card at a real-looking price.
    return {
      rate: null,
      error: `the zone matrix cell for ${where} holds `
        + `${JSON.stringify(chosen[badIndex].rate)}, which is not a readable amount`,
    }
  }

  const distinct = new Set(parsed as number[])

  // Substring matching can cover more than one cell, which `.eq()` could not
  // express and `.maybeSingle()` could not represent. Picking one by row order
  // would bill a real amount from an arbitrary agreement -- the same failure
  // matchLegacyRate refuses on the legacy card.
  if (distinct.size > 1) {
    return {
      rate: null,
      error: `${chosen.length} zone matrix cells cover ${where} for carrier `
        + `'${carrier}' service '${service}' with different rates `
        + `(${[...distinct].join(', ')}), so which one applies is ambiguous. `
        + `Narrow the overlapping rows.`,
    }
  }

  // 0 is returned as 0: a lane somebody priced at nothing on purpose.
  return { rate: parsed[0] as number, error: null }
}

/**
 * Look up the client's zone-matrix rate for a given weight/zone.
 *
 * Prefers a covering carrier/service cell, then falls back to the blanket rate
 * card (carrier='', service=''). `{ rate: null, error: null }` means no matrix
 * cell matched either; a non-null `error` means the read did not answer, and
 * the caller must not price the shipment off another card.
 */
export async function resolveZoneRate(
  clientId: string,
  carrier: string,
  service: string,
  weightOz: number,
  zone: number
): Promise<ZoneRateLookup> {
  const weightLb = weightToLb(weightOz)

  // A miss, and NOT an `error`, for a weight no row can be named from.
  //
  // The distinction is deliberate and it is about what the callers do with each.
  // An `error` means "ask again later", and recalculate.ts answers it by
  // skipping the row and leaving the price it already had -- right for a dropped
  // connection, wrong here, because a shipment with no recorded weight will
  // still have no recorded weight on the next run and would keep a stale price
  // forever with nothing on screen about it. A miss falls through to the legacy
  // card, whose matchLegacyRate guard refuses the same weight FIRST -- before
  // its "this client has no card" branch -- so the shipment is written as
  // UNPRICED with the weight named as the reason. Which is the fact.
  if (weightLb === null) return { rate: null, error: null }

  const where = `${weightLb} LB / zone ${zone}`

  // ONE read for the lane, with carrier/service decided in pickZoneCell.
  //
  // It used to be two reads -- the specific carrier/service, then the blanket
  // card -- because `.eq()` can only ask about one spelling at a time.
  // Substring matching cannot be expressed in PostgREST at all, so the rows for
  // this lane are fetched and the choice is made here.
  //
  // That also retires a whole failure mode rather than defending against it.
  // With two reads, the specific one could fail while the blanket one succeeded,
  // and answering with the blanket rate would have billed a price the client
  // never agreed for THIS carrier. There was a guard for that. With one read
  // there is no such state: either the lane was read or it was not.
  const { data, error } = await supabaseAdmin
    .from('client_zone_rates')
    .select('rate, carrier, service')
    .eq('client_id', clientId)
    .eq('weight_lb', weightLb)
    .eq('zone', zone)

  if (error) {
    return {
      rate: null,
      error: `could not read the zone matrix (${where}): ${error.message}`,
    }
  }

  return pickZoneCell((data ?? []) as ZoneRateCell[], carrier, service, where)
}
