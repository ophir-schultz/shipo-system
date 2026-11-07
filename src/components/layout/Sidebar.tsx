'use client'

import Link from 'next/link'
import Image from 'next/image'
import { usePathname, useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase-browser'
import { STAFF_NAV, STAFF_SETTINGS, type StaffNavItem } from '@/lib/staff-nav'

function activeItem(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`)
}

function ItemLink({ item, pathname, onNavigate }: { item: StaffNavItem; pathname: string; onNavigate?: () => void }) {
  const active = activeItem(pathname, item.href)
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      className={`block px-3 py-1.5 rounded-lg text-sm ${active ? 'text-white' : 'hover:text-white'}`}
      style={active
        ? { background: 'linear-gradient(135deg, #1A73E8, #0B5ED7)' }
        : { color: '#C7D8F0' }}
    >
      {item.label}
    </Link>
  )
}

export default function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname()
  const router = useRouter()
  const [userEmail, setUserEmail] = useState<string | null>(null)
  const settingsOpen = STAFF_SETTINGS.some((item) => activeItem(pathname, item.href))

  useEffect(() => {
    try {
      const supabase = createClient()
      supabase.auth.getUser().then(({ data }) => {
        setUserEmail(data.user?.email ?? null)
      }).catch(() => setUserEmail(null))
    } catch {
      setUserEmail(null)
    }
  }, [])

  async function handleLogout() {
    const supabase = createClient()
    await supabase.auth.signOut()
    router.push('/login')
    router.refresh()
  }

  return (
    <aside className="flex h-screen w-60 shrink-0 flex-col md:h-auto md:min-h-screen" style={{ background: 'linear-gradient(165deg, #081A33 0%, #0B3361 55%, #0F4A94 100%)', borderRight: '1px solid #0B3361' }}>
      <div className="px-5 py-4" style={{ borderBottom: '1px solid rgba(255,255,255,0.14)' }}>
        <div className="px-1 py-2 mb-1">
          <Image src="/shipo-logo-white.png" alt="Shipo" width={322} height={122} className="w-full h-auto" priority />
        </div>
        <div style={{ height: '4px', borderRadius: '2px', background: '#E0EE47', margin: '6px 2px 0' }} />
        <p className="text-xs text-center mt-2" style={{ color: '#C7D8F0' }}>Operations Platform</p>
      </div>
      <nav className="flex-1 px-3 py-4 space-y-2 overflow-auto">
        {STAFF_NAV.map((group) => {
          const open = group.items.some((item) => activeItem(pathname, item.href))
          return (
            <details key={group.id} open={open} className="rounded-lg">
              <summary className="cursor-pointer px-3 py-2 text-sm font-semibold text-white">{group.label}</summary>
              <div className="pb-1">
                {group.items.map((item) => <ItemLink key={item.href} item={item} pathname={pathname} onNavigate={onNavigate} />)}
              </div>
            </details>
          )
        })}
      </nav>
      <div className="px-4 py-4 space-y-2" style={{ borderTop: '1px solid rgba(255,255,255,0.14)' }}>
        <details open={settingsOpen}>
          <summary className="cursor-pointer px-2 py-1 text-xs font-semibold" style={{ color: '#C7D8F0' }}>Settings</summary>
          <div className="pt-1">
            {STAFF_SETTINGS.map((item) => <ItemLink key={item.href} item={item} pathname={pathname} onNavigate={onNavigate} />)}
          </div>
        </details>
        {userEmail && (
          <div className="px-2 py-1.5">
            <p className="text-xs text-gray-500 truncate">{userEmail}</p>
          </div>
        )}
        <button
          onClick={handleLogout}
          className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-[#C7D8F0] hover:text-white hover:bg-white/10 transition"
        >
          Sign Out
        </button>
        <p className="text-xs text-gray-600 px-2">Shipo LLC © 2026</p>
      </div>
    </aside>
  )
}
