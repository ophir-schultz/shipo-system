import { supabaseAdmin } from '@/lib/supabase'
import { computeOwed, summarize, REFERRAL_TERMS } from '@/lib/referrals'
import type { ReferralPartner, ReferredClient, FbaInvoice, PayoutRecord } from '@/lib/referrals'
import ReferralsManager from '@/components/referrals/ReferralsManager'

export const dynamic = 'force-dynamic'

async function getData() {
  const [partnersRes, clientsRes, invoicesRes, payoutsRes] = await Promise.all([
    supabaseAdmin
      .from('referral_partners')
      .select(
        'id, name, company, email, phone, partner_type, refer_method, status, notes, source, created_at, portal_last_seen_at',
      )
      .order('created_at', { ascending: false }),
    supabaseAdmin
      .from('clients')
      .select('id, name, active, referral_partner_id, referral_signup_date, referral_first_payment_date')
      .order('name'),
    supabaseAdmin
      .from('fba_invoices')
      .select(
        'id, client_id, period, amount, units_shipped, cost_freight, cost_materials, cost_storage, cost_processing, notes',
      )
      .order('period', { ascending: false }),
    supabaseAdmin
      .from('referral_payouts')
      .select('id, dedupe_key, status, amount, approved_at, paid_at, kind, period, client_id, referral_partner_id')
      .order('created_at', { ascending: false }),
  ])

  const migrationApplied = !partnersRes.error && !invoicesRes.error

  const partners = (partnersRes.data ?? []) as any[]
  const clients = (clientsRes.data ?? []) as any[]
  const invoices = (invoicesRes.data ?? []) as any[]
  const payouts = (payoutsRes.data ?? []) as any[]

  const owed = computeOwed(
    partners as ReferralPartner[],
    clients as ReferredClient[],
    invoices as FbaInvoice[],
    payouts as PayoutRecord[],
  )
  const totals = summarize(owed)

  return { migrationApplied, partners, clients, invoices, owed, totals }
}

export default async function ReferralsPage() {
  const d = await getData()

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-white">Referral Payouts</h2>
        <p className="text-gray-400 text-sm mt-1">
          Who to pay and how much. <span className="text-gray-300">${REFERRAL_TERMS.SIGNUP_BONUS}</span> one-time after the referred
          client&apos;s first payment, plus <span className="text-gray-300">{(REFERRAL_TERMS.COMMISSION_RATE * 100).toFixed(0)}%</span> of{' '}
          <span className="text-gray-300">net profit</span> on that account for{' '}
          <span className="text-gray-300">{REFERRAL_TERMS.COMMISSION_MONTHS} months</span> from their first paid invoice. Every payout
          stays <span className="text-yellow-400">pending</span> until you approve it — nothing is ever paid automatically.
        </p>
      </div>

      {!d.migrationApplied && (
        <div className="rounded-xl p-4 border border-yellow-700/50 bg-yellow-950/30">
          <p className="text-yellow-300 text-sm font-medium">⚠ Referral tables not created yet</p>
          <p className="text-yellow-500/80 text-xs mt-1">
            Run <span className="font-mono">supabase/referral_program.sql</span>, then{' '}
            <span className="font-mono">supabase/partner_portal.sql</span>, then{' '}
            <span className="font-mono">supabase/partner_login.sql</span> in the Supabase SQL editor to enable partner
            tracking, monthly account entry, the payout ledger, the partner portal and partner logins.
          </p>
        </div>
      )}

      <ReferralsManager
        partners={d.partners}
        clients={d.clients}
        invoices={d.invoices}
        owed={d.owed}
        totals={d.totals}
      />
    </div>
  )
}
