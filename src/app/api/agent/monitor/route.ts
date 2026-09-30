// CRON COUPLING: vercel.json fires this route at 06:00, 14:00 and 20:00 UTC.
// src/lib/ledger/pick-date.ts derives pick dates from those times via a
// before-06:00-local rule. Change the schedule and you must change that rule.

/**
 * Monitoring Agent — runs on a schedule via Vercel Cron.
 *
 * What it does on every run:
 *   1. Sync shipments from ShipStation (last 7 days)
 *   2. Recalculate all client rates / profit-loss
 *   3. Scan for problems:
 *        - Unpriced shipments (client_rate = 0, has a client assigned)
 *        - New losses (is_loss = true)
 *        - Pending carrier adjustments
 *        - Shipments with no client assigned
 *   4. Email a summary report to ALERT_EMAIL if anything needs attention
 */

import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { syncShipments } from '@/lib/sync/shipstation'
import { syncClientAssignments } from '@/lib/sync/zenventory'
import { sendEmail } from '@/lib/email'
import { requireStaffOrCron } from '@/lib/require-staff'
import { recalculateShipments } from '@/lib/billing/recalculate'
import { recalculateCharges, type RecalculateResult } from '@/lib/ledger/persist-charges'
import { loadChargeInputs, fetchAllPages } from '@/lib/ledger/load-charge-inputs'
import { buildStorageCharges } from '@/lib/ledger/storage-charges'
import type { RateCardLine } from '@/lib/ledger/calculate-charges'
import type { CostRateRow } from '@/lib/ledger/cost-rate'

const ALERT_TO = process.env.ALERT_EMAIL || 'ophir@shipousa.com'

// Four syncs run in sequence here, and step 3b recalculates thirty days of
// charges. Vercel's default Node function budget is 10-15 seconds, which this
// route cannot finish inside; the kill left the charge run's sync_runs row
// 'running', which held the lock for STALE_RUN_MINUTES, and the resulting skip
// was logged but never alerted — so the ledger stayed empty behind an email
// whose subject said "All clear". 300s is the Pro plan's ceiling and is the
// budget this route is now written against; the charge recalculation is also
// throttled (CHARGE_THROTTLE_MINUTES) so browser polling cannot drive it.
export const maxDuration = 300

