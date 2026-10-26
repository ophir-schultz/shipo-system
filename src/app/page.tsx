import Link from 'next/link'

export default function Home() {
  return (
    <div className="min-h-screen bg-gray-950 text-[#0B1220] flex flex-col items-center justify-center">
      <div className="text-center mb-12">
        <h1 className="text-5xl font-bold text-[#0B1220] mb-3">Shipo System</h1>
        <p className="text-[#4B4F58] text-lg">Fulfillment Operations & Billing Platform</p>
      </div>
      <div className="grid grid-cols-2 gap-4 w-full max-w-lg px-4">
        <Link href="/dashboard" className="bg-white hover:bg-[#EEF3FA] rounded-xl p-6 text-center transition">
          <div className="text-3xl mb-2">📊</div>
          <div className="font-semibold">Dashboard</div>
          <div className="text-[#4B4F58] text-sm">Live signals & overview</div>
        </Link>
        <Link href="/clients" className="bg-white hover:bg-[#EEF3FA] rounded-xl p-6 text-center transition">
          <div className="text-3xl mb-2">👥</div>
          <div className="font-semibold">Clients</div>
          <div className="text-[#4B4F58] text-sm">Manage clients & pricing</div>
        </Link>
        <Link href="/billing" className="bg-white hover:bg-[#EEF3FA] rounded-xl p-6 text-center transition">
          <div className="text-3xl mb-2">💰</div>
          <div className="font-semibold">Billing</div>
          <div className="text-[#4B4F58] text-sm">Weekly bills & charges</div>
        </Link>
        <Link href="/warehouse" className="bg-white hover:bg-[#EEF3FA] rounded-xl p-6 text-center transition">
          <div className="text-3xl mb-2">📦</div>
          <div className="font-semibold">Warehouse Log</div>
          <div className="text-[#4B4F58] text-sm">Daily activity entry</div>
        </Link>
        <Link href="/statements" className="bg-white hover:bg-[#EEF3FA] rounded-xl p-6 text-center transition">
          <div className="text-3xl mb-2">🧾</div>
          <div className="font-semibold">Statements</div>
          <div className="text-[#4B4F58] text-sm">Per-client charges by period</div>
        </Link>
        <Link href="/reports" className="bg-white hover:bg-[#EEF3FA] rounded-xl p-6 text-center transition">
          <div className="text-3xl mb-2">📥</div>
          <div className="font-semibold">Reports</div>
          <div className="text-[#4B4F58] text-sm">Exports &amp; downloads</div>
        </Link>
      </div>
    </div>
  )
}
