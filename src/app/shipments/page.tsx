import { supabaseAdmin } from '@/lib/supabase'
import ShipmentsTable from '@/components/shipments/ShipmentsTable'

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

  return {
    shipments: shipmentsRes.data ?? [],
    clients: clientsRes.data ?? [],
  }
}

export default async function ShipmentsPage({ searchParams }: { searchParams: Promise<{ filter?: string }> }) {
  const { filter } = await searchParams
  const { shipments, clients } = await getData()

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-white">Shipments</h2>
        <p className="text-gray-400 text-sm mt-1">{shipments.length} total shipments from ShipStation</p>
      </div>
      <ShipmentsTable shipments={shipments} clients={clients} initialFilter={filter ?? ''} />
    </div>
  )
}
