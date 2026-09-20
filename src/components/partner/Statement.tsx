import { supabaseAdmin } from '@/lib/supabase'
import {
  computeOwed,
  buildStatement,
  REFERRAL_TERMS,
  FOUNDING_CLIENT_TERMS,
  type ReferralPartner,
  type ReferredClient,
  type FbaInvoice,
  type PayoutRecord,
  type PayoutStatus,
} from '@/lib/referrals'
import SignOutButton from '@/components/partner/SignOutButton'

// The partner-facing statement. Server component — every figure is
// computed here and only the rendered numbers reach the browser.
//
// What a partner may see is fixed: summary totals and the four cost
// categories. Never a rate card, never line items, never per-unit
// prices. See §4.6 of the partner agreement.

const fmt = (n: number) => `$${n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`
const fmtNeg = (n: number) => (n === 0 ? '—' : `-${fmt(n)}`)
const fmtInt = (n: number) => n.toLocaleString('en-US')

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

function prettyPeriod(period: string) {
  const [y, m] = period.split('-').map(Number)
  if (!y || !m) return period
  return `${MONTH_NAMES[m - 1]} ${y}`
}

export interface StatementPartner {
  id: string
  name: string
  company: string | null
  email?: string | null
  status?: string | null
}

export default async function Statement({ partner }: { partner: StatementPartner }) {
  const [clientsRes, invoicesRes, payoutsRes] = await Promise.all([
    supabaseAdmin
      .from('clients')
      .select(
        'id, name, referral_partner_id, referral_signup_date, referral_first_payment_date, founding_bonus_seq',
      )
      .eq('referral_partner_id', partner.id),
    supabaseAdmin
      .from('fba_invoices')
      .select('id, client_id, period, amount, units_shipped, orders_shipped, cost_freight, cost_materials, cost_storage, cost_processing'),
    supabaseAdmin
      .from('referral_payouts')
      .select('id, dedupe_key, status, amount, approved_at, paid_at')
      .eq('referral_partner_id', partner.id),
  ])

  const clients = (clientsRes.data ?? []) as ReferredClient[]
  const clientIds = new Set(clients.map((c) => c.id))
  // Only this partner's clients' invoices ever reach the page.
  const invoices = ((invoicesRes.data ?? []) as FbaInvoice[]).filter((i) => clientIds.has(i.client_id))
  const payouts = (payoutsRes.data ?? []) as PayoutRecord[]

  // provisionalPlaces: false — and this is not an optimisation.
  //
  // `clients` here is ONE partner's clients. Launch places are ranked
  // across every referred client in the system, so ranking them inside
  // this slice would hand out places 1..10 among this partner's clients
  // alone and print a $500 bonus for someone who is really 40th in line.
  // Only a place already written to the client row is true when read
  // from here, so only those are honoured.
  const lines = computeOwed([partner as ReferralPartner], clients, invoices, payouts, {
    provisionalPlaces: false,
  })

  // Does this partner hold any launch-offer client? Drives one extra
  // paragraph below. Read from the STORED place for the same reason the
  // ranking is: a provisional place is not a fact yet, and a partner
  // should not be told terms that may turn out not to be theirs.
  const hasLaunchClient = clients.some((c) => c.founding_bonus_seq != null)
  const s = buildStatement(partner.id, clients, lines, invoices)

  return (
    <div className="space-y-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">{partner.name}</h1>
          <p className="text-sm text-gray-400 mt-1">
            {partner.company ? `${partner.company} · ` : ''}
            {s.activeClients === 1 ? '1 referred client' : `${s.activeClients} referred clients`}
          </p>
        </div>
        <SignOutButton />
      </div>

      {/* ---- Headline numbers ---- */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Stat label="Earned to date" value={fmt(s.lifetimeEarned)} sub="Bonuses + commission" tone="blue" />
        <Stat label="Paid to you" value={fmt(s.paidToDate)} sub="Settled" tone="green" />
        <Stat label="Awaiting payment" value={fmt(s.awaitingPayment)} sub="Approved or in review" tone="yellow" />
        <Stat
          label="Carried forward"
          value={fmt(s.carryForward)}
          sub={`Under the ${fmt(REFERRAL_TERMS.MIN_PAYOUT)} minimum`}
          tone="gray"
        />
      </div>

      {/* ---- Monthly statements ---- */}
      {s.months.length === 0 ? (
        <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-8 text-center">
          <p className="text-gray-300 font-medium">No statement yet</p>
          <p className="text-gray-500 text-sm mt-2 max-w-md mx-auto">
            Your first statement appears once a client you referred has paid their first invoice. Nothing is missing —
            there is simply nothing to report yet.
          </p>
        </div>
      ) : (
        s.months.map((m) => (
          <section key={m.period} className="rounded-xl border border-gray-800 bg-gray-900/40 overflow-hidden">
            <div className="flex items-baseline justify-between border-b border-gray-800 px-5 py-4">
              <h2 className="font-semibold">{prettyPeriod(m.period)}</h2>
              <span className="text-sm text-gray-400">
                Earned this month <span className="text-white font-semibold ml-1">{fmt(m.earned)}</span>
              </span>
            </div>

            <div className="divide-y divide-gray-800">
              {m.clients.map((c) => (
                <div key={c.dedupeKey} className="px-5 py-4">
                  <div className="flex items-center justify-between mb-3">
                    <span className="font-medium text-gray-100">{c.clientName}</span>
                    <Badge status={c.status} />
                  </div>
                  <dl className="text-sm">
                    {/* Only the line that applies. A DTC client has no
                        prep unit count and an FBA client has no order
                        count, so rendering both would print a "0" that
                        tells this partner their client shipped nothing. */}
                    {c.units !== null && <Row label="Units shipped" value={fmtInt(c.units)} />}
                    {c.orders !== null && <Row label="Orders shipped" value={fmtInt(c.orders)} />}
                    <Row label="Total billed" value={fmt(c.billed)} />
                    <Row label="Freight &amp; carrier" value={fmtNeg(c.costs.freight)} indent />
                    <Row label="Packaging &amp; materials" value={fmtNeg(c.costs.materials)} indent />
                    <Row label="Storage" value={fmtNeg(c.costs.storage)} indent />
                    <Row label="Payment processing" value={fmtNeg(c.costs.processing)} indent />
                    <Row label="Net profit" value={fmt(c.netProfit)} rule />
                    <Row
                      label={`Your share (${(REFERRAL_TERMS.COMMISSION_RATE * 100).toFixed(0)}%)`}
                      value={fmt(c.share)}
                      emphasis
                    />
                  </dl>
                </div>
              ))}

              {m.bonuses.map((b) => (
                <div key={b.dedupeKey} className="px-5 py-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="font-medium text-gray-100">{b.clientName}</span>
                      <span className="block text-xs text-gray-500 mt-0.5">
                        One-time referral bonus — first invoice paid
                      </span>
                    </div>
                    <div className="text-right">
                      <span className="font-semibold text-gray-100">{fmt(b.amount)}</span>
                      <span className="block mt-1"><Badge status={b.status} /></span>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {(m.carriedIn > 0 || m.carriedOut > 0) && (
              <div className="border-t border-gray-800 bg-gray-900/60 px-5 py-3 text-xs text-gray-400 space-y-1">
                {m.carriedIn > 0 && <p>Carried in from the previous month: {fmt(m.carriedIn)}</p>}
                {m.carriedOut > 0 ? (
                  <p>
                    Running balance {fmt(m.carriedOut)} is under the {fmt(REFERRAL_TERMS.MIN_PAYOUT)} minimum, so it rolls
                    into next month.
                  </p>
                ) : (
                  <p>Payable this month, including the carried balance: {fmt(m.payable)}</p>
                )}
              </div>
            )}
          </section>
        ))
      )}

      {/* ---- How this is calculated ---- */}
      <section className="rounded-xl border border-gray-800 bg-gray-900/20 p-5 text-sm text-gray-400 leading-relaxed space-y-3">
        <h2 className="font-semibold text-gray-200">How this is calculated</h2>
        <p>
          You earn <span className="text-gray-200">${REFERRAL_TERMS.SIGNUP_BONUS}</span> once per referred client, after
          that client has been active 60 days, has billed $500 or more in a single calendar month, and has paid its first
          invoice.
        </p>
        <p>
          On top of that you earn{' '}
          <span className="text-gray-200">{(REFERRAL_TERMS.COMMISSION_RATE * 100).toFixed(0)}% of net profit</span>{' '}
          on that client&apos;s account, every month for {REFERRAL_TERMS.COMMISSION_MONTHS} months from their first paid
          invoice.
        </p>
        {hasLaunchClient && (
          <p>
            <span className="text-gray-200">Launch offer.</span> One or more of the clients above qualified under
            Shipo&apos;s launch offer. For those clients the one-time bonus is{' '}
            <span className="text-gray-200">${FOUNDING_CLIENT_TERMS.BONUS}</span> instead of $
            {REFERRAL_TERMS.SIGNUP_BONUS}, and their {(REFERRAL_TERMS.COMMISSION_RATE * 100).toFixed(0)}% begins in the
            client&apos;s <span className="text-gray-200">second</span> month rather than their first — still{' '}
            {REFERRAL_TERMS.COMMISSION_MONTHS} monthly payments in total. Everything else on this page works the same
            way.
          </p>
        )}
        <p>
          <span className="text-gray-200">Net profit</span> means the amount invoiced to the client for the month, less
          the direct costs of serving that account — freight and carrier charges, packaging and prep materials, storage,
          and payment-processing fees. Charges billed at cost, such as freight, duties and Amazon fees, generate no
          profit and are excluded entirely.
        </p>
        <p>
          Payment is made within 30 days of the end of the month shown. A balance under{' '}
          {fmt(REFERRAL_TERMS.MIN_PAYOUT)} rolls into the following month and is paid once it clears{' '}
          {fmt(REFERRAL_TERMS.MIN_PAYOUT)}. We can only pay once we hold your completed W-9 or W-8 form.
        </p>
        <p className="text-gray-500">
          Figures are calculated in good faith from Shipo&apos;s books. If you disagree with a statement, tell us in
          writing within 30 days of receiving it.
        </p>
      </section>
    </div>
  )
}

function Row({
  label,
  value,
  indent,
  rule,
  emphasis,
}: {
  label: string
  value: string
  indent?: boolean
  rule?: boolean
  emphasis?: boolean
}) {
  return (
    <div
      className={[
        'flex items-baseline justify-between py-1',
        rule ? 'border-t border-gray-800 mt-1 pt-2' : '',
        emphasis ? 'text-white font-semibold' : '',
      ].join(' ')}
    >
      <dt className={indent ? 'pl-4 text-gray-500' : 'text-gray-400'} dangerouslySetInnerHTML={{ __html: label }} />
      <dd className={emphasis ? '' : indent ? 'text-gray-500 tabular-nums' : 'text-gray-200 tabular-nums'}>{value}</dd>
    </div>
  )
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub: string; tone: string }) {
  const tones: Record<string, string> = {
    blue: 'border-[#00AAFF]/20 bg-[#00AAFF]/5',
    green: 'border-green-800/50 bg-green-950/40',
    yellow: 'border-yellow-800/50 bg-yellow-950/30',
    gray: 'border-gray-800 bg-gray-900/40',
  }
  return (
    <div className={`rounded-xl border p-4 ${tones[tone] ?? tones.gray}`}>
      <p className="text-[11px] uppercase tracking-wider text-gray-400">{label}</p>
      <p className="text-xl font-bold text-white mt-1.5">{value}</p>
      <p className="text-[11px] text-gray-500 mt-1">{sub}</p>
    </div>
  )
}

function Badge({ status }: { status: PayoutStatus }) {
  // 'computed' means Shipo has not reviewed the line yet. A partner
  // should not see internal ledger jargon, so it reads "in review".
  const map: Record<string, { text: string; cls: string }> = {
    paid: { text: 'paid', cls: 'bg-green-900/50 text-green-400' },
    approved: { text: 'approved for payment', cls: 'bg-[#00AAFF]/15 text-[#00AAFF]' },
    pending: { text: 'in review', cls: 'bg-yellow-900/40 text-yellow-400' },
    computed: { text: 'in review', cls: 'bg-yellow-900/40 text-yellow-400' },
  }
  const v = map[status] ?? map.computed
  return <span className={`px-1.5 py-0.5 rounded text-[11px] ${v.cls}`}>{v.text}</span>
}
