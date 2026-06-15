import { supabaseAdmin } from '@/lib/supabase'
import { notFound } from 'next/navigation'
import ShippingRatesUpload from '@/components/billing/ShippingRatesUpload'
import WarehouseRatesUpload from '@/components/billing/WarehouseRatesUpload'
import DeleteClientButton from '@/components/clients/DeleteClientButton'
import ZenventoryCredentials from '@/components/clients/ZenventoryCredentials'

async function getClient(id: string) {
  const { data } = await supabaseAdmin.from('clients').select('*').eq('id', id).single()
  return data
}

async function getShippingRates(clientId: string) {
  const { data } = await supabaseAdmin
    .from('client_shipping_rates')
    .select('*')
    .eq('client_id', clientId)
    .order('carrier')
  return data ?? []
}

async function getWarehouseRates(clientId: string) {
  const { data } = await supabaseAdmin
    .from('client_warehouse_rates')
    .select('*')
    .eq('client_id', clientId)
    .order('service_type')
  return data ?? []
}

export default async function ClientDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const client = await getClient(id)
  if (!client) notFound()

  const [shippingRates, warehouseRates] = await Promise.all([
    getShippingRates(id),
    getWarehouseRates(id),
  ])

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-white">{client.name}</h2>
          <p className="text-gray-400 text-sm mt-1">{client.email} {client.phone ? `· ${client.phone}` : ''}</p>
        </div>
        <div className="flex items-center gap-3">
          <span className={`px-3 py-1 rounded-full text-sm ${client.active ? 'bg-green-900 text-green-300' : 'bg-gray-700 text-gray-400'}`}>
            {client.active ? 'Active' : 'Inactive'}
          </span>
          <DeleteClientButton clientId={id} clientName={client.name} />
        </div>
      </div>

      {/* Zenventory */}
      <ZenventoryCredentials
        clientId={id}
        apiKey={client.zenventory_api_key}
        apiSecret={client.zenventory_api_secret}
      />

      {/* Shipping Rates */}
      <div className="bg-gray-800 rounded-xl p-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h3 className="text-lg font-semibold text-white">Shipping Price List</h3>
            <p className="text-gray-400 text-sm mt-0.5">What you charge this client per carrier & service</p>
          </div>
          <ShippingRatesUpload clientId={id} />
        </div>

        {shippingRates.length === 0 ? (
          <div className="text-center py-10 border-2 border-dashed border-gray-700 rounded-lg">
            <p className="text-gray-500 mb-2">No shipping rates yet</p>
            <p className="text-gray-600 text-sm">Upload a CSV or Excel file with this client's shipping prices</p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-gray-400 text-left border-b border-gray-700">
                <th className="pb-3">Carrier</th>
                <th className="pb-3">Service</th>
                <th className="pb-3">Min Weight (lbs)</th>
                <th className="pb-3">Max Weight (lbs)</th>
                <th className="pb-3 text-right">Rate</th>
              </tr>
            </thead>
            <tbody>
              {shippingRates.map((r: any) => (
                <tr key={r.id} className="border-b border-gray-700/50 hover:bg-gray-700/30">
                  <td className="py-3 font-medium">{r.carrier}</td>
                  <td className="py-3 text-gray-300">{r.service}</td>
                  <td className="py-3 text-gray-400">{r.weight_min ?? 0}</td>
                  <td className="py-3 text-gray-400">{r.weight_max ?? '∞'}</td>
                  <td className="py-3 text-right text-green-400 font-semibold">${Number(r.rate).toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Warehouse Rates */}
      <div className="bg-gray-800 rounded-xl p-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h3 className="text-lg font-semibold text-white">Warehouse Price List</h3>
            <p className="text-gray-400 text-sm mt-0.5">Pick & pack, storage, receiving and other services</p>
          </div>
          <WarehouseRatesUpload clientId={id} />
        </div>

        {warehouseRates.length === 0 ? (
          <div className="text-center py-10 border-2 border-dashed border-gray-700 rounded-lg">
            <p className="text-gray-500 mb-2">No warehouse rates yet</p>
            <p className="text-gray-600 text-sm">Upload a CSV or add rates manually</p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-gray-400 text-left border-b border-gray-700">
                <th className="pb-3">Service Type</th>
                <th className="pb-3">Unit</th>
                <th className="pb-3 text-right">Rate</th>
              </tr>
            </thead>
            <tbody>
              {warehouseRates.map((r: any) => (
                <tr key={r.id} className="border-b border-gray-700/50 hover:bg-gray-700/30">
                  <td className="py-3 font-medium capitalize">{r.service_type.replace(/_/g, ' ')}</td>
                  <td className="py-3 text-gray-400 capitalize">{r.unit.replace(/_/g, ' ')}</td>
                  <td className="py-3 text-right text-green-400 font-semibold">${Number(r.rate).toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
