'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

export default function ShippingRatesUpload({ clientId }: { clientId: string }) {
  const fileRef = useRef<HTMLInputElement>(null)
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [preview, setPreview] = useState<any[]>([])
  const [allRows, setAllRows] = useState<any[]>([])
  const [error, setError] = useState('')

  async function parseFile(file: File): Promise<any[]> {
    const ext = file.name.split('.').pop()?.toLowerCase()
    if (ext === 'csv') {
      const text = await file.text()
      const lines = text.trim().split('\n')
      const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''))
      return lines.slice(1).map(line => {
        const vals = line.split(',').map(v => v.trim().replace(/^"|"$/g, ''))
        const obj: any = {}
        headers.forEach((h, i) => { obj[h] = vals[i] ?? '' })
        return obj
      }).filter(r => Object.values(r).some(v => v))
    } else {
      const XLSX = await import('xlsx')
      const buffer = await file.arrayBuffer()
      const wb = XLSX.read(buffer, { type: 'array' })
      const ws = wb.Sheets[wb.SheetNames[0]]
      return XLSX.utils.sheet_to_json(ws)
    }
  }

  function rowsToRates(rows: any[]) {
    return rows.map((r: any) => ({
      client_id: clientId,
      carrier: (r.carrier || r.Carrier || '').trim(),
      service: (r.service || r.Service || '').trim(),
      rate: parseFloat(r.rate || r.Rate || r.price || r.Price || 0),
      weight_min: parseFloat(r.weight_min || r['Weight Min'] || r.min_weight || 0) || 0,
      weight_max: (r.weight_max || r['Weight Max'] || r.max_weight)
        ? parseFloat(r.weight_max || r['Weight Max'] || r.max_weight)
        : null,
    })).filter(r => r.carrier && r.service && r.rate > 0)
  }

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setError('')
    setPreview([])
    setAllRows([])
    try {
      const rows = await parseFile(file)
      if (rows.length === 0) { setError('File is empty or could not be read.'); return }
      const rates = rowsToRates(rows)
      if (rates.length === 0) {
        setError(`No valid rows found. Make sure columns are: carrier, service, rate, weight_min, weight_max. Found columns: ${Object.keys(rows[0]).join(', ')}`)
        return
      }
      setAllRows(rates)
      setPreview(rates.slice(0, 5))
    } catch (err: any) {
      setError('Could not read file: ' + (err?.message ?? 'Unknown error'))
    }
  }

  async function handleUpload() {
    if (!allRows.length) return
    setLoading(true)
    setError('')
    try {
      const res = await fetch(`/api/clients/${clientId}/shipping-rates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rates: allRows }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Upload failed')
      setPreview([])
      setAllRows([])
      if (fileRef.current) fileRef.current.value = ''
      router.refresh()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex gap-2 flex-wrap">
      <a
        href="/templates/shipping-rates-template.csv"
        download
        className="bg-gray-700 hover:bg-gray-600 text-white px-4 py-2 rounded-lg text-sm font-medium transition"
      >
        ↓ Template
      </a>
      <input ref={fileRef} type="file" accept=".csv,.xlsx,.xls" onChange={handleFile} className="hidden" />
      <button
        onClick={() => fileRef.current?.click()}
        className="text-white px-4 py-2 rounded-lg text-sm font-medium transition"
        style={{ background: '#00AAFF' }}
      >
        Upload Price List
      </button>

      {error && !preview.length && (
        <p className="w-full text-red-400 text-sm mt-1">{error}</p>
      )}

      {preview.length > 0 && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-6">
          <div className="bg-gray-800 rounded-xl p-6 max-w-3xl w-full max-h-[90vh] overflow-y-auto">
            <h4 className="font-semibold text-white mb-1">Preview — {allRows.length} rates ready to upload</h4>
            <p className="text-gray-400 text-sm mb-4">Showing first 5 rows. This will replace all existing rates for this client.</p>
            <div className="overflow-x-auto mb-4">
              <table className="text-sm w-full">
                <thead>
                  <tr className="text-gray-400 border-b border-gray-700 text-xs uppercase">
                    <th className="pb-2 pr-4 text-left">Carrier</th>
                    <th className="pb-2 pr-4 text-left">Service</th>
                    <th className="pb-2 pr-4 text-right">Rate</th>
                    <th className="pb-2 pr-4 text-right">Min Wt (oz)</th>
                    <th className="pb-2 pr-4 text-right">Max Wt (oz)</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.map((row, i) => (
                    <tr key={i} className="border-b border-gray-700/50">
                      <td className="py-2 pr-4 text-gray-300">{row.carrier}</td>
                      <td className="py-2 pr-4 text-gray-300">{row.service}</td>
                      <td className="py-2 pr-4 text-right text-green-400">${row.rate.toFixed(2)}</td>
                      <td className="py-2 pr-4 text-right text-gray-400">{row.weight_min}</td>
                      <td className="py-2 pr-4 text-right text-gray-400">{row.weight_max ?? '∞'}</td>
                    </tr>
                  ))}
                  {allRows.length > 5 && (
                    <tr>
                      <td colSpan={5} className="py-2 text-gray-500 text-xs">
                        + {allRows.length - 5} more rows…
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            {error && <p className="text-red-400 text-sm mb-3">{error}</p>}
            <div className="flex gap-3">
              <button
                onClick={() => { setPreview([]); setAllRows([]) }}
                className="flex-1 bg-gray-700 hover:bg-gray-600 text-white py-2 rounded-lg text-sm transition"
              >
                Cancel
              </button>
              <button
                onClick={handleUpload}
                disabled={loading}
                className="flex-1 disabled:opacity-50 text-white py-2 rounded-lg text-sm font-medium transition"
                style={{ background: '#00AAFF' }}
              >
                {loading ? 'Uploading...' : `Upload ${allRows.length} Rates`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
