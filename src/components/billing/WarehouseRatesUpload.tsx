'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

const SERVICE_TYPES = ['storage', 'receiving', 'returns', 'labeling', 'kitting', 'pallet_in', 'pallet_out', 'special_task']
const UNITS = ['per_unit', 'per_order', 'per_pallet', 'per_hour', 'flat', 'per_lb']

export default function WarehouseRatesUpload({ clientId }: { clientId: string }) {
  const router = useRouter()
  const fileRef = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState([{ service_type: 'storage', rate: '', unit: 'per_unit' }])
  const [loading, setLoading] = useState(false)
  const [xlsxLoading, setXlsxLoading] = useState(false)
  const [error, setError] = useState('')

  function addRow() {
    setRows(r => [...r, { service_type: 'storage', rate: '', unit: 'per_unit' }])
  }

  function removeRow(i: number) {
    setRows(r => r.filter((_, idx) => idx !== i))
  }

  function updateRow(i: number, field: string, value: string) {
    setRows(r => r.map((row, idx) => idx === i ? { ...row, [field]: value } : row))
  }

  async function handleExcelUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setXlsxLoading(true)
    setError('')
    try {
      const XLSX = await import('xlsx')
      const buffer = await file.arrayBuffer()
      const workbook = XLSX.read(buffer, { type: 'array' })
      const sheet = workbook.Sheets[workbook.SheetNames[0]]
      const data: any[] = XLSX.utils.sheet_to_json(sheet)

      const parsed = data
        .map((row: any) => ({
          service_type: String(row['service_type'] ?? row['Service Type'] ?? row['service'] ?? '').toLowerCase().trim().replace(/\s+/g, '_'),
          rate: String(row['rate'] ?? row['Rate'] ?? row['price'] ?? row['Price'] ?? ''),
          unit: String(row['unit'] ?? row['Unit'] ?? 'per_unit').toLowerCase().trim().replace(/\s+/g, '_'),
        }))
        .filter(r => r.service_type && r.rate && parseFloat(r.rate) > 0)

      if (parsed.length === 0) {
        setError('No valid rows found. Make sure columns are: service_type, rate, unit')
        setXlsxLoading(false)
        return
      }

      setRows(parsed)
      setOpen(true)
    } catch {
      setError('Could not read Excel file. Please use the template.')
    }
    setXlsxLoading(false)
    // Reset file input so same file can be re-uploaded
    if (fileRef.current) fileRef.current.value = ''
  }

  async function handleSave() {
    setLoading(true)
    setError('')
    const rates = rows
      .filter(r => r.rate && parseFloat(r.rate) > 0)
      .map(r => ({
        client_id: clientId,
        service_type: r.service_type,
        rate: parseFloat(r.rate),
        unit: r.unit,
      }))
    if (!rates.length) { setError('Add at least one rate'); setLoading(false); return }
    const res = await fetch(`/api/clients/${clientId}/warehouse-rates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rates }),
    })
    if (!res.ok) { setError('Failed to save'); setLoading(false); return }
    setOpen(false)
    router.refresh()
    setLoading(false)
  }

  return (
    <div className="flex gap-2">
      <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" onChange={handleExcelUpload} className="hidden" />

      {/* Download template */}
      <a
        href="/templates/warehouse-rates-template.csv"
        download
        className="bg-gray-700 hover:bg-gray-600 text-white px-4 py-2 rounded-lg text-sm font-medium transition"
      >
        ↓ Template
      </a>

      {/* Upload Excel */}
      <button
        onClick={() => fileRef.current?.click()}
        disabled={xlsxLoading}
        className="bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-white px-4 py-2 rounded-lg text-sm font-medium transition"
      >
        {xlsxLoading ? 'Reading...' : '↑ Upload Excel'}
      </button>

      {/* Manual entry */}
      <button
        onClick={() => setOpen(true)}
        className="text-white px-4 py-2 rounded-lg text-sm font-medium transition"
        style={{ background: '#00AAFF' }}
      >
        + Add Manually
      </button>

      {open && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-6">
          <div className="bg-gray-800 rounded-xl p-6 max-w-2xl w-full max-h-[90vh] overflow-y-auto">
            <h4 className="font-semibold text-white mb-1">Warehouse Rates</h4>
            <p className="text-gray-400 text-sm mb-4">Review and edit before saving</p>

            <div className="space-y-2 mb-4">
              <div className="grid grid-cols-3 gap-2 text-xs text-gray-400 px-1">
                <span>Service</span><span>Rate ($)</span><span>Unit</span>
              </div>
              {rows.map((row, i) => (
                <div key={i} className="grid grid-cols-3 gap-2 items-center">
                  <select
                    value={row.service_type}
                    onChange={e => updateRow(i, 'service_type', e.target.value)}
                    className="bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-[#00AAFF]"
                  >
                    {SERVICE_TYPES.map(s => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
                  </select>
                  <input
                    type="number"
                    placeholder="0.00"
                    value={row.rate}
                    onChange={e => updateRow(i, 'rate', e.target.value)}
                    className="bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-[#00AAFF]"
                  />
                  <div className="flex gap-1">
                    <select
                      value={row.unit}
                      onChange={e => updateRow(i, 'unit', e.target.value)}
                      className="flex-1 bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-[#00AAFF]"
                    >
                      {UNITS.map(u => <option key={u} value={u}>{u.replace(/_/g, ' ')}</option>)}
                    </select>
                    <button onClick={() => removeRow(i)} className="text-gray-500 hover:text-red-400 px-2">✕</button>
                  </div>
                </div>
              ))}
            </div>

            <button onClick={addRow} className="text-[#00AAFF] text-sm hover:text-[#33BBFF] mb-4 block">+ Add row</button>

            {error && <p className="text-red-400 text-sm mb-3">{error}</p>}
            <div className="flex gap-3">
              <button onClick={() => setOpen(false)} className="flex-1 bg-gray-700 hover:bg-gray-600 text-white py-2 rounded-lg text-sm transition">Cancel</button>
              <button onClick={handleSave} disabled={loading} className="flex-1 disabled:opacity-50 text-white py-2 rounded-lg text-sm font-medium transition" style={{ background: '#00AAFF' }}>
                {loading ? 'Saving...' : 'Save Rates'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
