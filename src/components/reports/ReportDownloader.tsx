'use client'

import { useState } from 'react'
import { showError, showSuccess } from '@/components/ui/Toast'
import { easternMonthStart, easternToday } from '@/lib/ledger/eastern-day'

const colors: Record<string, string> = {
  blue: 'border-blue-200 bg-blue-50',
  green: 'border-emerald-200 bg-emerald-50',
  red: 'border-red-200 bg-red-50',
  yellow: 'border-amber-200 bg-amber-50',
  purple: 'border-purple-700 bg-purple-950/30',
  gray: 'border-[#E2E8F0] bg-white',
}

export default function ReportDownloader({ report, clients }: { report: any; clients: any[] }) {
  const [loading, setLoading] = useState(false)
  const [clientId, setClientId] = useState('')
  const [dateFrom, setDateFrom] = useState(() => easternMonthStart(easternToday()))
  const [dateTo, setDateTo] = useState(() => easternToday())

  async function handleDownload(format: 'xlsx' | 'csv' | 'pdf') {
    setLoading(true)
    const params = new URLSearchParams({
      type: report.id,
      dateFrom,
      dateTo,
      format,
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
      a.download = `${report.id}-${dateFrom}-${dateTo}.${format}`
      a.click()
      URL.revokeObjectURL(url)
      showSuccess('Report downloaded', `${report.title} exported as ${format.toUpperCase()}`)
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
          <h3 className="font-semibold text-[#0B1220]">{report.title}</h3>
          <p className="text-[#4B4F58] text-sm mt-1">{report.description}</p>
        </div>
      </div>

      <div className="space-y-3 mt-4">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-xs text-[#4B4F58] mb-1">From</label>
            <input
              type="date"
              value={dateFrom}
              onChange={e => setDateFrom(e.target.value)}
              className="w-full bg-[#EEF3FA] border border-[#CBD5E1] rounded-lg px-3 py-2 text-[#0B1220] text-sm focus:outline-none focus:border-[#1A73E8]"
            />
          </div>
          <div>
            <label className="block text-xs text-[#4B4F58] mb-1">To</label>
            <input
              type="date"
              value={dateTo}
              onChange={e => setDateTo(e.target.value)}
              className="w-full bg-[#EEF3FA] border border-[#CBD5E1] rounded-lg px-3 py-2 text-[#0B1220] text-sm focus:outline-none focus:border-[#1A73E8]"
            />
          </div>
        </div>

        <div>
          <label className="block text-xs text-[#4B4F58] mb-1">Client (optional — leave blank for all)</label>
          <select
            value={clientId}
            onChange={e => setClientId(e.target.value)}
            className="w-full bg-[#EEF3FA] border border-[#CBD5E1] rounded-lg px-3 py-2 text-[#0B1220] text-sm focus:outline-none focus:border-[#1A73E8]"
          >
            <option value="">All Clients</option>
            {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>

        <div className="flex gap-2">
          <button type="button" onClick={() => handleDownload('csv')} disabled={loading}
            className="flex-1 bg-white hover:bg-gray-100 disabled:opacity-50 text-gray-900 py-2.5 rounded-lg text-sm font-semibold">
            {loading ? '…' : 'CSV'}
          </button>
          <button type="button" onClick={() => handleDownload('xlsx')} disabled={loading}
            className="flex-1 bg-white hover:bg-gray-100 disabled:opacity-50 text-gray-900 py-2.5 rounded-lg text-sm font-semibold">
            {loading ? '…' : 'Excel'}
          </button>
          <button type="button" onClick={() => handleDownload('pdf')} disabled={loading}
            className="flex-1 text-white disabled:opacity-50 py-2.5 rounded-lg text-sm font-semibold"
            style={{ background: '#1A73E8' }}>
            {loading ? '…' : 'PDF'}
          </button>
        </div>
      </div>
    </div>
  )
}
