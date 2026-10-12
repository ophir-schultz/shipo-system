import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { requireStaff } from '@/lib/require-staff'
import {
  bonusAmount,
  type ReferralPartner,
  type ReferredClient,
} from '@/lib/referrals'
import { isLedgerInvoiceId } from '@/lib/partner-ledger'

/**
 * What this signup bonus is actually worth, decided server-side.
 *
 * It is the PARTNER'S OWN bonus, not the flat $300 constant. A partner
 * admitted on bespoke contracted terms carries signup_bonus_amount on
 * their row, and paying them $300 instead would underpay a signed
 * agreement — a quieter and worse failure than overpaying, because
 * nobody would ever query it. bonusAmount() falls back to the standing
 * REFERRAL_TERMS.SIGNUP_BONUS when the row carries no figure.
 *
 * This used to also claim a launch place, writing
 * `clients.founding_bonus_seq` at the moment of approval and returning
 * $500. That offer was withdrawn on 2026-10-12 with no place ever
 * approved, so the write is gone and the column is dead. Approval no
 * longer writes to `clients` at all, which is why this function no
 * longer reads every client and every invoice in the system to answer a
 * question about one client.
 */
async function resolveBonusAmount(
  clientId: string,
): Promise<{ amount: number | null; error?: string }> {
  const { data: client, error: clientErr } = await supabaseAdmin
    .from('clients')
    .select('id, name, referral_partner_id, referral_signup_date, referral_first_payment_date')
    .eq('id', clientId)
    .maybeSingle()
  if (clientErr) return { amount: null, error: clientErr.message }

  const mine = client as ReferredClient | null
  if (!mine) return { amount: null, error: 'Client not found.' }
  if (!mine.referral_partner_id) {
    return { amount: null, error: 'This client is not linked to a referral partner.' }
  }

  const { data: partnerRow, error: partnerErr } = await supabaseAdmin
    .from('referral_partners')
    .select('id, name, company, status, signup_bonus_amount, bonus_min_units, bonus_min_orders, bonus_min_revenue')
    .eq('id', mine.referral_partner_id)
    .maybeSingle()
  if (partnerErr) return { amount: null, error: partnerErr.message }

  const partner = partnerRow as ReferralPartner | null
  if (!partner) return { amount: null, error: 'This client is not linked to a referral partner.' }

  return { amount: bonusAmount(partner) }
}

// The payout ledger. This records / advances a payout's approval
// state. It NEVER sends money — 'paid' only means Ophir has marked
// it settled outside the system.
//
// Body: {
//   action: 'pending' | 'approve' | 'paid' | 'unrecord',
//   dedupe_key, referral_partner_id, client_id, kind, period, amount,
//   fba_invoice_id?
// }
export async function POST(req: Request) {
  const denied = await requireStaff()
  if (denied) return denied

  const body = await req.json()
  const { action, dedupe_key } = body

  if (!action || !dedupe_key) {
    return NextResponse.json({ error: 'action and dedupe_key are required.' }, { status: 400 })
  }

  if (action === 'unrecord') {
    const { error } = await supabaseAdmin.from('referral_payouts').delete().eq('dedupe_key', dedupe_key)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true })
  }

  const now = new Date().toISOString()

  // A month that exists only in the ledger has no fba_invoices row, so
  // computeOwed stamps it with a synthetic 'ledger:<client>:<month>' id.
  // referral_payouts.fba_invoice_id is a real uuid FK, so forwarding one
  // fails — 22P02 on the cast, or 23503 on the key. The column is
  // nullable and informational, so dropping it is the right answer and
  // the payout still records correctly. Guarding HERE because this route
  // is the only write path to the table.
  const fbaInvoiceId = isLedgerInvoiceId(body.fba_invoice_id) ? null : (body.fba_invoice_id ?? null)

  const row: Record<string, unknown> = {
    dedupe_key,
    referral_partner_id: body.referral_partner_id ?? null,
    client_id: body.client_id ?? null,
    kind: body.kind ?? 'commission',
    period: body.period ?? null,
    amount: Number(body.amount ?? 0),
    fba_invoice_id: fbaInvoiceId,
    updated_at: now,
  }

  if (action === 'pending') {
    row.status = 'pending'
  } else if (action === 'approve') {
    // Derive the bonus amount server-side from the launch place. The
    // browser sends `amount`, and a stale tab is enough to send $500
    // for a place that was taken minutes ago by someone else. The only
    // trustworthy figure is the one computed at the moment of approval.
    if (row.kind === 'signup_bonus' && row.client_id) {
      const resolved = await resolveBonusAmount(String(row.client_id))
      if (resolved.amount === null) {
        return NextResponse.json({ error: resolved.error ?? 'Could not price this bonus.' }, { status: 409 })
      }
      row.amount = resolved.amount
    }
    row.status = 'approved'
    row.approved_by = 'Ophir'
    row.approved_at = now
  } else if (action === 'paid') {
    row.status = 'paid'
    row.paid_at = now
  } else {
    return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 })
  }

  const { error } = await supabaseAdmin
    .from('referral_payouts')
    .upsert(row, { onConflict: 'dedupe_key' })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}
