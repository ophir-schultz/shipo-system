import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { requireStaff } from '@/lib/require-staff'
import {
  foundingPlaces,
  bonusAmount,
  FOUNDING_CLIENT_TERMS,
  type ReferralPartner,
  type ReferredClient,
  type FbaInvoice,
} from '@/lib/referrals'

/**
 * What this signup bonus is actually worth, decided server-side, and
 * the launch place taken permanently if one is going.
 *
 * Why the place is claimed HERE and not in `computeOwed`: `computeOwed`
 * is a pure function that re-derives the whole ordering on every page
 * load. If a place were only ever derived, entering a backdated invoice
 * for some other client would silently push an already-approved —
 * possibly already-paid — client out of their place, and the statement
 * would quietly restate money that has left the building. Approval is
 * the moment the place stops being an opinion, so approval is where it
 * gets written down.
 *
 * The fallback is the PARTNER'S OWN bonus, not the flat $300 constant.
 * A partner on bespoke contracted terms carries signup_bonus_amount on
 * their row, and paying them $300 because their client missed the
 * launch cap would underpay a signed agreement — a quieter and worse
 * failure than overpaying, because nobody would ever query it.
 */
async function resolveBonusAmount(
  clientId: string,
): Promise<{ amount: number | null; error?: string }> {
  const [clientsRes, invoicesRes, partnersRes] = await Promise.all([
    supabaseAdmin
      .from('clients')
      .select('id, name, referral_partner_id, referral_signup_date, referral_first_payment_date, founding_bonus_seq'),
    supabaseAdmin.from('fba_invoices').select('id, client_id, period, amount, units_shipped, orders_shipped'),
    supabaseAdmin
      .from('referral_partners')
      .select('id, name, company, status, signup_bonus_amount, bonus_min_units, bonus_min_orders, bonus_min_revenue'),
  ])
  if (clientsRes.error) return { amount: null, error: clientsRes.error.message }
  if (invoicesRes.error) return { amount: null, error: invoicesRes.error.message }
  if (partnersRes.error) return { amount: null, error: partnersRes.error.message }

  const clients = (clientsRes.data ?? []) as ReferredClient[]
  const invoices = (invoicesRes.data ?? []) as FbaInvoice[]
  const partners = (partnersRes.data ?? []) as ReferralPartner[]

  const mine = clients.find((c) => c.id === clientId)
  if (!mine) return { amount: null, error: 'Client not found.' }

  const partner = partners.find((p) => p.id === mine.referral_partner_id)
  if (!partner) return { amount: null, error: 'This client is not linked to a referral partner.' }
  const standing = bonusAmount(partner)

  // Already holds a place — idempotent, and never re-numbered.
  if (mine.founding_bonus_seq != null) return { amount: FOUNDING_CLIENT_TERMS.BONUS }

  const seq = foundingPlaces(clients, invoices).place.get(clientId)
  if (seq === undefined) return { amount: standing } // missed the bar, or the 10 are gone

  const { error } = await supabaseAdmin
    .from('clients')
    .update({ founding_bonus_seq: seq })
    .eq('id', clientId)
    .is('founding_bonus_seq', null) // never overwrite a place already recorded
  if (error) {
    // Almost certainly the unique index: another approval took this
    // number between the read and the write. Refusing is correct — the
    // ordering has moved and the next click will compute it afresh.
    return {
      amount: null,
      error: `Launch place ${seq} was taken while you were approving. Nothing was saved — click Approve again.`,
    }
  }

  return { amount: FOUNDING_CLIENT_TERMS.BONUS }
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
  const row: Record<string, unknown> = {
    dedupe_key,
    referral_partner_id: body.referral_partner_id ?? null,
    client_id: body.client_id ?? null,
    kind: body.kind ?? 'commission',
    period: body.period ?? null,
    amount: Number(body.amount ?? 0),
    fba_invoice_id: body.fba_invoice_id ?? null,
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
