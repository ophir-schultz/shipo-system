'use client'

import Link from 'next/link'
import Image from 'next/image'
import { usePathname, useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase-browser'

const nav = [
  { href: '/dashboard', label: 'Dashboard', icon: '📊' },
  { href: '/clients', label: 'Clients', icon: '👥' },
  { href: '/shipments', label: 'Shipments', icon: '🚚' },
  { href: '/losses', label: 'Loss Analysis', icon: '📉' },
  { href: '/adjustments', label: 'Adjustments', icon: '⚠️' },
  { href: '/warehouse', label: 'Warehouse Log', icon: '📦' },
  { href: '/scan', label: 'Serialization Scan', icon: '🔢' },
  { href: '/billing', label: 'Billing', icon: '💰' },
  { href: '/statements', label: 'Statements', icon: '🧾' },
  { href: '/referrals', label: 'Referral Payouts', icon: '🤝' },
  // Lives at /quotes, not /rate-sheets: that segment is excluded from the
  // proxy so prospects can open their links without logging in.
  { href: '/quotes', label: 'Rate Sheets', icon: '📄' },
  { href: '/reports', label: 'Reports', icon: '📥' },
  { href: '/employees', label: 'Employees', icon: '🧑‍💼' },
  { href: '/marketing', label: 'Marketing', icon: '📣' },
]

export default function Sidebar() {
  const pathname = usePathname()
  const router = useRouter()
  const [userEmail, setUserEmail] = useState<string | null>(null)

  useEffect(() => {
    const supabase = createClient()
    supabase.auth.getUser().then(({ data }) => {
      setUserEmail(data.user?.email ?? null)
    })
  }, [])

  async function handleLogout() {
    const supabase = createClient()
    await supabase.auth.signOut()
    router.push('/login')
    router.refresh()
  }

  return (
    <aside className="w-60 min-h-screen flex flex-col" style={{ background: 'linear-gradient(165deg, #081A33 0%, #0B3361 55%, #0F4A94 100%)', borderRight: '1px solid #0B3361' }}>
      <div className="px-5 py-4" style={{ borderBottom: '1px solid rgba(255,255,255,0.14)' }}>
        <div className="px-1 py-2 mb-1">
          <Image src="/shipo-logo-white.png" alt="Shipo" width={322} height={122} className="w-full h-auto" priority />
        </div>
        <div style={{ height: '4px', borderRadius: '2px', background: '#E0EE47', margin: '6px 2px 0' }} />
        <p className="text-xs text-center mt-2" style={{ color: '#C7D8F0' }}>Operations Platform</p>
      </div>
      <nav className="flex-1 px-3 py-4 space-y-0.5">
        {nav.map((item) => {
          const active = pathname === item.href || pathname.startsWith(item.href + '/')
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                active ? 'text-white' : 'hover:text-white'
              }`}
              style={active
                ? { background: 'linear-gradient(135deg, #1A73E8, #0B5ED7)' }
                : { color: '#C7D8F0' }}
            >
              <span>{item.icon}</span>
              {item.label}
            </Link>
          )
        })}
      </nav>
      <div className="px-4 py-4 space-y-2" style={{ borderTop: '1px solid rgba(255,255,255,0.14)' }}>
        {userEmail && (
          <div className="px-2 py-1.5">
            <p className="text-xs text-gray-500 truncate">{userEmail}</p>
          </div>
        )}
        <button
          onClick={handleLogout}
          className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-[#C7D8F0] hover:text-white hover:bg-white/10 transition"
        >
          <span>🚪</span> Sign Out
        </button>
        <p className="text-xs text-gray-600 px-2">Shipo LLC © 2026</p>
      </div>
    </aside>
  )
}
