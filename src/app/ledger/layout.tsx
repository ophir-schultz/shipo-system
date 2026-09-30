// Same chrome as every other screen in the app. Copied verbatim from
// src/app/dashboard/layout.tsx — without it /ledger renders bare and flush to
// the viewport edge with no sidebar.
//
// Deliberately NOT added to src/components/layout/Sidebar.tsx: /ledger is
// reachable by URL only for now, which matches /pnl.
import Sidebar from '@/components/layout/Sidebar'

export default function LedgerLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen bg-[#0a0f1a] text-white">
      <Sidebar />
      <main className="flex-1 p-8 overflow-auto">{children}</main>
    </div>
  )
}
