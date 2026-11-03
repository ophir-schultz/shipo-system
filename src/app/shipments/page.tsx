import { supabaseAdmin } from '@/lib/supabase'
import { read, readErrors, loaded } from '@/lib/db/read'
import { readAllPages } from '@/lib/db/page'
import ViewUnreadable from '@/components/ui/ViewUnreadable'
import ShipmentsTable from '@/components/shipments/ShipmentsTable'
import { withoutVoided } from '@/lib/billing/voided-shipment'

// The subtitle on this page is a claim, not a label: "0 total shipments from
// ShipStation" is a sentence about the sync, and the reasonable response to it
// is to go and re-run the sync -- or to conclude the ShipStation credentials
// have expired -- when in fact one read timed out and 40,000 shipments are
// sitting in the table.
//
// Both reads are refused together even though only the first feeds the count.
// `clients` is the assign-to-client dropdown inside the table; rendering it
// empty does not just disable assignment, it says those clients are gone.

async function getData() {
  const [shipmentsRes, clientsRes] = await Promise.all([
    // PAGED. `.limit(1000)` was the PostgREST cap written down as if it were
    // the whole table. The subtitle on this page counts the rows it got, so
    // a cap and a finished total are the same sentence. `id` is the unique
    // tiebreaker: ship_date ties by the hundred.
    readAllPages((from, to) => supabaseAdmin
      .from('shipments')
      .select('*, clients(name)')
      .order('ship_date', { ascending: false })
      .order('id')
      .range(from, to)),
    readAllPages((from, to) => supabaseAdmin
      .from('clients')
      .select('id, name')
      .eq('active', true)
      .order('name')
      .order('id')
      .range(from, to)),
  ])

  const shipments = read('shipments', shipmentsRes)
  const clients = read('clients', clientsRes)

  return loaded(readErrors(shipments, clients), () => ({
    shipments: withoutVoided(shipments.rows),
    clients: clients.rows,
  }))
}

export default async function ShipmentsPage({ searchParams }: { searchParams: Promise<{ filter?: string }> }) {
  const { filter } = await searchParams
  const page = await getData()

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-[#0B1220]">Shipments</h2>
        <p className="text-[#4B4F58] text-sm mt-1">
          {page.ok
            ? `${page.data.shipments.length} total shipments from ShipStation`
            : 'Shipment count unknown — the read failed'}
        </p>
      </div>
      {page.ok
        ? <ShipmentsTable shipments={page.data.shipments} clients={page.data.clients} initialFilter={filter ?? ''} />
        : <ViewUnreadable message={page.error} />}
    </div>
  )
}
