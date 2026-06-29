import { supabaseAdmin } from '@/lib/supabase'
import AdjustmentsClient from '@/components/adjustments/AdjustmentsClient'

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
  return {
    pending: pendingRes.data ?? [],
    resolved: allRes.data ?? [],
  }
}

export default async function AdjustmentsPage() {
  const { pending, resolved } = await getAdjustments()
  const pendingTotal = pending.reduce((s: number, r: any) => s + (r.adjustment_amount ?? 0), 0)
  const billedTotal = resolved.filter((r: any) => r.status === 'billed').reduce((s: number, r: any) => s + (r.adjustment_amount ?? 0), 0)
  const waivedTotal = resolved.filter((r: any) => r.status === 'waived').reduce((s: number, r: any) => s + (r.adjustment_amount ?? 0), 0)

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-white">Carrier Price Adjustments</h2>
        <p className="text-gray-400 text-sm mt-1">
          Post-shipment price changes detected on each sync — review and charge clients accordingly
        </p>
      </div>

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
        <div className="rounded-xl p-4 border border-[#00AAFF]/20 bg-[#00AAFF]/5">
          <p className="text-[#00AAFF]/70 text-xs uppercase tracking-wider">Billed</p>
          <p className="text-2xl font-bold text-[#33BBFF] mt-1">{resolved.filter((r: any) => r.status === 'billed').length}</p>
          <p className="text-[#00AAFF]/60 text-xs mt-1">+${billedTotal.toFixed(2)} recovered</p>
        </div>
        <div className="rounded-xl p-4 border border-gray-700 bg-gray-800">
          <p className="text-gray-400 text-xs uppercase tracking-wider">Waived</p>
          <p className="text-2xl font-bold text-gray-300 mt-1">{resolved.filter((r: any) => r.status === 'waived').length}</p>
          <p className="text-gray-500 text-xs mt-1">${waivedTotal.toFixed(2)} written off</p>
        </div>
      </div>

      {/* How it works */}
      <div className="rounded-xl p-4 border border-gray-700/50 bg-gray-800/50 flex gap-4 text-sm text-gray-400">
        <span className="text-2xl shrink-0">ℹ️</span>
        <div>
          <p className="text-gray-300 font-medium mb-1">How adjustments are detected</p>
          <p>Every sync compares the latest carrier cost for each shipment against what was previously stored.
          If the carrier increased the charge (reweigh, DIM correction, address correction), an adjustment is automatically created here.
          Use <strong className="text-white">Approve</strong> to flag for billing, <strong className="text-white">Billed</strong> once charged to client, or <strong className="text-white">Waive</strong> to write off.</p>
        </div>
      </div>

      <AdjustmentsClient pending={pending} resolved={resolved} pendingTotal={pendingTotal} />
    </div>
  )
}
