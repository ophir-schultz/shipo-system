import { supabaseAdmin } from '@/lib/supabase'
import { read, readErrors, loaded, type LoadedData } from '@/lib/db/read'
import ViewUnreadable from '@/components/ui/ViewUnreadable'
import {
  readStatementCharges, readEarliestChargeDate,
} from '@/lib/billing/statement-charges'
import { priceStatementCharges } from '@/lib/billing/statement-source'
import {
  buildStatement, resolveStatementQuery,
  type Grain, type Statement, type DateRange,
} from '@/lib/billing/statement'
import {
  rateText, periodLabel, coverageNote, estimateNote,
  statementAmountDueCell, statementFigures,
} from '@/lib/billing/statement-view'
import {
  formatPrice, unpricedNote, totalOrUnknown, UNPRICED_DASH,
} from '@/lib/billing/unpriced'
import { monthlyMinimumBill, type MonthlyMinimum } from '@/lib/billing/monthly-minimum'
import { loadAgreedMinimum } from '@/lib/billing/agreed-minimum'
import StatementPeriodForm from '@/components/billing/StatementPeriodForm'

// What one client has been billed in a period. Shipping uses the same zone-matrix price as Profit. Pick and pack come from the client's price list when the ledger did not already price them.
//
// This does NOT touch `bills` and does not run the weekly bill generator. It is
// a live read of `order_charges` -- the ledger's already-priced output -- so the
// figures here are the ones the ledger computed, grouped and totalled. Nothing
// on this screen re-prices anything; see the header of statement.ts for why a
// second pricing implementation would be worse than no screen at all.
//
// It is a Server Component with a plain GET <form> for the picker, which is why
// there is no client component here: a <select> that submits to the same route
// needs no JavaScript, so the screen works on a warehouse tablet with a dead
// bundle and the period is in the URL where it can be bookmarked and pasted
// into an email beside the figure it produced.

export const dynamic = 'force-dynamic'

/**
 * The grains the picker offers.
 *
 * `year` was held back because a year of order_charges is the one grain whose
 * page count nobody had measured. It has now been counted, off the code rather
 * than off a guess, and the cost lives almost entirely in the DOWNLOAD and not
 * on this screen:
 *
 *   this screen  readAllPages over order_charges     ceil(C / 1000) + 1
 *   download     the same, plus the orders and        + 2 * ceil(Uo / 150)
 *                shipments joins at 150 ids a request + 2 * ceil(Us / 150)
 *
 * So the screen is tens of requests at worst and was never the risk; the
 * download is hundreds, serially, and was being run on Vercel's default
 * budget. That is fixed at its source -- the route now declares
 * `maxDuration = 300`, with the arithmetic written out there -- which is what
 * makes offering a year here safe rather than merely possible.
 *
 * There is no hand-written list here any more. The picker renders GRAINS over
 * GRAIN_LABELS, which is a Record<Grain, string> -- so a grain added to the
 * type without a label fails to compile, and a grain that exists cannot go
 * unoffered again. The previous list was three entries beside a four-member
 * union, and nothing anywhere objected.
 */

interface ClientRow { id: string; name: string }

async function getClients() {
  const res = await supabaseAdmin
    .from('clients')
    .select('id, name')
    .eq('active', true)
    .order('name')
  const clients = read('clients', res)
  return loaded(readErrors(clients), () => clients.rows as ClientRow[])
}

/**
 * The statement, and how far back the ledger's record of this client goes.
 *
 * Both reads are refused together. The earliest-charge read is what decides
 * whether a $0.00 total means "this client did nothing this month" or "we have
 * no record of this client at all" (coverageNote), so publishing the total
 * while that read failed would put the confident reading of an ambiguous figure
 * on a document headed for a client.
 */
