'use client'

import { useState } from 'react'
import Sidebar from '@/components/layout/Sidebar'

// Staff chrome. The sidebar stays a column on a desktop. On a phone it
// is a menu, so the numbers are not squeezed into the space beside it.
export default function StaffShell({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="flex min-h-screen bg-white text-[#0B1220]">
      <div className={open
        ? 'fixed inset-0 z-40 flex max-md:w-screen md:static md:inset-auto md:z-auto'
        : 'hidden w-0 max-md:hidden md:flex md:w-60'}>
        {open ? (
          <button
            type="button"
            aria-label="Close menu"
            className="absolute inset-0 bg-black/40 md:hidden"
            onClick={() => setOpen(false)}
          />
        ) : null}
        <div className="relative z-10 h-full md:h-auto">
          <Sidebar onNavigate={() => setOpen(false)} />
        </div>
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-[#E2E8F0] bg-white px-4 py-3 md:hidden">
          <button
            type="button"
            aria-label="Open menu"
            onClick={() => setOpen(true)}
            className="rounded-lg border border-[#CBD5E1] px-3 py-2 text-sm font-semibold text-[#0B1220]"
          >
            Menu
          </button>
          <span className="text-sm font-semibold">Shipo</span>
        </header>
        <main className="staff-main w-full min-w-0 max-w-full flex-1 overflow-x-hidden p-4 md:overflow-x-auto md:p-8">{children}</main>
      </div>
    </div>
  )
}
