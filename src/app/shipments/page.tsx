import { supabaseAdmin } from '@/lib/supabase'
import { read, readErrors, loaded } from '@/lib/db/read'
import ViewUnreadable from '@/components/ui/ViewUnreadable'
import ShipmentsTable from '@/components/shipments/ShipmentsTable'

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
    supabaseAdmin
      .from('shipments')
      .select('*, clients(name)')
      .order('ship_date', { ascending: false })
      .limit(1000),
    supabaseAdmin
      .from('clients')
      .select('id, name')
      .eq('active', true)
      .order('name'),
  ])

  const shipments = read('shipments', shipmentsRes)
  const clients = read('clients', clientsRes)

  return loaded(readErrors(shipments, clients), () => ({
    shipments: shipments.rows,
    clients: clients.rows,
  }))
}

export default async function ShipmentsPage({ searchParams }: { searchParams: Promise<{ filter?: string }> }) {
  const { filter } = await searchParams
  const page = await getData()

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-white">Shipments</h2>
        <p className="text-gray-400 text-sm mt-1">
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
