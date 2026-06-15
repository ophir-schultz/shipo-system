'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

const SERVICE_TYPES = ['storage', 'receiving', 'returns', 'labeling', 'kitting', 'pallet_in', 'pallet_out', 'special_task']
const UNITS = ['per_unit', 'per_order', 'per_pallet', 'per_hour', 'flat', 'per_lb']

export default function WarehouseRatesUpload({ clientId }: { clientId: string }) {
  const router = useRouter()
  const fileRef = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState([{ service_type: 'pick_pack', rate: '', unit: 'per_unit' }])
  const [loading, setLoading] = useState(false)
  const [pdfLoading, setPdfLoading] = useState(false)
  const [error, setError] = useState('')
  const [pdfRawText, setPdfRawText] = useState('')

  function addRow() {
    setRows(r => [...r, { service_type: 'storage', rate: '', unit: 'per_unit' }])
  }

  function removeRow(i: number) {
    setRows(r => r.filter((_, idx) => idx !== i))
  }

  function updateRow(i: number, field: string, value: string) {
    setRows(r => r.map((row, idx) => idx === i ? { ...row, [field]: value } : row))
  }

  async function handlePdfUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setPdfLoading(true)
    setError('')
    const form = new FormData()
    form.append('file', file)
    const res = await fetch(`/api/clients/${clientId}/warehouse-rates/upload-pdf`, {
      method: 'POST',
      body: form,
    })
    const data = await res.json()
    if (!res.ok) { setError('Could not parse PDF'); setPdfLoading(false); return }

    if (data.rates?.length > 0) {
      setRows(data.rates.map((r: any) => ({ service_type: r.service_type, rate: String(r.rate), unit: r.unit })))
      setPdfRawText(data.rawText)
      setOpen(true)
    } else {
      setError('Could not extract rates from PDF. Please enter them manually below.')
      setPdfRawText(data.rawText)
      setOpen(true)
    }
    setPdfLoading(false)
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
    setPdfRawText('')
    router.refresh()
    setLoading(false)
  }

  return (
    <div className="flex gap-2">
      <input ref={fileRef} type="file" accept=".pdf" onChange={handlePdfUpload} className="hidden" />
      <button
        onClick={() => fileRef.current?.click()}
        disabled={pdfLoading}
        className="bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-white px-4 py-2 rounded-lg text-sm font-medium transition"
      >
        {pdfLoading ? 'Reading PDF...' : '↑ Upload PDF'}
      </button>
      <button
        onClick={() => setOpen(true)}
        className="bg-[#00AAFF] hover:bg-[#33BBFF] text-white px-4 py-2 rounded-lg text-sm font-medium transition"
      >
        + Add Manually
      </button>

      {open && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-6">
          <div className="bg-gray-800 rounded-xl p-6 max-w-2xl w-full max-h-[90vh] overflow-y-auto">
            <h4 className="font-semibold text-white mb-1">Warehouse Rates</h4>
            <p className="text-gray-400 text-sm mb-4">Review and edit before saving</p>

            {pdfRawText && (
              <details className="mb-4">
                <summary className="text-[#00AAFF] text-xs cursor-pointer">View raw PDF text (for reference)</summary>
                <pre className="text-gray-500 text-xs mt-2 bg-gray-900 p-3 rounded max-h-32 overflow-y-auto whitespace-pre-wrap">{pdfRawText}</pre>
              </details>
            )}

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
              <button onClick={() => { setOpen(false); setPdfRawText('') }} className="flex-1 bg-gray-700 hover:bg-gray-600 text-white py-2 rounded-lg text-sm transition">Cancel</button>
              <button onClick={handleSave} disabled={loading} className="flex-1 bg-[#00AAFF] hover:bg-[#33BBFF] disabled:opacity-50 text-white py-2 rounded-lg text-sm font-medium transition">
                {loading ? 'Saving...' : 'Save Rates'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
