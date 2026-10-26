'use client'

import { useState } from 'react'
import { showError, showSuccess } from '@/components/ui/Toast'
import {
  formatPrice, formatSignedPrice, isPriced, sumPriced, totalOrUnknown,
  unpricedNote, UNPRICED_DASH, type Money,
} from '@/lib/billing/unpriced'
import {
  combineReconciled, exclusionNote, marginPct, reconcile, reconciledOrUnknown,
} from '@/lib/billing/profit-rollup'
import { embedOne, type Embed } from '@/lib/db/read'
import { scopeRows, undatedNote, unattributedNote, type Scoped } from '@/lib/billing/date-range'
import {
  REPORT_TABS, reportTabById, reportTypeForTab, tabRequiresClient,
} from '@/lib/billing/report-types'
import { reportHeading } from '@/lib/billing/report-heading'

// `client_rate`, the profit derived from it, and `warehouse_daily_log.total`
// are all nullable: recalculate.ts and the daily-log route write null when they
// cannot read a rate, rather than the billable 0 they used to write. `?? 0`
// printed those as "$0.00" -- indistinguishable from a line carried free -- and
// dropped them out of every total while leaving them in the count beside it.
//
// This file cannot be unit-tested here (vitest.config.ts excludes `.test.tsx`),
// so the rules live in lib/billing/unpriced.ts, which is tested and
// mutation-checked, and this file only calls them.
//
// `adjustment_amount` was previously left on `?? 0` here, on the grounds that
// nothing writes null to that column so changing it would be a guess dressed up
// as a fix. That reasoning is withdrawn, for two reasons neither of which was
// available when it was written:
//
//   1. It is not true as stated. schema.sql:68 declares `adjustment_amount
//      numeric(10,2)` with no `not null`, so the column accepts null whatever
//      today's writers happen to do. "No current writer emits null" is a fact
//      about four call sites, not about the data this page reads.
//   2. It answers the wrong question. `?? 0` guards null and undefined only,
//      and the hazard on a `numeric` column is the wire shape: PostgREST is
//      entitled to hand back '12.34', on which `.toFixed` is not a function and
//      `s + x` is string concatenation -- `0 + '12.34'` is '012.34', which then
//      poisons every remaining addition in the same reduce. Nullability was
//      never the only thing `?? 0` was failing to handle.
//
// So the columns below go through priceOf, which coerces rather than assuming
// either shape. If the column really is never null, nothing on screen changes.

// The payload, declared rather than inferred -- see the LoadedData docstring in
// src/lib/db/read.ts for why `data: any` here was load-bearing rather than
// untidy: it let /reports' refusal-to-render check be deleted without tsc
// noticing, on the one screen in the app that writes a .xlsx file.
//
// `type` and not `interface`, because an interface has no implicit index
// signature and so would not satisfy sumPriced's `Record<string, unknown>`.
//
// Note the row shapes are NOT shared with BillingView even where the table is
// the same. Both pages now select `client_id`, but this one also joins
// `clients(name)` because it renders a Client column across every client, while
// /billing is already scoped to one. A single shared row type would have to make
// the join optional, which would describe neither page and would let a field
// that is always undefined on one of them compile.
type ClientOption = { id: string; name: string | null }

/**
 * What every row on this screen carries so the client dropdown can filter it.
 *
 * `string | null` and not `string`: schema.sql declares `client_id uuid
 * references clients(id)` on all four tables with no `not null` (lines
 * 39, 64, 79, 105), and the production monitor reports 241 shipments from 9
 * unmapped stores -- so the null case is live data carrying money nobody has
 * attributed, not a defensive branch. filterByClient counts those rows out
 * loud rather than dropping them silently; see its docstring.
 */
type Attributed = { client_id: string | null }

/**
 * The `clients(name)` join.
 *
 * Written as an Embed rather than as the object this file's five render sites
 * already assume, because the cardinality is genuinely unverified here: the
 * fourteen consumers in this repo read `.name` off an object, supabase-js's
 * select-string parser types the same embed as an array, and nobody has asked
 * the database. See the Embed docstring in src/lib/db/read.ts. Reading it
 * through embedOne costs one call per cell and is right either way.
 */
type ClientRef = Embed<{ name: string | null }>

type ReportLossShipment = Attributed & {
  // The row's React key, and that is the whole reason it is selected.
  // `order_number` is NOT unique -- supabase/ledger_03_charges.sql:8 states it
  // outright: multi-package orders, reships and return labels share one. Both
  // tables below were keyed by it, so React reconciled two distinct shipments
  // as one row and a re-render could paint the second one's money into the
  // first one's cells.
  //
  // Optional, because `id` being absent means a `.select()` that was not
  // updated rather than a row with no primary key, and the `??` at both render
  // sites keeps the table rendering instead of crashing on an undefined key.
  id?: string | null
  order_number: string
  clients: ClientRef
  ship_date: string | null
  carrier: string | null
  service: string | null
  actual_cost: Money
  client_rate: Money
  profit_loss: Money
}

/** The shipments select is the losses select plus these two. */
type ReportShipment = ReportLossShipment & {
  tracking_number: string | null
  is_loss: boolean | null
}

type ReportAdjustment = Attributed & {
  order_number: string
  clients: ClientRef
  reason: string | null
  adjustment_date: string | null
  original_cost: Money
  // Was `new_cost`, which occurs in no migration and which nothing writes.
  // This was the stronger of this file's two phantom columns and it is now
  // settled: schema.sql:67 declares `adjusted_cost`, shipstation.ts:620 WRITES
  // `adjusted_cost`, and api/reports/download/route.ts and
  // AdjustmentsClient.tsx both read it. Only this page's select disagreed.
  //
  // Reading the column the writer writes is correct whether or not `new_cost`
  // exists -- see the note on `manual_charges_total` below, which is the same
  // argument. If it does not exist the select was a 42703, which read() turns
  // into an error, which makes reports/page.tsx refuse the whole screen: six
  // reads feed six tabs and any one failing blanks all of them, which is what
  // "Reports is not working" looks like.
  adjusted_cost: Money
  adjustment_amount: Money
  status: string | null
}

type ReportBill = Attributed & {
  clients: ClientRef
  week_start: string
  week_end: string
  shipping_total: Money
  warehouse_total: Money
  adjustments_total: Money
  // Was `manual_total`. Same reasoning as the note on BillingView's BillingBill:
  // calculator.ts:298 is the only writer to `bills` and it writes
  // `manual_charges_total`, so reading that name is right whether or not a
  // `manual_total` column also exists -- and if it does not, this select has
  // been failing with 42703 since the initial commit.
  manual_charges_total: Money
  grand_total: Money
  status: string | null
}

type ReportWarehouseLine = Attributed & {
  clients: ClientRef
  log_date: string
  service_type: string | null
  // A count rather than a price, rendered raw rather than summed -- so not
  // Money, but still a `numeric` column whose wire shape is not guaranteed.
  quantity: number | string | null
  rate: Money
  total: Money
  notes: string | null
}

export type ReportsData = {
  clients: ClientOption[]
  shipments: ReportShipment[]
  lossShipments: ReportLossShipment[]
  adjustments: ReportAdjustment[]
  bills: ReportBill[]
  warehouse: ReportWarehouseLine[]
  defaultFrom: string
  defaultTo: string
}

/** What every one of the five tables below is handed. */
type TableProps<T> = {
  rows: T[]
  clientId: string
  dateFrom: string
  dateTo: string
}

