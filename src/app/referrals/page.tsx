import { supabaseAdmin } from '@/lib/supabase'
import { computeOwed, summarize, REFERRAL_TERMS } from '@/lib/referrals'
import type { ReferralPartner, ReferredClient, FbaInvoice, PayoutRecord } from '@/lib/referrals'
import { read, readErrors, loaded, isMigrationMissing, type LoadedData } from '@/lib/db/read'
import ViewUnreadable from '@/components/ui/ViewUnreadable'
import ReferralsManager from '@/components/referrals/ReferralsManager'

export const dynamic = 'force-dynamic'

// This page says who to pay and how much, and the amounts are not read out of a
// column -- computeOwed derives them from partners x clients x invoices x
// payouts. All four reads ended `?? []`, so a read that failed did not blank a
// figure, it CHANGED one:
//
//   invoices missing -> commission on net profit computes to nothing, and a
//                       partner who is owed money appears to be owed none
//   payouts missing  -> the ledger of what has already been paid comes back
//                       empty, so bonuses and commissions already settled
//                       reappear as outstanding and get paid a second time
//
// The second direction is the one that moves money. Nothing here pays
// automatically -- every payout is held at `pending` until it is approved by
// hand -- but approving is done by reading this screen, so a screen that errs
// in the double-pay direction has consumed the entire safety margin.

async function getData() {
  const [partnersRes, clientsRes, invoicesRes, payoutsRes] = await Promise.all([
    supabaseAdmin
      .from('referral_partners')
      .select(
        'id, name, company, email, phone, partner_type, refer_method, status, notes, source, created_at, portal_last_seen_at, signup_bonus_amount, bonus_min_units, bonus_min_orders, bonus_min_revenue, founding_partner',
      )
      .order('created_at', { ascending: false }),
    supabaseAdmin
      .from('clients')
      .select(
        'id, name, active, referral_partner_id, referral_signup_date, referral_first_payment_date, founding_bonus_seq',
      )
      .order('name'),
    supabaseAdmin
      .from('fba_invoices')
      .select(
        'id, client_id, period, amount, units_shipped, orders_shipped, cost_freight, cost_materials, cost_storage, cost_processing, notes',
      )
      .order('period', { ascending: false }),
    supabaseAdmin
      .from('referral_payouts')
      .select('id, dedupe_key, status, amount, approved_at, paid_at, kind, period, client_id, referral_partner_id')
      .order('created_at', { ascending: false }),
  ])

  // `referral_partners` and `fba_invoices` are the two tables the migration
  // creates, so they are the two that can legitimately be absent on a fresh
  // database. Asked by error CODE now rather than by `!res.error`, which made
  // every transient failure claim the tables were never created and told the
  // operator to paste three .sql files at a database that was fine.
  const migrationMissing =
    isMigrationMissing(partnersRes) || isMigrationMissing(invoicesRes)

  const partners = read('referral_partners', partnersRes)
  const clients = read('clients', clientsRes)
  const invoices = read('fba_invoices', invoicesRes)
  const payouts = read('referral_payouts', payoutsRes)

  // Migration first: a missing relation is also a failed read, and burying the
  // actionable yellow banner under an opaque red one on day one would make the
  // app look broken on the one occasion it is merely new.
  const unreadable = migrationMissing
    ? null
    : readErrors(partners, clients, invoices, payouts)

  return {
    migrationMissing,
    // Inside the thunk, so on the failure path computeOwed never runs. It is
    // not that its answer would be wrong and discarded -- it is that a full set
    // of plausible amounts-owed should not exist in the program at all.
    page: loaded(unreadable, () => {
      const owed = computeOwed(
        partners.rows as ReferralPartner[],
        clients.rows as ReferredClient[],
        invoices.rows as FbaInvoice[],
        payouts.rows as PayoutRecord[],
      )
      return {
        partners: partners.rows,
        clients: clients.rows,
        invoices: invoices.rows,
        owed,
        totals: summarize(owed),
      }
    }),
  }
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

      {d.migrationMissing && (
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

      {d.page.ok
        ? <Manager data={d.page.data} />
        : <ViewUnreadable message={d.page.error} />}
    </div>
  )
}

// Split out so the payload gets an annotation. ReferralsManager's props are
// loosely typed enough that `undefined` would pass straight through them, so
// without this the refusal above gates nothing -- the same hole that made the
// /billing and /reports checks ornamental. See LoadedData.
function Manager({ data }: { data: LoadedData<Awaited<ReturnType<typeof getData>>['page']> }) {
  return (
    <ReferralsManager
      partners={data.partners}
      clients={data.clients}
      invoices={data.invoices}
      owed={data.owed}
      totals={data.totals}
    />
  )
}
