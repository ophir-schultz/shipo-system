'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Papa from 'papaparse'
import * as XLSX from 'xlsx'

export default function ShippingRatesUpload({ clientId }: { clientId: string }) {
  const fileRef = useRef<HTMLInputElement>(null)
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [preview, setPreview] = useState<any[]>([])
  const [error, setError] = useState('')

  function parseFile(file: File): Promise<any[]> {
    return new Promise((resolve, reject) => {
      const ext = file.name.split('.').pop()?.toLowerCase()
      if (ext === 'csv') {
        Papa.parse(file, {
          header: true,
          skipEmptyLines: true,
          complete: (r) => resolve(r.data),
          error: reject,
        })
      } else {
        const reader = new FileReader()
        reader.onload = (e) => {
          const wb = XLSX.read(e.target?.result, { type: 'array' })
          const ws = wb.Sheets[wb.SheetNames[0]]
          resolve(XLSX.utils.sheet_to_json(ws))
        }
        reader.readAsArrayBuffer(file)
      }
    })
  }

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setError('')
    try {
      const rows = await parseFile(file)
      setPreview(rows.slice(0, 5))
    } catch {
      setError('Could not read file. Please use CSV or Excel.')
    }
  }

  async function handleUpload() {
    const file = fileRef.current?.files?.[0]
    if (!file) return
    setLoading(true)
    setError('')
    try {
      const rows = await parseFile(file)
      const rates = rows.map((r: any) => ({
        client_id: clientId,
        carrier: r.carrier || r.Carrier || '',
        service: r.service || r.Service || '',
        rate: parseFloat(r.rate || r.Rate || r.price || r.Price || 0),
        weight_min: parseFloat(r.weight_min || r['Weight Min'] || r.min_weight || 0) || 0,
        weight_max: r.weight_max || r['Weight Max'] || r.max_weight
          ? parseFloat(r.weight_max || r['Weight Max'] || r.max_weight)
          : null,
      })).filter(r => r.carrier && r.service && r.rate > 0)

      const res = await fetch(`/api/clients/${clientId}/shipping-rates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rates }),
      })
      if (!res.ok) throw new Error('Upload failed')
      setPreview([])
      if (fileRef.current) fileRef.current.value = ''
      router.refresh()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex gap-2">
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
        className="bg-[#00AAFF] hover:bg-[#33BBFF] text-white px-4 py-2 rounded-lg text-sm font-medium transition"
      >
        Upload Price List
      </button>

      {preview.length > 0 && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-6">
          <div className="bg-gray-800 rounded-xl p-6 max-w-2xl w-full">
            <h4 className="font-semibold text-white mb-1">Preview (first 5 rows)</h4>
            <p className="text-gray-400 text-sm mb-4">
              Make sure your file has columns: <code className="text-[#00AAFF]">carrier, service, rate, weight_min, weight_max</code>
            </p>
            <div className="overflow-x-auto mb-4">
              <table className="text-sm w-full">
                <thead>
                  <tr className="text-gray-400 border-b border-gray-700">
                    {Object.keys(preview[0]).map(k => <th key={k} className="pb-2 pr-4 text-left">{k}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {preview.map((row, i) => (
                    <tr key={i} className="border-b border-gray-700/50">
                      {Object.values(row).map((v: any, j) => (
                        <td key={j} className="py-2 pr-4 text-gray-300">{v}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {error && <p className="text-red-400 text-sm mb-3">{error}</p>}
            <div className="flex gap-3">
              <button onClick={() => setPreview([])} className="flex-1 bg-gray-700 hover:bg-gray-600 text-white py-2 rounded-lg text-sm transition">
                Cancel
              </button>
              <button onClick={handleUpload} disabled={loading} className="flex-1 bg-[#00AAFF] hover:bg-[#33BBFF] disabled:opacity-50 text-white py-2 rounded-lg text-sm font-medium transition">
                {loading ? 'Uploading...' : 'Confirm & Upload'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
