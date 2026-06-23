import { supabaseAdmin } from '@/lib/supabase'
import { notFound } from 'next/navigation'
import ShippingRatesUpload from '@/components/billing/ShippingRatesUpload'
import ZoneRatesUpload from '@/components/billing/ZoneRatesUpload'
import ZoneChartUpload from '@/components/billing/ZoneChartUpload'
import WarehouseRatesUpload from '@/components/billing/WarehouseRatesUpload'
import DeleteClientButton from '@/components/clients/DeleteClientButton'
import ZenventoryCredentials from '@/components/clients/ZenventoryCredentials'
import OriginZipEditor from '@/components/clients/OriginZipEditor'

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

async function getZoneRates(clientId: string) {
  const { data } = await supabaseAdmin
    .from('client_zone_rates')
    .select('*')
    .eq('client_id', clientId)
    .order('weight_lb')
  return data ?? []
}

type ZoneMatrix = {
  key: string
  carrier: string
  service: string
  weights: number[]
  zones: number[]
  rows: Record<number, Record<number, number>>
}

function buildZoneMatrices(rates: any[]): ZoneMatrix[] {
  const groups: Record<string, any[]> = {}
  for (const r of rates) {
    const key = `${r.carrier}||${r.service}`
    ;(groups[key] ??= []).push(r)
  }
  return Object.entries(groups).map(([key, cells]) => {
    const weights = [...new Set(cells.map(c => c.weight_lb))].sort((a, b) => a - b)
    const zones = [...new Set(cells.map(c => c.zone))].sort((a, b) => a - b)
    const rows: Record<number, Record<number, number>> = {}
    for (const c of cells) {
      rows[c.weight_lb] ??= {}
      rows[c.weight_lb][c.zone] = Number(c.rate)
    }
    const [carrier, service] = key.split('||')
    return { key, carrier, service, weights, zones, rows }
  })
}

export default async function ClientDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const client = await getClient(id)
  if (!client) notFound()

  const [shippingRates, warehouseRates, zoneRates] = await Promise.all([
    getShippingRates(id),
    getWarehouseRates(id),
    getZoneRates(id),
  ])

  // Group zone rates into matrices keyed by carrier/service
  const zoneMatrices = buildZoneMatrices(zoneRates)

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

      {/* Zone Rate Matrix (Weight LB × Zone 1-8) */}
      <div className="bg-gray-800 rounded-xl p-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h3 className="text-lg font-semibold text-white">Zone Rate Matrix</h3>
            <p className="text-gray-400 text-sm mt-0.5">Weight (LB) × Zone pricing. Upload the rate card exactly as the table.</p>
          </div>
          <ZoneRatesUpload clientId={id} />
        </div>

        {/* Origin ZIP + Zone Map */}
        <div className="border border-gray-700 rounded-xl p-4 mb-4 space-y-4">
          <OriginZipEditor clientId={id} originZip={client.origin_zip ?? ''} />
          <div className="border-t border-gray-700/50 pt-4">
            <ZoneChartUpload clientId={id} originZip={client.origin_zip ?? ''} />
          </div>
        </div>

        {zoneMatrices.length === 0 ? (
          <div className="text-center py-10 border-2 border-dashed border-gray-700 rounded-lg">
            <p className="text-gray-500 mb-2">No zone rates yet</p>
            <p className="text-gray-600 text-sm">Upload a CSV/Excel with a “Weight (LB)” column and “ZONE 1”…“ZONE 8” columns</p>
          </div>
        ) : (
          <div className="space-y-6">
            {zoneMatrices.map(m => (
              <div key={m.key}>
                <p className="text-sm text-gray-300 mb-2 font-medium">
                  {m.carrier || m.service
                    ? `${m.carrier || 'Any carrier'} · ${m.service || 'Any service'}`
                    : 'Blanket rate card (any carrier / service)'}
                </p>
                <div className="overflow-x-auto border border-gray-700 rounded-lg">
                  <table className="text-sm w-full">
                    <thead>
                      <tr className="text-gray-400 border-b border-gray-700 text-xs uppercase">
                        <th className="p-2 text-left sticky left-0 bg-gray-800">Weight (LB)</th>
                        {m.zones.map(z => <th key={z} className="p-2 text-right">Zone {z}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {m.weights.map(w => (
                        <tr key={w} className="border-b border-gray-700/40 hover:bg-gray-700/30">
                          <td className="p-2 text-gray-300 sticky left-0 bg-gray-800">{w}</td>
                          {m.zones.map(z => (
                            <td key={z} className="p-2 text-right text-green-400">
                              {m.rows[w]?.[z] != null ? `$${m.rows[w][z].toFixed(2)}` : '—'}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </div>
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
