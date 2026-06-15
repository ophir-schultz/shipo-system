import { supabaseAdmin } from '@/lib/supabase'
import Link from 'next/link'

async function getClients() {
  const { data } = await supabaseAdmin
    .from('clients')
    .select(`
      *,
      client_shipping_rates(count),
      client_warehouse_rates(count)
    `)
    .order('name')
  return data ?? []
}

export default async function ClientsPage() {
  const clients = await getClients()

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h2 className="text-2xl font-bold text-white">Clients</h2>
          <p className="text-gray-400 text-sm mt-1">Manage clients and their price lists</p>
        </div>
        <Link
          href="/clients/new"
          className="bg-[#00AAFF] hover:bg-[#33BBFF] text-white px-4 py-2 rounded-lg text-sm font-medium transition"
        >
          + Add Client
        </Link>
      </div>

      {clients.length === 0 ? (
        <div className="bg-gray-800 rounded-xl p-16 text-center">
          <p className="text-5xl mb-4">👥</p>
          <p className="text-gray-300 font-medium text-lg">No clients yet</p>
          <p className="text-gray-500 text-sm mt-2 mb-6">Add your first client to start managing their pricing and billing</p>
          <Link href="/clients/new" className="bg-[#00AAFF] hover:bg-[#33BBFF] text-white px-6 py-2.5 rounded-lg text-sm font-medium transition">
            Add First Client
          </Link>
        </div>
      ) : (
        <div className="grid gap-4">
          {clients.map((client: any) => (
            <div key={client.id} className="bg-gray-800 rounded-xl p-5 flex items-center justify-between hover:bg-gray-750">
              <div className="flex items-center gap-4">
                <div className="w-10 h-10 rounded-full bg-[#0090DD] flex items-center justify-center font-bold text-white">
                  {client.name[0].toUpperCase()}
                </div>
                <div>
                  <p className="font-semibold text-white">{client.name}</p>
                  <p className="text-gray-400 text-sm">{client.email ?? 'No email'} {client.phone ? `· ${client.phone}` : ''}</p>
                </div>
              </div>
              <div className="flex items-center gap-6">
                <div className="text-center">
                  <p className="text-white font-semibold">{client.client_shipping_rates?.[0]?.count ?? 0}</p>
                  <p className="text-gray-500 text-xs">Shipping Rates</p>
                </div>
                <div className="text-center">
                  <p className="text-white font-semibold">{client.client_warehouse_rates?.[0]?.count ?? 0}</p>
                  <p className="text-gray-500 text-xs">Warehouse Rates</p>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`px-2 py-0.5 rounded text-xs ${client.active ? 'bg-green-900 text-green-300' : 'bg-gray-700 text-gray-400'}`}>
                    {client.active ? 'Active' : 'Inactive'}
                  </span>
                  <Link
                    href={`/clients/${client.id}`}
                    className="bg-gray-700 hover:bg-gray-600 text-white px-3 py-1.5 rounded-lg text-sm transition"
                  >
                    Manage →
                  </Link>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