async function getStatement(clientId: string, clientName: string, range: DateRange) {
  const [chargesRes, earliestRes] = await Promise.all([
    readStatementCharges(clientId, range),
    readEarliestChargeDate(clientId),
  ])

  const charges = read('charges for this period', chargesRes)
  const earliest = read("the client's earliest charge", earliestRes)
  const priced = await priceStatementCharges(clientId, clientName, charges.rows ?? [], range)
  const priceError = priced.error
    ? `shipment prices could not be read (${priced.error.message})`
    : null
  const agreed = await loadAgreedMinimum(clientName)
  const statement = buildStatement(priced.charges, range)

  return loaded(readErrors(charges, earliest) ?? priceError, () => ({
    range,
    statement,
    freightReviews: priced.freightReviews,
    basisReviews: priced.basisReviews,
    pickDetails: priced.pickDetails,
    pickReason: priced.pickPack.reason,
    minimum: monthlyMinimumBill({
      from: range.from,
      to: range.to,
      rows: priced.charges,
      agreed,
    }),
    // An explicit length check, and NOT `rows[0]?.charge_date ?? null`.
    // `noUncheckedIndexedAccess` is off in this project, so `rows[0]` is typed
    // as always present: the `?.` and the `?? null` are both read as dead code
    // and the field leaves here typed `string` while being null at runtime for
    // every client with no charges -- the exact client coverageNote exists for.
    // A later reader trusting that type writes `earliest.slice(0, 7)` and the
    // screen throws on the one client it most needed to explain itself to.
    //
    // Annotating a local `{ charge_date: string } | undefined` does NOT fix it
    // either: control-flow analysis narrows a const straight back to the type
    // of its initialiser, so the `| undefined` is discarded. Probed, both ways
    // -- tsc reported `string` for the `?.` form and for the annotated local,
    // and `string | null` only for this one.
    //
    // `[]` here is a real answer: this client has no charges on any date.
    // Distinct from the read having failed, which the gate above already took.
    earliest: earliest.rows.length === 0 ? null : earliest.rows[0].charge_date,
  }))
}

/** Units billed. A dash and not 0 -- see StatementLine.quantity. */
function Units({ quantity }: { quantity: number | null }) {
  if (quantity === null) {
    return (
      <span
        className="text-slate-500"
        title="No charge on this line carries a quantity — a percentage surcharge is priced off a basis, not off a count. This is not a quantity of zero."
      >
        {UNPRICED_DASH}
      </span>
    )
  }
  return <span className="text-slate-300">{quantity.toLocaleString('en-US')}</span>
}

/**
 * A money cell that can be UNKNOWN.
 *
 * `totalOrUnknown` and not `sum.total`: a line whose every row is waiting on a
 * carrier invoice sums to 0, and $0.00 on an invoice line means "free".
 */
function Amount({ sum }: { sum: Statement['sum'] }) {
  const total = totalOrUnknown(sum)
  if (total === null) {
    return (
      <span
        className="text-orange-500"
        title="This amount is not known yet. It is not zero."
      >
        unknown
      </span>
    )
  }
  return <span className="text-slate-200">{formatPrice(total)}</span>
}

