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

const ALERT_TO = process.env.ALERT_EMAIL || 'ophir@shipousa.com'
const SECRET   = process.env.MONITOR_SECRET  // optional bearer token guard

export async function GET(req: Request) {
  // Optional secret guard so only Vercel cron (or you) can trigger it
  if (SECRET) {
    const auth = req.headers.get('authorization') ?? ''
    if (auth !== `Bearer ${SECRET}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
  }

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
    const res = await fetch(new URL('/api/sync/recalculate', process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000').toString(), { method: 'POST' })
    recalcStats = await res.json()
    log.push(`✓ Recalculate: ${recalcStats.updated} shipments · ${recalcStats.zone_matched} zone-matched · ${recalcStats.legacy_matched} rate-card · ${recalcStats.unmatched} unmatched`)
    if (recalcStats.unmatched > 0) {
      errors.push(`⚠ ${recalcStats.unmatched} shipments have no rate match (check zone matrix / rate cards)`)
    }
  } catch (err: any) {
    const msg = `✗ Recalculate FAILED: ${err.message}`
    log.push(msg)
    errors.push(msg)
  }

  // ── 4. Scan for problems ───────────────────────────────────────────────────

  // 4a. Unpriced shipments (has a client but client_rate is 0)
  const { data: unpriced, count: unpricedCount } = await supabaseAdmin
    .from('shipments')
    .select('order_number, clients(name)', { count: 'exact' })
    .not('client_id', 'is', null)
    .eq('client_rate', 0)
    .limit(20)

  if (unpricedCount && unpricedCount > 0) {
    errors.push(`⚠ ${unpricedCount} shipments have a client assigned but NO rate (client_rate = $0)`)
    log.push(`⚠ ${unpricedCount} unpriced shipments`)
  }

  // 4b. Current loss shipments
  const { count: lossCount } = await supabaseAdmin
    .from('shipments')
    .select('*', { count: 'exact', head: true })
    .eq('is_loss', true)

  const { data: lossSum } = await supabaseAdmin
    .from('shipments')
    .select('profit_loss')
    .eq('is_loss', true)

  const totalLoss = (lossSum ?? []).reduce((s, r) => s + Math.abs(r.profit_loss ?? 0), 0)

  if ((lossCount ?? 0) > 0) {
    log.push(`⚠ ${lossCount} loss shipments · total -$${totalLoss.toFixed(2)}`)
  } else {
    log.push(`✓ No loss shipments`)
  }

  // 4c. Pending carrier adjustments
  const { data: adjustments, count: adjCount } = await supabaseAdmin
    .from('rate_adjustments')
    .select('adjustment_amount, clients(name)', { count: 'exact' })
    .eq('status', 'pending')
    .limit(20)

  const adjTotal = (adjustments ?? []).reduce((s, r) => s + (r.adjustment_amount ?? 0), 0)

  if ((adjCount ?? 0) > 0) {
    log.push(`🔔 ${adjCount} pending carrier adjustments · +$${adjTotal.toFixed(2)} to recover`)
  } else {
    log.push(`✓ No pending adjustments`)
  }

  // 4d. Shipments with no client assigned
  const { count: unassignedCount } = await supabaseAdmin
    .from('shipments')
    .select('*', { count: 'exact', head: true })
    .is('client_id', null)

  if ((unassignedCount ?? 0) > 0) {
    log.push(`⚠ ${unassignedCount} shipments have no client assigned`)
  }

  // ── 5. Send email report ───────────────────────────────────────────────────
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
          Loss shipments: ${lossCount ?? 0} (-$${totalLoss.toFixed(2)}) &nbsp;·&nbsp;
          Pending adjustments: ${adjCount ?? 0} (+$${adjTotal.toFixed(2)}) &nbsp;·&nbsp;
          Unassigned: ${unassignedCount ?? 0}
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
      losses: { count: lossCount, total: totalLoss },
      adjustments: { count: adjCount, total: adjTotal },
      unassigned: unassignedCount,
      unpriced: unpricedCount,
    },
    email: emailResult,
  })
}
