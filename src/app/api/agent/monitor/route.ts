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
import { loadChargeInputs } from '@/lib/ledger/load-charge-inputs'
import { persistStorageCharges, type StorageResult } from '@/lib/ledger/persist-storage-charges'

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
    // A green tick belongs to a clean pass, not to a pass that returned.
    // syncShipments counts its own per-shipment failures in results.errors and
    // does not throw on them, so the old unconditional ✓ printed beside three
    // happy numbers while any number of shipments had silently not been
    // recorded. Section 4 below is a post-mortem on exactly that shape of
    // claim; this is the same claim, two stages earlier in the same handler.
    const shipFailed = Number(syncResult.errors ?? 0)
    log.push(`${shipFailed > 0 ? '⚠' : '✓'} ShipStation sync: ${syncResult.created} new · `
      + `${syncResult.updated} updated · ${syncResult.adjustments} adjustments`
      + `${shipFailed > 0 ? ` · ${shipFailed} FAILED` : ''}`)
    if (shipFailed > 0) {
      errors.push(`⚠ ${shipFailed} ShipStation shipment${shipFailed > 1 ? 's' : ''} could `
        + `not be recorded (see the latest sync_runs row for source = `
        + `'shipstation'). Their revenue and carrier cost are missing from the `
        + `ledger until the next successful run picks them up.`)
    }
    // Log, not errors[]: an unrecognised carrier code leaves the cost null
    // rather than wrong, and the shipment row is still written. It needs a
    // person eventually, not a 🚨 subject line every eight hours.
    if (Number(syncResult.unknownCarrier ?? 0) > 0) {
      log.push(`⚠ ${syncResult.unknownCarrier} shipments carry a carrier code that maps `
        + `to no cost rate (cost left null, not zero)`)
    }
    if (Number(syncResult.blankOrderNumber ?? 0) > 0) {
      log.push(`⚠ ${syncResult.blankOrderNumber} shipments arrived with no order number, `
        + `so they cannot be matched to a Zenventory order`)
    }
  } catch (err: any) {
    const msg = `✗ ShipStation sync FAILED: ${err.message}`
    log.push(msg)
    errors.push(msg)
  }

  // ── 2. Zenventory client mapping ───────────────────────────────────────────
  let clientResult: any = {}
  try {
    clientResult = await syncClientAssignments(7)
    // syncClientAssignments only throws when EVERY client failed — a partial
    // failure is its documented normal state, because two clients are 401ing
    // while their Zenventory 2.0 credentials are restored. So the tick here was
    // reporting "all clear" on a run that had lost whole clients. A client that
    // did not sync has no new orders, no picks and therefore no pick revenue,
    // which is exactly the kind of gap that reads downstream as a cheap month.
    const clientsFailed = Number(clientResult.clients_failed ?? 0)
    log.push(`${clientsFailed > 0 ? '⚠' : '✓'} Client mapping: `
      + `${clientResult.updated ?? 0} shipments assigned`
      + `${clientsFailed > 0 ? ` · ${clientsFailed} of `
        + `${(clientResult.clients_synced ?? 0) + clientsFailed} clients FAILED` : ''}`)
    if (clientsFailed > 0) {
      errors.push(`⚠ ${clientsFailed} Zenventory client${clientsFailed > 1 ? 's' : ''} did `
        + `not sync, so ${clientsFailed > 1 ? 'their' : 'its'} orders and picks are `
        + `missing from this pass: ${(clientResult.errors ?? []).join('; ')}`)
    }
    // Picked lines the sync refused to date because it had no continuous
    // observation to date them from. Not an error — declining to invent a date
    // is the correct behaviour — but those lines produce no pick charge at all
    // until a real date arrives, so the count cannot go unsaid.
    if (Number(clientResult.undated_picks ?? 0) > 0) {
      errors.push(`⚠ ${clientResult.undated_picks} picked lines have no pick date, `
        + `because the sync had no recent prior run to date them from (see `
        + `watermarkIsEvidence in src/lib/ledger/pick-date.ts). They are NOT billed `
        + `until dated. This is expected on the first run after an outage.`)
    }
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
      // The sweep refused to delete. Either it could not count the stale
      // candidates, or there were more of them than this run built rows for —
      // the signature of a run that priced almost nothing (a rate-card typo, an
      // empty rate window) and would otherwise have deleted the previous,
      // correct revenue rows and left nothing in their place. The refusal saved
      // the data; it also means order_charges now holds rows from two different
      // runs and the totals may double-count until someone looks.
      if (chargeResult.staleDeleteRefused > 0) {
        errors.push(`⚠ The stale-charge sweep REFUSED to delete `
          + `${chargeResult.staleDeleteRefused} old charge rows, because that is more `
          + `than the ${chargeResult.upserted} rows this run wrote. That pattern means `
          + `the run priced far less than it should have — check the rate cards and `
          + `cost_rates effective dates before trusting this month's totals, which `
          + `may now contain charges from two runs.`)
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
  // The work itself lives in src/lib/ledger/persist-storage-charges.ts — see the
  // header there for why it is a module and not a block in this handler.
  //
  // GATED ON THE CHARGE RUN HAVING ACTUALLY RUN. AutoSync.tsx polls this route
  // every five minutes from every open browser tab, and an ungated storage block
  // ran on all of them — including while another run held the lock and was
  // mid-write, where both would SELECT, find nothing, both INSERT, and the
  // client-keyed unique index would raise 23505. Piggybacking on
  // recalculateCharges' lock and throttle costs nothing: storage is declared
  // monthly, so there is no version of this that needs to run more often than
  // charges do.
  let storageResult: StorageResult | null = null
  if (chargeResult && !chargeResult.skipped) {
    try {
      storageResult = await persistStorageCharges()
      if (storageResult.skipped) {
        // A missing client_storage_months table before ledger_07_storage.sql has
        // been pasted in is the EXPECTED day-one state, not an incident. It goes
        // in the log, never in errors[] — otherwise all three crons send a
        // 🚨 subject line and every dashboard toasts every five minutes until
        // somebody runs the file.
        log.push(`⏭ Storage charges: skipped — ${storageResult.reason}`)
      } else {
        const s = storageResult
        // No ✓ for a zero write. This is the route whose header is a post-mortem
        // on an "All clear" email that actually meant "it never ran"; a green
        // tick beside `0 written` is the same claim in miniature.
        if (s.written > 0 || s.cleared > 0) {
          log.push(`✓ Storage charges: ${s.written} written (${s.inserted} new · `
            + `${s.updated} updated) · ${s.cleared} stale removed · `
            + `${s.months} client-months`)
        } else {
          log.push(`· Storage charges: nothing written — ${s.months} client-months read, `
            + `${s.undeclaredMonths} with no counts declared`)
        }
        if (s.estimatedCharges > 0) {
          log.push(`⚠ ${s.estimatedCharges} storage charges are estimates (the count was `
            + `declared rather than counted, or the cost rate is itself an estimate)`)
        }
        if (s.undeclaredMonths > 0) {
          log.push(`⚠ ${s.undeclaredMonths} client-months have a storage declaration row `
            + `with no counts in it — nobody has answered, which is not the same as `
            + `a client who stored nothing`)
        }
        if (s.orphanedCharges > 0) {
          errors.push(`⚠ ${s.orphanedCharges} storage charge${s.orphanedCharges > 1 ? 's' : ''} `
            + `have no declaration row — the declaration was deleted rather than zeroed, `
            + `so these charges can never be corrected automatically. Zero the counts `
            + `instead of deleting the row, or delete these charges by hand.`)
        }
        for (const w of s.warnings) log.push(w)
        for (const e of s.errors) errors.push(e)
      }
    } catch (err) {
      const msg = `✗ Storage charge sync FAILED: `
        + `${err instanceof Error ? err.message : String(err)}`
      log.push(msg)
      errors.push(msg)
    }
  } else {
    // Not an error of its own. When the charge run was skipped for any reason
    // other than the throttle, the block above has already put that in errors[],
    // and saying it twice would double every alert.
    log.push(`⏭ Storage charges: skipped — the charge run did not execute this pass`)
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
      storage: storageResult,
      losses: { count: lossCount, total: totalLoss },
      adjustments: { count: adjCount, total: adjTotal },
      unassigned: unassignedCount,
      unpriced: unpricedCount,
    },
    email: emailResult,
  })
}
