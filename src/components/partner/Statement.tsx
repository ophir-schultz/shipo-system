import { supabaseAdmin } from '@/lib/supabase'
import {
  computeOwed,
  buildStatement,
  isoDay,
  REFERRAL_TERMS,
  type ReferralPartner,
  type PayoutRecord,
  type PayoutStatus,
} from '@/lib/referrals'
import {
  prettyDay,
  prettyMonth,
  ROSTER_STATE_TEXT,
  rosterRows,
  type RosterRow,
} from '@/lib/partner-roster'
import { BONUS_STATE_TEXT, bonusStateFor, type BonusState } from '@/lib/partner-bonus-state'
// The same two label functions the STAFF screen asks (§4.4), so
// /referrals and the partner's own panel cannot disagree about whether a
// form is held.
import { agreementLabel } from '@/lib/partner-access'
import { holdsW9, w9Label } from '@/lib/partner-w9'
import { loadPartnerLedger } from '@/lib/partner-ledger'
import {
  ORDER_UNITS_LIMIT,
  fbaActivity,
  fbaUnitsLabel,
  groupOrderUnits,
  type ActivityClientMonth,
  type FbaActivityRow,
} from '@/lib/partner-activity'
import { CLAIM_PARTNER_TEXT, claimPartnerState } from '@/lib/partner-claims'
import SignOutButton from '@/components/partner/SignOutButton'
import ClaimForm from '@/components/partner/ClaimForm'
import BatchClaimForm from '@/components/partner/BatchClaimForm'
import W9Prompt from '@/components/partner/W9Prompt'

// The partner-facing statement. Server component — every figure is
// computed here and only the rendered numbers reach the browser.
//
// What a partner may see is fixed by Decision 1 of
// docs/superpowers/specs/2026-10-11-partner-ledger-statements-design.md --
// summary totals and the four cost CATEGORIES at month level -- as
// AMENDED by finding 2 of the 2026-10-20 dashboard-v2 spec (§4.1), which
// took the per-order AMOUNT off this screen entirely.
//
// Never a rate card, never per-unit prices, never per-order cost.
// `amount / quantity` on a single line item IS the rate card, and a
// partner who is also an agency reads it straight off. So the per-order
// list now carries a UNIT COUNT and no money: the figure is not in the
// view the partner path reads (public.partner_order_units has no amount
// column) and not in what loadPartnerLedger fetches, which means no
// future edit to this component can leak it back. Month-level money is
// unaffected and still renders below.
//
// This used to cite "§4.6 of the partner agreement". There is no such
// section and no executed agreement — do not re-cite one until there is.

const fmt = (n: number) => `$${n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`
const fmtNeg = (n: number) => (n === 0 ? '—' : `-${fmt(n)}`)
const fmtInt = (n: number) => n.toLocaleString('en-US')

// prettyMonth and prettyDay both live in partner-roster.ts — ONE
// month-name list. This file had its own, and §4.2's closing month now
// renders in the same table as these month headings and those date
// columns; two lists would eventually print one month two ways on one
// screen. They are also the only two formatters in this file with
// branches worth testing, and a .tsx is where vitest cannot see them.

export interface StatementPartner {
  id: string
  name: string
  company: string | null
  email?: string | null
  status?: string | null
  // §4.4. All three ride on the select getPartnerFromSession already
  // performs — no second read for a three-line panel.
  agreement_status?: string | null
  agreement_signed_at?: string | null
  w9_received_at?: string | null
}

/**
 * One row of this partner's own claims (§3.5).
 *
 * FOUR COLUMNS, NAMED. `decision_note` is staff-facing and says things
 * like "already claimed by Partner B" — §3.3 is explicit that keeping it
 * off this screen means naming columns, because `select('*')` here
 * carries it, `client_id` and `decided_by` straight to the partner.
 */
interface PartnerClaim {
  id: string
  company_name: string
  status: string | null
  created_at: string
}

/** What the roster table may print in its two money columns. */
type RosterMoney =
  | {
      show: true
      shares: Map<string, { share: number; provisional: boolean }>
      bonuses: Map<string, BonusState>
    }
  | { show: false }

/** The payouts read, in the shape both branches of the W-9 gate return. */
interface PayoutsRead {
  data: PayoutRecord[] | null
  error: unknown
}

