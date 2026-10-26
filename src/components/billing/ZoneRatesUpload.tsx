'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { showError, showSuccess } from '@/components/ui/Toast'

type Cell = { weight_lb: number; zone: number; rate: number }

export default function ZoneRatesUpload({ clientId }: { clientId: string }) {
  const fileRef = useRef<HTMLInputElement>(null)
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [cells, setCells] = useState<Cell[]>([])
  const [grid, setGrid] = useState<{ weights: number[]; rows: Record<number, Record<number, number>> }>({ weights: [], rows: {} })
  const [carrier, setCarrier] = useState('')
  const [service, setService] = useState('')
  const [error, setError] = useState('')

  // Parse a 2D array (rows of cells) into matrix cells.
  function parseMatrix(matrix: any[][]): Cell[] {
    if (!matrix.length) return []
    // Find the header row (contains "weight" and at least one "zone")
    let headerIdx = matrix.findIndex(row =>
      row.some(c => String(c).toLowerCase().includes('weight')) &&
      row.some(c => String(c).toLowerCase().includes('zone'))
    )
    if (headerIdx === -1) headerIdx = 0
    const header = matrix[headerIdx].map(c => String(c ?? '').trim())

    // Map each column index -> zone number (from "ZONE 3" etc.)
    const zoneCols: { col: number; zone: number }[] = []
    let weightCol = 0
    header.forEach((h, i) => {
      const lower = h.toLowerCase()
      const zoneMatch = lower.match(/zone\s*(\d+)/)
      if (zoneMatch) zoneCols.push({ col: i, zone: parseInt(zoneMatch[1], 10) })
      else if (lower.includes('weight')) weightCol = i
    })
    if (zoneCols.length === 0) return []

    const out: Cell[] = []
    for (let r = headerIdx + 1; r < matrix.length; r++) {
      const row = matrix[r]
      if (!row || row.length === 0) continue
      const weightRaw = String(row[weightCol] ?? '').replace(/[^0-9.]/g, '')
      const weight_lb = parseInt(weightRaw, 10)
      if (!Number.isInteger(weight_lb) || weight_lb < 1) continue
      for (const { col, zone } of zoneCols) {
        const rateRaw = String(row[col] ?? '').replace(/[^0-9.]/g, '')
        const rate = parseFloat(rateRaw)
        if (Number.isFinite(rate) && rate > 0) out.push({ weight_lb, zone, rate })
      }
    }
    return out
  }

  async function fileToMatrix(file: File): Promise<any[][]> {
    const ext = file.name.split('.').pop()?.toLowerCase()
    if (ext === 'csv') {
      const text = await file.text()
      return text.trim().split('\n').map(line =>
        line.split(',').map(v => v.trim().replace(/^"|"$/g, ''))
      )
    }
    const XLSX = await import('xlsx')
    const buf = await file.arrayBuffer()
    const wb = XLSX.read(buf, { type: 'array' })
    const ws = wb.Sheets[wb.SheetNames[0]]
    return XLSX.utils.sheet_to_json(ws, { header: 1 }) as any[][]
  }

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setError('')
    setCells([])
    try {
      const matrix = await fileToMatrix(file)
      const parsed = parseMatrix(matrix)
      if (parsed.length === 0) {
        setError('Could not read the matrix. Expected a "Weight (LB)" column and "ZONE 1"…"ZONE 8" columns.')
        return
      }
      // Build a grid for preview
      const weights = [...new Set(parsed.map(c => c.weight_lb))].sort((a, b) => a - b)
      const rows: Record<number, Record<number, number>> = {}
      for (const c of parsed) {
        rows[c.weight_lb] ??= {}
        rows[c.weight_lb][c.zone] = c.rate
      }
      setCells(parsed)
      setGrid({ weights, rows })
    } catch (err: any) {
      setError('Could not read file: ' + (err?.message ?? 'Unknown error'))
    }
  }

  async function handleUpload() {
    if (!cells.length) return
    setLoading(true)
    setError('')
    try {
      const res = await fetch(`/api/clients/${clientId}/zone-rates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rates: cells, carrier: carrier.trim(), service: service.trim() }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Upload failed')
      showSuccess('Zone rates uploaded', `${data.count} rate cells saved`)
      setCells([])
      if (fileRef.current) fileRef.current.value = ''
      router.refresh()
    } catch (err: any) {
      showError('Upload failed', err?.message)
      setError(err?.message ?? 'Could not save rates')
    } finally {
      setLoading(false)
    }
  }

  const zones = [1, 2, 3, 4, 5, 6, 7, 8]

  return (
    <div className="flex gap-2 flex-wrap">
      <a
        href="/templates/zone-rates-template.csv"
        download
        className="bg-[#EEF3FA] hover:bg-[#DDE6F2] text-[#0B1220] px-4 py-2 rounded-lg text-sm font-medium transition"
      >
        ↓ Template
      </a>
      <input ref={fileRef} type="file" accept=".csv,.xlsx,.xls" onChange={handleFile} className="hidden" />
      <button
        onClick={() => fileRef.current?.click()}
        className="text-[#0B1220] px-4 py-2 rounded-lg text-sm font-medium transition"
        style={{ background: '#1A73E8' }}
      >
        Upload Zone Matrix
      </button>

      {error && !cells.length && <p className="w-full text-red-700 text-sm mt-1">{error}</p>}

      {cells.length > 0 && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-6">
          <div className="bg-white rounded-xl p-6 max-w-4xl w-full max-h-[90vh] overflow-y-auto">
            <h4 className="font-semibold text-[#0B1220] mb-1">Preview — {cells.length} rate cells</h4>
            <p className="text-[#4B4F58] text-sm mb-4">
              {grid.weights.length} weight rows × {zones.length} zones. Optionally tag this matrix with a carrier/service (leave blank for a blanket rate card).
            </p>

            <div className="grid grid-cols-2 gap-3 mb-4">
              <input
                value={carrier}
                onChange={e => setCarrier(e.target.value)}
                placeholder="Carrier (optional, e.g. UPS)"
                className="bg-[#EEF3FA] border border-[#CBD5E1] rounded-lg px-3 py-2 text-[#0B1220] text-sm focus:outline-none focus:border-[#1A73E8]"
              />
              <input
                value={service}
                onChange={e => setService(e.target.value)}
                placeholder="Service (optional, e.g. Ground)"
                className="bg-[#EEF3FA] border border-[#CBD5E1] rounded-lg px-3 py-2 text-[#0B1220] text-sm focus:outline-none focus:border-[#1A73E8]"
              />
            </div>

            <div className="overflow-x-auto mb-4 border border-[#E2E8F0] rounded-lg">
              <table className="text-sm w-full">
                <thead>
                  <tr className="text-[#4B4F58] border-b border-[#E2E8F0] text-xs uppercase">
                    <th className="p-2 text-left sticky left-0 bg-white">Weight (LB)</th>
                    {zones.map(z => <th key={z} className="p-2 text-right">Zone {z}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {grid.weights.map(w => (
                    <tr key={w} className="border-b border-[#E2E8F0]/40">
                      <td className="p-2 text-[#3A4658] sticky left-0 bg-white">{w}</td>
                      {zones.map(z => (
                        <td key={z} className="p-2 text-right text-emerald-700">
                          {grid.rows[w]?.[z] != null ? `$${grid.rows[w][z].toFixed(2)}` : '—'}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {error && <p className="text-red-700 text-sm mb-3">{error}</p>}
            <div className="flex gap-3">
              <button
                onClick={() => { setCells([]); if (fileRef.current) fileRef.current.value = '' }}
                className="flex-1 bg-[#EEF3FA] hover:bg-[#DDE6F2] text-[#0B1220] py-2 rounded-lg text-sm transition"
              >
                Cancel
              </button>
              <button
                onClick={handleUpload}
                disabled={loading}
                className="flex-1 disabled:opacity-50 text-[#0B1220] py-2 rounded-lg text-sm font-medium transition"
                style={{ background: '#1A73E8' }}
              >
                {loading ? 'Uploading…' : `Upload ${cells.length} Cells`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
