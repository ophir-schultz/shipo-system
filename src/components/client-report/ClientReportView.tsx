'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { showError, showSuccess } from '@/components/ui/Toast'
import {
  CLIENT_REPORT_COLUMNS,
  filterReportRows,
  reportCells,
  type ClientReportRow,
} from '@/lib/pricing/client-report'

export interface ClientReportLine extends ClientReportRow {
  clientId: string | null
}

export default function ClientReportView({
  rows,
  clients,
  linesMissing,
}: {
  rows: ClientReportLine[]
  clients: { id: string; name: string }[]
  linesMissing: boolean
}) {
  const router = useRouter()
  const [clientId, setClientId] = useState('')
  const [dateFrom, setDateFrom] = useState('2026-05-01')
  const [dateTo, setDateTo] = useState('2026-08-31')
  const [busy, setBusy] = useState<'csv' | 'xlsx' | 'pdf' | 'approve' | 'import' | null>(null)
  const [importClientId, setImportClientId] = useState('')

  const filtered = useMemo(() => {
    const ranged = filterReportRows(rows, dateFrom, dateTo)
    return clientId ? ranged.filter((row) => row.clientId === clientId) : ranged
  }, [rows, dateFrom, dateTo, clientId])

  async function approve() {
    if (!clientId) {
      showError('Choose a client', 'A report is approved for one client and one date range.')
      return
    }
    setBusy('approve')
    try {
      const res = await fetch('/api/client-reports/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId, dateFrom, dateTo }),
      })
      const data = await res.json().catch(() => ({} as { error?: string }))
      if (!res.ok) throw new Error(data.error ?? `Server error ${res.status}`)
      showSuccess('Report approved', 'You can download it now. It is not emailed.')
    } catch (err) {
      showError('Not approved', err instanceof Error ? err.message : 'Could not record the approval')
    } finally {
      setBusy(null)
    }
  }

  async function download(format: 'csv' | 'xlsx' | 'pdf') {
    setBusy(format)
    const params = new URLSearchParams({ format, dateFrom, dateTo })
    if (clientId) params.set('clientId', clientId)
    try {
      const res = await fetch(`/api/client-reports/download?${params}`)
      if (!res.ok) {
        const data = await res.json().catch(() => ({} as { error?: string }))
        throw new Error(data.error ?? `Server error ${res.status}`)
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `client-report-${dateFrom}-${dateTo}.${format}`
      a.click()
      URL.revokeObjectURL(url)
      showSuccess('Report downloaded', `${format.toUpperCase()} saved on this computer. It was not emailed.`)
    } catch (err) {
      showError('Download failed', err instanceof Error ? err.message : 'Could not build the file')
    } finally {
      setBusy(null)
    }
  }

  async function importWorkbook(file: File) {
    if (!importClientId) {
      showError('Choose a client', 'The workbook is stored against one client.')
      return
    }
    setBusy('import')
    try {
      const XLSX = await import('xlsx')
      const book = XLSX.read(await file.arrayBuffer(), { type: 'array' })
      const sheet = book.Sheets[book.SheetNames[0]]
      const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true })
      const res = await fetch('/api/client-reports/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: importClientId, filename: file.name, grid }),
      })
      const data = await res.json().catch(() => ({} as { error?: string; count?: number }))
      if (!res.ok) throw new Error(data.error ?? `Server error ${res.status}`)
      showSuccess('Workbook imported', `${data.count ?? 0} orders added. Earlier imports were left in place.`)
      router.refresh()
    } catch (err) {
      showError('Import failed', err instanceof Error ? err.message : 'Could not read the workbook')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-xl p-5">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <label className="text-xs text-[#4B4F58]">
            From
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="mt-1 w-full bg-[#EEF3FA] border border-[#CBD5E1] rounded-lg px-3 py-2 text-[#0B1220] text-sm focus:outline-none focus:border-[#1A73E8]"
            />
          </label>
          <label className="text-xs text-[#4B4F58]">
            To
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="mt-1 w-full bg-[#EEF3FA] border border-[#CBD5E1] rounded-lg px-3 py-2 text-[#0B1220] text-sm focus:outline-none focus:border-[#1A73E8]"
            />
          </label>
          <label className="text-xs text-[#4B4F58] col-span-2">
            Client
            <select
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              className="mt-1 w-full bg-[#EEF3FA] border border-[#CBD5E1] rounded-lg px-3 py-2 text-[#0B1220] text-sm focus:outline-none focus:border-[#1A73E8]"
            >
              <option value="">All clients</option>
              {clients.map((client) => (
                <option key={client.id} value={client.id}>{client.name}</option>
              ))}
            </select>
          </label>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={approve}
            disabled={busy !== null || linesMissing}
            className="px-4 py-2 bg-[#0B3361] hover:bg-[#0F4A94] disabled:opacity-50 text-white text-sm font-semibold rounded-lg"
          >
            {busy === 'approve' ? 'Approving…' : 'Approve for download'}
          </button>
          <button
            type="button"
            onClick={() => download('csv')}
            disabled={busy !== null || linesMissing}
            className="px-4 py-2 bg-[#1A73E8] hover:bg-[#0B5ED7] disabled:opacity-50 text-white text-sm font-semibold rounded-lg"
          >
            {busy === 'csv' ? 'Preparing…' : 'Download CSV'}
          </button>
          <button
            type="button"
            onClick={() => download('xlsx')}
            disabled={busy !== null || linesMissing}
            className="px-4 py-2 bg-white border border-[#CBD5E1] hover:bg-[#EEF3FA] disabled:opacity-50 text-[#0B1220] text-sm font-semibold rounded-lg"
          >
            {busy === 'xlsx' ? 'Preparing…' : 'Download Excel'}
          </button>
          <button
            type="button"
            onClick={() => download('pdf')}
            disabled={busy !== null || linesMissing}
            className="px-4 py-2 bg-white border border-[#CBD5E1] hover:bg-[#EEF3FA] disabled:opacity-50 text-[#0B1220] text-sm font-semibold rounded-lg"
          >
            {busy === 'pdf' ? 'Preparing…' : 'Download PDF'}
          </button>
          <span className="text-xs text-[#6B7A8D]">{filtered.length} orders in this range. Download is not emailed.</span>
        </div>
      </div>

      <div className="bg-white rounded-xl p-5">
        <h3 className="font-semibold text-[#0B1220] mb-3">Import a workbook</h3>
        <p className="text-sm text-[#4B4F58] mb-3">
          Adds rows for one client. It does not delete a previous import, and it does not email anyone.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs text-[#4B4F58]">
            Client
            <select
              value={importClientId}
              onChange={(e) => setImportClientId(e.target.value)}
              className="mt-1 block bg-[#EEF3FA] border border-[#CBD5E1] rounded-lg px-3 py-2 text-[#0B1220] text-sm"
            >
              <option value="">Select</option>
              {clients.map((client) => (
                <option key={client.id} value={client.id}>{client.name}</option>
              ))}
            </select>
          </label>
          <label className="px-4 py-2 bg-[#1A73E8] hover:bg-[#0B5ED7] text-white text-sm font-semibold rounded-lg cursor-pointer">
            {busy === 'import' ? 'Importing…' : 'Upload Excel or CSV'}
            <input
              type="file"
              accept=".xlsx,.xls,.csv"
              className="hidden"
              disabled={busy !== null || linesMissing}
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) importWorkbook(file)
                e.target.value = ''
              }}
            />
          </label>
        </div>
      </div>

      <div className="bg-white rounded-xl p-5 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[#4B4F58] text-left border-b border-[#E2E8F0] text-xs uppercase">
              {CLIENT_REPORT_COLUMNS.map((column) => (
                <th key={column} className="pb-2 pr-3 whitespace-pre">{column}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={CLIENT_REPORT_COLUMNS.length} className="py-6 text-[#6B7A8D]">
                  No billing lines in this range.
                </td>
              </tr>
            ) : filtered.slice(0, 200).map((row, index) => (
              <tr key={`${row.orderNumber}:${row.date}:${index}`} className="border-b border-[#E2E8F0]/40">
                {reportCells(row).map((cell, cellIndex) => (
                  <td key={cellIndex} className="py-2 pr-3 whitespace-pre text-[#3A4658] align-top">{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length > 200 && (
          <p className="mt-3 text-xs text-[#6B7A8D]">
            Showing the first 200 of {filtered.length}. The download includes the whole range.
          </p>
        )}
      </div>
    </div>
  )
}
