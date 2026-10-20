import { supabaseAdmin } from '@/lib/supabase'
import {
  computeOwed,
  summarize,
  REFERRAL_TERMS,
  type ReferralPartner,
  type PayoutRecord,
} from '@/lib/referrals'
import {
  loadPartnerLedger,
  monthKey,
  reconcile,
  type LedgerMonth,
  type PartnerLedger,
} from '@/lib/partner-ledger'

// What we owe each referral partner, and every charge behind it.
//
// Spec: docs/superpowers/specs/2026-10-11-partner-ledger-statements-design.md
//
// This is the INTERNAL twin of src/components/partner/Statement.tsx. Both read
// loadPartnerLedger(), which is the entire point: the partner's statement and
// this screen cannot disagree about what we owe, because they cannot reach
// different numbers. Where they differ is disclosure, not arithmetic — a
// partner sees date/order/billed, and this screen also shows charge type and
// cost, because it is ours.
//
// It is also deliberately NOT part of getPnlData()'s all-or-nothing refusal.
// That page refuses as a whole because its headline figures are sums across
// six tables and one failed read silently moves a total. Nothing here feeds
// those figures, and the two views this reads are created by a migration that
// may not be applied yet — folding them into that refusal would blank the
// entire P&L page until someone runs a SQL file.

const fmt = (n: number) => `$${n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`
const fmtNeg = (n: number) => (n === 0 ? '—' : `-${fmt(n)}`)
const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0)

/** Newest-first cap on the internal charge read. See CHARGE_LIMIT below. */
const CHARGE_LIMIT = 4000

interface ChargeRow {
  order_id: string | null
  client_id: string
  charge_type: string
  label: string
  charge_date: string
  amount: number | null
  cost: number | null
  is_estimate: boolean
  orders: { order_number: string | null } | null
}

/**
 * Every charge behind these clients, for the internal drilldown.
 *
 * Read from order_charges directly rather than from any partner-facing view,
 * because those have no cost column — by design, since they are what the
 * partner's page reads. The partner path now reads partner_order_units, which
 * has no money column at all. Internally we want the charge type and the cost,
 * so this goes to the base table.
 *
 * Ordered newest-first so the cap can only ever hide the oldest charges, and
 * the caller says so when it bites.
 */
async function loadCharges(clientIds: string[]) {
  if (clientIds.length === 0) return { rows: [] as ChargeRow[], truncated: false, failed: false }

  const res = await supabaseAdmin
    .from('order_charges')
    .select('order_id, client_id, charge_type, label, charge_date, amount, cost, is_estimate, orders(order_number)')
    .in('client_id', clientIds)
    .order('charge_date', { ascending: false })
    .limit(CHARGE_LIMIT)

  if (res.error) return { rows: [] as ChargeRow[], truncated: false, failed: true }
  const rows = (res.data ?? []) as unknown as ChargeRow[]
  return { rows, truncated: rows.length >= CHARGE_LIMIT, failed: false }
}

interface PartnerBlock {
  partner: ReferralPartner
  ledger: PartnerLedger
  payouts: PayoutRecord[]
  totals: ReturnType<typeof summarize>
  chargesByClientMonth: Map<string, ChargeRow[]>
  chargesTruncated: boolean
  chargesFailed: boolean
}