export default async function StatementsPage(
  { searchParams }: { searchParams: Promise<{ client?: string; grain?: string; from?: string; to?: string; month?: string }> },
) {
  const query = await searchParams
  const clientId = query.client
  const period = resolveStatementQuery(query)
  const grain = period.ok ? period.grain : null
  const grainNote = period.ok ? '' : period.error

  const clientsPage = await getClients()
  // The client list IS the screen when no client is chosen, so a failed read of
  // it refuses the page rather than rendering a picker with nothing in it --
  // which would read as "there are no active clients".
  if (!clientsPage.ok) return <Shell><ViewUnreadable message={clientsPage.error} /></Shell>
  const clients: LoadedData<typeof clientsPage> = clientsPage.data

  const selected = clients.find(c => c.id === clientId) ?? null

  return (
    <Shell>
      <StatementPeriodForm
        clients={clients}
        selectedId={selected?.id ?? ''}
        grain={query.month || query.from || query.to ? '' : (query.grain || 'month')}
        month={query.month ?? ''}
        from={query.from ?? ''}
        to={query.to ?? ''}
      />

      <StatementDownloads
        enabled={selected !== null && period.ok}
        reason={selected === null
          ? 'Choose a client before downloading.'
          : !period.ok
            ? 'Choose one period before downloading.'
            : ''}
        csv={selected && period.ok ? `/api/statements/download?client=${encodeURIComponent(selected.id)}&from=${encodeURIComponent(period.range.from)}&to=${encodeURIComponent(period.range.to)}&format=csv` : ''}
        excel={selected && period.ok ? `/api/statements/download?client=${encodeURIComponent(selected.id)}&from=${encodeURIComponent(period.range.from)}&to=${encodeURIComponent(period.range.to)}` : ''}
        pdf={selected && period.ok ? `/api/statements/download?client=${encodeURIComponent(selected.id)}&from=${encodeURIComponent(period.range.from)}&to=${encodeURIComponent(period.range.to)}&format=pdf` : ''}
      />

      {grainNote !== '' && (
        <p className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-700">
          {grainNote}
        </p>
      )}

      {selected === null || !period.ok ? (
        <p className="text-sm text-[#0B1220]">
          Choose a client and one period. No figures are shown until both are
          valid — a statement with no client is not an empty statement, it is no
          statement.
        </p>
      ) : (
        <StatementSection clientId={selected.id} name={selected.name} grain={grain} range={period.range} />
      )}
    </Shell>
  )
}

/**
 * The statement for one chosen client.
 *
 * Its own async component rather than a branch in the page, so the refusal gate
 * is a real narrowing of a `Loaded` -- `statementPage!.ok` inside a ternary
 * typechecks either way, and a gate that tsc cannot enforce is the one defect
 * `Loaded` was introduced to make impossible (see read.ts).
 */
async function StatementSection(
  { clientId, name, grain, range }: { clientId: string; name: string; grain: Grain | null; range: DateRange },
) {
  const page = await getStatement(clientId, name, range)
  if (!page.ok) return <ViewUnreadable message={page.error} />
  const data: LoadedData<typeof page> = page.data

  return <StatementTable name={name} grain={grain} data={data} />
}

