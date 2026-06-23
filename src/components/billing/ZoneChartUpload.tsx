'use client'

import { useRef, useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { showError, showSuccess } from '@/components/ui/Toast'

interface Props {
  clientId: string
  originZip: string
}

export default function ZoneChartUpload({ clientId, originZip }: Props) {
  const fileRef = useRef<HTMLInputElement>(null)
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [entries, setEntries] = useState<{ dest_prefix: string; zone: number }[]>([])
  const [error, setError] = useState('')
  const [chartCount, setChartCount] = useState<number | null>(null)

  useEffect(() => {
    // Show how many entries are already loaded
    fetch(`/api/clients/${clientId}/zone-chart`)
      .then(r => r.json())
      .then(d => setChartCount(d.count ?? 0))
      .catch(() => {})
  }, [clientId])

  async function parseFile(file: File): Promise<{ dest_prefix: string; zone: number }[]> {
    const ext = file.name.split('.').pop()?.toLowerCase()
    let rows: any[][] = []

    if (ext === 'csv') {
      const text = await file.text()
      rows = text.trim().split('\n').map(line =>
        line.split(',').map(v => v.trim().replace(/^"|"$/g, ''))
      )
    } else {
      const XLSX = await import('xlsx')
      const buf = await file.arrayBuffer()
      const wb = XLSX.read(buf, { type: 'array' })
      rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 }) as any[][]
    }

    if (!rows.length) return []

    // Auto-detect columns: find 'dest', 'zip', 'prefix' for ZIP col and 'zone' for zone col
    const header = rows[0].map(c => String(c ?? '').toLowerCase().trim())
    const zipCol = header.findIndex(h => h.includes('dest') || h.includes('zip') || h.includes('prefix'))
    const zoneCol = header.findIndex(h => h.includes('zone'))
    if (zipCol === -1 || zoneCol === -1) {
      throw new Error(`Could not find required columns. Found: ${rows[0].join(', ')}. Need a ZIP/prefix column and a zone column.`)
    }

    return rows.slice(1)
      .map(r => ({
        dest_prefix: String(r[zipCol] ?? '').replace(/\D/g, '').slice(0, 3),
        zone: parseInt(String(r[zoneCol] ?? ''), 10),
      }))
      .filter(e => e.dest_prefix.length === 3 && e.zone >= 1 && e.zone <= 8)
  }

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setError('')
    setEntries([])
    if (!originZip || originZip.length < 5) {
      setError('Set the Origin ZIP first (save client info), then upload the zone chart.')
      return
    }
    try {
      const parsed = await parseFile(file)
      if (parsed.length === 0) {
        setError('No valid entries found. Need columns: dest_prefix (ZIP or 3-digit prefix), zone (1–8).')
        return
      }
      setEntries(parsed)
    } catch (err: any) {
      setError(err?.message ?? 'Could not read file')
    }
  }

  async function handleUpload() {
    setLoading(true)
    setError('')
    try {
      const res = await fetch(`/api/clients/${clientId}/zone-chart`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entries }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Upload failed')
      showSuccess('Zone chart uploaded', `${data.count} ZIP prefix → zone mappings saved`)
      setChartCount(data.count)
      setEntries([])
      if (fileRef.current) fileRef.current.value = ''
      router.refresh()
    } catch (err: any) {
      showError('Upload failed', err?.message)
      setError(err?.message)
    } finally {
      setLoading(false)
    }
  }

  // Sample preview: show first 10 + last 5 entries
  const preview = entries.length <= 15
    ? entries
    : [...entries.slice(0, 10), { dest_prefix: '…', zone: 0 }, ...entries.slice(-5)]

  return (
    <div>
      <div className="flex items-center gap-3 mb-3">
        <div>
          <p className="text-sm font-medium text-white">Zone Map (ZIP → Zone)</p>
          <p className="text-xs text-gray-400 mt-0.5">
            {chartCount == null
              ? 'Loading…'
              : chartCount > 0
                ? `${chartCount} ZIP prefix mappings loaded`
                : 'No zone map uploaded yet'}
            {originZip
              ? ` · Origin: ${originZip}`
              : ' · Set Origin ZIP above first'}
          </p>
        </div>
        <div className="ml-auto flex gap-2">
          <a
            href="/templates/zone-chart-template.csv"
            download
            className="bg-gray-700 hover:bg-gray-600 text-white px-3 py-1.5 rounded-lg text-xs font-medium transition"
          >
            ↓ Template
          </a>
          <input ref={fileRef} type="file" accept=".csv,.xlsx,.xls" onChange={handleFile} className="hidden" />
          <button
            onClick={() => fileRef.current?.click()}
            disabled={!originZip}
            title={!originZip ? 'Set the Origin ZIP first' : 'Upload zone map'}
            className="px-3 py-1.5 rounded-lg text-xs font-medium text-white transition disabled:opacity-40"
            style={{ background: '#00AAFF' }}
          >
            {chartCount && chartCount > 0 ? 'Replace Zone Map' : 'Upload Zone Map'}
          </button>
        </div>
      </div>

      {error && <p className="text-red-400 text-xs mb-2">{error}</p>}

      {entries.length > 0 && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-6">
          <div className="bg-gray-800 rounded-xl p-6 max-w-lg w-full max-h-[85vh] overflow-y-auto">
            <h4 className="font-semibold text-white mb-1">Zone Map Preview</h4>
            <p className="text-gray-400 text-sm mb-4">
              {entries.length} mappings from origin prefix <strong className="text-white">{String(originZip).slice(0, 3)}</strong>. This will replace the existing zone map.
            </p>

            <div className="border border-gray-700 rounded-lg overflow-hidden mb-4">
              <table className="text-sm w-full">
                <thead>
                  <tr className="text-gray-400 text-xs uppercase border-b border-gray-700">
                    <th className="p-2 text-left">Dest ZIP Prefix</th>
                    <th className="p-2 text-center">Zone</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.map((e, i) => (
                    <tr key={i} className="border-b border-gray-700/40">
                      {e.dest_prefix === '…'
                        ? <td colSpan={2} className="p-2 text-gray-500 text-center text-xs">…{entries.length - 15} more rows…</td>
                        : <>
                          <td className="p-2 text-gray-300 font-mono">{e.dest_prefix}xxx</td>
                          <td className="p-2 text-center">
                            <span className="px-2 py-0.5 rounded text-xs font-bold" style={{ background: '#00AAFF33', color: '#00AAFF' }}>
                              Zone {e.zone}
                            </span>
                          </td>
                        </>
                      }
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {error && <p className="text-red-400 text-sm mb-3">{error}</p>}
            <div className="flex gap-3">
              <button
                onClick={() => { setEntries([]); if (fileRef.current) fileRef.current.value = '' }}
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
                {loading ? 'Uploading…' : `Save ${entries.length} Mappings`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