export async function GET(req: Request) {
  // Two callers, both legitimate: the Vercel cron (see vercel.json) and
  // the AutoSync widget on the staff dashboard, which polls this every
  // five minutes from a signed-in browser. The guard has to accept
  // both, so it is not a plain requireStaff().
  const denied = await requireStaffOrCron(req)
  if (denied) return denied

  const log: string[] = []
  const errors: string[] = []
  const now = new Date()
  const label = now.toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short' })

  log.push(`▶ Monitor agent started at ${label} ET`)

  // ── 1. Sync ShipStation ────────────────────────────────────────────────────
  let syncResult: any = {}
  try {
    syncResult = await syncShipments(7)
    log.push(`✓ ShipStation sync: ${syncResult.created} new · ${syncResult.updated} updated · ${syncResult.adjustments} adjustments`)
  } catch (err: any) {
    const msg = `✗ ShipStation sync FAILED: ${err.message}`
    log.push(msg)
    errors.push(msg)
  }

  // ── 2. Zenventory client mapping ───────────────────────────────────────────
  let clientResult: any = {}
  try {
    clientResult = await syncClientAssignments(7)
    log.push(`✓ Client mapping: ${clientResult.updated ?? 0} shipments assigned`)
  } catch (err: any) {
    const msg = `✗ Zenventory client mapping FAILED: ${err.message}`
    log.push(msg)
    errors.push(msg)
  }

  // ── 3. Recalculate rates ───────────────────────────────────────────────────
  let recalcStats = { updated: 0, zone_matched: 0, legacy_matched: 0, unmatched: 0 }
  try {
    // Called directly, not over HTTP. The old self-fetch to
    // /api/sync/recalculate carried no credentials, which is the only
    // reason that endpoint had to stay unauthenticated.
    recalcStats = await recalculateShipments()
    log.push(`✓ Recalculate: ${recalcStats.updated} shipments · ${recalcStats.zone_matched} zone-matched · ${recalcStats.legacy_matched} rate-card · ${recalcStats.unmatched} unmatched`)
    if (recalcStats.unmatched > 0) {
      errors.push(`⚠ ${recalcStats.unmatched} shipments have no rate match (check zone matrix / rate cards)`)
    }
  } catch (err: any) {
    const msg = `✗ Recalculate FAILED: ${err.message}`
    log.push(msg)
    errors.push(msg)
  }

  // ── 3b. Recalculate ledger charges ─────────────────────────────────────────
  // Thirty days: long enough to catch a pick recorded against a date already
  // passed, short enough that a run stays inside the cron's time budget.
  let chargeResult: RecalculateResult | null = null
  try {
    const windowStart = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10)
    chargeResult = await recalculateCharges((warn) => loadChargeInputs(windowStart, warn))

    if (chargeResult.skipped) {
      log.push(`⏭ Charges: skipped — ${chargeResult.reason}`)
      // A throttled skip is the healthy case, but ONLY because of the two
      // properties CHARGE_THROTTLE_MINUTES documents: the throttle can be
      // satisfied only by a run that SUCCEEDED, and never by one that a cron
      // was due to make. Without both, this branch is "All clear because it
      // never ran" wearing a green tick — a failed run would buy the next hour
      // of silence right here. Everything else means charges did NOT run. A
      // stuck lock self-heals after STALE_RUN_MINUTES, but for those thirty
      // minutes the ledger is not being updated and nobody would otherwise be
      // told.
      if (chargeResult.cause !== 'throttled') {
        errors.push(`⚠ Charge calculation did NOT run: ${chargeResult.reason} `
          + `Charges are not up to date until a run completes.`)
      }
    } else {
      log.push(`✓ Charges: ${chargeResult.orders} orders · ${chargeResult.upserted} written · ${chargeResult.deleted} stale removed`)
      if (chargeResult.failedOrders > 0) {
        errors.push(`⚠ ${chargeResult.failedOrders} orders failed charge calculation (see the latest sync_runs row for source = 'charges')`)
      }
      if (chargeResult.unpricedOrders > 0) {
        errors.push(`⚠ ${chargeResult.unpricedOrders} orders had picked lines but produced no pick charge — most likely a client with no rate card line`)
      }
      if (chargeResult.unknownCostCharges > 0) {
        log.push(`⚠ ${chargeResult.unknownCostCharges} charges have no known cost rate (flagged as estimates, cost left null)`)
      }
      if (chargeResult.unknownCarrierCharges > 0) {
        log.push(`⚠ ${chargeResult.unknownCarrierCharges} shipping charges have no carrier cost reported yet (cost left null, not zero — and on an at-cost rate the revenue is null too, so billable revenue is understated until the carrier reports)`)
      }
    }
  } catch (err) {
    const msg = `✗ Charge calculation FAILED: `
      + `${err instanceof Error ? err.message : String(err)}`
    log.push(msg)
    errors.push(msg)
  }

  // ── 3c. Persist monthly storage charges ───────────────────────────────────
  // Storage is the only charge type whose input is a person rather than an API.
  // We read client_storage_months for the last three months, build StorageCharge
  // rows per client-month, then select-then-write each one against the
  // client-keyed partial unique index (order_charges_client_key). Upsert with
  // onConflict is not used because the index is partial and PostgREST cannot
  // emit the predicate, causing Postgres error 42P10 at runtime (see
  // ledger_03_charges.sql:155-170 and Ruling 9).
  try {
    // monthStart(n): first day of the month n months ago, computed arithmetically.
    // Never via Date.setMonth() — on the 31st, setMonth(m-3) overflows to a
    // different month. Follow the pattern in src/lib/ledger/summary.ts:threeMonthWindowStart.
    const monthStart = (monthsBack: number): string => {
      const now = new Date()
      const y = now.getFullYear()
      const m = now.getMonth() + 1 // 1-based
      const shifted = m - monthsBack
      const fromMonth = shifted <= 0 ? shifted + 12 : shifted
      const fromYear = shifted <= 0 ? y - 1 : y
      return `${fromYear}-${String(fromMonth).padStart(2, '0')}-01`
    }

    // Load all cost rates (paginated — bare .select() silently caps at 1000 rows).
    const allCostRates = await fetchAllPages<CostRateRow>('cost_rates (storage)', (from, to) =>
      supabaseAdmin
        .from('cost_rates')
        .select('id, cost_type, variant, unit, rate, effective_from, effective_to, basis')
        .order('id', { ascending: true })
        .range(from, to))

    // Load all rate card lines (paginated for the same reason).
    interface RateRow {
      id: string; client_id: string | null; charge_type: string | null
      variant: string | null; rate: number | string | null; rate_type: string | null
      effective_from: string | null; effective_to: string | null
    }
    const allRateRows = await fetchAllPages<RateRow>('client_warehouse_rates (storage)', (from, to) =>
      supabaseAdmin
        .from('client_warehouse_rates')
        .select('id, client_id, charge_type, variant, rate, rate_type, effective_from, effective_to')
        .not('charge_type', 'is', null)
        .order('id', { ascending: true })
        .range(from, to))

    // cardFor(clientId): all RateCardLine rows for a given client, in the same
    // shape that load-charge-inputs.ts:441-449 produces.
    const ratesByClient = new Map<string, RateCardLine[]>()
    for (const r of allRateRows) {
      if (!r.client_id) continue
      const line: RateCardLine = {
        id: r.id,
        chargeType: String(r.charge_type ?? ''),
        variant: r.variant,
        rate: r.rate === null || r.rate === undefined ? null : Number(r.rate),
        rateType: String(r.rate_type ?? ''),
        effectiveFrom: r.effective_from ?? null,
        effectiveTo: r.effective_to ?? null,
      }
      const list = ratesByClient.get(r.client_id) ?? []
      list.push(line)
      ratesByClient.set(r.client_id, list)
    }
    const cardFor = (clientId: string): RateCardLine[] =>
      ratesByClient.get(clientId) ?? []

    // Read declared storage for the last three months.
    interface StorageMonthRow {
      client_id: string
      period_month: string
      pallet_positions: number | string | null
      shelf_positions: number | string | null
    }
    const { data: months, error: monthsError } = await supabaseAdmin
      .from('client_storage_months')
      .select('client_id, period_month, pallet_positions, shelf_positions')
      .gte('period_month', monthStart(3))
    if (monthsError) throw new Error(`storage months: ${monthsError.message}`, { cause: monthsError })

    let storageWritten = 0
    for (const m of (months as StorageMonthRow[] | null) ?? []) {
      const rows = buildStorageCharges({
        clientId: m.client_id,
        periodMonth: m.period_month,
        palletPositions: m.pallet_positions === null ? null : Number(m.pallet_positions),
        shelfPositions: m.shelf_positions === null ? null : Number(m.shelf_positions),
        rateCard: cardFor(m.client_id),
        costRates: allCostRates,
      })
      if (rows.length === 0) continue

      // Select-then-write (Ruling 9): the partial unique index cannot be used
      // in a PostgREST onConflict clause, so we read existing ids first, then
      // UPDATE matching keys and INSERT new ones. This has no absence window
      // between a delete and a re-insert, so two overlapping cron runs cannot
      // produce a moment with zero storage charges.
      const keys = rows.map((r) => r.charge_key)
      const { data: existing, error: selErr } = await supabaseAdmin
        .from('order_charges')
        .select('id, charge_key')
        .eq('client_id', m.client_id)
        .in('charge_key', keys)
        .is('order_id', null)
      if (selErr) throw new Error(`storage select: ${selErr.message}`, { cause: selErr })

      const existingByKey = new Map<string, string>()
      for (const row of existing ?? []) existingByKey.set(row.charge_key, row.id)

      const now = new Date().toISOString()
      for (const r of rows) {
        const payload = { ...r, calculated_at: now }
        const existingId = existingByKey.get(r.charge_key)
        if (existingId) {
          const { error: updErr } = await supabaseAdmin
            .from('order_charges')
            .update(payload)
            .eq('id', existingId)
          if (updErr) throw new Error(`storage update: ${updErr.message}`, { cause: updErr })
        } else {
          const { error: insErr } = await supabaseAdmin
            .from('order_charges')
            .insert(payload)
          if (insErr) throw new Error(`storage insert: ${insErr.message}`, { cause: insErr })
        }
        storageWritten++
      }
    }
    log.push(`✓ Storage charges: ${storageWritten} written`)
  } catch (err) {
    const msg = `✗ Storage charge sync FAILED: `
      + `${err instanceof Error ? err.message : String(err)}`
    log.push(msg)
    errors.push(msg)
  }

  // ── 4. Scan for problems ───────────────────────────────────────────────────
  //
  // Every read below keeps its `error`. These five used to discard it, which is
  // the global constraint's banned pattern sitting in the one route whose whole
  // job is to report whether the system is healthy: a failed count destructures
  // to undefined, `(count ?? 0) > 0` is false, and the email prints "✓ No loss
  // shipments" and "✓ No pending adjustments" on the strength of a query that
  // never answered. An error discarded HERE is an error nobody will ever learn
  // about, because this is the thing that would have told them. Same precedent
  // as sync/shipstation.ts.
  //
  // A failed scan goes into errors[] rather than throwing: one unreadable count
  // must not cost the other three, nor the email itself.
  const scanFailed = (what: string, err: { message: string }) => {
    const msg = `✗ Could not read ${what}: ${err.message}`
    log.push(msg)
    errors.push(msg)
  }

  // 4a. Unpriced shipments (has a client but client_rate is 0)
  const { count: unpricedCount, error: unpricedError } = await supabaseAdmin
    .from('shipments')
    .select('order_number, clients(name)', { count: 'exact' })
    .not('client_id', 'is', null)
    .eq('client_rate', 0)
    .limit(20)

  if (unpricedError) {
    scanFailed('unpriced shipments', unpricedError)
  } else if (unpricedCount && unpricedCount > 0) {
    errors.push(`⚠ ${unpricedCount} shipments have a client assigned but NO rate (client_rate = $0)`)
    log.push(`⚠ ${unpricedCount} unpriced shipments`)
  }

  // 4b. Current loss shipments
  const { count: lossCount, error: lossCountError } = await supabaseAdmin
    .from('shipments')
    .select('*', { count: 'exact', head: true })
    .eq('is_loss', true)

  const { data: lossSum, error: lossSumError } = await supabaseAdmin
    .from('shipments')
    .select('profit_loss')
    .eq('is_loss', true)

  const totalLoss = (lossSum ?? []).reduce((s, r) => s + Math.abs(r.profit_loss ?? 0), 0)

  if (lossCountError) scanFailed('the loss shipment count', lossCountError)
  // Reported separately from the count: the two reads can disagree, and a
  // total of $0.00 printed beside a non-zero count is a worse lie than saying
  // the total is unknown.
  if (lossSumError) scanFailed('the loss shipment total', lossSumError)

  if ((lossCount ?? 0) > 0) {
    log.push(`⚠ ${lossCount} loss shipments · total -$${totalLoss.toFixed(2)}`)
  } else if (!lossCountError) {
    // Only claimed when the read succeeded. "No loss shipments" derived from a
    // query that errored is the false all-clear this whole section exists to
    // stop.
    log.push(`✓ No loss shipments`)
  }

  // 4c. Pending carrier adjustments
  const { data: adjustments, count: adjCount, error: adjError } = await supabaseAdmin
    .from('rate_adjustments')
    .select('adjustment_amount, clients(name)', { count: 'exact' })
    .eq('status', 'pending')
    .limit(20)

  const adjTotal = (adjustments ?? []).reduce((s, r) => s + (r.adjustment_amount ?? 0), 0)

  if (adjError) {
    scanFailed('pending carrier adjustments', adjError)
  } else if ((adjCount ?? 0) > 0) {
    log.push(`🔔 ${adjCount} pending carrier adjustments · +$${adjTotal.toFixed(2)} to recover`)
  } else {
    log.push(`✓ No pending adjustments`)
  }

  // 4d. Shipments with no client assigned
  const { count: unassignedCount, error: unassignedError } = await supabaseAdmin
    .from('shipments')
    .select('*', { count: 'exact', head: true })
    .is('client_id', null)

  if (unassignedError) {
    scanFailed('the unassigned shipment count', unassignedError)
  } else if ((unassignedCount ?? 0) > 0) {
    log.push(`⚠ ${unassignedCount} shipments have no client assigned`)
  }

  // ── 5. Send email report ───────────────────────────────────────────────────
  // `?? 0` in the stats block would render an unreadable count as a confident
  // zero — the same null-versus-unknown confusion the ledger exists to stop,
  // in the one place a person actually looks.
  const stat = (err: unknown, n: number | null) => (err ? 'unknown' : String(n ?? 0))
  const money = (err: unknown, n: number) => (err ? '?' : n.toFixed(2))

  const hasErrors = errors.length > 0
  const subject = hasErrors
    ? `🚨 Shipo Monitor — ${errors.length} issue${errors.length > 1 ? 's' : ''} need attention`
    : `✅ Shipo Monitor — All clear (${label} ET)`

  const html = `
    <div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:560px;color:#374151;">
      <h2 style="margin-bottom:4px;color:${hasErrors ? '#b91c1c' : '#065f46'}">
        ${hasErrors ? '🚨 Issues Detected' : '✅ All Clear'}
      </h2>
      <p style="color:#6b7280;font-size:13px;margin-top:0;">${label} ET · Shipo Operations Platform</p>

      ${hasErrors ? `
      <div style="background:#fef2f2;border:1px solid #fca5a5;border-radius:8px;padding:12px 16px;margin:16px 0;">
        <p style="font-weight:600;color:#b91c1c;margin:0 0 8px;">Issues requiring attention:</p>
        <ul style="margin:0;padding-left:20px;color:#7f1d1d;">
          ${errors.map(e => `<li style="margin:4px 0;">${e}</li>`).join('')}
        </ul>
      </div>` : ''}

      <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:12px 16px;margin:16px 0;">
        <p style="font-weight:600;color:#111827;margin:0 0 8px;">Run log:</p>
        <ul style="margin:0;padding-left:20px;color:#374151;font-size:13px;">
          ${log.map(l => `<li style="margin:3px 0;">${l}</li>`).join('')}
        </ul>
      </div>

      <div style="background:#f0f9ff;border:1px solid #bae6fd;border-radius:8px;padding:12px 16px;font-size:13px;">
        <p style="margin:0;"><strong>Quick stats:</strong></p>
        <p style="margin:4px 0 0;color:#0369a1;">
          Loss shipments: ${stat(lossCountError, lossCount)} (-$${money(lossSumError, totalLoss)}) &nbsp;·&nbsp;
          Pending adjustments: ${stat(adjError, adjCount)} (+$${money(adjError, adjTotal)}) &nbsp;·&nbsp;
          Unassigned: ${stat(unassignedError, unassignedCount)}
        </p>
      </div>

      <p style="font-size:12px;color:#9ca3af;margin-top:16px;">
        <a href="${process.env.NEXT_PUBLIC_SITE_URL || 'https://shipo-system.vercel.app'}/dashboard" style="color:#0ea5e9;">Open Dashboard</a>
        &nbsp;·&nbsp;
        <a href="${process.env.NEXT_PUBLIC_SITE_URL || 'https://shipo-system.vercel.app'}/losses" style="color:#0ea5e9;">View Losses</a>
        &nbsp;·&nbsp;
        <a href="${process.env.NEXT_PUBLIC_SITE_URL || 'https://shipo-system.vercel.app'}/adjustments" style="color:#0ea5e9;">View Adjustments</a>
      </p>
    </div>
  `

  const emailResult = await sendEmail({ to: ALERT_TO, subject, html, text: log.join('\n') })
  log.push(`📧 Email → ${ALERT_TO}: ${emailResult.sent ? `sent via ${emailResult.provider}` : `FAILED (${emailResult.error})`}`)

  return NextResponse.json({
    ok: true,
    has_issues: hasErrors,
    errors,
    log,
    stats: {
      sync: syncResult,
      recalc: recalcStats,
      charges: chargeResult,
      losses: { count: lossCount, total: totalLoss },
      adjustments: { count: adjCount, total: adjTotal },
      unassigned: unassignedCount,
      unpriced: unpricedCount,
    },
    email: emailResult,
  })
}