function StatementDownloads({
  enabled, reason, csv, excel, pdf,
}: {
  enabled: boolean
  reason: string
  csv: string
  excel: string
  pdf: string
}) {
  const shape = 'inline-flex min-h-11 w-full items-center justify-center rounded-lg px-4 py-2 text-center text-sm font-semibold sm:w-auto'
  if (!enabled) {
    return (
      <div>
        <p className="mb-2 text-sm text-[#0B1220]">{reason}</p>
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          {['Download CSV', 'Download Excel', 'Download PDF'].map((label) => (
            <button
              key={label}
              type="button"
              disabled
              className={`${shape} cursor-not-allowed border border-[#64748B] bg-[#E2E8F0] text-[#0B1220]`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
      <a href={csv} className={`${shape} bg-[#0B3361] text-white hover:bg-[#0F4A94]`}>Download CSV</a>
      <a href={excel} className={`${shape} bg-[#1A73E8] text-white hover:bg-[#0B5ED7]`}>Download Excel</a>
      <a href={pdf} className={`${shape} border border-[#0B1220] bg-white text-[#0B1220] hover:bg-[#EEF3FA]`}>Download PDF</a>
    </div>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-6 font-sans text-[#0B1220]">
      <div>
        <h2 className="text-2xl font-bold text-[#0B1220]">Statements</h2>
        <p className="mt-1 text-sm text-[#3A4658]">
          Charges whose charge date falls in the period. This month is the 1st
          through the last day of that month, not the month so far. Lines that
          share a charge and a label are added into one row, so one shipping row
          can be many parcels, and “41 rates” means those parcels do not share one
          rate. Pick units are order quantities. When the ledger has no pick
          charge, each order is priced from the price list and those orders are
          added. A stored rate replaces a blank shipping amount. When the stored
          rate and the ledger amount differ, neither is the client price and the
          amount due is not final. A linked full freight price is still the
          client price. This page does not show that every order in the month is
          included. The order rows are on Order activity. A missing price stays
          unknown. The $395 floor applies only when the range is one full calendar
          month and every amount is known. This is not an invoice and nothing
          here is saved.
        </p>
      </div>
      {children}
    </div>
  )
}

function StatementTable(
  { name, grain, data }: {
    name: string
    grain: Grain | null
    data: {
      range: DateRange
      statement: Statement
      earliest: string | null
      freightReviews: string[]
      basisReviews: string[]
      pickDetails: { orderId: string | null; orderNumber: string; chargeDate: string; quantity: number | null; amount: number | null; label: string; source: string }[]
      pickReason: string
      minimum: MonthlyMinimum
    }
  },
) {
  const { range, statement, earliest, minimum, freightReviews, basisReviews, pickDetails, pickReason } = data
  const figures = statementFigures(statement, minimum)
  const subtotal = figures.knownSubtotal
  const dueCell = statementAmountDueCell(figures)
  const dueText = typeof dueCell === 'number' ? formatPrice(dueCell) : dueCell

  const coverage = coverageNote(earliest, range, statement.lines.length)
  const unpriced = unpricedNote(statement.sum.unpriced, 'charge')
  const estimated = estimateNote(statement.estimated)

  return (
    <div className="rounded-xl bg-slate-800 p-5">
      <div className="mb-1 flex flex-wrap items-start justify-between gap-2">
        <h3 className="font-semibold text-white">{name}</h3>
        <span className="font-mono text-xs text-slate-300">{periodLabel(grain, range)}</span>
      </div>

      {statement.lines.length === 0 ? (
        <p className="mt-3 text-sm text-slate-300">
          No charges recorded for {name} in this period.
        </p>
      ) : (
        <div className="mt-4 max-w-full">
          <ul className="space-y-3 md:hidden">
            {statement.lines.map(line => (
              <li key={`${line.charge_type}\u0000${line.label}-card`} className="rounded-lg border border-slate-600 p-3 text-sm">
                <p className="font-mono text-xs text-sky-300">{line.charge_type}</p>
                <p className="text-slate-100">{line.label}</p>
                <p className="mt-1 text-slate-300">Units <Units quantity={line.quantity} /></p>
                <p className="text-slate-300">Rate {rateText(line)}</p>
                <p className="font-medium text-white">Amount <Amount sum={line.sum} /></p>
              </li>
            ))}
          </ul>
          <div className="hidden max-w-full overflow-x-auto md:block">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-700 text-left text-xs uppercase text-slate-200">
                <th className="pb-2 pr-3">Charge</th>
                <th className="pb-2 pr-3">Line</th>
                <th className="pb-2 pr-3 text-right">Units</th>
                <th className="pb-2 pr-3 text-right">Rate</th>
                <th className="pb-2 text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {statement.lines.map(line => (
                <tr
                  // The same (type, label) pair buildStatement groups on,
                  // joined on the same escaped NUL for the same reason: a
                  // space separator would make ('a b', 'c') and ('a', 'b c')
                  // one key, and two rows sharing a React key inherit each
                  // other's DOM. Written as the ESCAPE and never as a literal
                  // byte -- a raw NUL makes the whole file binary to git and
                  // grep, which is how this exact line was briefly invisible
                  // to a search for it.
                  key={`${line.charge_type}\u0000${line.label}`}
                  className="border-b border-slate-800 hover:bg-white/5"
                >
                  <td className="py-2.5 pr-3 font-mono text-xs text-sky-200">{line.charge_type}</td>
                  <td className="py-2.5 pr-3 text-slate-300">{line.label}</td>
                  <td className="py-2.5 pr-3 text-right"><Units quantity={line.quantity} /></td>
                  <td className="py-2.5 pr-3 text-right font-mono text-xs text-slate-100">
                    {rateText(line)}
                  </td>
                  <td className="py-2.5 text-right font-medium"><Amount sum={line.sum} /></td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-slate-600">
                <td className="pt-3 pr-3 text-xs uppercase text-slate-200" colSpan={4}>
                  {figures.subtotalLabel}
                </td>
                <td className="pt-3 text-right font-medium text-white">
                  {subtotal === null ? 'unknown' : formatPrice(subtotal)}
                </td>
              </tr>
              <tr>
                <td className="pt-2 pr-3 text-xs uppercase text-slate-200" colSpan={4}>
                  Monthly minimum top-up
                </td>
                <td className="pt-2 text-right font-medium text-white">
                  {minimum.applies && minimum.topUpCents !== null
                    ? formatPrice(minimum.topUpCents / 100)
                    : 'not applied'}
                </td>
              </tr>
              <tr>
                <td className="pt-2 pr-3 text-xs uppercase text-slate-200" colSpan={4}>
                  Amount due
                </td>
                <td className="pt-2 text-right text-base font-bold text-white">
                  {dueText}
                </td>
              </tr>
            </tfoot>
          </table>
          </div>
          <div className="mt-3 space-y-1 text-sm text-slate-100 md:hidden">
            <p>{figures.subtotalLabel} {subtotal === null ? 'unknown' : formatPrice(subtotal)}</p>
            <p>Monthly minimum top-up {minimum.applies && minimum.topUpCents !== null ? formatPrice(minimum.topUpCents / 100) : 'not applied'}</p>
            <p className="font-bold">Amount due {dueText}</p>
          </div>
        </div>
      )}

      {/* The caveats. Each renders only when it has something to say, so none of
          them is the permanent all-clear that teaches a reader to skip the box. */}
      <ul className="mt-4 space-y-1.5 border-t border-slate-700 pt-4 text-xs text-amber-100">
        <li>{minimum.reason}</li>
        {coverage !== '' && <li>{coverage}</li>}
        {unpriced !== '' && <li>{unpriced}.</li>}
        {freightReviews.map((note) => <li key={note}>{note}</li>)}
        {estimated !== '' && <li>{estimated}.</li>}
        {basisReviews.length > 0 && <li>Internal review. These notes are not client charges and are not in the download.</li>}
        {basisReviews.map((note) => <li key={note}>{note}</li>)}
      </ul>
      <div className="mt-4 border-t border-slate-700 pt-4">
        <h4 className="text-sm font-semibold text-white">Pick per order</h4>
        <p className="mt-1 text-xs text-slate-100">{pickReason}</p>
        <p className="mt-1 text-xs text-slate-200">
          <a href="/client-report/activity" className="font-semibold text-white underline">Order activity</a>
          {' '}lists each order on the 16 workbook columns. Quantity there is units picked. A missing pick date is not amount due. The current item list is not a ship-day price. The imported client report is not this list.
        </p>
        {pickDetails.length === 0 ? (
          <p className="mt-2 text-xs text-slate-100">No per-order pick line in this period.</p>
        ) : (
          <div className="mt-2 max-h-80 overflow-auto">
            <table className="w-full text-xs text-slate-100">
              <thead>
                <tr className="text-left text-slate-100">
                  <th className="py-1 pr-2">Order</th>
                  <th className="py-1 pr-2">Date</th>
                  <th className="py-1 pr-2 text-right">Units</th>
                  <th className="py-1 pr-2">Line</th>
                  <th className="py-1 text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {pickDetails.map((row, index) => (
                  <tr key={`${row.orderId ?? row.orderNumber}:${row.label}:${index}`} className="border-t border-slate-600">
                    <td className="py-1 pr-2">{row.orderNumber || row.orderId || 'Unknown order'}</td>
                    <td className="py-1 pr-2">{row.chargeDate}</td>
                    <td className="py-1 pr-2 text-right">{row.quantity ?? 'Unknown'}</td>
                    <td className="py-1 pr-2">{row.label}</td>
                    <td className="py-1 text-right">{row.amount == null ? 'Unknown' : formatPrice(row.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
