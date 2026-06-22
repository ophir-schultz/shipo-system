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
  { href: '/adjustments', label: 'Adjustments', icon: '⚠️' },
  { href: '/warehouse', label: 'Warehouse Log', icon: '📦' },
  { href: '/billing', label: 'Billing', icon: '💰' },
  { href: '/reports', label: 'Reports', icon: '📥' },
  { href: '/employees', label: 'Employees', icon: '🧑‍💼' },
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
    <aside className="w-60 min-h-screen flex flex-col" style={{ background: '#0d1420', borderRight: '1px solid #1a2540' }}>
      <div className="px-5 py-4" style={{ borderBottom: '1px solid #1a2540' }}>
        <div className="rounded-xl px-3 py-3 mb-1" style={{ background: '#00AAFF' }}>
          <Image src="/shipo-logo.jpg" alt="Shipo" width={160} height={52} className="w-full h-auto rounded-lg" priority />
        </div>
        <p className="text-xs text-center mt-2" style={{ color: '#00AAFF' }}>Operations Platform</p>
      </div>
      <nav className="flex-1 px-3 py-4 space-y-0.5">
        {nav.map((item) => {
          const active = pathname === item.href || pathname.startsWith(item.href + '/')
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                active ? 'text-white' : 'text-gray-400 hover:text-white'
              }`}
              style={active ? { background: '#00AAFF' } : {}}
            >
              <span>{item.icon}</span>
              {item.label}
            </Link>
          )
        })}
      </nav>
      <div className="px-4 py-4 space-y-2" style={{ borderTop: '1px solid #1a2540' }}>
        {userEmail && (
          <div className="px-2 py-1.5">
            <p className="text-xs text-gray-500 truncate">{userEmail}</p>
          </div>
        )}
        <button
          onClick={handleLogout}
          className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-gray-400 hover:text-white hover:bg-gray-700/50 transition"
        >
          <span>🚪</span> Sign Out
        </button>
        <p className="text-xs text-gray-600 px-2">ShipoLLC © 2025</p>
      </div>
    </aside>
  )
}
