import { supabaseAdmin } from '@/lib/supabase'
import { fetchAllPages } from '@/lib/ledger/load-charge-inputs'
import { buildStorageCharges, type StorageCharge } from '@/lib/ledger/storage-charges'
import type { RateCardLine } from '@/lib/ledger/calculate-charges'
import type { CostRateRow } from '@/lib/ledger/cost-rate'

/**
 * Monthly storage charges, written from the counts declared in
 * `client_storage_months`.
 *
 * WHY THIS IS A MODULE AND NOT A BLOCK IN THE MONITOR ROUTE. It used to be a
 * top-level try in src/app/api/agent/monitor/route.ts, which cost it three
 * things:
 *
 *   1. THE LOCK. AutoSync.tsx polls that route every five minutes from every
 *      open browser tab. Inline, this block ran on every one of those, including
 *      while another run was actively writing — both would SELECT, find nothing,
 *      both INSERT, and the client-keyed unique index would raise 23505. The
 *      route now calls this only when recalculateCharges() actually RAN (its
 *      result is not `skipped`), so it piggybacks on the lock and the throttle
 *      that persist-charges.ts already pays for. See CHARGE_THROTTLE_MINUTES.
 *
 *   2. TESTABILITY. vitest collects src/**\/*.test.ts and cannot reach a Next
 *      route handler, so the select-then-write choreography below — the one
 *      genuinely new piece of database work in Task 18 — had zero tests.
 *
 *   3. ISOLATION. Every error path threw, which exited the whole client-month
 *      loop. persist-charges.ts:211-216 already ruled this trade for orders:
 *      "One broken order must not stop the other few thousand, so it is recorded
 *      and skipped." Each client-month now has its own boundary.
 *
 * WHY SELECT-THEN-WRITE RATHER THAN UPSERT (Ruling 9). Storage rows carry
 * `order_id is null`, so the index that constrains them is the PARTIAL
 * `order_charges_client_key`. PostgREST's on_conflict parameter emits a column
 * list with no index predicate, Postgres cannot infer a partial index from that
 * and raises 42P10 on every batch — see ledger_03_charges.sql:155-170. So the
 * existing rows are read first, matching keys are UPDATEd and new ones
 * INSERTed. There is no delete-then-insert window in which the month has zero
 * charges.
 */

/** Flat day-one flag: nothing has been written, and that is not an incident. */
export type StorageResult =
  | { skipped: true; cause: 'missing-table'; reason: string }
  | {
      skipped: false
      /** client_storage_months rows read. */
      months: number
      /** Charge rows inserted or updated. */
      written: number
      inserted: number
      updated: number
      /** Stale storage rows removed by the sweep. See the C1 note below. */
      cleared: number
      /** Client-months whose build or write failed; their existing rows are untouched. */
      failedMonths: number
      /** Client-months with a declaration row but no counts in it at all. */
      undeclaredMonths: number
      /** Client-months with a positive count that produced no charge. */
      unpricedMonths: number
      /** Written rows carrying is_estimate. */
      estimatedCharges: number
      /**
       * Storage charges in the window with no declaration row — the declaration
       * was deleted rather than zeroed, so the stale sweep can never reach them.
       * Read-only detector: does not delete anything.
       */
      orphanedCharges: number
      /** Findings a person should act on. The caller puts these in errors[]. */
      errors: string[]
      /** Findings worth printing but not worth an alert. */
      warnings: string[]
    }

/**
 * First day of the month `monthsBack` months ago, as 'YYYY-MM-01'.
 *
 * Arithmetic, never Date.setMonth(): on the 31st, setMonth(m - 3) overflows
 * into a different month. Same construction as
 * src/lib/ledger/summary.ts:threeMonthWindowStart, and called only with 0 and 3.
 */