// The tab list and the tab -> export-type mapping used to be declared here, as
// `TABS` and as a `typeMap` object inside handleDownload. Both are now derived
// from REPORT_TABS in @/lib/billing/report-types, which the download route also
// reads. See that file's header for the drift this removes; the short version is
// that the two lists here and the one in the route had already diverged, leaving
// 'profit-loss' a working export with no tab able to request it.

export default function ReportsTabs({ data }: { data: ReportsData }) {
  const [activeTab, setActiveTab] = useState('shipments')
  const [clientId, setClientId] = useState('')
  const [dateFrom, setDateFrom] = useState(data.defaultFrom)
  const [dateTo, setDateTo] = useState(data.defaultTo)
  const [downloading, setDownloading] = useState(false)

  // Recomputed per render rather than memoised: it is four strings, and a
  // stale generated-at stamp is the one thing on the sheet that must not lag.
  const printHeading = reportHeading({
    tabLabel: reportTabById(activeTab)?.label ?? 'Report',
    clientId,
    clients: data.clients,
    dateFrom,
    dateTo,
    generatedAt: new Date(),
  })

  function handlePrintPDF() {
    window.print()
  }

  async function handleDownload() {
    // Resolved BEFORE setDownloading, so a tab with no spreadsheet cannot
    // leave the button stuck in its '⏳…' state. The old code set the flag
    // first and read the map second, and the map returning undefined still
    // went down the fetch path -- `type=undefined` on the wire, a 400 back,
    // and a toast about query parameters.
    const reportType = reportTypeForTab(activeTab)
    if (reportType === null) {
      // Not reachable from the UI: the button below does not render for these
      // tabs. Kept because "the button is hidden" is a fact about a different
      // expression twenty lines away, and this function is exported to the
      // click handler, not to a proof.
      showError('No spreadsheet for this tab', 'This view has no Excel export.')
      return
    }
    setDownloading(true)
    const params = new URLSearchParams({ type: reportType, dateFrom, dateTo, ...(clientId ? { clientId } : {}) })
    try {
      const res = await fetch(`/api/reports/download?${params}`)
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error ?? `Server error ${res.status}`)
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${reportType}-${dateFrom}-${dateTo}.xlsx`
      a.click()
      URL.revokeObjectURL(url)
      showSuccess('Report downloaded')
    } catch (err) {
      showError('Download failed',
        err instanceof Error && err.message !== ''
          ? err.message
          : 'Could not generate report')
    } finally {
      setDownloading(false)
    }
  }

  return (
    <div className="space-y-4">
      {/*
        PRINT ONLY, and it is not decoration. On screen the filter bar states
        the report's scope -- which client, which dates. Those are form
        controls, so window.print() takes them away with the rest of the
        chrome and leaves a table of figures with nothing saying whose they
        are or what period they cover. This puts the scope in the document
        instead. See src/lib/billing/report-heading.ts.
      */}
      <div className="print-only" style={{ marginBottom: '12px' }}>
        <h1 style={{ fontSize: '16pt', fontWeight: 700 }}>{printHeading.title}</h1>
        <p style={{ fontSize: '11pt' }}>{printHeading.scope}</p>
        <p style={{ fontSize: '11pt' }}>{printHeading.period}</p>
        <p style={{ fontSize: '9pt' }}>{printHeading.generated}</p>
      </div>

      {/* Filters + Download bar */}
      <div data-print-hide className="bg-gray-800 rounded-xl px-5 py-4 flex flex-wrap items-end gap-4">
        <div>
          <label className="block text-xs text-gray-400 mb-1">From</label>
          <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
            className="bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-[#00AAFF]" />
        </div>
        <div>
          <label className="block text-xs text-gray-400 mb-1">To</label>
          <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
            className="bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-[#00AAFF]" />
        </div>
        <div>
          <label className="block text-xs text-gray-400 mb-1">Client</label>
          <select value={clientId} onChange={e => setClientId(e.target.value)}
            className="bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-[#00AAFF]">
            <option value="">All Clients</option>
            {data.clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div className="ml-auto flex gap-2">
          {/*
            Rendered only when the active tab HAS a spreadsheet. A button that
            is present but cannot work is worse than an absent one: the operator
            clicks it, waits, and gets an error about a query parameter.
            PDF stays unconditional -- it is window.print(), so it works on
            whatever is on screen regardless of which exports exist.
          */}
          {reportTypeForTab(activeTab) !== null && (
            <button onClick={handleDownload} disabled={downloading}
              className="px-4 py-2 rounded-lg text-sm font-semibold text-white bg-gray-700 hover:bg-gray-600 disabled:opacity-50 transition">
              {downloading ? '⏳…' : '↓ Excel'}
            </button>
          )}
          <button onClick={handlePrintPDF} disabled={downloading}
            className="px-4 py-2 rounded-lg text-sm font-semibold text-white disabled:opacity-50 transition"
            style={{ background: '#00AAFF' }}>
            ↓ PDF
          </button>
        </div>
      </div>

      {/* Tabs. Navigation, so it does not belong on paper -- and a printed
          tab strip implies the other tabs are part of this document. */}
      <div data-print-hide className="flex gap-1 bg-gray-900 rounded-xl p-1">
        {REPORT_TABS.map(tab => (
          <button key={tab.id} onClick={() => setActiveTab(tab.id)}
            className={`flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium transition ${
              activeTab === tab.id ? 'text-white' : 'text-gray-400 hover:text-white'
            }`}
            style={activeTab === tab.id ? { background: '#00AAFF' } : {}}>
            <span>{tab.icon}</span>{tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="bg-gray-800 rounded-xl overflow-hidden">
        {/*
          THE ONE PLACE the "this tab needs a client" rule is enforced.

          Read from the registry via tabRequiresClient rather than compared
          against a tab id here, and checked ABOVE the panels rather than inside
          them. Both of those are the point. A panel that re-decides it is a
          second copy of the rule -- the pattern report-types.ts exists to
          remove -- and a rule enforced once per panel is a rule the next tab
          that needs it will be added without.

          The gate also means the panel below never renders with `clientId ===
          ''`, so it does not have to handle it. If one ever did get through,
          its fetch sends an empty `client` and /api/statements/data answers 400
          with its own sentence, which the panel's error state renders verbatim.
        */}
        {tabRequiresClient(activeTab) && clientId === '' ? (
          <ChooseClientFirst tabId={activeTab} />
        ) : (
          <>
            {activeTab === 'shipments' && <ShipmentsTable rows={data.shipments} clientId={clientId} dateFrom={dateFrom} dateTo={dateTo} />}
            {activeTab === 'profit' && <ProfitTable rows={data.shipments} clientId={clientId} dateFrom={dateFrom} dateTo={dateTo} />}
            {activeTab === 'loss' && <LossTable rows={data.lossShipments} clientId={clientId} dateFrom={dateFrom} dateTo={dateTo} />}
            {activeTab === 'adjustments' && <AdjustmentsTable rows={data.adjustments} clientId={clientId} dateFrom={dateFrom} dateTo={dateTo} />}
            {activeTab === 'billing' && <BillingTable rows={data.bills} clientId={clientId} dateFrom={dateFrom} dateTo={dateTo} />}
            {activeTab === 'warehouse' && <WarehouseTable rows={data.warehouse} clientId={clientId} dateFrom={dateFrom} dateTo={dateTo} />}
            {/*
              Handed `data.clients` and not a pre-loaded payload. Every other
              tab here renders rows reports/page.tsx already read; this one
              reads on demand, because a statement is ONE client's charges and
              pre-loading it would mean reading every client's `order_charges`
              on every visit to /reports to serve a tab that shows one of them.
              reports/page.tsx also refuses the whole screen when any single
              read fails, so a slow or failing charges read would blank the six
              tabs that work today.
            */}
            {activeTab === 'statement' && (
              <StatementPanel clients={data.clients} clientId={clientId} dateFrom={dateFrom} dateTo={dateTo} />
            )}
          </>
        )}
      </div>
    </div>
  )
}

/**
 * What a `requiresClient` tab shows while the dropdown says All Clients.
 *
 * One component for the whole class of tabs rather than one refusal per tab,
 * and the wording is built from the registry entry so it names whichever tab
 * the operator is looking at. The alternative -- copy written per tab -- is how
 * two tabs end up refusing for what reads like two different reasons.
 *
 * It says what to do next and WHY the tab refuses, because "Choose a client"
 * alone reads as a broken screen. The reason is not a UI nicety: the obvious
 * thing to do with a screen full of figures and a Download button is to send
 * it, and the sum of every client's charges under the heading 'Statement' is a
 * correct figure that must not be sent to anybody.
 */
function ChooseClientFirst({ tabId }: { tabId: string }) {
  const tab = reportTabById(tabId)
  return (
    <div className="px-6 py-12 text-center">
      <div className="text-3xl mb-3">{tab?.icon ?? '📄'}</div>
      <div className="text-white font-semibold mb-2">
        Choose a client to see {tab?.label === undefined ? 'this view' : `the ${tab.label}`}
      </div>
      <p className="text-gray-400 text-sm max-w-md mx-auto">
        This one is a single client&rsquo;s document &mdash; the charges for the
        period, as they go out with that client&rsquo;s invoice &mdash; not a
        management view across all of them. Pick a client in the dropdown above.
      </p>
    </div>
  )
}

/**
 * Client + date filter, generic over the row so neither key can be one the row
 * does not have.
 *
 * `clientId` IS NOW READ. It used to be accepted by this function and ignored,
 * which meant picking a client in the dropdown above filtered nothing on screen
 * -- while the Excel button next to it DID pass clientId to
 * /api/reports/download, which filters in SQL with `.eq('client_id',
 * clientId)`. The table showed every client and the spreadsheet you exported
 * from it showed one. The screenshot that caught it had 'Nayax' selected above
 * rows belonging to SitnStand, Orcam, Crisp Power and Time Systems (UK) Ltd.
 *
 * The old comment here said it could not be fixed in this file because
 * reports/page.tsx selected `clients(name)` and no `client_id`, so the column
 * to filter on was not in the payload. That was true and it was the right
 * diagnosis: the fix went to the source. All five selects now ask for
 * `client_id`, every row type carries it, and `T extends Attributed` makes a
 * table that forgets it a compile error rather than a filter that matches
 * nothing.
 *
 * The date logic lives in src/lib/billing/date-range.ts, shared with
 * BillingView, because the two screens disagreed about undated rows and this one
 * was wrong. `if (dateFrom && d && d < dateFrom)` skips the comparison
 * altogether when `d` is absent, so a row with a null ship_date was KEPT in
 * every range it was ever asked for -- while BillingView dropped it, and more
 * to the point while the Excel export beside this table dropped it too, because
 * /api/reports/download filters in SQL where `null >= '2026-10-01'` is null and
 * therefore not true. The table disagreed with its own download button.
 *
 * Both filters now drop what they cannot place and COUNT it, so the drop is
 * stated instead of silent -- see omissionNote below. Only ship_date and
 * adjustment_date are nullable (schema.sql:42,70); for week_start and log_date
 * the undated count is always 0 and nothing on screen changes.
 *
 * Kept as a wrapper rather than calling scopeRows at the five sites so
 * `clientKey: 'client_id'` is written once. The order of the two filters is not
 * this file's decision to make -- it is load-bearing for what the counts mean,
 * and it is pinned by a test next to scopeRows.
 */
function filterRows<T extends Attributed>(
  rows: T[], clientId: string, dateFrom: string, dateTo: string, dateKey: keyof T & string,
): Scoped<T> {
  return scopeRows(rows, {
    clientKey: 'client_id',
    clientId,
    dateKey,
    from: dateFrom,
    to: dateTo,
  })
}

/**
 * The warning line under a figure, naming every row the figure left out.
 *
 * Two omissions, listed in the order the filters applied them, because they are
 * different problems with different fixes: a row with no client needs a store
 * mapping, a row with no date needs a ship_date. Collapsing them into one count
 * would send the operator looking for the wrong thing.
 *
 * Takes the counts and not the Scoped object so this stays independent of the
 * row type, and so a caller cannot pass the wrong table's result.
 */
function omissionNote(s: { unattributed: number; undated: number }, noun?: string): string {
  return [unattributedNote(s.unattributed, noun), undatedNote(s.undated, noun)]
    .filter(Boolean).join(' · ')
}

function Empty({ msg }: { msg: string }) {
  return <div className="px-6 py-12 text-center text-gray-500 text-sm">{msg}</div>
}

/**
 * Margin as a percentage, or a dash when it is not a ratio.
 *
 * `marginPct` returns null for zero revenue rather than 0, because zero revenue
 * is an undefined ratio and not a zero margin -- `profit / 0` is Infinity or
 * NaN, and both of those render through `toFixed(1)` without complaining
 * ("Infinity%", "NaN%"). The download route's profit-loss branch printed '0%'
 * for exactly this case, which reads as "we broke even" on a client who was
 * never billed at all.
 */
function marginPctText(r: Parameters<typeof marginPct>[0]): string {
  const pct = marginPct(r)
  return pct === null ? UNPRICED_DASH : `${pct.toFixed(1)}%`
}

/**
 * Per-client margin, built so the three money columns actually subtract.
 *
 * WHY THIS TAB IS NOT THE SHIPMENTS TAB WITH A GROUP BY.
 *
 * ShipmentsTable below prints "We Paid", "Charged" and "Net P/L" as three
 * independent sums, the last of which is the STORED `profit_loss` column. Each
 * is individually defensible and the stack of them is not: the three figures
 * are taken over different readable subsets, so Charged minus We Paid does not
 * equal Net P/L, and nothing on screen says so. That is the defect
 * profit-rollup.ts was written to remove, and it was removed from the dashboard
 * first; this tab is the /reports half of the same fix.
 *
 * So every figure here comes from `reconcile`, which sums revenue and cost over
 * the SAME rows -- the ones where both are known -- and derives profit by
 * subtracting them in integer cents. The identity holds by construction rather
 * than by being checked afterwards. Rows it cannot reconcile are not dropped;
 * they are counted into three named buckets and reported under the figure, and
 * `reconciled + unrated + uncosted + unmeasured === counted` is pinned by a
 * test next to the function.
 *
 * SORTED WORST FIRST, which is the question being asked. "Where do I lose from
 * each client, I need to see all the cents I'm losing" -- so the client costing
 * the most money sorts to the top rather than being found by scrolling.
 *
 * GROUPED BY client_id AND NEVER BY NAME. The profit-loss branch of
 * api/reports/download keyed its roll-up on `clients.name ?? 'Unknown'`, which
 * merges two clients who share a name into one line and files every unattributed
 * row under a client literally called Unknown. Grouping on the id keeps them
 * distinct, and the rows with no client get their own labelled line below --
 * they are not noise, they are the 241 shipments from 9 unmapped stores the
 * production monitor reports, carrying real money nobody has assigned. Note
 * those rows only reach here when "All Clients" is selected: filterByClient
 * passes everything through untouched for the empty clientId and counts nothing
 * as unattributed, which is why this groups them rather than relying on the
 * omission note.
 */
function ProfitTable({ rows, clientId, dateFrom, dateTo }: TableProps<ReportShipment>) {
  const period = filterRows(rows, clientId, dateFrom, dateTo, 'ship_date')

  // Keyed on client_id. The empty string is the bucket for rows with no client
  // at all -- a real key here, not a missing one, so it cannot collide with a
  // uuid and cannot be mistaken for a client named 'Unknown'.
  const groups = new Map<string, { name: string | null; rows: ReportShipment[] }>()
  for (const r of period.rows) {
    const key = typeof r.client_id === 'string' ? r.client_id : ''
    const g = groups.get(key)
    if (g) g.rows.push(r)
    else groups.set(key, { name: embedOne(r.clients)?.name ?? null, rows: [r] })
  }

  const lines = [...groups.entries()]
    .map(([key, g]) => ({
      key,
      // Named only when the join actually carried a name. A client row whose
      // name is null is a data problem worth seeing, not a blank cell to fill
      // with the id.
      label: key === ''
        ? 'No client assigned'
        : g.name ?? `(unnamed client ${key.slice(0, 8)})`,
      unattributed: key === '',
      r: reconcile(g.rows),
    }))
    // Worst margin first, and the unattributed line last regardless of its
    // figures: it is not a client and ranking it among them invites reading it
    // as one. `sort` is in-place on an array this expression just built.
    .sort((a, b) => {
      if (a.unattributed !== b.unattributed) return a.unattributed ? 1 : -1
      return a.r.profit - b.r.profit
    })

  const totals = combineReconciled(...lines.map(l => l.r))
  const t = reconciledOrUnknown(totals)
  const totalNote = exclusionNote(totals)

  if (period.rows.length === 0) {
    return <Empty msg="No shipments found for the selected period." />
  }

  return (
    <>
      <div className="grid grid-cols-4 divide-x divide-gray-700 border-b border-gray-700">
        {([
          ['Revenue', t.revenue === null ? UNPRICED_DASH : `$${t.revenue.toFixed(2)}`, 'text-white'],
          ['Cost', t.cost === null ? UNPRICED_DASH : `$${t.cost.toFixed(2)}`, 'text-white'],
          [
            'Profit',
            t.profit === null
              ? UNPRICED_DASH
              : `${t.profit >= 0 ? '+' : ''}$${t.profit.toFixed(2)}`,
            // `t.profit === null` first: `null >= 0` is TRUE in JS, so testing
            // the sign before the null would paint an UNKNOWN margin green.
            t.profit === null ? 'text-gray-400' : t.profit >= 0 ? 'text-green-400' : 'text-red-400',
          ],
          ['Margin', marginPctText(totals), 'text-white'],
        ] as Array<[string, string, string]>).map(([l, v, cls]) => (
          <div key={l} className="px-5 py-3">
            <p className="text-xs text-gray-400">{l}</p>
            <p className={`font-bold text-lg ${cls}`}>{v}</p>
          </div>
        ))}
      </div>

      {/*
        One note for the panel, not one per column -- unlike ShipmentsTable.
        Here it is correct: all three figures are built from the SAME reconciled
        rows, so they are short by exactly the same shipments. That is the
        property this tab exists to have, and a per-column note would imply
        three different shortfalls.
      */}
      {totalNote && (
        <p className="px-5 py-2 text-[11px] text-amber-400 border-b border-gray-700">⚠ {totalNote}</p>
      )}
      {omissionNote(period) && (
        <p className="px-5 py-2 text-[11px] text-amber-400 border-b border-gray-700">⚠ {omissionNote(period)}</p>
      )}
      {totals.stale > 0 && (
        <p className="px-5 py-2 text-[11px] text-amber-400 border-b border-gray-700">
          ⚠ {totals.stale} of {totals.reconciled} reconciled shipments have a stored
          profit_loss that disagrees with charged minus paid. The figures above are
          derived by subtraction and do not use that column; the disagreement means
          it was written against a rate or cost that has since changed.
        </p>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-900 text-gray-400">
            <tr>
              <th className="text-left px-4 py-2 font-medium">Client</th>
              <th className="text-right px-4 py-2 font-medium">Shipments</th>
              <th className="text-right px-4 py-2 font-medium">Revenue</th>
              <th className="text-right px-4 py-2 font-medium">Cost</th>
              <th className="text-right px-4 py-2 font-medium">Profit</th>
              <th className="text-right px-4 py-2 font-medium">Margin</th>
              <th className="text-left px-4 py-2 font-medium">Not counted</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-700">
            {lines.map(line => {
              const v = reconciledOrUnknown(line.r)
              return (
                <tr key={line.key} className={line.unattributed ? 'bg-gray-900/40' : ''}>
                  <td className="px-4 py-2 text-white">
                    {line.unattributed ? <span className="text-amber-400">⚠ {line.label}</span> : line.label}
                  </td>
                  {/*
                    reconciled OF counted, not just one of them. "40" alone
                    cannot distinguish a client whose every shipment priced
                    cleanly from one where 40 of 300 did, and those are
                    opposite situations with the same margin.
                  */}
                  <td className="px-4 py-2 text-right text-gray-300">
                    {line.r.reconciled === line.r.counted
                      ? line.r.counted
                      : `${line.r.reconciled} of ${line.r.counted}`}
                  </td>
                  <td className="px-4 py-2 text-right text-gray-300">
                    {v.revenue === null ? UNPRICED_DASH : `$${v.revenue.toFixed(2)}`}
                  </td>
                  <td className="px-4 py-2 text-right text-gray-300">
                    {v.cost === null ? UNPRICED_DASH : `$${v.cost.toFixed(2)}`}
                  </td>
                  <td className={`px-4 py-2 text-right font-semibold ${
                    v.profit === null ? 'text-gray-400' : v.profit >= 0 ? 'text-green-400' : 'text-red-400'
                  }`}>
                    {v.profit === null
                      ? UNPRICED_DASH
                      : `${v.profit >= 0 ? '+' : ''}$${v.profit.toFixed(2)}`}
                  </td>
                  <td className="px-4 py-2 text-right text-gray-300">{marginPctText(line.r)}</td>
                  <td className="px-4 py-2 text-[11px] text-amber-400">{exclusionNote(line.r)}</td>
                </tr>
              )
            })}
          </tbody>
          <tfoot className="bg-gray-900 font-semibold">
            <tr>
              <td className="px-4 py-2 text-white">Total</td>
              <td className="px-4 py-2 text-right text-gray-300">
                {totals.reconciled === totals.counted
                  ? totals.counted
                  : `${totals.reconciled} of ${totals.counted}`}
              </td>
              <td className="px-4 py-2 text-right text-gray-300">
                {t.revenue === null ? UNPRICED_DASH : `$${t.revenue.toFixed(2)}`}
              </td>
              <td className="px-4 py-2 text-right text-gray-300">
                {t.cost === null ? UNPRICED_DASH : `$${t.cost.toFixed(2)}`}
              </td>
              <td className={`px-4 py-2 text-right ${
                t.profit === null ? 'text-gray-400' : t.profit >= 0 ? 'text-green-400' : 'text-red-400'
              }`}>
                {t.profit === null
                  ? UNPRICED_DASH
                  : `${t.profit >= 0 ? '+' : ''}$${t.profit.toFixed(2)}`}
              </td>
              <td className="px-4 py-2 text-right text-gray-300">{marginPctText(totals)}</td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
    </>
  )
}

/**
 * What /api/statements/data sends back.
 *
 * Declared, not inferred from a `res.json()` that is `any`. This is the shape
 * of a document an operator invoices from, and `any` here would let a renamed
 * field render as `undefined` -- which `?? 0` or a template string turns into a
 * figure or a blank rather than an error. The route builds every one of these
 * from the same statement.ts the .xlsx uses; the matching test is
 * api/statements/data/route.test.ts's 'agrees with the spreadsheet'.
 *
 * `amount` and `total` are `number | null` and the null is load-bearing: a line
 * whose every row is billed at cost and not yet reported is UNKNOWN, and 0
 * there says the work was free. Measured by mutation -- swapping the route's
 * `totalOrUnknown` for a plain sum left every other assertion in that file
 * green, because no line in the original fixture was entirely unpriced.
 */
type StatementLineDTO = {
  charge_type: string
  label: string
  quantity: number | null
  /** Already rendered: '$0.3500', 'at cost', '3 rates', or the unknown dash. */
  rate: string
  amount: number | null
  unpriced: number
  counted: number
  estimated: number
}

type StatementDTO = {
  client: { id: string; name: string | null }
  from: string
  to: string
  period: string
  lines: StatementLineDTO[]
  total: number | null
  unpriced: number
  counted: number
  estimated: number
  notes: string[]
}

/**
 * One client's statement: the lines, the total, and the caveats.
 *
 * WHY THIS TAB REFUSES WITHOUT A CLIENT.
 *
 * Every other tab here is a management view across all clients, and "All
 * Clients" is a meaningful selection on them. A statement is not: it is the
 * document that gets attached to one client's invoice, and a statement with no
 * client is not an empty statement, it is no statement. Rendering the sum of
 * everybody's charges under the heading 'Statement' would be a correct figure
 * that nobody can send -- and the obvious thing to do with a screen full of
 * figures and a Download button is to send it. /statements already enforces
 * this rule, and `requiresClient` in the registry carries it here so the two
 * screens agree rather than one of them quietly showing a blank document.
 *
 * The refusal itself is NOT in this function: it is ChooseClientFirst, in the
 * tab container, which reads the flag off the registry. This component is only
 * ever rendered with a client already chosen.
 *
 * WHY IT HAS ITS OWN DOWNLOAD BUTTON.
 *
 * The toolbar's Excel button posts to /api/reports/download, which builds the
 * internal exports from `shipments` -- carrier cost, profit, margin. The
 * statement is the client-facing artefact built from `order_charges` by
 * /api/statements/download, and it deliberately contains none of those columns.
 * Those are two different documents on two different bases, and the way to keep
 * them that way is for the client-facing one not to share a code path with the
 * exporter that knows what we paid.
 */
function StatementPanel({ clients, clientId, dateFrom, dateTo }: {
  clients: ClientOption[]
  clientId: string
  dateFrom: string
  dateTo: string
}) {
  const [state, setState] = useState<
    | { status: 'idle' }
    | { status: 'loading' }
    | { status: 'error'; message: string }
    | { status: 'ready'; data: StatementDTO }
  >({ status: 'idle' })

  // What the figures currently on screen were read FOR. Compared against the
  // live props below so a stale statement is never shown under a new client or
  // period: the fetch is async, and the operator can change the dropdown while
  // one is in flight. Without this, the previous client's total sits there
  // looking like an answer to the question just asked -- the worst available
  // outcome on a screen whose next action is "download and email".
  const [loadedFor, setLoadedFor] = useState('')
  // NUL as the separator, written as the `\x00` ESCAPE and not as the raw byte.
  // The separator has to be a character none of the three parts can contain, or
  // two different triples can build the same key and a stale statement passes
  // the freshness check. A raw 0x00 in the source does that job and also makes
  // `file` call this .tsx "data", at which point the grep on the PATH here
  // (ugrep, with -I) skips the whole file silently and every line in it becomes
  // unsearchable. source-encoding.test.ts fails on the raw byte for exactly
  // that reason; the escape parses to the identical character.
  const key = `${clientId}\x00${dateFrom}\x00${dateTo}`

  async function load() {
    setState({ status: 'loading' })
    // Captured BEFORE the await, so a response is matched against the request
    // that asked for it rather than against whatever the dropdown says when it
    // lands. Two overlapping fetches otherwise resolve in arbitrary order and
    // the slower one wins.
    const asked = key
    const params = new URLSearchParams({ client: clientId, from: dateFrom, to: dateTo })
    try {
      const res = await fetch(`/api/statements/data?${params}`)
      const json = await res.json()
      if (!res.ok) throw new Error(json?.error ?? `Server error ${res.status}`)
      setLoadedFor(asked)
      setState({ status: 'ready', data: json as StatementDTO })
    } catch (err) {
      setLoadedFor(asked)
      setState({
        status: 'error',
        // Narrowed rather than typed `any`. The `err?.message ?? fallback`
        // spelling used elsewhere in this file has a hole the fallback looks
        // like it covers: `??` passes the EMPTY STRING through, so a response
        // carrying `{"error": ""}` reaches `throw new Error('')` and renders as
        // a red heading with nothing under it -- the one case where the
        // operator is told least and the screen looks most broken.
        message: err instanceof Error && err.message !== ''
          ? err.message
          : 'Could not read this statement',
      })
    }
  }

  function handleDownload() {
    // A plain navigation and not a fetch-then-blob, because this response is a
    // file with a Content-Disposition filename the route composes from the
    // client name and the real dates. Re-deriving that filename here would be a
    // second naming rule, and 'statement-week.xlsx' sitting beside last week's
    // copy is two files with one name.
    const params = new URLSearchParams({ client: clientId, from: dateFrom, to: dateTo })
    window.location.href = `/api/statements/download?${params}`
  }

  // No `clientId === ''` branch here. That refusal is the registry's
  // `requiresClient: true`, enforced once by ChooseClientFirst in the tab
  // container above for every tab that opts in -- re-deciding it in this
  // component would be a second source of truth for the same rule, which is
  // the exact pattern report-types.ts was written to remove. If one ever did
  // get through, `load()` sends an empty `client` and the route answers 400
  // with its own sentence, which the error state below renders verbatim.
  const stale = state.status === 'ready' && loadedFor !== key
  const clientName = clients.find(c => c.id === clientId)?.name ?? null

  return (
    <div className="divide-y divide-gray-700">
      <div className="px-5 py-4 flex flex-wrap items-center gap-3">
        <div className="mr-auto">
          <div className="text-white font-semibold">
            {clientName ?? 'Selected client'}
          </div>
          <div className="text-xs text-gray-400 font-mono">
            {dateFrom} to {dateTo}
          </div>
        </div>
        <button onClick={load} disabled={state.status === 'loading'}
          className="px-4 py-2 rounded-lg text-sm font-semibold text-white disabled:opacity-50 transition"
          style={{ background: '#00AAFF' }}>
          {state.status === 'loading'
            ? '⏳…'
            : state.status === 'idle' ? 'Build statement' : '↻ Rebuild'}
        </button>
        {/*
          Shown only once figures have been read and are current. A download
          offered before the screen has any is a download nobody has checked,
          and offered beside a stale total it is the WRONG period's file -- the
          route would in fact build the current one, so the operator would send
          a file that disagrees with the figures they approved.
        */}
        {state.status === 'ready' && !stale && (
          <button onClick={handleDownload}
            className="px-4 py-2 rounded-lg text-sm font-semibold text-white bg-gray-700 hover:bg-gray-600 transition">
            ↓ Excel for client
          </button>
        )}
      </div>

      {stale && (
        <div className="px-5 py-3 bg-amber-500/10 text-amber-300 text-sm">
          The client or period changed. These figures are for{' '}
          <span className="font-mono">{state.data.client.name ?? state.data.client.id}</span>,{' '}
          <span className="font-mono">{state.data.period}</span>. Rebuild to see
          the period selected above.
        </div>
      )}

      {state.status === 'idle' && (
        <Empty msg="Nothing has been read yet. Build the statement to see this client's charges for the period." />
      )}

      {state.status === 'loading' && (
        <Empty msg="Reading this client's charges from the ledger…" />
      )}

      {state.status === 'error' && (
        // The route's own sentence, verbatim. It names which read failed and
        // says the figure is UNKNOWN rather than zero; replacing it with
        // 'Could not load' here would discard the only part an operator can act
        // on, and a generic message beside a blank table reads as "no charges".
        <div className="px-5 py-6">
          <div className="text-red-400 font-semibold text-sm mb-1">
            No figures were shown
          </div>
          <p className="text-gray-300 text-sm">{state.message}</p>
        </div>
      )}

      {state.status === 'ready' && <StatementLines data={state.data} />}
    </div>
  )
}

/** The read-only half: lines, total, notes. Split out so the fetch state above stays legible. */
function StatementLines({ data }: { data: StatementDTO }) {
  if (data.lines.length === 0) {
    return (
      <>
        <Empty msg={`No charges recorded for ${data.client.name ?? 'this client'} in ${data.period}.`} />
        <StatementNotes notes={data.notes} />
      </>
    )
  }

  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-900 text-gray-400 text-xs uppercase">
            <tr>
              <th className="px-4 py-3 text-left">Charge</th>
              <th className="px-4 py-3 text-left">Line</th>
              <th className="px-4 py-3 text-right">Units</th>
              <th className="px-4 py-3 text-right">Rate</th>
              <th className="px-4 py-3 text-right">Amount</th>
              <th className="px-4 py-3 text-left">Note</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-700">
            {data.lines.map(line => (
              // Keyed on (type, label), which is exactly what buildStatement
              // grouped by -- so the key is unique by construction rather than
              // by hoping two lines differ. The same NUL join the route uses.
              <tr key={`${line.charge_type}\x00${line.label}`} className="hover:bg-gray-750">
                <td className="px-4 py-2 text-gray-400">{line.charge_type}</td>
                <td className="px-4 py-2 text-white">{line.label}</td>
                <td className="px-4 py-2 text-right text-gray-300">
                  {/*
                    A dash and not a 0. A peak surcharge is a percentage of a
                    basis and carries no quantity; '0' beside it states that
                    nothing was handled, next to a charge for handling it.
                  */}
                  {line.quantity === null ? UNPRICED_DASH : line.quantity}
                </td>
                <td className="px-4 py-2 text-right text-gray-300 font-mono text-xs">{line.rate}</td>
                <td className="px-4 py-2 text-right text-white">
                  {line.amount === null ? UNPRICED_DASH : `$${line.amount.toFixed(2)}`}
                </td>
                <td className="px-4 py-2 text-[11px] text-amber-400">
                  {lineCaveat(line)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot className="bg-gray-900 font-semibold">
            <tr>
              <td className="px-4 py-3 text-white" colSpan={4}>Total owed</td>
              <td className="px-4 py-3 text-right text-white">
                {data.total === null ? UNPRICED_DASH : `$${data.total.toFixed(2)}`}
              </td>
              <td className="px-4 py-3 text-[11px] text-amber-400">
                {data.unpriced > 0
                  ? `${data.unpriced} of ${data.counted} charges not yet priced`
                  : ''}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
      <StatementNotes notes={data.notes} />
    </>
  )
}

/**
 * What one line could not account for, or ''.
 *
 * Built here and not on the server only because it is arithmetic on two counts
 * the route already sends, not a claim about money -- the three sentences that
 * ARE claims (coverage, unpriced, estimate) come from statement-view.ts, which
 * is tested.
 */
function lineCaveat(line: StatementLineDTO): string {
  return [
    line.unpriced > 0 ? `${line.unpriced} of ${line.counted} not yet priced` : '',
    line.estimated > 0 ? `${line.estimated} estimated` : '',
  ].filter(Boolean).join(' · ')
}

/**
 * The caveats, below the total.
 *
 * Rendered as given. Every string here was built by statement-view.ts and they
 * are the same ones the .xlsx carries on its Statement sheet -- so a figure
 * checked on this screen and a figure read out of the emailed file arrive with
 * the same qualifications. A note that only exists on one of the two is a note
 * that is missing from the other.
 */
function StatementNotes({ notes }: { notes: string[] }) {
  if (notes.length === 0) return null
  return (
    <div className="px-5 py-3 space-y-1">
      {notes.map(note => (
        <p key={note} className="text-[11px] text-amber-400">{note}</p>
      ))}
    </div>
  )
}

function ShipmentsTable({ rows, clientId, dateFrom, dateTo }: TableProps<ReportShipment>) {
  const period = filterRows(rows, clientId, dateFrom, dateTo, 'ship_date')
  const filtered = period.rows
  // THE SAME DEFECT THE DASHBOARD AND /losses HAD, in a third place. This was
  // three independent sums -- sumPriced(actual_cost), sumPriced(client_rate),
  // sumPriced(profit_loss) -- rendered side by side as Paid / Charged / Net
  // P/L. Each withheld its own unreadable rows, so the three figures described
  // three different sets of shipments and Charged minus Paid was not Net P/L;
  // worse, Net P/L came off the STORED column, so this panel could print a
  // different profit for the same period than the dashboard did for it.
  //
  // One `reconcile` over one row set, with the margin derived by subtraction,
  // is the same call the dashboard and /losses make. The three figures now
  // agree with each other to the cent and with every other screen.
  const margin = reconcile(filtered)
  const known = reconciledOrUnknown(margin)
  const fig = (n: number | null) => (n === null ? UNPRICED_DASH : `$${n.toFixed(2)}`)

  // One note across the three money figures, because there is now one row set
  // behind all three -- the previous per-figure notes existed precisely because
  // each sum withheld a different set, which is the thing that was wrong.
  // `exclusionNote` names the urgent bucket first.
  const note = exclusionNote(margin)
  const stats: Array<[string, string | number, string]> = [
    ['Shipments', filtered.length, omissionNote(period)],
    ['We Paid', fig(known.cost), note],
    ['Charged', fig(known.revenue), note],
    ['Net P/L', known.profit === null
      ? UNPRICED_DASH
      : `${known.profit >= 0 ? '+' : ''}$${known.profit.toFixed(2)}`, note],
  ]
  // Hoisted out of the render below, which coloured on `totalPL >= 0` -- and
  // `null >= 0` is TRUE in JavaScript, so an unmeasurable period would have
  // been painted green.
  const plPositive = known.profit !== null && known.profit >= 0

  return (
    <>
      <div className="grid grid-cols-4 divide-x divide-gray-700 border-b border-gray-700">
        {stats.map(([l, v, note]) => (
          <div key={l} className="px-5 py-3">
            <p className="text-xs text-gray-400">{l}</p>
            <p className={`font-bold text-lg ${l === 'Net P/L' ? (known.profit === null ? 'text-gray-400' : plPositive ? 'text-green-400' : 'text-red-400') : 'text-white'}`}>{v}</p>
            {note && <p className="text-[11px] text-amber-400 mt-0.5">⚠ {note}</p>}
          </div>
        ))}
      </div>
      <div className="overflow-auto max-h-[520px]">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-gray-900">
            <tr className="text-gray-400 text-left border-b border-gray-700 text-xs uppercase">
              <th className="px-5 py-3">Order #</th>
              <th className="px-4 py-3">Client</th>
              <th className="px-4 py-3">Date</th>
              <th className="px-4 py-3">Carrier / Service</th>
              <th className="px-4 py-3">Tracking</th>
              <th className="px-4 py-3 text-right">We Paid</th>
              <th className="px-4 py-3 text-right">Charged</th>
              <th className="px-4 py-3 text-right">P / L</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? <tr><td colSpan={8}><Empty msg="No shipments in this range" /></td></tr> : filtered.map(s => (
              <tr key={s.id ?? s.order_number} className={`border-b border-gray-700/40 hover:bg-gray-700/30 ${s.is_loss ? 'bg-red-950/10' : ''}`}>
                <td className="px-5 py-2.5 font-mono text-xs text-gray-300">{s.order_number}</td>
                <td className="px-4 py-2.5">{embedOne(s.clients)?.name ?? <span className="text-gray-500">—</span>}</td>
                <td className="px-4 py-2.5 text-gray-400 text-xs">{s.ship_date ? new Date(s.ship_date).toLocaleDateString() : '—'}</td>
                <td className="px-4 py-2.5 text-gray-300 text-xs">{[s.carrier, s.service].filter(Boolean).join(' · ') || '—'}</td>
                <td className="px-4 py-2.5 font-mono text-xs text-gray-500">{s.tracking_number ?? '—'}</td>
                <td className="px-4 py-2.5 text-right">{formatPrice(s.actual_cost)}</td>
                <td className={`px-4 py-2.5 text-right ${isPriced(s.client_rate) ? '' : 'text-amber-400'}`}
                    title={isPriced(s.client_rate) ? undefined : 'No rate-card rate covers this shipment'}>
                  {formatPrice(s.client_rate)}
                </td>
                <td className={`px-4 py-2.5 text-right font-semibold ${
                  !isPriced(s.profit_loss) ? 'text-gray-500'
                    : s.is_loss ? 'text-red-400' : 'text-green-400'
                }`}>
                  {formatSignedPrice(s.profit_loss)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

function LossTable({ rows, clientId, dateFrom, dateTo }: TableProps<ReportLossShipment>) {
  const period = filterRows(rows, clientId, dateFrom, dateTo, 'ship_date')
  const filtered = period.rows
  const plSum = sumPriced(filtered, 'profit_loss')
  const total = Math.abs(plSum.total)
  // Averaged over the rows that actually contributed, not over every row in the
  // table. `total / filtered.length` divides a short total by a full count,
  // which understates the average loss -- the direction that makes a problem
  // look smaller than it is.
  const priced = plSum.counted - plSum.unpriced
  const note = unpricedNote(plSum.unpriced)
  return (
    <>
      <div className="grid grid-cols-3 divide-x divide-gray-700 border-b border-gray-700" style={{ background: '#1a0a0a' }}>
        {([
          ['Loss Shipments', filtered.length, omissionNote(period)],
          ['Total Lost', `-$${total.toFixed(2)}`, note],
          ['Avg Loss', priced ? `-$${(total / priced).toFixed(2)}` : '$0.00', note],
        ] as Array<[string, string | number, string]>).map(([l, v, n]) => (
          <div key={l} className="px-5 py-3">
            <p className="text-xs text-red-400/70">{l}</p>
            <p className="font-bold text-lg text-red-400">{v}</p>
            {n && <p className="text-[11px] text-amber-400 mt-0.5">⚠ {n}</p>}
          </div>
        ))}
      </div>
      <div className="overflow-auto max-h-[520px]">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-gray-900">
            <tr className="text-gray-400 text-left border-b border-gray-700 text-xs uppercase">
              <th className="px-5 py-3">Order #</th>
              <th className="px-4 py-3">Client</th>
              <th className="px-4 py-3">Date</th>
              <th className="px-4 py-3">Carrier / Service</th>
              <th className="px-4 py-3 text-right">We Paid</th>
              <th className="px-4 py-3 text-right">Charged</th>
              <th className="px-4 py-3 text-right">Loss</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? <tr><td colSpan={7}><Empty msg="✓ No loss shipments in this range" /></td></tr> : filtered.map(s => (
              <tr key={s.id ?? s.order_number} className="border-b border-gray-700/40 hover:bg-red-950/20">
                <td className="px-5 py-2.5 font-mono text-xs text-gray-300">{s.order_number}</td>
                <td className="px-4 py-2.5">{embedOne(s.clients)?.name ?? '—'}</td>
                <td className="px-4 py-2.5 text-gray-400 text-xs">{s.ship_date ? new Date(s.ship_date).toLocaleDateString() : '—'}</td>
                <td className="px-4 py-2.5 text-gray-300 text-xs">{[s.carrier, s.service].filter(Boolean).join(' · ') || '—'}</td>
                <td className="px-4 py-2.5 text-right">{formatPrice(s.actual_cost)}</td>
                <td className={`px-4 py-2.5 text-right ${isPriced(s.client_rate) ? '' : 'text-amber-400'}`}>
                  {formatPrice(s.client_rate)}
                </td>
                <td className={`px-4 py-2.5 text-right font-bold ${isPriced(s.profit_loss) ? 'text-red-400' : 'text-gray-500'}`}>
                  {isPriced(s.profit_loss) ? `-${formatPrice(Math.abs(Number(s.profit_loss)))}` : formatPrice(null)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

function AdjustmentsTable({ rows, clientId, dateFrom, dateTo }: TableProps<ReportAdjustment>) {
  const period = filterRows(rows, clientId, dateFrom, dateTo, 'adjustment_date')
  const filtered = period.rows
  const pending = filtered.filter(r => r.status === 'pending')
  const pendingSum = sumPriced(pending, 'adjustment_amount')
  // `string | null` and not `string`: bills.status and rate_adjustments.status
  // are both nullable, and widening is behaviour-preserving -- null never
  // equalled any of the labels, so it fell to the grey default before and
  // falls to it now. Narrowing instead would mean a non-null assertion, which
  // is a claim about the column nobody here has checked.
  const statusBadge = (s: string | null) => s === 'pending'
    ? 'bg-orange-900/60 text-orange-300'
    : s === 'charged' ? 'bg-green-900/60 text-green-300' : 'bg-gray-700 text-gray-400'

  return (
    <>
      <div className="grid grid-cols-3 divide-x divide-gray-700 border-b border-gray-700">
        {([
          ['Total', filtered.length, omissionNote(period, 'adjustment')],
          ['Pending', pending.length, ''],
          ['To Recover', formatSignedPrice(totalOrUnknown(pendingSum)), unpricedNote(pendingSum.unpriced, 'adjustment')],
        ] as Array<[string, string | number, string]>).map(([l, v, n]) => (
          <div key={l} className="px-5 py-3">
            <p className="text-xs text-gray-400">{l}</p>
            <p className={`font-bold text-lg ${l === 'To Recover' ? 'text-orange-400' : 'text-white'}`}>{v}</p>
            {n && <p className="text-[11px] text-amber-400 mt-0.5">⚠ {n}</p>}
          </div>
        ))}
      </div>
      <div className="overflow-auto max-h-[520px]">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-gray-900">
            <tr className="text-gray-400 text-left border-b border-gray-700 text-xs uppercase">
              <th className="px-5 py-3">Order #</th>
              <th className="px-4 py-3">Client</th>
              <th className="px-4 py-3">Reason</th>
              <th className="px-4 py-3">Date</th>
              <th className="px-4 py-3 text-right">Original</th>
              <th className="px-4 py-3 text-right">New Cost</th>
              <th className="px-4 py-3 text-right">Adjustment</th>
              <th className="px-4 py-3 text-center">Status</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? <tr><td colSpan={8}><Empty msg="No adjustments in this range" /></td></tr> : filtered.map((a, i) => (
              <tr key={i} className="border-b border-gray-700/40 hover:bg-gray-700/30">
                <td className="px-5 py-2.5 font-mono text-xs text-gray-300">{a.order_number}</td>
                <td className="px-4 py-2.5">{embedOne(a.clients)?.name ?? '—'}</td>
                <td className="px-4 py-2.5 text-gray-300 text-xs">{a.reason ?? 'Carrier reweigh'}</td>
                <td className="px-4 py-2.5 text-gray-400 text-xs">{a.adjustment_date ? new Date(a.adjustment_date).toLocaleDateString() : '—'}</td>
                <td className="px-4 py-2.5 text-right text-gray-400">{formatPrice(a.original_cost)}</td>
                <td className="px-4 py-2.5 text-right text-gray-400">{formatPrice(a.adjusted_cost)}</td>
                <td className="px-4 py-2.5 text-right font-bold text-orange-400">{formatSignedPrice(a.adjustment_amount)}</td>
                <td className="px-4 py-2.5 text-center">
                  <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${statusBadge(a.status)}`}>{a.status}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

function BillingTable({ rows, clientId, dateFrom, dateTo }: TableProps<ReportBill>) {
  const period = filterRows(rows, clientId, dateFrom, dateTo, 'week_start')
  const filtered = period.rows
  const billedSum = sumPriced(filtered, 'grand_total')
  // Nullable for the same reason as the one in AdjustmentsTable above.
  const statusBadge = (s: string | null) => s === 'paid' ? 'bg-green-900/60 text-green-300' : s === 'sent' ? 'bg-[#00AAFF]/10 text-[#00AAFF]' : 'bg-gray-700 text-gray-400'

  return (
    <>
      <div className="grid grid-cols-3 divide-x divide-gray-700 border-b border-gray-700">
        {([
          ['Bills', filtered.length, omissionNote(period, 'bill')],
          ['Total Billed', formatPrice(totalOrUnknown(billedSum)), unpricedNote(billedSum.unpriced, 'bill')],
          ['Paid', filtered.filter(r => r.status === 'paid').length, ''],
        ] as Array<[string, string | number, string]>).map(([l, v, n]) => (
          <div key={l} className="px-5 py-3">
            <p className="text-xs text-gray-400">{l}</p>
            <p className="font-bold text-lg text-white">{v}</p>
            {n && <p className="text-[11px] text-amber-400 mt-0.5">⚠ {n}</p>}
          </div>
        ))}
      </div>
      <div className="overflow-auto max-h-[520px]">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-gray-900">
            <tr className="text-gray-400 text-left border-b border-gray-700 text-xs uppercase">
              <th className="px-5 py-3">Client</th>
              <th className="px-4 py-3">Week</th>
              <th className="px-4 py-3 text-right">Shipping</th>
              <th className="px-4 py-3 text-right">Warehouse</th>
              <th className="px-4 py-3 text-right">Adjustments</th>
              <th className="px-4 py-3 text-right">Manual</th>
              <th className="px-4 py-3 text-right">Total</th>
              <th className="px-4 py-3 text-center">Status</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? <tr><td colSpan={8}><Empty msg="No bills in this range" /></td></tr> : filtered.map((b, i) => (
              <tr key={i} className="border-b border-gray-700/40 hover:bg-gray-700/30">
                <td className="px-5 py-2.5 font-medium">{embedOne(b.clients)?.name ?? '—'}</td>
                <td className="px-4 py-2.5 text-gray-400 text-xs">{b.week_start} → {b.week_end}</td>
                <td className="px-4 py-2.5 text-right text-gray-300">{formatPrice(b.shipping_total)}</td>
                <td className="px-4 py-2.5 text-right text-gray-300">{formatPrice(b.warehouse_total)}</td>
                <td className="px-4 py-2.5 text-right text-gray-300">{formatPrice(b.adjustments_total)}</td>
                <td className="px-4 py-2.5 text-right text-gray-300">{formatPrice(b.manual_charges_total)}</td>
                <td className="px-4 py-2.5 text-right font-bold">{formatPrice(b.grand_total)}</td>
                <td className="px-4 py-2.5 text-center">
                  <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${statusBadge(b.status)}`}>{b.status}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

function WarehouseTable({ rows, clientId, dateFrom, dateTo }: TableProps<ReportWarehouseLine>) {
  const period = filterRows(rows, clientId, dateFrom, dateTo, 'log_date')
  const filtered = period.rows
  const revenueSum = sumPriced(filtered, 'total')
  const totalRevenue = revenueSum.total

  return (
    <>
      <div className="grid grid-cols-3 divide-x divide-gray-700 border-b border-gray-700">
        {([
          // 'row' and not 'day', which the other notes in this strip use. A
          // warehouse_daily_log row is one service line for one client on one
          // day, so "3 days with no client not included" would read as three
          // whole days missing from the table when it is three lines. The
          // undated count here is always 0 (log_date is not nullable), so only
          // the client half of this note ever renders -- and that half is the
          // one 'day' gets wrong. Not 'entry': the pluralizer appends `s`.
          ['Entries', filtered.length, omissionNote(period, 'row')],
          ['Total Revenue', `$${totalRevenue.toFixed(2)}`, unpricedNote(revenueSum.unpriced, 'day')],
          ['Unique Days', new Set(filtered.map(r => r.log_date)).size, ''],
        ] as Array<[string, string | number, string]>).map(([l, v, n]) => (
          <div key={l} className="px-5 py-3">
            <p className="text-xs text-gray-400">{l}</p>
            <p className="font-bold text-lg text-white">{v}</p>
            {n && <p className="text-[11px] text-amber-400 mt-0.5">⚠ {n}</p>}
          </div>
        ))}
      </div>
      <div className="overflow-auto max-h-[520px]">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-gray-900">
            <tr className="text-gray-400 text-left border-b border-gray-700 text-xs uppercase">
              <th className="px-5 py-3">Date</th>
              <th className="px-4 py-3">Client</th>
              <th className="px-4 py-3">Service</th>
              <th className="px-4 py-3 text-right">Qty</th>
              <th className="px-4 py-3 text-right">Rate</th>
              <th className="px-4 py-3 text-right">Total</th>
              <th className="px-4 py-3">Notes</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? <tr><td colSpan={7}><Empty msg="No warehouse activity in this range" /></td></tr> : filtered.map((w, i) => (
              <tr key={i} className="border-b border-gray-700/40 hover:bg-gray-700/30">
                <td className="px-5 py-2.5 text-gray-400 text-xs">{w.log_date ? new Date(w.log_date + 'T12:00:00').toLocaleDateString() : '—'}</td>
                <td className="px-4 py-2.5 font-medium">{embedOne(w.clients)?.name ?? '—'}</td>
                <td className="px-4 py-2.5 text-gray-300 capitalize">{w.service_type?.replace(/_/g, ' ') ?? '—'}</td>
                <td className="px-4 py-2.5 text-right">{w.quantity}</td>
                <td className="px-4 py-2.5 text-right text-gray-400">{formatPrice(w.rate)}</td>
                <td className={`px-4 py-2.5 text-right font-semibold ${isPriced(w.total) ? 'text-green-400' : 'text-amber-400'}`}
                    title={isPriced(w.total) ? undefined : 'The daily log could not read a rate for this day'}>
                  {formatPrice(w.total)}
                </td>
                <td className="px-4 py-2.5 text-gray-500 text-xs">{w.notes ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}
