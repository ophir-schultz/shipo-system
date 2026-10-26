'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { showError, showSuccess } from '@/components/ui/Toast'
import {
  WAREHOUSE_SERVICE_TYPES, LEGACY_UNITS,
  toEditableRates, ratesToSubmit, droppedServices, nextUnusedService,
  type StoredRate, type EditableRate,
} from '@/lib/billing/warehouse-rate-card'

// Imported rather than declared, because the local copy had drifted from the
// daily log's list and the missing entry was `labor_hours`: labour could be
// logged against a service for which no rate could be entered here, so every
// hour of it was unpriceable. One list means adding a service adds it to both
// screens.
const SERVICE_TYPES = WAREHOUSE_SERVICE_TYPES
const UNITS = LEGACY_UNITS

/**
 * @param existingRates the client's stored card, or NULL when the read FAILED.
 *
 * The distinction is the whole point of the prop. POST
 * /api/clients/[id]/warehouse-rates replaces the legacy card with exactly what
 * this form submits, so seeding the form from a failed read -- which looks
 * identical to an empty card -- would open an editor claiming the client has
 * no rates and then delete the ones they do have. lib/db/read.ts exists to
 * keep those two apart; passing `rows` regardless of `error` would collapse
 * them again right at the point where it destroys data.
 */