function monthStart(monthsBack: number): string {
  const now = new Date()
  const y = now.getFullYear()
  const m = now.getMonth() + 1 // 1-based
  const shifted = m - monthsBack
  const fromMonth = shifted <= 0 ? shifted + 12 : shifted
  const fromYear = shifted <= 0 ? y - 1 : y
  return `${fromYear}-${String(fromMonth).padStart(2, '0')}-01`
}

/** null and undefined alike mean "absent". `Number(undefined)` is NaN, so the
 *  undefined arm is load-bearing: a `=== null` test lets an absent column
 *  through as NaN. Mirrors load-charge-inputs.ts:114-115. */
const num = (v: unknown): number | null =>
  v === null || v === undefined ? null : Number(v)

/** The PostgREST error code fetchAllPages preserved on `cause`, if any. */
function causeCode(err: unknown): string | undefined {
  return (err as { cause?: { code?: string } } | null | undefined)?.cause?.code
}

interface StorageMonthRow {
  client_id: string
  period_month: string
  pallet_positions: number | string | null
  shelf_positions: number | string | null
  basis: string | null
}

interface RateRow {
  id: string
  client_id: string | null
  charge_type: string | null
  variant: string | null
  rate: number | string | null
  rate_type: string | null
  effective_from: string | null
  effective_to: string | null
}

/** How many onWarn findings are carried back before they are summarised. */
const MAX_WARNINGS = 10

