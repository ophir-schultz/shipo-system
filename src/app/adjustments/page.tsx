import { supabaseAdmin } from '@/lib/supabase'
import { read, readErrors, loaded, type LoadedData } from '@/lib/db/read'
import ViewUnreadable from '@/components/ui/ViewUnreadable'
import AdjustmentsClient from '@/components/adjustments/AdjustmentsClient'

// Read at REQUEST time, never at build time. Without this the App Router
// prerenders this page during `next build`, which on this page is the worst
// of the three: unrecovered carrier charges baked at deploy time means the
// "pending" figure stops moving, and a frozen "Pending 0" reads as an
// all-clear. See src/app/dynamic-rendering.test.ts.
export const dynamic = 'force-dynamic'

// Adjustments are carrier charges that landed AFTER the shipment was billed --
// reweighs, DIM corrections, address corrections -- so this page is the only
// record of money the business is owed and has not yet asked for. "Pending 0 ·
// +$0.00 to recover" is therefore not an empty screen, it is an all-clear, and
// the correct response to an all-clear is to do nothing. The charges then age
// out quietly.
//
// Both reads are refused together: `pending` and `resolved` are the same table
// partitioned by status, and the four summary cards read as a set. "0 pending,
// 14 billed" invites a different conclusion from "0 pending, 0 billed", and
// neither is one this page is entitled to draw from a read it did not get.
//
// `adjustment_amount ?? 0` is left alone on purpose. Nothing writes null to
// that column, and the same judgement is already written down in ReportsTabs:
// changing it would be a guess dressed up as a fix. The defect here is the
// failed read, not the coercion.

async function getAdjustments() {
  const [pendingRes, allRes] = await Promise.all([
    supabaseAdmin
      .from('rate_adjustments')
      .select('*, clients(name)')
      .eq('status', 'pending')
      .order('adjustment_amount', { ascending: false }),
    supabaseAdmin
      .from('rate_adjustments')
      .select('*, clients(name)')
      .neq('status', 'pending')
      .order('adjustment_date', { ascending: false })
      .limit(100),
  ])
  const pending = read('rate_adjustments (pending)', pendingRes)
  const resolved = read('rate_adjustments (resolved)', allRes)

  return loaded(readErrors(pending, resolved), () => ({
    pending: pending.rows,
    resolved: resolved.rows,
  }))
}

export default async function AdjustmentsPage() {
  const page = await getAdjustments()

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-[#0B1220]">Carrier Price Adjustments</h2>
        <p className="text-[#4B4F58] text-sm mt-1">
          Post-shipment price changes detected on each sync — review and charge clients accordingly
        </p>
      </div>

      {page.ok ? <Summary data={page.data} /> : <ViewUnreadable message={page.error} />}

      {/* How it works */}
      <div className="rounded-xl p-4 border border-[#E2E8F0]/50 bg-white/50 flex gap-4 text-sm text-[#4B4F58]">
        <span className="text-2xl shrink-0">ℹ️</span>
        <div>
          <p className="text-[#3A4658] font-medium mb-1">How adjustments are detected</p>
          <p>Every sync compares the latest carrier cost for each shipment against what was previously stored.
          If the carrier increased the charge (reweigh, DIM correction, address correction), an adjustment is automatically created here.
          Use <strong className="text-[#0B1220]">Approve</strong> to flag for billing, <strong className="text-[#0B1220]">Billed</strong> once charged to client, or <strong className="text-[#0B1220]">Waive</strong> to write off.</p>
        </div>
      </div>
    </div>
  )
}

// The cards and the table together, behind one annotated payload. Annotated so
// that deleting the refusal above is a compile error rather than a quiet return
// to printing "+$0.00 to recover" over an unread table. See LoadedData.
function Summary({ data }: { data: LoadedData<Awaited<ReturnType<typeof getAdjustments>>> }) {
  const { pending, resolved } = data
  const pendingTotal = pending.reduce((s: number, r: any) => s + (r.adjustment_amount ?? 0), 0)
  const billedTotal = resolved.filter((r: any) => r.status === 'billed').reduce((s: number, r: any) => s + (r.adjustment_amount ?? 0), 0)
  const waivedTotal = resolved.filter((r: any) => r.status === 'waived').reduce((s: number, r: any) => s + (r.adjustment_amount ?? 0), 0)

  return (
    <>
      {/* Summary cards */}
      <div className="grid grid-cols-4 gap-4">
        <div className="rounded-xl p-4 border border-orange-800/60" style={{ background: '#1a1000' }}>
          <p className="text-orange-400/70 text-xs uppercase tracking-wider">Pending</p>
          <p className="text-2xl font-bold text-orange-400 mt-1">{pending.length}</p>
          <p className="text-orange-400/60 text-xs mt-1">+${pendingTotal.toFixed(2)} to recover</p>
        </div>
        <div className="rounded-xl p-4 border border-green-800/40 bg-green-950/30">
          <p className="text-green-400/70 text-xs uppercase tracking-wider">Approved</p>
          <p className="text-2xl font-bold text-green-400 mt-1">{resolved.filter((r: any) => r.status === 'approved').length}</p>
          <p className="text-green-400/60 text-xs mt-1">Approved, not yet billed</p>
        </div>
        <div className="rounded-xl p-4 border border-[#1A73E8]/20 bg-[#1A73E8]/5">
          <p className="text-[#1A73E8]/70 text-xs uppercase tracking-wider">Billed</p>
          <p className="text-2xl font-bold text-[#63B3FF] mt-1">{resolved.filter((r: any) => r.status === 'billed').length}</p>
          <p className="text-[#1A73E8]/60 text-xs mt-1">+${billedTotal.toFixed(2)} recovered</p>
        </div>
        <div className="rounded-xl p-4 border border-[#E2E8F0] bg-white">
          <p className="text-[#4B4F58] text-xs uppercase tracking-wider">Waived</p>
          <p className="text-2xl font-bold text-[#3A4658] mt-1">{resolved.filter((r: any) => r.status === 'waived').length}</p>
          <p className="text-[#6B7A8D] text-xs mt-1">${waivedTotal.toFixed(2)} written off</p>
        </div>
      </div>

      <AdjustmentsClient pending={pending} resolved={resolved} pendingTotal={pendingTotal} />
    </>
  )
}