export default function WarehouseRatesUpload(
  { clientId, existingRates }: { clientId: string; existingRates: StoredRate[] | null },
) {
  const router = useRouter()
  const fileRef = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState<EditableRate[]>([])
  const [loading, setLoading] = useState(false)
  const [xlsxLoading, setXlsxLoading] = useState(false)
  const [error, setError] = useState('')
  // Set only after a save that returned warnings. The modal then shows the
  // warnings instead of closing, because a toast is gone before it is read and
  // these lines are the ones that will never bill.
  const [saved, setSaved] = useState<{ count: number; warnings: string[] } | null>(null)

  /**
   * Seed the form with the card as it stands. The endpoint replaces rather
   * than merges, so the editor has to start from everything the client
   * already has or saving silently deletes the rest.
   */
  function openEditor() {
    // Belt and braces: the buttons are disabled in this state, but a form
    // seeded from an unreadable card is the one outcome that destroys data,
    // so it is refused here too rather than relying on a `disabled` attribute.
    if (existingRates === null) return
    const seeded = toEditableRates(existingRates)
    setRows(seeded.length > 0
      ? seeded
      : [{ service_type: nextUnusedService([]), rate: '', unit: 'per_unit' }])
    setSaved(null)
    setError('')
    setOpen(true)
  }

  function addRow() {
    setRows(r => [...r, {
      service_type: nextUnusedService(r.map(x => x.service_type)),
      rate: '',
      unit: 'per_unit',
    }])
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
      setSaved(null)
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
    // ratesToSubmit, not a local filter: the "will be removed" warning above
    // the button is computed from the same function, so the two cannot
    // disagree about which rows survive.
    const rates = ratesToSubmit(rows)
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
    const data = await res.json().catch(() => ({} as Record<string, unknown>))
    if (!res.ok) {
      const message = typeof data.error === 'string' && data.error
        ? data.error
        : `Failed to save (HTTP ${res.status})`
      // Both a toast and the inline error. The 409 from the route -- new rates
      // saved, old ones not removed -- carries instructions that take longer to
      // read than a toast stays on screen, and re-uploading makes it worse.
      showError('Failed to save rates', message)
      setError(message)
      setLoading(false)
      // The 409 DID write. Refresh so the card on the page shows the duplicate
      // state the message describes rather than the state before the attempt.
      if (res.status === 409) router.refresh()
      return
    }

    const warnings = Array.isArray(data.warnings)
      ? data.warnings.filter((w: unknown): w is string => typeof w === 'string')
      : []
    router.refresh()
    setLoading(false)
    if (warnings.length > 0) {
      setSaved({ count: rates.length, warnings })
      return
    }
    showSuccess('Warehouse rates saved', `${rates.length} rates saved successfully`)
    setOpen(false)
  }

  function closeModal() {
    setOpen(false)
    setSaved(null)
    setError('')
  }

  // Computed from droppedServices -- the same function the test suite pins --
  // rather than from a local filter, so the warning cannot promise to keep a
  // rate that handleSave then deletes. `[]` when the read failed: there is
  // nothing to compare against, and the editor is refused in that state anyway.
  const dropped = existingRates === null ? [] : droppedServices(existingRates, rows)
  const unreadable = existingRates === null

  return (
    <div className="flex gap-2">
      <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" onChange={handleExcelUpload} className="hidden" />

      {/* Download template */}
      <a
        href="/templates/warehouse-rates-template.csv"
        download
        className="bg-[#EEF3FA] hover:bg-[#DDE6F2] text-[#0B1220] px-4 py-2 rounded-lg text-sm font-medium transition"
      >
        ↓ Template
      </a>

      {/* Upload Excel. Disabled when the card could not be READ: the sheet
          replaces the whole card, so uploading without knowing what is there
          deletes whatever the spreadsheet happens to omit. */}
      <button
        onClick={() => fileRef.current?.click()}
        disabled={xlsxLoading || unreadable}
        title={unreadable ? 'Current rates could not be loaded -- reload before replacing them' : undefined}
        className="bg-[#EEF3FA] hover:bg-[#DDE6F2] disabled:opacity-50 disabled:cursor-not-allowed text-[#0B1220] px-4 py-2 rounded-lg text-sm font-medium transition"
      >
        {xlsxLoading ? 'Reading...' : '↑ Replace from Excel'}
      </button>

      {/* Edit. Label says "Edit", not "Add", because the endpoint replaces the
          card with exactly what the form submits -- there is no append. The
          button used to say "Add Manually" and open one blank row, so adding
          one service deleted every other rate the client had. */}
      <button
        onClick={openEditor}
        disabled={unreadable}
        title={unreadable ? 'Current rates could not be loaded -- reload before editing them' : undefined}
        className="text-[#0B1220] px-4 py-2 rounded-lg text-sm font-medium transition disabled:opacity-50 disabled:cursor-not-allowed"
        style={{ background: '#1A73E8' }}
      >
        ✎ Edit Rates
      </button>

      {open && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-6">
          <div className="bg-white rounded-xl p-6 max-w-2xl w-full max-h-[90vh] overflow-y-auto">
            <h4 className="font-semibold text-[#0B1220] mb-1">Warehouse Rates</h4>
            <p className="text-[#4B4F58] text-sm mb-4">
              {saved ? `${saved.count} rate(s) saved.` : 'Review and edit before saving'}
            </p>

            {saved ? (
              <>
                {/* Saved, and some lines can never be billed from. Amber rather
                    than red: nothing failed and nothing needs retrying. Shown
                    here rather than in a toast because the operator has to
                    decide whether the spreadsheet named the wrong service. */}
                <div className="bg-amber-500/10 border border-amber-500/40 rounded-lg p-4 mb-4">
                  <p className="text-amber-700 text-sm font-medium mb-2">
                    {saved.warnings.length} rate(s) will never be billed from
                  </p>
                  <ul className="space-y-2">
                    {saved.warnings.map((w, i) => (
                      <li key={i} className="text-amber-700 text-sm">• {w}</li>
                    ))}
                  </ul>
                </div>
                <button
                  onClick={closeModal}
                  className="w-full bg-[#EEF3FA] hover:bg-[#DDE6F2] text-[#0B1220] py-2 rounded-lg text-sm transition"
                >
                  Close
                </button>
              </>
            ) : (
            <>
            {/* Says what saving DOES, next to the button that does it. The
                endpoint replaces the legacy card with exactly these lines, so
                an operator who deletes a row here is deleting a rate -- that
                has to be stated where the decision is made, not discovered
                afterwards from a bill that came out short. */}
            <p className="text-[#4B4F58] text-xs mb-3 bg-[#EEF3FA]/40 border border-[#CBD5E1]/60 rounded-lg px-3 py-2">
              Saving sets this client&apos;s warehouse rates to exactly the lines below.
              Anything removed from this list stops being billed.
            </p>

            <div className="space-y-2 mb-4">
              <div className="grid grid-cols-3 gap-2 text-xs text-[#4B4F58] px-1">
                <span>Service</span><span>Rate ($)</span><span>Unit</span>
              </div>
              {rows.map((row, i) => (
                <div key={i} className="grid grid-cols-3 gap-2 items-center">
                  <select
                    value={row.service_type}
                    onChange={e => updateRow(i, 'service_type', e.target.value)}
                    className="bg-[#EEF3FA] border border-[#CBD5E1] rounded-lg px-3 py-2 text-[#0B1220] text-sm focus:outline-none focus:border-[#1A73E8]"
                  >
                    {SERVICE_TYPES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                  </select>
                  <input
                    type="number"
                    placeholder="0.00"
                    value={row.rate}
                    onChange={e => updateRow(i, 'rate', e.target.value)}
                    className="bg-[#EEF3FA] border border-[#CBD5E1] rounded-lg px-3 py-2 text-[#0B1220] text-sm focus:outline-none focus:border-[#1A73E8]"
                  />
                  <div className="flex gap-1">
                    <select
                      value={row.unit}
                      onChange={e => updateRow(i, 'unit', e.target.value)}
                      className="flex-1 bg-[#EEF3FA] border border-[#CBD5E1] rounded-lg px-3 py-2 text-[#0B1220] text-sm focus:outline-none focus:border-[#1A73E8]"
                    >
                      {UNITS.map(u => <option key={u} value={u}>{u.replace(/_/g, ' ')}</option>)}
                    </select>
                    <button onClick={() => removeRow(i)} className="text-[#6B7A8D] hover:text-red-700 px-2">✕</button>
                  </div>
                </div>
              ))}
            </div>

            <button onClick={addRow} className="text-[#1A73E8] text-sm hover:text-[#63B3FF] mb-4 block">+ Add row</button>

            {/* Named BEFORE the save, from the same function the save uses.
                A row left blank is not kept at its old rate -- it is dropped --
                and the only moment that is still fixable is this one. */}
            {dropped.length > 0 && (
              <div className="bg-amber-500/10 border border-amber-500/40 rounded-lg p-3 mb-3">
                <p className="text-amber-700 text-sm font-medium mb-1">
                  Saving now will remove {dropped.length} existing rate(s)
                </p>
                <p className="text-amber-700 text-xs">
                  {dropped.map(s => s.replace(/_/g, ' ')).join(', ')}
                </p>
              </div>
            )}

            {error && <p className="text-red-700 text-sm mb-3 whitespace-pre-wrap">{error}</p>}
            <div className="flex gap-3">
              <button onClick={closeModal} className="flex-1 bg-[#EEF3FA] hover:bg-[#DDE6F2] text-[#0B1220] py-2 rounded-lg text-sm transition">Cancel</button>
              <button onClick={handleSave} disabled={loading} className="flex-1 disabled:opacity-50 text-white py-2 rounded-lg text-sm font-medium transition" style={{ background: '#1A73E8' }}>
                {loading ? 'Saving...' : 'Save Rates'}
              </button>
            </div>
            </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
