// The unwired billing calculator.
//
// NOTHING IMPORTS THIS FILE, and nothing ever has -- `git log -S` over every
// commit on every branch finds only the two comments that point at it. It is
// kept, and fixed, rather than deleted, because it is the only draft of
// "generate a weekly bill" in the repo and the day it gets wired up is the day
// its defects become money. Fixing it now costs effort on a path that does not
// execute; fixing it later costs a wrong invoice first.
//
// Every defect below is the same one, in four places: 0 used as a stand-in for
// "I could not find out".
//
//   1. `let clientRate = 0`, then `if (clientRate === 0)` as the "not found
//      yet" test, then a returned 0 meaning "no rate". So a zone rate of
//      exactly 0 -- a lane somebody deliberately made free -- was read as a
//      miss and silently repriced off the legacy card, and a final 0 was
//      indistinguishable from a price of nothing.
//   2. `const { data: rate } = await ...` dropped the query error on the
//      floor. A failed read left clientRate at 0, so a database hiccup billed
//      the shipment at nothing and said so to no one.
//   3. The legacy lookup matched the card with `.eq('carrier', ...)` while
//      recalculate.ts matches it with a bidirectional substring. Two rules for
//      choosing which agreed price applies to a shipment, in two files, with
//      nothing keeping them equal. It now calls the same matchLegacyRate both
//      paths use, so there is one rule and it is the tested one.
//   4. generateWeeklyBill discarded FOUR read errors and summed `?? 0`, then
//      INSERTED the result as a draft bill. Four failed reads produced a
//      cleanly-formatted $0.00 bill, stored, with a status of 'draft' and no
//      trace of the failure. It now refuses to insert anything it could not
//      read.
//
// `profit_loss` likewise comes from shipmentProfit rather than
// `clientRate - actualCost`, so a shipment whose carrier invoice has not
// arrived is not reported as pure profit.

import { supabaseAdmin } from '@/lib/supabase'
import { resolveZone, resolveZoneRate } from '@/lib/billing/zones'
import { matchLegacyRate, shipmentProfit } from '@/lib/billing/shipment-rate'
import { priceOf } from '@/lib/billing/unpriced'

export interface ShipmentPricing {
  /**
   * null means UNKNOWN. Never 0 for "not found" -- 0 is a price, and the one
   * figure a billing path must not invent.
   */
  clientRate: number | null
  /** null when the rate or the carrier cost is UNKNOWN. */
  profitLoss: number | null
  /**
   * False whenever profitLoss is null. A shipment of unknown profit is not
   * evidence of a loss, and filling a loss report with unknowns is how a real
   * loss stops being noticed.
   */
  isLoss: boolean
  zone: number | null
  /** null exactly when clientRate is non-null. Says what is missing. */
  reason: string | null
}

export async function calculateShipmentProfitLoss(
  clientId: string,
  carrier: string,
  service: string,
  weight: number,
  actualCost: number,
  shipment?: { recipient_zip?: string | null; raw_data?: unknown; zone?: number | null },
  originZip?: string | null
): Promise<ShipmentPricing> {
  let zone: number | null = null

  // 1. Prefer the zone-based rate matrix when a zone can be resolved.
  //
  // `zoneRate != null` and not `!== 0`: a zone cell holding 0 is a lane
  // somebody priced at nothing on purpose, and it is honoured as that rather
  // than treated as a miss and repriced off a different card.
  //
  // KNOWN GAP, not fixed here: resolveZoneRate discards its own query error,
  // so the null it returns means both "no matrix cell for this lane" and "the
  // query failed". That makes a failed read fall through to the legacy card
  // below, which is the wrong price rather than no price. zones.ts is shared
  // with the scripts/ diagnostics, so changing its return shape is a separate
  // change with its own blast radius -- recorded here and in recalculate.ts
  // rather than silently absorbed.
  if (shipment) {
    zone = await resolveZone(shipment, originZip)
    if (zone != null) {
      const zoneRate = await resolveZoneRate(clientId, carrier, service, weight, zone)
      if (zoneRate != null) {
        const profit = shipmentProfit(zoneRate, actualCost)
        return {
          clientRate: zoneRate,
          profitLoss: profit.profitLoss,
          isLoss: profit.isLoss,
          zone,
          reason: null,
        }
      }
    }
  }

  // 2. Fall back to the legacy carrier/service weight-range rate card.
  //
  // The WHOLE card is read and the matching is done in matchLegacyRate, rather
  // than narrowing it in the query. Two reasons, both about what a miss means:
  // an empty result from a narrowed query cannot tell "this client has agreed
  // no prices at all" from "the card does not cover this carrier", and the
  // narrowed version had `.maybeSingle()` on a filter that can match several
  // overlapping bands -- which is a PGRST116 error, which was then discarded,
  // which billed $0.
  const { data: card, error } = await supabaseAdmin
    .from('client_shipping_rates')
    .select('rate, weight_min, weight_max, carrier, service')
    .eq('client_id', clientId)

  // Surfaced, where it used to be dropped. "Could not read the rate card" is
  // not "the client has no rate card": the first must stop, the second is a
  // finding about the client.
  if (error) {
    return {
      clientRate: null,
      profitLoss: null,
      isLoss: false,
      zone,
      reason: `could not read the shipping rate card: ${error.message}. `
        + `The shipment is NOT priced at 0 -- a failed read says nothing about `
        + `what was agreed.`,
    }
  }

  const matched = matchLegacyRate(card ?? [], carrier, service, weight)
  const profit = shipmentProfit(matched.rate, actualCost)
  return {
    clientRate: matched.rate,
    profitLoss: profit.profitLoss,
    isLoss: profit.isLoss,
    zone,
    // matchLegacyRate's reason when there is no rate; otherwise
    // shipmentProfit's, which is non-null when the rate is known but the
    // carrier cost is not -- a real state that still has to be reportable.
    reason: matched.reason ?? profit.reason,
  }
}