export default async function PartnerPayouts() {
  const partnersRes = await supabaseAdmin
    .from('referral_partners')
    .select('id, name, company, status, signup_bonus_amount, bonus_min_units, bonus_min_orders, bonus_min_revenue')
    .order('name')

  if (partnersRes.error) {
    return <Shell note={`Could not read referral_partners: ${partnersRes.error.message}`} />
  }

  const partners = (partnersRes.data ?? []) as ReferralPartner[]
  if (partners.length === 0) {
    return <Shell note="No referral partners yet. Link a client to a partner on /referrals and the payout detail appears here." />
  }

  // One loadPartnerLedger() per partner rather than one wide read narrowed in
  // JS. It is more round trips and it is the right trade: this is the same
  // function the partner's own statement calls, so the two screens cannot
  // compute different figures from differently-shaped data.
  const blocks: PartnerBlock[] = await Promise.all(
    partners.map(async (partner) => {
      const [ledger, payoutsRes] = await Promise.all([
        loadPartnerLedger(partner.id),
        supabaseAdmin
          .from('referral_payouts')
          .select('id, dedupe_key, status, amount, approved_at, paid_at')
          .eq('referral_partner_id', partner.id),
      ])

      const payouts = (payoutsRes.data ?? []) as PayoutRecord[]
      const charges = await loadCharges(ledger.clients.map((c) => c.id))

      const chargesByClientMonth = new Map<string, ChargeRow[]>()
      for (const c of charges.rows) {
        const key = monthKey(c.client_id, c.charge_date.slice(0, 7))
        const list = chargesByClientMonth.get(key)
        if (list) list.push(c)
        else chargesByClientMonth.set(key, [c])
      }

      // One partner's clients at a time, which is safe: every figure
      // computeOwed derives is per-client. It was not safe while the launch
      // offer existed — places were ranked globally — but that offer was
      // withdrawn 2026-10-12 and the opt-out is gone with it.
      const lines = computeOwed([partner], ledger.clients, ledger.invoices, payouts)

      return {
        partner,
        ledger,
        payouts,
        totals: summarize(lines),
        chargesByClientMonth,
        chargesTruncated: charges.truncated,
        chargesFailed: charges.failed,
      }
    }),
  )

  // The views are created by supabase/partner_ledger.sql. Until it is applied
  // every partner comes back with no months, which would render as a page full
  // of partners who are owed nothing — the most reassuring possible way to
  // display a missing migration.
  const anyMonths = blocks.some((b) => b.ledger.months.length > 0)
  const anyClients = blocks.some((b) => b.ledger.clients.length > 0)

  // The heuristic above INFERS a broken read from its symptom. Now that the
  // loader reports errors, prefer the fact: "the view is missing" and "the
  // view is empty" look identical from here but are different jobs, and the
  // error text names which table failed.
  const readErrors = [
    ...new Set(blocks.map((b) => b.ledger.readFailed).filter(Boolean) as string[]),
  ]

  return (
    <Shell>
      {readErrors.length > 0 && (
        <div className="mb-4 rounded-lg border border-red-800/60 bg-red-950/30 px-4 py-3 text-xs text-red-300">
          <p className="font-semibold">⚠ A ledger read FAILED. Nothing below is a payable figure.</p>
          <ul className="mt-1.5 space-y-0.5 font-mono text-[11px] text-red-400/90">
            {readErrors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
          <p className="mt-1.5">
            A <span className="font-mono">42P01</span> here means{' '}
            <span className="font-mono">supabase/partner_ledger.sql</span> has not been applied.
          </p>
        </div>
      )}

      {readErrors.length === 0 && anyClients && !anyMonths && (
        <p className="mb-4 rounded-lg border border-yellow-800/60 bg-yellow-950/30 px-4 py-3 text-xs text-yellow-300">
          ⚠ These partners have referred clients, but the ledger returned no months for any of
          them. Either no charges are dated yet, or{' '}
          <span className="font-mono">supabase/partner_ledger.sql</span> has not been run — the two
          views this reads do not exist until it is. Figures below are not evidence of $0 owed.
        </p>
      )}

      <div className="space-y-6">
        {blocks.map((b) => (
          <PartnerSection key={b.partner.id} block={b} />
        ))}
      </div>
    </Shell>
  )
}

function Shell({ children, note }: { children?: React.ReactNode; note?: string }) {
  return (
    <div className="bg-gray-800 rounded-xl p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-semibold text-white">Partner Payout Detail</h3>
        <span className="text-xs text-gray-400">
          Every client, every month, every charge — from the ledger
        </span>
      </div>
      {note ? <p className="text-gray-500 text-sm">{note}</p> : children}
    </div>
  )
}

function PartnerSection({ block }: { block: PartnerBlock }) {
  const { partner, ledger, totals } = block

  // Months grouped by client, newest first. loadPartnerLedger already orders
  // period_month descending, so insertion order carries that through.
  const byClient = new Map<string, LedgerMonth[]>()
  for (const m of ledger.months) {
    const list = byClient.get(m.client_id)
    if (list) list.push(m)
    else byClient.set(m.client_id, [m])
  }

  return (
    <section className="rounded-xl border border-gray-700 overflow-hidden">
      <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-gray-700 bg-gray-900/50 px-4 py-3">
        <div>
          <span className="font-semibold text-white">{partner.name}</span>
          {partner.company && <span className="text-gray-500 text-sm ml-2">{partner.company}</span>}
          <span className="text-gray-500 text-xs ml-2">
            {ledger.clients.length === 1 ? '1 client' : `${ledger.clients.length} clients`}
          </span>
        </div>
        <div className="flex gap-5 text-xs">
          <Figure label="Owed" value={fmt(totals.owed)} tone="text-white" />
          <Figure label="In review" value={fmt(totals.pending)} tone="text-yellow-400" />
          <Figure label="Approved" value={fmt(totals.approved)} tone="text-[#00AAFF]" />
          <Figure label="Paid" value={fmt(totals.paid)} tone="text-green-400" />
        </div>
      </div>

      {ledger.clients.length === 0 ? (
        <p className="px-4 py-4 text-sm text-gray-500">No clients linked to this partner.</p>
      ) : (
        <div className="divide-y divide-gray-700/60">
          {ledger.clients.map((c) => (
            <ClientRows key={c.id} block={block} clientId={c.id} clientName={c.name} months={byClient.get(c.id) ?? []} />
          ))}
        </div>
      )}

      {block.chargesFailed && (
        <p className="border-t border-gray-700 px-4 py-2 text-xs text-red-300">
          ⚠ The charge detail could not be read. The monthly figures above come from the ledger
          views and are unaffected, but the drilldowns below are empty for the wrong reason.
        </p>
      )}
      {block.chargesTruncated && (
        <p className="border-t border-gray-700 px-4 py-2 text-xs text-gray-500">
          Charge drilldown capped at the most recent {CHARGE_LIMIT.toLocaleString('en-US')} charges.
          Older months list fewer charges than they contain; monthly totals are unaffected.
        </p>
      )}
      {ledger.orderUnitsTruncated && (
        <p className="border-t border-gray-700 px-4 py-2 text-xs text-gray-500">
          This partner has more than {ledger.orderUnits.length.toLocaleString('en-US')} orders, so
          the order count shown for older months falls back to the hand-recorded figure or nothing
          at all, never to a count of the rows that survived the cap.
        </p>
      )}
    </section>
  )
}

function ClientRows({
  block,
  clientId,
  clientName,
  months,
}: {
  block: PartnerBlock
  clientId: string
  clientName: string
  months: LedgerMonth[]
}) {
  return (
    <div className="px-4 py-3">
      <div className="flex items-baseline gap-2 mb-2">
        <span className="text-sm font-medium text-gray-200">{clientName}</span>
        {months.length === 0 && (
          <span className="text-xs text-gray-500">no ledger months — nothing charged yet</span>
        )}
      </div>

      {months.length > 0 && (
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-gray-500 border-b border-gray-700/60 uppercase tracking-wide">
              <th className="pb-1.5 pr-3 font-medium">Month</th>
              <th className="pb-1.5 pr-3 font-medium text-right">Billed</th>
              <th className="pb-1.5 pr-3 font-medium text-right">Freight</th>
              <th className="pb-1.5 pr-3 font-medium text-right">Materials</th>
              <th className="pb-1.5 pr-3 font-medium text-right">Storage</th>
              <th className="pb-1.5 pr-3 font-medium text-right">Labour</th>
              <th className="pb-1.5 pr-3 font-medium text-right">Partner net</th>
              <th className="pb-1.5 pr-3 font-medium text-right">Our margin</th>
              <th className="pb-1.5 font-medium text-right">
                {(REFERRAL_TERMS.COMMISSION_RATE * 100).toFixed(0)}% owed
              </th>
            </tr>
          </thead>
          <tbody>
            {months.map((m) => (
              <MonthRow key={m.period_month} block={block} clientId={clientId} month={m} />
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

function MonthRow({
  block,
  clientId,
  month: m,
}: {
  block: PartnerBlock
  clientId: string
  month: LedgerMonth
}) {
  const invoice = block.ledger.invoices.find(
    (i) => i.client_id === m.client_id && i.period === m.period_month,
  )
  const processing = num(invoice?.cost_processing)

  // Partner net profit per the agreement: billed less freight, materials,
  // storage and processing. Warehouse labour is NOT deducted.
  const partnerNet =
    m.revenue === null
      ? null
      : Math.max(
          0,
          num(m.revenue) - num(m.cost_freight) - num(m.cost_materials) - num(m.cost_storage) - processing,
        )

  // Our real gross margin, which is LOWER by exactly the labour we do not
  // deduct. Rendered beside the partner figure because the gap is structural
  // and correct per the deal — and because reading the partner's net as our
  // margin is the single easiest mistake to make on this screen.
  const ourMargin = partnerNet === null ? null : partnerNet - num(m.cost_labour_not_deducted)

  const commission =
    partnerNet === null || !m.payable ? null : Math.round(partnerNet * REFERRAL_TERMS.COMMISSION_RATE * 100) / 100

  const delta = reconcile(m, block.ledger)
  const charges = block.chargesByClientMonth.get(monthKey(clientId, m.period_month.slice(0, 7))) ?? []

  return (
    <>
      <tr className="border-b border-gray-700/30">
        <td className="py-1.5 pr-3 text-gray-300">
          {m.period_month.slice(0, 7)}
          {!m.payable && (
            <span className="ml-1.5 px-1 py-0.5 rounded bg-yellow-900/40 text-yellow-400 text-[10px]">
              provisional
            </span>
          )}
          {m.has_estimates && <span className="ml-1.5 text-gray-500 text-[10px]">est.</span>}
        </td>
        <td className="py-1.5 pr-3 text-right text-gray-200 tabular-nums">
          {m.revenue === null ? <span className="text-gray-500">unknown</span> : fmt(num(m.revenue))}
        </td>
        <td className="py-1.5 pr-3 text-right text-gray-400 tabular-nums">{fmtNeg(num(m.cost_freight))}</td>
        <td className="py-1.5 pr-3 text-right text-gray-400 tabular-nums">{fmtNeg(num(m.cost_materials))}</td>
        <td className="py-1.5 pr-3 text-right text-gray-400 tabular-nums">{fmtNeg(num(m.cost_storage))}</td>
        {/* Reported, never deducted from the partner's figure. */}
        <td className="py-1.5 pr-3 text-right text-gray-500 tabular-nums">
          ({fmt(num(m.cost_labour_not_deducted))})
        </td>
        <td className="py-1.5 pr-3 text-right text-gray-200 tabular-nums">
          {partnerNet === null ? '—' : fmt(partnerNet)}
        </td>
        <td className="py-1.5 pr-3 text-right text-gray-300 tabular-nums">
          {ourMargin === null ? '—' : fmt(ourMargin)}
        </td>
        <td className="py-1.5 text-right tabular-nums">
          {commission === null ? (
            <span className="text-yellow-400/80">not payable</span>
          ) : (
            <span className="text-white font-semibold">{fmt(commission)}</span>
          )}
        </td>
      </tr>

      {(m.cost_unknown_charges > 0 || m.revenue_unknown_charges > 0 || delta || charges.length > 0) && (
        <tr>
          <td colSpan={9} className="pb-2">
            {(m.cost_unknown_charges > 0 || m.revenue_unknown_charges > 0) && (
              <p className="text-[11px] text-yellow-400/90">
                {m.revenue_unknown_charges > 0 && (
                  <>
                    {m.revenue_unknown_charges} charge
                    {m.revenue_unknown_charges === 1 ? '' : 's'} with no amount
                    {m.cost_unknown_charges > 0 ? '; ' : '. '}
                  </>
                )}
                {m.cost_unknown_charges > 0 && (
                  <>
                    {m.cost_unknown_charges} deducted-bucket charge
                    {m.cost_unknown_charges === 1 ? '' : 's'} with no cost.{' '}
                  </>
                )}
                Not payable until priced — an unpriced cost reads as free, and 5% of a margin we
                never earned does not come back.
              </p>
            )}
            {delta && delta.delta !== 0 && (
              <p className="text-[11px] text-orange-300 mt-0.5">
                Hand-typed fba_invoices says {fmt(delta.manualAmount)}, the ledger says{' '}
                {fmt(delta.ledgerAmount)} — a {fmt(Math.abs(delta.delta))}{' '}
                {delta.delta > 0 ? 'shortfall in' : 'overstatement in'} the recorded figure.
              </p>
            )}
            {charges.length > 0 && <ChargeDetail rows={charges} />}
          </td>
        </tr>
      )}
    </>
  )
}

/**
 * Every charge in the month, ours to see in full.
 *
 * This is the half of the design that the partner's page deliberately does not
 * have: charge type, label and cost, per order. Ophir's ask was "every order
 * every prep", and a prep charge is only identifiable by its type.
 */
function ChargeDetail({ rows }: { rows: ChargeRow[] }) {
  const ordered = rows
    .slice()
    .sort(
      (a, b) =>
        b.charge_date.localeCompare(a.charge_date) ||
        (a.orders?.order_number ?? '').localeCompare(b.orders?.order_number ?? ''),
    )

  const billed = ordered.reduce((s, r) => s + num(r.amount), 0)
  const cost = ordered.reduce((s, r) => s + num(r.cost), 0)

  return (
    <details className="mt-1.5">
      <summary className="text-[11px] text-[#00AAFF] cursor-pointer select-none hover:underline">
        {ordered.length === 1 ? '1 charge' : `${ordered.length} charges`}
      </summary>
      <div className="mt-1.5 rounded border border-gray-700/60 overflow-hidden">
        <table className="w-full text-[11px]">
          <thead>
            <tr className="bg-gray-900/60 text-gray-500 text-left">
              <th className="px-2 py-1 font-medium">Date</th>
              <th className="px-2 py-1 font-medium">Order</th>
              <th className="px-2 py-1 font-medium">Type</th>
              <th className="px-2 py-1 font-medium">Label</th>
              <th className="px-2 py-1 font-medium text-right">Billed</th>
              <th className="px-2 py-1 font-medium text-right">Cost</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-700/40">
            {ordered.map((r, i) => (
              <tr key={`${r.order_id ?? 'account'}:${r.charge_type}:${r.charge_date}:${i}`}>
                <td className="px-2 py-1 text-gray-500 tabular-nums">{r.charge_date}</td>
                <td className="px-2 py-1 text-gray-400">
                  {/* order_id is nullable: storage and other account-level
                      charges have a client and a month but no order. */}
                  {r.orders?.order_number ?? <span className="text-gray-600">account-level</span>}
                </td>
                <td className="px-2 py-1 text-gray-400">
                  {r.charge_type}
                  {r.is_estimate && <span className="ml-1 text-gray-600">est.</span>}
                </td>
                <td className="px-2 py-1 text-gray-500">{r.label}</td>
                {/* null is UNKNOWN, not zero, and the whole project exists to
                    keep those apart. A dash here is the honest cell. */}
                <td className="px-2 py-1 text-right text-gray-300 tabular-nums">
                  {r.amount === null ? <span className="text-gray-600">—</span> : fmt(num(r.amount))}
                </td>
                <td className="px-2 py-1 text-right text-gray-400 tabular-nums">
                  {r.cost === null ? <span className="text-gray-600">—</span> : fmt(num(r.cost))}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            {/* Sums over the KNOWN figures only, which is why the counters on
                the month row above are the thing that says what is missing.
                These two are here to tie the list to the month, not to price
                anything. */}
            <tr className="bg-gray-900/40 text-gray-400">
              <td className="px-2 py-1" colSpan={4}>
                Priced charges only
              </td>
              <td className="px-2 py-1 text-right tabular-nums">{fmt(billed)}</td>
              <td className="px-2 py-1 text-right tabular-nums">{fmt(cost)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </details>
  )
}

function Figure({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div className="text-right">
      <span className="block text-[10px] uppercase tracking-wider text-gray-500">{label}</span>
      <span className={`font-semibold ${tone}`}>{value}</span>
    </div>
  )
}
