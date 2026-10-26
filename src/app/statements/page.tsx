import { supabaseAdmin } from '@/lib/supabase'
import { read, readErrors, loaded, type LoadedData } from '@/lib/db/read'
import ViewUnreadable from '@/components/ui/ViewUnreadable'
import {
  readStatementCharges, readEarliestChargeDate,
} from '@/lib/billing/statement-charges'
import {
  periodRange, buildStatement, statementTotal, statementToday,
  GRAINS, GRAIN_LABELS,
  type Grain, type Statement,
} from '@/lib/billing/statement'
import {
  rateText, periodLabel, coverageNote, estimateNote, grainChoice,
} from '@/lib/billing/statement-view'
import {
  formatPrice, unpricedNote, totalOrUnknown, UNPRICED_DASH,
} from '@/lib/billing/unpriced'

// What one client has made in a period, priced off their own rate card.
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
async function getStatement(clientId: string, grain: Grain) {
  const range = periodRange(grain, statementToday())

  const [chargesRes, earliestRes] = await Promise.all([
    readStatementCharges(clientId, range),
    readEarliestChargeDate(clientId),
  ])

  const charges = read('charges for this period', chargesRes)
  const earliest = read("the client's earliest charge", earliestRes)

  return loaded(readErrors(charges, earliest), () => ({
    range,
    statement: buildStatement(charges.rows, range),
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
        title="Every charge on this line is billed at cost and the carrier has not reported yet. This is UNKNOWN, not zero."
      >
        unknown
      </span>
    )
  }
  return <span className="text-slate-200">{formatPrice(total)}</span>
}

export default async function StatementsPage(
  { searchParams }: { searchParams: Promise<{ client?: string; grain?: string }> },
) {
  const { client: clientId, grain: askedGrain } = await searchParams
  const { grain, note: grainNote } = grainChoice(askedGrain, 'month')

  const clientsPage = await getClients()
  // The client list IS the screen when no client is chosen, so a failed read of
  // it refuses the page rather than rendering a picker with nothing in it --
  // which would read as "there are no active clients".
  if (!clientsPage.ok) return <Shell><ViewUnreadable message={clientsPage.error} /></Shell>
  const clients: LoadedData<typeof clientsPage> = clientsPage.data

  const selected = clients.find(c => c.id === clientId) ?? null

  return (
    <Shell>
      <form method="GET" className="flex flex-wrap items-end gap-3 rounded-xl bg-slate-800 p-5">
        <label className="flex flex-col gap-1 text-xs uppercase text-slate-500">
          Client
          <select
            name="client"
            defaultValue={selected?.id ?? ''}
            className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200"
          >
            <option value="">Choose a client…</option>
            {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs uppercase text-slate-500">
          Period
          <select
            name="grain"
            defaultValue={grain}
            className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200"
          >
            {GRAINS.map(g => <option key={g} value={g}>{GRAIN_LABELS[g]}</option>)}
          </select>
        </label>

        <button
          type="submit"
          className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-500"
        >
          Show statement
        </button>

        {selected !== null && (
          <a
            href={`/api/statements/download?client=${encodeURIComponent(selected.id)}&grain=${encodeURIComponent(grain)}`}
            className="rounded-lg border border-slate-600 px-4 py-2 text-sm text-slate-200 hover:bg-white/5"
          >
            Download Excel
          </a>
        )}
      </form>

      {grainNote !== '' && (
        <p className="rounded-xl border border-amber-700/50 bg-amber-950/30 p-4 text-sm text-amber-300">
          {grainNote}
        </p>
      )}

      {selected === null ? (
        <p className="text-sm text-slate-500">
          Choose a client to see what they have been billed for the period. No
          figures are shown until one is chosen — a statement with no client is
          not an empty statement, it is no statement.
        </p>
      ) : (
        <StatementSection clientId={selected.id} name={selected.name} grain={grain} />
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
  { clientId, name, grain }: { clientId: string; name: string; grain: Grain },
) {
  const page = await getStatement(clientId, grain)
  if (!page.ok) return <ViewUnreadable message={page.error} />
  const data: LoadedData<typeof page> = page.data

  return <StatementTable name={name} grain={grain} data={data} />
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-6 font-sans text-slate-200">
      <div>
        <h2 className="text-2xl font-bold text-[#0B1220]">Statements</h2>
        <p className="mt-1 text-sm text-slate-400">
          What one client has been billed for a period — pick and pack counts at
          their own rates, plus shipping. Read live from the ledger; this is not
          an invoice and nothing here is saved.
        </p>
      </div>
      {children}
    </div>
  )
}

function StatementTable(
  { name, grain, data }: {
    name: string
    grain: Grain
    data: { range: ReturnType<typeof periodRange>; statement: Statement; earliest: string | null }
  },
) {
  const { range, statement, earliest } = data
  const total = statementTotal(statement)

  const coverage = coverageNote(earliest, range)
  const unpriced = unpricedNote(statement.sum.unpriced, 'charge')
  const estimated = estimateNote(statement.estimated)

  return (
    <div className="rounded-xl bg-slate-800 p-5">
      <div className="mb-1 flex flex-wrap items-start justify-between gap-2">
        <h3 className="font-semibold text-[#0B1220]">{name}</h3>
        <span className="font-mono text-xs text-slate-500">{periodLabel(grain, range)}</span>
      </div>

      {statement.lines.length === 0 ? (
        <p className="mt-3 text-sm text-slate-500">
          No charges recorded for {name} in this period.
        </p>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-700 text-left text-xs uppercase text-slate-500">
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
                  <td className="py-2.5 pr-3 font-mono text-xs text-sky-300">{line.charge_type}</td>
                  <td className="py-2.5 pr-3 text-slate-300">{line.label}</td>
                  <td className="py-2.5 pr-3 text-right"><Units quantity={line.quantity} /></td>
                  <td className="py-2.5 pr-3 text-right font-mono text-xs text-slate-400">
                    {rateText(line)}
                  </td>
                  <td className="py-2.5 text-right font-medium"><Amount sum={line.sum} /></td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-slate-600">
                <td className="pt-3 pr-3 text-xs uppercase text-slate-500" colSpan={4}>
                  Total for the period
                </td>
                <td className="pt-3 text-right text-base font-bold text-[#0B1220]">
                  {total === null ? (
                    <span
                      className="text-orange-500"
                      title="Every charge in this period is billed at cost and no carrier has reported yet. The total is UNKNOWN, not zero."
                    >
                      unknown
                    </span>
                  ) : formatPrice(total)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {/* The caveats. Each renders only when it has something to say, so none of
          them is the permanent all-clear that teaches a reader to skip the box. */}
      {(coverage !== '' || unpriced !== '' || estimated !== '') && (
        <ul className="mt-4 space-y-1.5 border-t border-slate-700 pt-4 text-xs text-amber-400/90">
          {coverage !== '' && <li>{coverage}</li>}
          {unpriced !== '' && <li>{unpriced} — billed at cost, awaiting the carrier.</li>}
          {estimated !== '' && <li>{estimated}.</li>}
        </ul>
      )}
    </div>
  )
}