export interface WeeklyBillResult {
  /** The inserted draft bill row, or null when nothing was inserted. */
  bill: unknown | null
  /** null on success. Non-null means NO bill row was written. */
  error: string | null
  /**
   * Lines the reads returned but that carried no readable amount, and so are
   * not in any of the totals above. Zero does not mean "nothing went wrong";
   * it means nothing was withheld.
   */
  unpricedLines: number
}

/**
 * Insert a draft weekly bill, or refuse and say why.
 *
 * The refusal is the point. The previous version read four tables, discarded
 * all four errors, and inserted whatever the surviving rows summed to. Four
 * failed reads inserted a $0.00 draft bill that looked exactly like a client
 * who had no activity that week.
 */
export async function generateWeeklyBill(
  clientId: string, weekStart: string, weekEnd: string,
): Promise<WeeklyBillResult> {
  const [shipmentsRes, warehouseRes, adjustmentsRes, manualRes] = await Promise.all([
    supabaseAdmin
      .from('shipments')
      .select('client_rate, profit_loss')
      .eq('client_id', clientId)
      .gte('ship_date', weekStart)
      .lte('ship_date', weekEnd),
    supabaseAdmin
      .from('warehouse_daily_log')
      .select('total')
      .eq('client_id', clientId)
      .gte('log_date', weekStart)
      .lte('log_date', weekEnd),
    supabaseAdmin
      .from('rate_adjustments')
      .select('adjustment_amount')
      .eq('client_id', clientId)
      .eq('status', 'approved')
      .gte('adjustment_date', weekStart)
      .lte('adjustment_date', weekEnd),
    supabaseAdmin
      .from('manual_charges')
      .select('amount')
      .eq('client_id', clientId)
      .eq('approved', true)
      .gte('charge_date', weekStart)
      .lte('charge_date', weekEnd),
  ])

  // All four are fatal, and all four are reported together rather than on the
  // first failure: an operator looking at why a bill did not generate wants to
  // know whether one table is unreachable or the whole connection is.
  const failures = [
    ['shipments', shipmentsRes.error],
    ['warehouse_daily_log', warehouseRes.error],
    ['rate_adjustments', adjustmentsRes.error],
    ['manual_charges', manualRes.error],
  ].filter(([, e]) => e) as Array<[string, { message: string }]>

  if (failures.length > 0) {
    return {
      bill: null,
      error: `no bill written: could not read `
        + failures.map(([t, e]) => `${t} (${e.message})`).join(', ')
        + `. A partial read is not billed -- the missing rows are worth an `
        + `unknown amount, and a bill short by an unknown amount is worse than `
        + `no bill.`,
      unpricedLines: 0,
    }
  }

  // Accumulated in cents, and UNKNOWN counted rather than added as 0.
  //
  // `client_rate` and `warehouse_daily_log.total` are both nullable now, so a
  // `?? 0` here would understate the bill by however many lines the rate card
  // did not cover -- and the client would be under-billed with no record of by
  // how much. `adjustment_amount` and `amount` are not nullable by anything in
  // this codebase, but they go through the same coercion because a `numeric`
  // over PostgREST can arrive as a string and `0 + '12.34'` is '012.34'.
  let cents = 0
  let unpricedLines = 0
  const sectionCents: Record<string, number> = {
    shipping: 0, warehouse: 0, adjustments: 0, manual: 0,
  }

  const sections: Array<[string, Array<Record<string, unknown>>, string]> = [
    ['shipping', shipmentsRes.data ?? [], 'client_rate'],
    ['warehouse', warehouseRes.data ?? [], 'total'],
    ['adjustments', adjustmentsRes.data ?? [], 'adjustment_amount'],
    ['manual', manualRes.data ?? [], 'amount'],
  ]
  for (const [name, rows, key] of sections) {
    for (const row of rows) {
      const n = priceOf(row?.[key])
      if (n === null) unpricedLines++
      else {
        const c = Math.round(n * 100)
        sectionCents[name] += c
        cents += c
      }
    }
  }

  // Refused rather than inserted-with-a-note. A stored bill is the artefact an
  // invoice is sent from; a row in `bills` carrying a total that is short by an
  // unknown amount is a thing somebody will bill from later, and the note will
  // not travel with it. Price the lines and re-run.
  if (unpricedLines > 0) {
    return {
      bill: null,
      error: `no bill written: ${unpricedLines} line`
        + `${unpricedLines === 1 ? '' : 's'} in ${weekStart}..${weekEnd} `
        + `carr${unpricedLines === 1 ? 'ies' : 'y'} no readable amount, so the `
        + `total would be short by an unknown amount. Price `
        + `${unpricedLines === 1 ? 'it' : 'them'} and re-run.`,
      unpricedLines,
    }
  }

  const { data: bill, error: insertError } = await supabaseAdmin
    .from('bills')
    .insert({
      client_id: clientId,
      week_start: weekStart,
      week_end: weekEnd,
      shipping_total: sectionCents.shipping / 100,
      warehouse_total: sectionCents.warehouse / 100,
      adjustments_total: sectionCents.adjustments / 100,
      manual_charges_total: sectionCents.manual / 100,
      grand_total: cents / 100,
      status: 'draft',
    })
    .select()
    .single()

  // The insert's error was discarded too, and `data` is null on failure, so the
  // old version returned undefined-ish on both "written" and "not written".
  if (insertError) {
    return {
      bill: null,
      error: `the bill total was computed but not stored: ${insertError.message}`,
      unpricedLines: 0,
    }
  }

  return { bill, error: null, unpricedLines: 0 }
}