export default async function Statement({ partner }: { partner: StatementPartner }) {
  // ---- May we show him any money? (the W-9) ----
  //
  // THE AGREEMENT OPENS THE PORTAL; THE W-9 OPENS PAYMENT. An unsigned
  // partner never reaches this component — portalAccessBlock stops him at
  // login. A partner we have no W-9 for does, and what he is missing is a
  // tax form, not a partnership: he gets his roster, his commission
  // window, his claim form and the program terms, and his commission
  // accrues while the form is outstanding. What he does not get is a
  // figure, because a figure is a statement about money we cannot yet pay.
  //
  // ASKED BEFORE THE READS, NOT BEFORE THE RENDER. That ordering is the
  // whole guard and src/lib/partner-w9.test.ts pins it: a payout read
  // performed unconditionally is one `fmt()` away from being rendered, and
  // the check above it becomes decoration. Derived values are `null` on
  // the withheld path rather than zero or empty, so every money surface
  // below has to be written as `s && ...` — a new one added carelessly is
  // a TypeScript error, not a leak. That is why `s` is nullable.
  const showMoney = holdsW9(partner)

  const [ledger, payoutsRes, claimsRes] = await Promise.all([
    loadPartnerLedger(partner.id),
    showMoney ? readPayouts(partner.id) : Promise.resolve<PayoutsRead>({ data: [], error: null }),
    // §3.5. Columns named, never '*' — see PartnerClaim above. Scoped by
    // referral_partner_id: without the eq() this lists every partner's
    // claims, which is the same leak as a star select reached by
    // forgetting a filter.
    supabaseAdmin
      .from('partner_client_claims')
      .select('id, company_name, status, created_at')
      .eq('referral_partner_id', partner.id)
      .order('created_at', { ascending: false }),
  ])

  const { clients, invoices } = ledger
  const payouts = (payoutsRes.data ?? []) as PayoutRecord[]

  // Stop before computing anything if a read failed.
  //
  // Every figure below descends from those reads, and each one degrades to
  // zero rather than to an error. A failed read therefore produces a
  // statement that is internally consistent, correctly formatted, and wrong
  // — and the empty state actively tells the partner "nothing is missing".
  // Saying nothing is owed is a claim about their money; it may only be made
  // from data we actually read.
  if (ledger.readFailed || payoutsRes.error) {
    return (
      <div className="space-y-8">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold">{partner.name}</h1>
            {partner.company && <p className="text-sm text-gray-600 mt-1">{partner.company}</p>}
          </div>
          <SignOutButton />
        </div>
        <div className="rounded-xl border border-yellow-300 bg-yellow-50 p-8 text-center">
          <p className="text-[var(--brand-ink)] font-medium">We can&apos;t show your statement right now</p>
          <p className="text-gray-600 text-sm mt-2 max-w-md mx-auto">
            This is a problem on our side, not a statement showing nothing owed. Your earnings are
            unaffected and nothing has been lost. Please try again shortly — if it persists, contact
            us and we will send your statement directly.
          </p>
        </div>
      </div>
    )
  }

  // ---- Activity (§4.1, §4.2) ----
  //
  // NOT gated on showMoney, and that is deliberate. Units are not money. The
  // W-9 gate withholds what we would PAY him; it has never withheld the
  // roster, which renders on the withheld path with its money columns
  // suppressed. A partner waiting on a tax form can still see that his clients
  // are shipping, which is the strongest reason to go and file it.
  //
  // These are their own sections rather than a drilldown inside the money
  // months, because the two cannot share a month. partner_client_monthly groups
  // by charge_date and partner_order_units groups by order date, so an order
  // placed on the 30th and charged on the 1st belongs to different months in
  // each — nesting would file it under the wrong one. §4.2 also calls for the
  // FBA list to be "its own labelled section", and a client with orders but no
  // charges yet has no money month to nest under at all.
  const activity = groupOrderUnits(ledger.orderUnits)

  // manualInvoices, NOT invoices. The merge sets `units_shipped: manual?.
  // units_shipped ?? null` on every ledger month, so reading the merged array
  // would manufacture a "not recorded yet" FBA row for every month of every
  // purely DTC client. Only a hand-typed row means FBA prep happened.
  // `?? null`, never `?? 0`. FbaInvoice.units_shipped is optional, so the field
  // arrives as `undefined` when the column is absent and as `null` when it is
  // present and nobody typed a figure. Both mean "not recorded yet", which is
  // what fbaUnitsLabel renders. A 0 would tell the partner, on his own screen,
  // that his client shipped nothing that month.
  const fba = fbaActivity(
    ledger.manualInvoices.map((i) => ({
      client_id: i.client_id,
      period: i.period,
      units_shipped: i.units_shipped ?? null,
    })),
    clients,
  )

  // `clients` here is ONE partner's clients, and that is now safe to
  // pass: every figure computeOwed derives is per-client, so a slice
  // gives the same answer as the whole table. It was NOT safe while the
  // launch offer existed — places were ranked globally, so ranking them
  // inside this slice handed out places 1..10 among one partner's
  // clients and could print a raised bonus for someone really 40th in
  // line. The offer was withdrawn 2026-10-12 and the option is gone.
  //
  // NOT COMPUTED AT ALL when the W-9 is outstanding. Computing the
  // statement and then declining to render it leaves every figure sitting
  // in scope, one careless `{fmt(s.lifetimeEarned)}` from the screen.
  // `null` makes the compiler the guard instead of the reviewer.
  const lines = showMoney ? computeOwed([partner as ReferralPartner], clients, invoices, payouts) : null
  const s = lines ? buildStatement(partner.id, clients, lines, invoices) : null

  // ---- The client roster (§4.1) ----
  //
  // ONE clock, read once, and passed down. rosterRows and windowPosition
  // both take `asOf` as a parameter; calling new Date() in each of them
  // would let a request that straddles midnight on the 1st put a client
  // in two different months in two cells of the same row.
  const asOf = new Date()
  const roster = rosterRows(clients, asOf)

  // "This month" is taken from the statement that is rendered BELOW,
  // keyed by client, rather than recomputed from the ledger. The roster
  // and the monthly sections then cannot print different figures for the
  // same client-month — which they would, eventually, since the statement
  // applies the provisional rule and a second calculation here would not.
  //
  // A client absent from this map has no measured figure for the month.
  // That renders '—', never $0: the unknown-vs-zero discipline this whole
  // file is built on.
  const thisMonth = s?.months.find((m) => m.period === isoDay(asOf).slice(0, 7))
  const shareThisMonth = s
    ? new Map(
        // `provisional` is optional on the line and absent means "final", so
        // it is coerced here rather than carried as boolean | undefined. It
        // matters: `share` is 0 on a provisional line, so a falsy flag with a
        // 0 share would render a confident $0.00 for a month whose charges
        // are not priced yet.
        (thisMonth?.clients ?? []).map(
          (c) => [c.clientId, { share: c.share, provisional: !!c.provisional }] as const,
        ),
      )
    : null

  // ---- Per-client sign-up bonus state (§4.3) ----
  //
  // Re-voiced from computeOwed's OWN line, not recomputed. The staff note
  // on that line ("set the first-payment date to release") names a field
  // the partner cannot see and an action only Shipo can take; it used to
  // be dropped entirely, so a partner saw a bonus only once it was
  // released and had no way to tell "not yet" from "never".
  //
  // There is exactly one signup_bonus line per client, so last-wins is a
  // non-event; written as a Map rather than a find() per row to keep the
  // table O(n).
  //
  // A MONEY SURFACE, THOUGH IT LOOKS LIKE A STATUS. BONUS_STATE_TEXT
  // interpolates REFERRAL_TERMS.SIGNUP_BONUS, so every sentence in this
  // column carries a dollar figure. It is withheld with the rest.
  const bonusByClient = lines
    ? new Map<string, BonusState>(
        lines.filter((l) => l.kind === 'signup_bonus').map((l) => [l.clientId, bonusStateFor(l)]),
      )
    : null

  // The roster's two money columns travel as ONE discriminated value, not
  // as two optional maps. `rosterMoney.shares` does not typecheck until
  // `show === true` has been narrowed, so a third money column added to
  // that table cannot reach the withheld branch by accident — the data is
  // not in scope there to render.
  const rosterMoney: RosterMoney =
    shareThisMonth && bonusByClient
      ? { show: true, shares: shareThisMonth, bonuses: bonusByClient }
      : { show: false }

  // ---- His own claims (§3.5) ----
  //
  // A FAILED CLAIMS READ IS NOT "no claims". An empty list under a form
  // he just submitted reads as "the claim you filed is gone", which is
  // the one thing §3.1 is built to prevent him from believing. It is
  // carried as a flag and rendered as a sentence.
  //
  // It does NOT join the statement-wide failure branch above: a missing
  // claims table must not blank out a statement about money he is owed.
  // The branch above is about figures; this is about a list beside them.
  const claims = (claimsRes.data ?? []) as PartnerClaim[]
  const claimsReadFailed = !!claimsRes.error

  return (
    <div className="space-y-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">{partner.name}</h1>
          <p className="text-sm text-gray-600 mt-1">
            {partner.company ? `${partner.company} · ` : ''}
            {/* roster.length, not s.activeClients, and they are the same
                number: activeClients counts the distinct clients linked to
                this partner and rosterRows maps that list one-to-one. One
                source means the header cannot disagree with the table
                under it, and it is the only count available on the
                withheld path. */}
            {roster.length === 1 ? '1 referred client' : `${roster.length} referred clients`}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {/* The download, §5.

              A plain anchor and not a button: the response is a file with
              a Content-Disposition, so the browser's own download path is
              the right one and there is no state to manage. No `download`
              attribute — the server already names the file, and the
              attribute would override that name with the URL's last
              segment ("report").

              It sits HERE, after the failure branch has already returned,
              so a partner looking at "we can't show your statement" is
              not offered a file built from the same reads that just
              failed. The route re-checks everything itself — session,
              read success, W-9 — because a link is not an authorisation.

              --brand-action (#1a73e8), never --brand-accent: the accent is
              a #e0ee47 lime that is illegible as text on a white surface.
              Accent is a highlight colour, not a text colour. */}
          <a
            href="/api/partner/report"
            className="text-sm font-medium text-[var(--brand-action)] hover:underline whitespace-nowrap"
          >
            Download CSV
          </a>
          <SignOutButton />
        </div>
      </div>

      {/* ---- Headline numbers, or the reason there are none ----

          The W-9 prompt takes the tiles' place rather than appearing
          under them: it is the answer to "where are my figures", and it
          has to be where the figures would have been. */}
      {s ? (
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
      ) : (
        <W9Prompt partner={partner} />
      )}

      {/* ---- Clients you referred (§4.1) ----

          OUTSIDE the s.months.length === 0 branch below, and that
          placement is the fix. A partner with a live but not-yet-paying
          client used to get "No statement yet — nothing is missing", and
          his client was never named on the screen at all. */}
      <ClientRoster
        rows={roster}
        money={rosterMoney}
        claims={claims}
        claimsReadFailed={claimsReadFailed}
      />

      {/* ---- Monthly statements ----

          Absent entirely while the W-9 is outstanding; `s` is null there,
          so this whole block cannot be reached. The W-9 prompt above has
          already said why, which is why there is no second notice here. */}
      {s === null ? null : s.months.length === 0 ? (
        <div className="rounded-xl border border-gray-200 bg-[var(--brand-surface)] p-8 text-center">
          <p className="text-gray-700 font-medium">No statement yet</p>
          <p className="text-gray-500 text-sm mt-2 max-w-md mx-auto">
            Your first statement appears once a client you referred has paid their first invoice. Nothing is missing —
            there is simply nothing to report yet.
          </p>
        </div>
      ) : (
        s.months.map((m) => (
          <section key={m.period} className="rounded-xl border border-gray-200 bg-[var(--brand-surface)] overflow-hidden">
            <div className="flex items-baseline justify-between border-b border-gray-200 px-5 py-4">
              <h2 className="font-semibold">{prettyMonth(m.period)}</h2>
              <span className="text-sm text-gray-600">
                Earned this month <span className="text-[var(--brand-ink)] font-semibold ml-1">{fmt(m.earned)}</span>
              </span>
            </div>

            <div className="divide-y divide-gray-200">
              {m.clients.map((c) => (
                <div key={c.dedupeKey} className="px-5 py-4">
                  <div className="flex items-center justify-between mb-3">
                    <span className="font-medium text-[var(--brand-ink)]">{c.clientName}</span>
                    {c.provisional ? (
                      <span className="px-1.5 py-0.5 rounded text-[11px] bg-[var(--brand-surface)] text-gray-600">
                        not final
                      </span>
                    ) : (
                      <Badge status={c.status} />
                    )}
                  </div>
                  {c.provisional && (
                    <p className="text-xs text-gray-500 mb-3 -mt-1">
                      Some charges for this month are not priced yet, so the figures below are not
                      final and nothing is owed on them yet. They will settle on a later statement.
                    </p>
                  )}
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
                      <span className="font-medium text-[var(--brand-ink)]">{b.clientName}</span>
                      <span className="block text-xs text-gray-500 mt-0.5">
                        One-time referral bonus — first invoice paid
                      </span>
                    </div>
                    <div className="text-right">
                      <span className="font-semibold text-[var(--brand-ink)]">{fmt(b.amount)}</span>
                      <span className="block mt-1"><Badge status={b.status} /></span>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {(m.carriedIn > 0 || m.carriedOut > 0) && (
              <div className="border-t border-gray-200 bg-white px-5 py-3 text-xs text-gray-600 space-y-1">
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

      {/* ---- Order activity (§4.1) ---- */}
      <OrderActivity groups={activity} truncated={ledger.orderUnitsTruncated} />

      {/* ---- FBA prep activity (§4.2) ---- */}
      <FbaPrepActivity rows={fba} />

      {/* ---- Your account (§4.4) ---- */}
      <AccountState partner={partner} />

      {/* ---- How this is calculated ---- */}
      {/* THE TWO GATES ARE GONE, AND THAT IS A CONTRACT CHANGE, NOT A
          WORDING ONE. This read "after that client has been active 60
          days, has billed $500 or more in a single calendar month". Both
          clauses were removed from the Agreement on 2026-10-12 — Section
          3.1's revenue threshold and 3.2's 60-day wait — leaving 3.9's
          offset-only clawback as the only protection. The screen went on
          stating both for eleven days, so a partner reading his own
          statement was told he had to clear bars his signed agreement did
          not impose. referral-agreement-terms.test.ts pinned the
          AGREEMENT against their return and nothing pinned this file;
          partner-bonus-copy.test.ts now does.

          It is laid out rather than written out because this is the
          section partners actually read: two earning streams, then the
          one definition the money turns on. */}
      <section className="rounded-xl border border-gray-200 bg-[var(--brand-surface)] p-5 space-y-4">
        <h2 className="font-semibold text-[var(--brand-ink)]">How this is calculated</h2>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg border border-gray-200 bg-white p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">One-time</p>
            <p className="mt-1 text-3xl font-bold text-[var(--brand-ink)]">${REFERRAL_TERMS.SIGNUP_BONUS}</p>
            <p className="mt-1 text-sm leading-relaxed text-gray-600">
              per referred client, once they have paid their first invoice
            </p>
          </div>

          <div className="rounded-lg border border-gray-200 bg-white p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Every month</p>
            <p className="mt-1 text-3xl font-bold text-[var(--brand-ink)]">
              {(REFERRAL_TERMS.COMMISSION_RATE * 100).toFixed(0)}%
              <span className="ml-2 align-middle text-base font-semibold">of net profit</span>
            </p>
            <p className="mt-1 text-sm leading-relaxed text-gray-600">
              {/* One template string, not `for {X} months`. JSX dropped the
                  space after the closing brace -- SWC compiled that form to
                  "for ", MONTHS, "months from..." and the screen read "for
                  12months". Interpolating inside the string cannot lose it. */}
              {`for ${REFERRAL_TERMS.COMMISSION_MONTHS} months from that client’s first paid invoice`}
            </p>
          </div>
        </div>

        {/* The definition the whole second stream turns on, set as the
            subtraction it actually is. A partner checking a figure is
            doing this arithmetic; prose made him assemble it himself. */}
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">What net profit means</p>
          <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-2 text-sm">
            <span className="rounded-md bg-[var(--brand-surface)] px-2 py-1 font-semibold text-[var(--brand-ink)]">
              Invoiced to the client
            </span>
            {['Freight & carrier', 'Packaging & prep', 'Storage', 'Payment processing'].map((cost) => (
              <span key={cost} className="flex items-center gap-2">
                <span aria-hidden="true" className="text-gray-500">
                  −
                </span>
                <span className="rounded-md border border-gray-200 px-2 py-1 text-gray-600">{cost}</span>
              </span>
            ))}
            <span aria-hidden="true" className="text-gray-500">
              =
            </span>
            <span className="rounded-md bg-[var(--brand-ink)] px-2 py-1 font-semibold text-white">Net profit</span>
          </div>
          <p className="mt-3 text-sm leading-relaxed text-gray-600">
            Charges billed at cost — freight, duties and Amazon fees — generate no profit and are excluded entirely.
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          {[
            { k: 'When you are paid', v: 'Within 30 days', d: 'of the end of the month shown' },
            {
              k: 'Minimum payout',
              v: fmt(REFERRAL_TERMS.MIN_PAYOUT),
              d: `a smaller balance rolls over until it clears ${fmt(REFERRAL_TERMS.MIN_PAYOUT)}`,
            },
            { k: 'Before we can pay', v: 'W-9 or W-8', d: 'we need your completed form on file' },
          ].map((item) => (
            <div key={item.k} className="rounded-lg border border-gray-200 bg-white p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">{item.k}</p>
              <p className="mt-1 font-semibold text-[var(--brand-ink)]">{item.v}</p>
              <p className="mt-1 text-sm leading-relaxed text-gray-600">{item.d}</p>
            </div>
          ))}
        </div>

        <p className="text-sm leading-relaxed text-gray-500">
          Figures are calculated in good faith from Shipo&apos;s books. If you disagree with a statement, tell us in
          writing within 30 days of receiving it.
        </p>
      </section>
    </div>
  )
}

/**
 * This partner's payouts — the only read of `referral_payouts` in this
 * file, and the only one there may be.
 *
 * IT LIVES IN A FUNCTION SO IT CAN BE SKIPPED. A read inside the
 * Promise.all is unconditional by construction; a read behind a name is
 * called on one branch of the W-9 check and not the other, and
 * src/lib/partner-w9.test.ts asserts both halves of that — that this
 * table is named exactly once in the file, and that the name appears
 * after the `holdsW9(` call rather than before it.
 */
async function readPayouts(partnerId: string): Promise<PayoutsRead> {
  const res = await supabaseAdmin
    .from('referral_payouts')
    .select('id, dedupe_key, status, amount, approved_at, paid_at')
    .eq('referral_partner_id', partnerId)
  return { data: (res.data ?? null) as PayoutRecord[] | null, error: res.error }
}

/**
 * The three standing facts about his own account. §4.4.
 *
 * THREE FACTS, AND THE THIRD IS AN ABSENCE. The agreement state and the
 * W-9 state both come from the functions the STAFF screen asks —
 * `agreementLabel` and `w9Label`, both already under test — so /referrals
 * and this panel cannot come to disagree about whether a form is held.
 *
 * Payout method is the one fact we do not have. §4.4's `payout_method`,
 * `payout_details` and `referral_code` columns do not exist and are not
 * proposed here, so there is nothing to read. An empty cell under a
 * "Payout method" heading reads as "we have your bank details" to the
 * person most harmed by believing it, so the absence is written out as a
 * sentence with the action in it.
 *
 * NO BRANCHING ON STATE. Every decision shown was made in a `.ts` that
 * vitest can see; this file is a `.tsx`, where it cannot. The only
 * conditional here is "do we have a date to print", and `prettyDay`
 * answers that in a tested function.
 */
function AccountState({ partner }: { partner: StatementPartner }) {
  const agreement = agreementLabel(partner.agreement_status)
  const w9 = w9Label(partner)

  const tones: Record<'good' | 'bad' | 'wait', string> = {
    good: 'text-green-700',
    bad: 'text-red-700',
    wait: 'text-yellow-700',
  }

  return (
    <section className="rounded-xl border border-gray-200 bg-[var(--brand-surface)] p-5 space-y-4">
      <h2 className="font-semibold text-[var(--brand-ink)]">Your account</h2>

      <dl className="grid sm:grid-cols-3 gap-4 text-sm">
        <div>
          <dt className="text-gray-500">Partner agreement</dt>
          <dd className={`mt-1 font-medium ${tones[agreement.tone]}`}>{agreement.text}</dd>
          {/* Only when we hold one. prettyDay renders a missing date as an
              em dash, which is the honest answer and not a blank. */}
          <dd className="text-xs text-gray-500 mt-0.5">{prettyDay(partner.agreement_signed_at ?? null)}</dd>
        </div>

        <div>
          <dt className="text-gray-500">W-9 on file</dt>
          <dd className={`mt-1 font-medium ${tones[w9.tone]}`}>{w9.text}</dd>
          <dd className="text-xs text-gray-500 mt-0.5">{prettyDay(partner.w9_received_at ?? null)}</dd>
        </div>

        <div>
          <dt className="text-gray-500">Payout method</dt>
          <dd className="mt-1 font-medium text-yellow-700">not on file</dd>
          <dd className="text-xs text-gray-500 mt-0.5">
            We do not hold payment details for you. Email{' '}
            <a className="underline hover:text-gray-700" href="mailto:Support@shipousa.com">
              Support@shipousa.com
            </a>{' '}
            to tell us where to send your commission.
          </dd>
        </div>
      </dl>
    </section>
  )
}

/**
 * Every client this partner referred, earning or not. §4.1.
 *
 * The states and their sentences come from partner-roster.ts, which is
 * under test; this renders them and decides nothing. In particular the
 * commission window is READ OFF THE ROW (`r.window`) and not re-derived
 * here. It used to call windowPosition itself, which looks like the same
 * answer and is not: that call cannot see the paid-before-signed check
 * that gave the row its state, so a client with those two dates reversed
 * showed "your commission starts the month this client pays their first
 * invoice" beside "month 4 of 12". One row, both sentences, and no way
 * for him to tell which half to believe.
 */
function ClientRoster({
  rows,
  money,
  claims,
  claimsReadFailed,
}: {
  rows: RosterRow[]
  money: RosterMoney
  claims: PartnerClaim[]
  claimsReadFailed: boolean
}) {
  // ONE SECTION, two branches inside it. The claims list and the form
  // are below BOTH the table and the no-clients empty state, because a
  // partner with nothing linked is the person who most needs the way in
  // — he is the one who wrote "i dont see the option to add more of my
  // clients". An early `return` for the empty case is what hid it.
  return (
    <section className="rounded-xl border border-gray-200 bg-[var(--brand-surface)] overflow-hidden">
      {rows.length === 0 ? (
        // Genuinely no clients — distinct from "clients with no earnings
        // yet", which is the case this whole section exists to render.
        // The sentence has to say which one it is.
        <div className="p-8 text-center">
          <p className="text-gray-700 font-medium">No clients linked to you yet</p>
          <p className="text-gray-500 text-sm mt-2 max-w-md mx-auto">
            Clients you refer appear here as soon as we have linked them to your account — before
            they have paid anything, so you can see where each one stands.
          </p>
        </div>
      ) : (
        // No `asOf`: the table has no date arithmetic left to do. Every
        // row arrives with its own window already derived, which is the
        // point — a clock passed into a renderer is an invitation to
        // re-derive, and re-deriving is what disagreed with the state.
        <ClientRosterTable rows={rows} money={money} />
      )}

      <Claims rows={claims} readFailed={claimsReadFailed} />
      <ClaimForm />
      {/* The answer to "i have close to 100 clients". Below the
          single-claim form on purpose: one client is the common case and
          stays the first thing he meets, and the batch box is the way out
          of filling that form a hundred times. */}
      <BatchClaimForm />
    </section>
  )
}

/**
 * THE TWO MONEY COLUMNS ARE DROPPED, NOT BLANKED, when the W-9 is
 * outstanding, and the distinction is the whole point of the `money`
 * discriminated union.
 *
 * A "This month" column rendering '—' for every row is how this file
 * reads an UNKNOWN, and §4.1's own comment says why that is not $0: "your
 * client earned you nothing this month" is a claim about his money. On
 * the withheld path the figure is neither unknown nor zero — it is known
 * and deliberately not shown — so printing the column at all would be a
 * third meaning for the same dash, on the one screen already telling him
 * his figures are held.
 *
 * "Sign-up bonus" goes with it. It looks like a status column and is not:
 * BONUS_STATE_TEXT interpolates REFERRAL_TERMS.SIGNUP_BONUS, so every
 * sentence in it carries a dollar amount. It was the non-obvious one.
 */
function ClientRosterTable({ rows, money }: { rows: RosterRow[]; money: RosterMoney }) {
  return (
    <>
      <div className="flex items-baseline justify-between border-b border-gray-200 px-5 py-4">
        <h2 className="font-semibold">Clients you referred</h2>
        <span className="text-sm text-gray-600">
          {rows.length === 1 ? '1 client' : `${rows.length} clients`}
        </span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-white text-gray-500">
              <th className="text-left font-medium px-5 py-2">Client</th>
              <th className="text-left font-medium px-3 py-2 whitespace-nowrap">Referred</th>
              <th className="text-left font-medium px-3 py-2 whitespace-nowrap">First paid</th>
              <th className="text-left font-medium px-3 py-2 whitespace-nowrap">Commission window</th>
              {money.show && (
                <>
                  <th className="text-left font-medium px-3 py-2 whitespace-nowrap">Sign-up bonus</th>
                  <th className="text-right font-medium px-5 py-2 whitespace-nowrap">This month</th>
                </>
              )}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {rows.map((r) => {
              const pos = r.window
              // Narrowed, not optional-chained. `money.shares` does not
              // exist on the withheld branch of the union, so these two
              // lines are unreachable there by the type system rather than
              // by a reviewer noticing.
              const mine = money.show ? money.shares.get(r.clientId) : undefined
              const bonus = money.show ? money.bonuses.get(r.clientId) : undefined
              return (
                <tr key={r.clientId} className="align-top">
                  <td className="px-5 py-3">
                    <span className="font-medium text-[var(--brand-ink)]">{r.clientName}</span>
                    <span className="block text-xs text-gray-500 mt-0.5 max-w-sm">
                      {ROSTER_STATE_TEXT[r.state]}
                    </span>
                  </td>
                  <td className="px-3 py-3 text-gray-600 whitespace-nowrap">{prettyDay(r.referred)}</td>
                  <td className="px-3 py-3 text-gray-600 whitespace-nowrap">{prettyDay(r.firstPaid)}</td>
                  <td className="px-3 py-3 text-gray-700 whitespace-nowrap">
                    {/* §4.2: month N of 12 AND the month it closes —
                        "the single biggest determinant of his future
                        income". Nothing at all for a client with no first
                        paid invoice: that is unknown, not month zero, and
                        a closing month derived from a date nobody has set
                        would be a deadline we invented. */}
                    {pos ? (
                      <>
                        Month {pos.month} of {pos.of}
                        <span className="block text-xs text-gray-500 mt-0.5">
                          Through {pos.closesAfter}
                        </span>
                      </>
                    ) : (
                      <span className="text-gray-500">—</span>
                    )}
                  </td>
                  {money.show && (
                    <>
                  <td className="px-3 py-3 whitespace-normal">
                    {/* §4.3, re-voiced. undefined means computeOwed
                        produced no signup_bonus line for this client at
                        all, which happens when the client is not linked
                        to a partner row this run — '—' rather than a
                        sentence about a bonus we cannot speak to. */}
                    {bonus === undefined ? (
                      <span className="text-gray-500">—</span>
                    ) : (
                      <span className="text-xs text-gray-600 block max-w-[16rem]">
                        {BONUS_STATE_TEXT[bonus]}
                      </span>
                    )}
                  </td>
                  <td className="px-5 py-3 text-right tabular-nums whitespace-nowrap">
                    {/* No measured figure is '—', never $0. A zero here
                        would read as "your client earned you nothing this
                        month", which is a claim about his money we have
                        not made and often cannot make yet. */}
                    {mine === undefined ? (
                      <span className="text-gray-500">—</span>
                    ) : mine.provisional ? (
                      <span className="text-gray-500 text-xs">not final</span>
                    ) : (
                      <span className="text-[var(--brand-ink)]">{fmt(mine.share)}</span>
                    )}
                  </td>
                    </>
                  )}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <p className="border-t border-gray-200 bg-white px-5 py-3 text-xs text-gray-500">
        Commission runs from a client&apos;s first paid invoice, not from the day they are linked.
      </p>
    </>
  )
}

/**
 * The claims this partner has already filed (§3.5).
 *
 * THREE STATES, NOT FOUR, and no reason ever: see claimPartnerState.
 * What is rendered is the company name HE typed, the date, and one
 * sentence from CLAIM_PARTNER_TEXT. The staff's `decision_note` is not
 * selected, so there is nothing here to leak even by a careless edit.
 *
 * A FAILED READ SAYS SO. An empty list under a form he just used reads
 * as "the claim you filed is gone" — the one belief §3.1 exists to
 * prevent, and the expensive one, since he will not file it twice.
 */
function Claims({ rows, readFailed }: { rows: PartnerClaim[]; readFailed: boolean }) {
  if (readFailed) {
    return (
      <div className="border-t border-gray-200 px-5 py-4">
        <p className="text-sm text-yellow-700">We can&apos;t show your submitted claims right now</p>
        <p className="text-xs text-gray-600 mt-1 max-w-lg">
          This is a problem on our side, not a sign that anything you sent was lost. Nothing you
          have submitted has been discarded. Please don&apos;t re-send — contact us if it persists.
        </p>
      </div>
    )
  }

  if (rows.length === 0) return null

  return (
    <div className="border-t border-gray-200">
      <div className="px-5 py-3">
        <h3 className="text-sm font-semibold text-[var(--brand-ink)]">Clients you&apos;ve told us about</h3>
      </div>
      <ul className="divide-y divide-gray-200">
        {rows.map((c) => {
          const state = claimPartnerState(c.status)
          return (
            <li key={c.id} className="px-5 py-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="font-medium text-[var(--brand-ink)]">{c.company_name}</span>
              <span className="text-xs text-gray-500">{prettyDay(c.created_at)}</span>
              <span className="block w-full text-xs text-gray-600">
                {CLAIM_PARTNER_TEXT[state]}
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/**
 * What his clients shipped, per order, in UNITS.
 *
 * This replaced a per-order table whose third column was the amount billed.
 * `amount / quantity` on a single order IS the rate card, and several referral
 * partners are agencies who also resell fulfilment — the shipped screen handed
 * a competitor our pricing one order at a time. §4.1 removes it, and removes it
 * from the view rather than from this table, so there is no money column here
 * to restore by accident.
 *
 * Nothing in this component is a money surface, which is why it renders on the
 * W-9-withheld path too.
 */
function OrderActivity({
  groups,
  truncated,
}: {
  groups: ActivityClientMonth[]
  truncated: boolean
}) {
  if (groups.length === 0) return null

  return (
    <section className="space-y-3">
      <div>
        <h2 className="font-semibold text-[var(--brand-ink)]">Order activity</h2>
        <p className="text-sm text-gray-600 mt-1">
          Orders your clients shipped, by the month the order was placed. Volume only — this section
          carries no billing figures, and the months here are order months, so they will not always
          line up with the billing months above.
        </p>
      </div>

      {groups.map((g) => (
        <details key={`${g.clientId}:${g.periodMonth}`} className="rounded-xl border border-gray-200 bg-[var(--brand-surface)]">
          <summary className="cursor-pointer select-none px-5 py-3 text-sm flex items-center justify-between gap-4">
            <span className="font-medium text-[var(--brand-ink)]">
              {g.clientName}
              <span className="text-gray-500 font-normal"> · {prettyMonth(g.periodMonth)}</span>
            </span>
            <span className="text-gray-600 tabular-nums">
              {g.orders.length === 1 ? '1 order' : `${fmtInt(g.orders.length)} orders`}
              {' · '}
              {/* NEVER the total without the counter beside it. `sum` skips
                  nulls, so a month with an unquantified order reads LOW, and a
                  low number presented as a total is worse than no number. */}
              {fbaUnitsLabel(g.totalUnits)} {g.totalUnits === 1 ? 'unit' : 'units'}
              {g.unitsEstimated && <span className="text-gray-500"> (some not yet picked)</span>}
            </span>
          </summary>

          {g.unitsUnknownOrders > 0 && (
            <p className="px-5 pb-2 text-xs text-gray-500">
              {g.unitsUnknownOrders === 1
                ? '1 order in this month has no unit count recorded, so it is not in the total above.'
                : `${fmtInt(g.unitsUnknownOrders)} orders in this month have no unit count recorded, so they are not in the total above.`}
            </p>
          )}

          <div className="mx-5 mb-4 rounded-lg border border-gray-200 overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-white text-gray-500">
                  <th className="text-left font-medium px-3 py-1.5">Date</th>
                  <th className="text-left font-medium px-3 py-1.5">Order</th>
                  <th className="text-right font-medium px-3 py-1.5">Units</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {g.orders.map((o, i) => (
                  <tr key={`${o.order_number ?? 'order'}:${o.order_date ?? 'undated'}:${i}`}>
                    <td className="px-3 py-1.5 text-gray-600 tabular-nums">
                      {o.order_date ? (
                        prettyDay(o.order_date)
                      ) : (
                        <span className="text-gray-500">no date recorded</span>
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-gray-700">{o.order_number ?? '—'}</td>
                    <td className="px-3 py-1.5 text-right text-gray-700 tabular-nums">
                      {/* fbaUnitsLabel, not `?? 0`: null here means nobody can
                          say, and a 0 would tell him the order shipped empty. */}
                      {fbaUnitsLabel(o.units)}
                      {o.units_estimated === true && (
                        <span className="text-gray-500"> ordered</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ))}

      {/* A list that quietly dropped its oldest orders is worse than one that
          says so. The read is capped and ordered newest first, so only the
          oldest can ever be missing. */}
      {truncated && (
        <p className="text-xs text-gray-500">
          This list shows the most recent {fmtInt(ORDER_UNITS_LIMIT)} orders. Older months may list
          fewer orders than they contain — the monthly billing figures above are unaffected. Ask us
          and we will send the full history.
        </p>
      )}
    </section>
  )
}

/**
 * FBA prep months.
 *
 * §4.2: per-unit, not order-shaped, and hand-typed on /referrals — so a null
 * is "nobody has recorded it yet" and must never render as a 0. FbaInvoice
 * keeps the two apart on purpose and this is the screen where collapsing them
 * would tell a partner his month was empty.
 */
function FbaPrepActivity({ rows }: { rows: FbaActivityRow[] }) {
  if (rows.length === 0) return null

  return (
    <section className="space-y-3">
      <div>
        <h2 className="font-semibold text-[var(--brand-ink)]">FBA prep activity</h2>
        <p className="text-sm text-gray-600 mt-1">
          FBA prep is billed per unit rather than per order, so there is nothing order-by-order to
          show here — just the units prepped in each month. These figures are recorded by our team,
          so a recent month may not be filled in yet.
        </p>
      </div>

      <div className="rounded-xl border border-gray-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-[var(--brand-surface)] text-gray-500">
              <th className="text-left font-medium px-5 py-2">Month</th>
              <th className="text-left font-medium px-5 py-2">Client</th>
              <th className="text-right font-medium px-5 py-2">Units prepped</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200 bg-white">
            {rows.map((r) => (
              <tr key={`${r.clientId}:${r.period}`}>
                <td className="px-5 py-2 text-gray-600 tabular-nums">{prettyMonth(r.period)}</td>
                <td className="px-5 py-2 text-[var(--brand-ink)]">{r.clientName}</td>
                <td className="px-5 py-2 text-right tabular-nums">
                  {r.unitsShipped === null ? (
                    <span className="text-gray-500">not recorded yet</span>
                  ) : (
                    <span className="text-gray-700">{fbaUnitsLabel(r.unitsShipped)}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
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
        rule ? 'border-t border-gray-200 mt-1 pt-2' : '',
        emphasis ? 'text-[var(--brand-ink)] font-semibold' : '',
      ].join(' ')}
    >
      <dt className={indent ? 'pl-4 text-gray-500' : 'text-gray-600'} dangerouslySetInnerHTML={{ __html: label }} />
      <dd className={emphasis ? '' : indent ? 'text-gray-500 tabular-nums' : 'text-[var(--brand-ink)] tabular-nums'}>{value}</dd>
    </div>
  )
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub: string; tone: string }) {
  const tones: Record<string, string> = {
    blue: 'border-[var(--brand-action)]/30 bg-[var(--brand-surface)]',
    green: 'border-green-300 bg-green-50',
    yellow: 'border-yellow-300 bg-yellow-50',
    gray: 'border-gray-200 bg-[var(--brand-surface)]',
  }
  return (
    <div className={`rounded-xl border p-4 ${tones[tone] ?? tones.gray}`}>
      <p className="text-[11px] uppercase tracking-wider text-gray-600">{label}</p>
      <p className="text-xl font-bold text-[var(--brand-ink)] mt-1.5">{value}</p>
      <p className="text-[11px] text-gray-500 mt-1">{sub}</p>
    </div>
  )
}

function Badge({ status }: { status: PayoutStatus }) {
  // 'computed' means Shipo has not reviewed the line yet. A partner
  // should not see internal ledger jargon, so it reads "in review".
  const map: Record<string, { text: string; cls: string }> = {
    paid: { text: 'paid', cls: 'bg-green-100 text-green-800' },
    // Navy, not the action blue: #1a73e8 on #f4f8fd is 4.22:1 and this is
    // 11px. The pale blue fill is what distinguishes the state; the text
    // does not have to be blue to say so. See partner-brand.test.ts.
    approved: { text: 'approved for payment', cls: 'bg-[var(--brand-surface)] text-[var(--brand-ink)]' },
    pending: { text: 'in review', cls: 'bg-yellow-100 text-yellow-800' },
    computed: { text: 'in review', cls: 'bg-yellow-100 text-yellow-800' },
  }
  const v = map[status] ?? map.computed
  return <span className={`px-1.5 py-0.5 rounded text-[11px] ${v.cls}`}>{v.text}</span>
}
