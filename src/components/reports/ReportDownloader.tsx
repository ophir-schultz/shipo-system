'use client'

import { useState } from 'react'
import { showError, showSuccess } from '@/components/ui/Toast'

const colors: Record<string, string> = {
  blue: 'border-blue-700 bg-blue-950/30',
  green: 'border-green-700 bg-green-950/30',
  red: 'border-red-700 bg-red-950/30',
  yellow: 'border-yellow-700 bg-yellow-950/30',
  purple: 'border-purple-700 bg-purple-950/30',
  gray: 'border-gray-700 bg-gray-800',
}

export default function ReportDownloader({ report, clients }: { report: any; clients: any[] }) {
  const [loading, setLoading] = useState(false)
  const [clientId, setClientId] = useState('')
  const [dateFrom, setDateFrom] = useState(() => {
    const d = new Date()
    d.setDate(1)
    return d.toISOString().split('T')[0]
  })
  const [dateTo, setDateTo] = useState(() => new Date().toISOString().split('T')[0])

  async function handleDownload() {
    setLoading(true)
    const params = new URLSearchParams({
      type: report.id,
      dateFrom,
      dateTo,
      ...(clientId ? { clientId } : {}),
    })
    try {
      const res = await fetch(`/api/reports/download?${params}`)
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error ?? `Server error ${res.status}`)
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${report.id}-${dateFrom}-${dateTo}.xlsx`
      a.click()
      URL.revokeObjectURL(url)
      showSuccess('Report downloaded', `${report.title} exported as Excel`)
    } catch (err: any) {
      showError('Download failed', err?.message ?? 'Could not generate report')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className={`rounded-xl p-6 border ${colors[report.color]}`}>
      <div className="flex items-start justify-between mb-4">
        <div>
          <div className="text-2xl mb-2">{report.icon}</div>
          <h3 className="font-semibold text-white">{report.title}</h3>
          <p className="text-gray-400 text-sm mt-1">{report.description}</p>
        </div>
      </div>

      <div className="space-y-3 mt-4">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-xs text-gray-400 mb-1">From</label>
            <input
              type="date"
              value={dateFrom}
              onChange={e => setDateFrom(e.target.value)}
              className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-[#00AAFF]"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">To</label>
            <input
              type="date"
              value={dateTo}
              onChange={e => setDateTo(e.target.value)}
              className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-[#00AAFF]"
            />
          </div>
        </div>

        <div>
          <label className="block text-xs text-gray-400 mb-1">Client (optional — leave blank for all)</label>
          <select
            value={clientId}
            onChange={e => setClientId(e.target.value)}
            className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-[#00AAFF]"
          >
            <option value="">All Clients</option>
            {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>

        <button
          onClick={handleDownload}
          disabled={loading}
          className="w-full bg-white hover:bg-gray-100 disabled:opacity-50 text-gray-900 py-2.5 rounded-lg text-sm font-semibold transition flex items-center justify-center gap-2"
        >
          {loading ? '⏳ Generating...' : '↓ Download Excel'}
        </button>
      </div>
    </div>
  )
}
