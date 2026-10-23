import { supabaseAdmin } from '@/lib/supabase'
import { readAllPages } from '@/lib/db/page'
import {
  zoneFromChartRow, zoneFromSources, zoneRateFromMatrix,
  type ZoneChartRow, type ZoneLookup, type ZoneMatrixCell,
} from '@/lib/billing/zones'
import { calcDimWeightOz, calcBilledWeightOz } from '@/lib/billing/dim-weight'
import {
  matchLegacyRate, shipmentProfit, billedWeightOf, type ShippingRateRow,
} from '@/lib/billing/shipment-rate'

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
  | {
      ok: true
      originZip: string | null
      rates: ShippingRateRow[]
      /** The client's whole zone matrix, read once per run. */
      matrix: ZoneMatrixCell[]
    }
  | { ok: false; error: string }

/**
 * The columns this function reads -- it mirrors the select below and nothing
 * more. Needed explicitly now the read goes through readAllPages, which is
 * generic and cannot infer the row shape from the query the way a bare
 * `.select()` did.
 */
interface ShipmentRow {
  id: string
  order_number: string | null
  /** Never null here: the read filters on `client_id is not null`. */
  client_id: string
  actual_cost: number | null
  weight: number | null
  length: number | null
  width: number | null
  height: number | null
  carrier: string | null
  service: string | null
  recipient_zip: string | null
  zone: number | null
  raw_data: unknown
}