export async function persistStorageCharges(): Promise<StorageResult> {
  const windowStart = monthStart(3)
  // The current month is the latest that can be billed. Without this ceiling a
  // typo'd '2030-01-01' in a declaration row bills today, four years early, and
  // nothing downstream would question a storage charge that looks exactly like
  // every other storage charge.
  const windowEnd = monthStart(0)

  let months: StorageMonthRow[]
  try {
    months = await fetchAllPages<StorageMonthRow>('client_storage_months', (from, to) =>
      supabaseAdmin
        .from('client_storage_months')
        .select('client_id, period_month, pallet_positions, shelf_positions, basis')
        // No companion `.is('period_month', null)` read is needed here, unlike
        // summary.ts:256-269: client_storage_months.period_month is `date not
        // null`, so there is no undated row for `.gte` to drop. That is the
        // ONLY reason this is safe — `null >= '2026-07-01'` is NULL, and
        // PostgREST turns that into a silently missing row, not an error.
        .gte('period_month', windowStart)
        .lte('period_month', windowEnd)
        // PostgREST row order is unspecified without this. It matters because
        // the per-month boundary below means some client-months can fail, and
        // WHICH ones go unbilled must not differ run to run — an unstable
        // victim set is an intermittent bug that never reproduces.
        .order('client_id', { ascending: true })
        .order('period_month', { ascending: true })
        .range(from, to))
  } catch (err) {
    // 42P01 undefined_table. There is no migration runner in this project: the
    // supabase/*.sql files are pasted into the SQL editor by a person, so "the
    // code is deployed" and "the table exists" are independent facts. Before
    // ledger_07_storage.sql has been run this is the EXPECTED state, and
    // reporting it as an incident would put a 🚨 subject line on all three
    // crons and a toast on every dashboard every five minutes until someone
    // pasted the file. fetchAllPages already names the file in the message.
    if (causeCode(err) === '42P01') {
      return {
        skipped: true,
        cause: 'missing-table',
        reason: err instanceof Error ? err.message : String(err),
      }
    }
    throw err
  }

  const errors: string[] = []
  const warnings: string[] = []
  let suppressedWarnings = 0
  const warn = (context: string, detail: string) => {
    if (warnings.length < MAX_WARNINGS) warnings.push(`⚠ ${context}: ${detail}`)
    else suppressedWarnings++
  }

  let written = 0
  let inserted = 0
  let updated = 0
  let cleared = 0
  let failedMonths = 0
  let undeclaredMonths = 0
  let unpricedMonths = 0
  let estimatedCharges = 0
  let orphanedCharges = 0
  /** Keys of client-months that threw during processing. Used by the orphan detector
   *  to avoid reporting their charges as orphaned — the run simply didn't process them. */
  const failedClientMonths = new Set<string>()

  if (months.length > 0) {
  // Both loads are paginated. A bare .select() silently caps at PostgREST's
  // db-max-rows (1000) with no error and no flag.
  const allCostRates = await fetchAllPages<CostRateRow>('cost_rates (storage)', (from, to) =>
    supabaseAdmin
      .from('cost_rates')
      .select('id, cost_type, variant, unit, rate, effective_from, effective_to, basis')
      .order('id', { ascending: true })
      .range(from, to))

  const allRateRows = await fetchAllPages<RateRow>('client_warehouse_rates (storage)', (from, to) =>
    supabaseAdmin
      .from('client_warehouse_rates')
      .select('id, client_id, charge_type, variant, rate, rate_type, effective_from, effective_to')
      .not('charge_type', 'is', null)
      .order('id', { ascending: true })
      .range(from, to))

  // Same RateCardLine shape load-charge-inputs.ts:441-449 produces, including
  // the effective dates — without them the rate lookup degenerates to a bare
  // .find() and a superseded rate wins by array order.
  const ratesByClient = new Map<string, RateCardLine[]>()
  for (const r of allRateRows) {
    if (!r.client_id) continue
    const list = ratesByClient.get(r.client_id) ?? []
    list.push({
      id: r.id,
      chargeType: String(r.charge_type ?? ''),
      variant: r.variant,
      rate: num(r.rate),
      rateType: String(r.rate_type ?? ''),
      effectiveFrom: r.effective_from ?? null,
      effectiveTo: r.effective_to ?? null,
    })
    ratesByClient.set(r.client_id, list)
  }

  for (const m of months) {
    // PER-CLIENT-MONTH BOUNDARY. One unreadable rate card or one corrupt count
    // must not cost every client that sorts after it their storage billing.
    try {
      const pallet = num(m.pallet_positions)
      const shelf = num(m.shelf_positions)

      const rows: StorageCharge[] = buildStorageCharges({
        clientId: m.client_id,
        periodMonth: m.period_month,
        palletPositions: pallet,
        shelfPositions: shelf,
        declarationBasis: m.basis ?? null,
        rateCard: ratesByClient.get(m.client_id) ?? [],
        costRates: allCostRates,
      }, warn)

      // A declaration row with no counts in it at all is a person who has been
      // asked and has not answered. It is NOT the same as a client who stored
      // nothing, and only the first should ever be chased up.
      if (pallet === null && shelf === null) undeclaredMonths++

      // A positive count that produced no charge means we are giving storage
      // away: almost always a client with no ('storage', <variant>) line on
      // their rate card, which is close to certain for Orcam, Suteka and Crisp
      // Power because ledger_05_seed_nayax.sql seeds those lines for Nayax
      // alone. Same detector persist-charges.ts:241-243 runs for orders.
      const wanted: Array<'pallet' | 'shelf'> = []
      if (pallet !== null && Number.isFinite(pallet) && pallet > 0) wanted.push('pallet')
      if (shelf !== null && Number.isFinite(shelf) && shelf > 0) wanted.push('shelf')
      const missing = wanted.filter(
        (v) => !rows.some((r) => r.charge_key.endsWith(`:${v}`)))
      if (missing.length > 0) {
        unpricedMonths++
        warn('unpriced storage', `client ${m.client_id} ${m.period_month}: `
          + `${missing.join(' and ')} positions are declared but no storage charge `
          + `was raised for them.`)
      }

      // ---- read what is already there ------------------------------------
      // Read by KEY PREFIX, not by the keys we are about to write. The stale
      // sweep below needs to see rows that are no longer being written, and a
      // `.in('charge_key', keys)` filter can by construction never return one.
      const prefix = `storage:${m.period_month}:`
      const { data: existing, error: selErr } = await supabaseAdmin
        .from('order_charges')
        .select('id, charge_key')
        .eq('client_id', m.client_id)
        // order_id is null is what makes these rows storage rather than an
        // order's charges, and it is the predicate of the partial unique index
        // they live under. Without it this could update an order's charge that
        // happened to share a key.
        .is('order_id', null)
        .like('charge_key', `${prefix}%`)
      if (selErr) throw new Error(`storage select: ${selErr.message}`, { cause: selErr })

      const existingByKey = new Map<string, string>()
      for (const row of (existing ?? []) as Array<{ id: string; charge_key: string }>) {
        existingByKey.set(row.charge_key, row.id)
      }

      // ---- write -----------------------------------------------------------
      const calculatedAt = new Date().toISOString()
      for (const r of rows) {
        const payload = { ...r, calculated_at: calculatedAt }
        const existingId = existingByKey.get(r.charge_key)
        if (existingId) {
          const { error: updErr } = await supabaseAdmin
            .from('order_charges')
            .update(payload)
            .eq('id', existingId)
          if (updErr) throw new Error(`storage update: ${updErr.message}`, { cause: updErr })
          updated++
        } else {
          const { error: insErr } = await supabaseAdmin
            .from('order_charges')
            .insert(payload)
          if (insErr) throw new Error(`storage insert: ${insErr.message}`, { cause: insErr })
          inserted++
        }
        written++
        if (r.is_estimate) estimatedCharges++
      }

      // ---- the stale sweep (C1) -------------------------------------------
      // WITHOUT THIS, A STORAGE CHARGE CAN NEVER BE REDUCED TO ZERO. Declare 4
      // pallets for September, $100 is written. Discover it was really 0 and set
      // it to 0, or switch the storage line off on the rate card: the build
      // returns no rows, and the previous shape's `if (rows.length === 0)
      // continue` left the $100 in place for ever, with no log line and no
      // error. leaks_monthly has no over-billing branch (see
      // ledger_05_seed_nayax.sql:137), so nothing downstream would ever catch
      // it. Correcting 4 -> 3 worked; 4 -> 0 was one-way.
      //
      // THE SCOPE IS THE POINT. Task 18's brief forbids a stale-delete scoped by
      // client_id alone, and rightly — that would remove every unattributed
      // charge the client has. This is scoped to the client AND `order_id is
      // null` AND this ONE month's key prefix AND only keys this run did not
      // write. Its blast radius is exactly the rows it is correcting.
      //
      // It runs AFTER the writes, so a failed write leaves the old rows alone
      // rather than deleting on the strength of a run that did not finish.
      //
      // RESIDUAL, NOW DETECTED BUT NOT AUTO-CORRECTED: deleting the declaration
      // ROW outright removes this client-month from `months`, so this loop never
      // reaches it and its charges survive. After the loop, a read-only orphan
      // detector queries order_charges for storage rows in the window with no
      // matching declaration and reports them in orphanedCharges + a warning.
      // It does not delete anything — see the ruling in the module header.
      // Zero the counts instead of deleting the row — ledger_07_storage.sql's
      // header says so too.
      const writtenKeys = new Set(rows.map((r) => r.charge_key))
      const staleIds = [...existingByKey.entries()]
        .filter(([key]) => !writtenKeys.has(key))
        .map(([, id]) => id)
      // `.in('id', [])` is an empty IN list, which PostgREST renders as
      // `id=in.()` — a syntax error, not a no-op. Guarded rather than trusted.
      if (staleIds.length > 0) {
        const { data: removed, error: delErr } = await supabaseAdmin
          .from('order_charges')
          .delete()
          .in('id', staleIds)
          .select('id')
        if (delErr) throw new Error(`storage sweep: ${delErr.message}`, { cause: delErr })
        cleared += (removed as unknown[] | null)?.length ?? staleIds.length
      }
    } catch (err) {
      failedMonths++
      failedClientMonths.add(`${m.client_id}:${m.period_month}`)
      warn('storage month failed', `client ${m.client_id} ${m.period_month}: `
        + `${err instanceof Error ? err.message : String(err)}`)
    }
  }
  } // end if (months.length > 0)

  // ---- orphan detector (read-only) ------------------------------------------
  // Storage charges in the window whose (client_id, period_month) has no
  // declaration row: the declaration was DELETED rather than zeroed, so the
  // stale sweep can never reach them. This does not delete anything.
  //
  // Failed client-months are excluded: their charges are not orphaned, the run
  // just did not process them this pass. failedClientMonths was populated in the
  // catch block of the loop above.
  try {
    // All months that were read — both successfully processed and failed.
    // A failed month still has a declaration row; its charges are not orphaned.
    // Orphaned means: the declaration row was DELETED (not in months at all).
    const declaredSet = new Set(
      months.map((m) => `${m.client_id}:${m.period_month}`)
    )

    interface StorageChargeRow {
      client_id: string
      charge_key: string
      charge_date: string
      amount: number | string | null
    }

    const allStorageInWindow = await fetchAllPages<StorageChargeRow>(
      'order_charges (orphan scan)',
      (from, to) =>
        supabaseAdmin
          .from('order_charges')
          .select('client_id, charge_key, charge_date, amount')
          .is('order_id', null)
          .like('charge_key', 'storage:%')
          .gte('charge_date', windowStart)
          .lte('charge_date', windowEnd)
          .order('client_id', { ascending: true })
          .order('charge_key', { ascending: true })
          .range(from, to)
    )

    let orphanTotal = 0
    for (const row of allStorageInWindow) {
      // Derive period_month from charge_key: storage:YYYY-MM-DD:variant
      // The second segment is the period_month stored in charge_key.
      const parts = row.charge_key.split(':')
      if (parts.length < 3) continue
      const periodMonth = parts[1]
      const key = `${row.client_id}:${periodMonth}`
      if (!declaredSet.has(key)) {
        orphanedCharges++
        orphanTotal += num(row.amount) ?? 0
      }
    }

    if (orphanedCharges > 0) {
      warn(
        'orphaned storage charges',
        `${orphanedCharges} storage charge${orphanedCharges > 1 ? 's' : ''} `
        + `totalling $${orphanTotal.toFixed(2)} have no declaration row — `
        + `the declaration was deleted rather than zeroed, so these charges can `
        + `never be corrected automatically. Zero the counts instead of deleting `
        + `the row, or delete these charges by hand.`,
      )
    }
  } catch (err) {
    if (causeCode(err) === '42P01') {
      // order_charges table missing — should not happen if we got this far, but
      // treat non-fatally to match the module's missing-table philosophy.
      warn('orphan scan', `order_charges table missing: ${err instanceof Error ? err.message : String(err)}`)
    } else {
      warn('orphan scan failed', `${err instanceof Error ? err.message : String(err)}`)
    }
  }

  if (failedMonths > 0) {
    errors.push(`⚠ ${failedMonths} client-month${failedMonths > 1 ? 's' : ''} failed `
      + `storage billing and were skipped; their existing storage charges are `
      + `unchanged. See the monitor log for which.`)
  }
  if (unpricedMonths > 0) {
    errors.push(`⚠ ${unpricedMonths} client-month${unpricedMonths > 1 ? 's' : ''} declared `
      + `storage positions but produced no storage charge — most likely a client with `
      + `no ('storage', pallet/shelf) line on their rate card, or a line whose `
      + `rate_type is not a flat per-position rate.`)
  }
  if (suppressedWarnings > 0) {
    warnings.push(`⚠ …and ${suppressedWarnings} further storage findings not listed.`)
  }

  return {
    skipped: false,
    months: months.length,
    written, inserted, updated, cleared,
    failedMonths, undeclaredMonths, unpricedMonths, estimatedCharges,
    orphanedCharges,
    errors, warnings,
  }
}
