import { supabaseAdmin } from '@/lib/supabase'
import { read, readErrors, loaded, type LoadedData } from '@/lib/db/read'
import { readAllPages } from '@/lib/db/page'
import ViewUnreadable from '@/components/ui/ViewUnreadable'
import BillingView from '@/components/billing/BillingView'

// This screen's output is an invoice. BillingView composes all five reads into
// one per-client grand total -- shipments + warehouse lines + adjustments,
// checked against the bills already generated -- so a read that failed and came
// back `[]` does not make the page emptier, it makes the invoice SHORTER by an
// unknown amount, with nothing on screen to say so.
//
// So the whole page refuses rather than degrading section by section. A partial
// render is defensible on a dashboard; it is not defensible here. Composing a
// bill from a database that is answering some questions and not others produces
// a number that looks finished and is under-billed, and it gets sent.
//
// AND THE SAME ARGUMENT APPLIES TO A READ THAT WAS MERELY SHORT.
//
// Four of these five reads carried no .limit() and no .range(), which does not
// mean "all rows" -- it means at most the server's `db-max-rows`, 1000 by
// default, returned as a 200 with `error: null`. The refusal above is built on
// `error` and never fires. So the invoice was short by an unknown amount for
// exactly the reason the comment above says is indefensible, except that there
// was no outage to blame and nothing to notice: the page looked healthy.
//
// Paged via readAllPages now, each read ending its sort keys with `.order('id')`
// because an OFFSET page boundary on a non-unique sort column is undefined, and
// `ship_date` ties by the hundreds. Without the tiebreaker, paging introduces a
// duplicated billable line and a dropped one in place of the truncation.
//
// These reads are still UNBOUNDED by date, which is deliberate and is not the
// same defect: BillingView holds every row and filters in the browser, because
// the operator can select any period after the page has loaded. So the cost of
// correctness here is round trips -- a few per table -- not a shorter answer.
// Bounding them server-side means moving the date filter into the request, and
// that is a change to BillingView, not to this file.

// Without this line Next prerendered this page at build time -- all five reads
// baked into a static .next/server/app/billing.html and frozen until the next
// deploy, which is what "billing is not working" looked like from the outside.
// See the long note on the same line in src/app/reports/page.tsx for how it was
// found, why nothing on screen looked wrong, and how to check it stayed fixed.
//
// Note this interacts with the paragraph above: the reads are unbounded by date
// BECAUSE the operator picks the period in the browser after load. That is only
// defensible if the load is fresh. Prerendered, it meant every period the
// operator could select was served out of one deploy-time snapshot.
export const dynamic = 'force-dynamic'

async function getBillingData() {
  const now = new Date()
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0]
  const today = now.toISOString().split('T')[0]

  const [clientsRes, shipmentsRes, warehouseRes, adjustmentsRes, billsRes] = await Promise.all([
    supabaseAdmin.from('clients').select('id, name').eq('active', true).order('name'),
    readAllPages((from, to) => supabaseAdmin.from('shipments')
      .select('client_id, order_number, ship_date, carrier, service, actual_cost, client_rate, profit_loss, is_loss')
      .order('ship_date', { ascending: false }).order('id').range(from, to)),
    readAllPages((from, to) => supabaseAdmin.from('warehouse_daily_log')
      .select('client_id, log_date, service_type, quantity, rate, total, notes')
      .order('log_date', { ascending: false }).order('id').range(from, to)),
    readAllPages((from, to) => supabaseAdmin.from('rate_adjustments')
      .select('client_id, order_number, adjustment_amount, reason, adjustment_date, status')
      .order('adjustment_date', { ascending: false }).order('id').range(from, to)),
    readAllPages((from, to) => supabaseAdmin.from('bills')
      .select('client_id, week_start, week_end, shipping_total, warehouse_total, adjustments_total, manual_charges_total, grand_total, status')
      .order('week_start', { ascending: false }).order('id').range(from, to)),
  ])

  const clients = read('clients', clientsRes)
  const shipments = read('shipments', shipmentsRes)
  const warehouse = read('warehouse_daily_log', warehouseRes)
  const adjustments = read('rate_adjustments', adjustmentsRes)
  const bills = read('bills', billsRes)

  return loaded(
    readErrors(clients, shipments, warehouse, adjustments, bills),
    () => ({
      clients: clients.rows,
      shipments: shipments.rows,
      warehouse: warehouse.rows,
      adjustments: adjustments.rows,
      bills: bills.rows,
      defaultFrom: monthStart,
      defaultTo: today,
    }),
  )
}

function Header() {
  return (
    <div>
      <h2 className="text-2xl font-bold text-white">Billing</h2>
      <p className="text-gray-400 text-sm mt-1">Full billing breakdown per client — shipments, warehouse, adjustments</p>
    </div>
  )
}

export default async function BillingPage() {
  const billing = await getBillingData()

  if (!billing.ok) {
    return (
      <div className="space-y-6">
        <Header />
        <ViewUnreadable message={billing.error} />
      </div>
    )
  }

  // Annotated, not inferred. BillingView's prop used to be `data: any`, which
  // accepted `BillingData | undefined` silently, so the refusal above was not a
  // gate on its own -- this local was. The prop is now typed, so there are two
  // independent gates; the annotation stays because it fails nearer the cause
  // (TS2322 here, naming this read) and because it keeps holding if the
  // component's prop ever loosens again.
  const data: LoadedData<typeof billing> = billing.data

  return (
    <div className="space-y-6">
      <Header />
      <BillingView data={data} />
    </div>
  )
}