export async function recalculateShipments(): Promise<RecalculateStats> {
  // PAGED, and the page.ts header says why in full. The short version is that
  // this read used to be a bare `.select(...)`, which PostgREST silently caps
  // at `db-max-rows` -- 1000 by default -- and reports as a 200 with
  // `error: null`. Nothing here could tell a complete answer from the first
  // thousand rows of one.
  //
  // That made this function's own statistics lie in the one direction nobody
  // checks. `updated`, `unmatched` and `skipped` were all counted over the
  // truncated set, so a run that never looked at 700 shipments reported clean
  // totals and a short gap list. Every count it returns is a count OF WHAT IT
  // READ, which is only the same as the book while the book fits in one page.
  //
  // It fit until 2026-10-23. Attributing 833 orphaned shipments that morning
  // took the table from 867 rows with a client to 1700, and 700 of them went
  // unpriced with nothing anywhere saying so -- found from the database side,
  // not from this process, because this process could not see them. page.ts
  // predicted the shape exactly: "the defect does not exist at all until the
  // table crosses the cap, and then it appears without anything changing in
  // the code."
  //
  // `.order('id')` is REQUIRED, not tidiness. Postgres makes no promise about
  // row order across two OFFSET queries, so paging an unordered read can hand
  // the same shipment back twice and skip another -- here that is one parcel
  // repriced twice and one left on a stale rate, with the totals still adding
  // up. `id` is unique on every table in schema.sql.
  const { data: shipments, error } = await readAllPages<ShipmentRow>((from, to) =>
    supabaseAdmin
      .from('shipments')
      .select('id, order_number, client_id, actual_cost, weight, length, width, height, carrier, service, recipient_zip, zone, raw_data')
      .not('client_id', 'is', null)
      .order('id')
      .range(from, to))

  if (error) throw new Error(error.message)

  // The ZIP-prefix chart, read ONCE for the whole run.
  //
  // It used to be one read per shipment, inside resolveZone. Together with the
  // matrix read below and the write, that made three sequential round trips
  // per row -- about 5,100 of them across 1,700 shipments, every one of them
  // awaited before the next began. That is minutes of pure latency, and this
  // route had no maxDuration, so the function was killed partway and the run
  // reported totals for the rows it managed rather than for the book. The
  // numbers improved a little on each attempt, which is what a job that cannot
  // finish looks like from the outside.
  //
  // The chart is small -- one origin prefix is a few hundred rows -- and it
  // does not change during a run, so it is held in memory. Paged, because
  // the thing this file was just fixed for applies here too.
  let chart: { ok: true; lanes: Map<string, number> } | { ok: false; error: string } | null = null

  async function getChart() {
    if (chart) return chart
    const { data, error } = await readAllPages<ZoneChartRow>((from, to) =>
      supabaseAdmin
        .from('zone_chart')
        .select('origin_prefix, dest_prefix, zone')
        .order('id')
        .range(from, to))
    if (error) {
      // Fatal for every row that needs a chart lookup, exactly as a per-row
      // read failure was. A chart that could not be read is not a chart with
      // no row for this lane, and the two must not share an outcome: the
      // second falls through to the legacy card at a different agreed price.
      chart = { ok: false, error: `could not read the zone chart: ${error.message}` }
      return chart
    }
    const lanes = new Map<string, number>()
    for (const row of data ?? []) {
      lanes.set(`${row.origin_prefix}>${row.dest_prefix}`, row.zone)
    }
    chart = { ok: true, lanes }
    return chart
  }

  // Cache: client_id → origin zip + rate card + the whole zone matrix
  const clientCache: Record<string, ClientData> = {}

  async function getClientData(clientId: string): Promise<ClientData> {
    if (clientCache[clientId]) return clientCache[clientId]
    const [clientRes, ratesRes, matrixRes] = await Promise.all([
      supabaseAdmin.from('clients').select('origin_zip').eq('id', clientId).maybeSingle(),
      supabaseAdmin.from('client_shipping_rates')
        .select('rate, weight_min, weight_max, carrier, service').eq('client_id', clientId),
      // The client's ENTIRE matrix, once, instead of one lane per shipment.
      // Paged without exception: Orcam's matrix is 1600 cells and an unpaged
      // read would return 1000 of them and say nothing, which would price
      // every parcel over 62 LB off the legacy card instead.
      readAllPages<ZoneMatrixCell>((from, to) =>
        supabaseAdmin.from('client_zone_rates')
          .select('rate, carrier, service, weight_lb, zone')
          .eq('client_id', clientId)
          .order('id')
          .range(from, to)),
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
    // Equally fatal, and it used to be caught per shipment inside
    // resolveZoneRate. Hoisting the read hoists its failure with it: one
    // unreadable matrix now withholds every one of that client's shipments
    // rather than one, which is the same rule applied at the new granularity.
    if (matrixRes.error) {
      clientCache[clientId] = {
        ok: false,
        error: `could not read the zone matrix: ${matrixRes.error.message}`,
      }
      return clientCache[clientId]
    }
    clientCache[clientId] = {
      ok: true,
      originZip: clientRes.data?.origin_zip ?? null,
      rates: (ratesRes.data ?? []) as ShippingRateRow[],
      matrix: matrixRes.data ?? [],
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
    // These five `?? 0`s look like the defect they resemble elsewhere, and are
    // not, because every consumer of the 0 refuses it rather than believing it.
    // Left alone deliberately, and recorded here so that neither half of the
    // pairing gets "tidied" on the strength of how the line reads:
    //
    //   weight -> matchLegacyRate refuses billedWeightOf(w) === null, i.e. any
    //     weight <= 0, so an unweighed shipment gets a null rate and a stated
    //     reason instead of the LIGHTEST band's price.
    //   weight -> the write below stores `billed_weight: null`, not 0, under
    //     the same billedWeightOf guard.
    //   l/w/h -> calcDimWeightOz returns null unless all three are > 0, which
    //     means "DIM does not apply, bill on actual weight alone" -- a missing
    //     dimension cannot be invented, and declining to apply a surcharge is
    //     the only direction that does not overcharge on no evidence.
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
    // Set only when the matrix was actually consulted and covered nothing, so
    // that the unpriced report below can say so. Stays null when there was no
    // zone to look up with -- claiming the matrix was consulted and found
    // wanting would be a false account of a Puerto Rico or Canada row.
    let zoneMissReason: string | null = null

    // ── 1. Zone matrix rate (weight × zone) ──────────────────────────────────
    //
    // Both zone reads are now fatal FOR THIS ROW, and the row is skipped rather
    // than repriced. The reason is the fallback directly below: a null zone or
    // a null zone rate sends the shipment to the legacy carrier/service card,
    // which is a different agreed price. So a failed zone read used to produce
    // the WRONG price and write it -- not "no price", which would have been
    // visible. Skipping leaves whatever the last good run stored and names the
    // reason in `reasons`, which the monitor emails.
    //
    // resolveZone is not used here, though it is still what every other caller
    // uses. It performs one chart read per call, which is the right shape when
    // you are pricing a single shipment and the wrong one across the whole
    // book. This drives the same two pure functions it does -- zoneFromSources
    // then zoneFromChartRow -- against the chart already in memory, so the
    // rules are shared rather than restated.
    const source = zoneFromSources(
      { recipient_zip: s.recipient_zip, raw_data: s.raw_data, zone: s.zone },
      client.originZip
    )
    let zone: ZoneLookup
    if (source.kind === 'resolved') {
      zone = { zone: source.zone, error: null }
    } else if (source.kind === 'none') {
      zone = { zone: null, error: null }
    } else {
      const c = await getChart()
      zone = c.ok
        ? zoneFromChartRow(
            c.lanes.get(`${source.originPrefix}>${source.destPrefix}`),
            source.originPrefix, source.destPrefix)
        : { zone: null, error: c.error }
    }
    if (zone.error) {
      skipped++
      note(zone.error, label)
      continue
    }

    if (zone.zone != null) {
      resolvedZone = zone.zone
      // From the cached matrix, not a read. The read's failure is handled once,
      // at getClientData, and arrives here as `!client.ok` above.
      const zoneRate = zoneRateFromMatrix(
        client.matrix, s.carrier ?? '', s.service ?? '', billedWeightOz, zone.zone)
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
      } else {
        zoneMissReason = zoneRate.reason ?? null
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
        // Both halves, in the order they were tried. The legacy card can only
        // ever describe itself, so on its own it reports "this client has no
        // legacy shipping rate card" for a client whose 800-cell matrix simply
        // does not cover this carrier -- true, and it points at the wrong fix.
        const legacy = priced.reason ?? 'no rate could be matched'
        note(zoneMissReason ? `${zoneMissReason} Then: ${legacy}` : legacy, label)
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
        // billedWeightOf and not `Number.isFinite`, so that the weight column
        // agrees with the price. 0 is finite, so an unweighed shipment used to
        // store `billed_weight: 0` next to a null rate -- a figure in the column
        // the operator would look at to find out WHY the rate is null, reading
        // as a parcel that weighs nothing rather than as one nobody weighed.
        billed_weight: billedWeightOf(billedWeightOz) != null
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
