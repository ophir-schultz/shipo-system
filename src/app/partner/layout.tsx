import type { Metadata } from 'next'

// The partner portal is a separate surface from the staff app: no
// sidebar, no internal navigation, nothing that hints at the rest
// of the system.
export const metadata: Metadata = {
  title: 'Partner Statement — Shipo LLC',
  // Private per-partner financial data. Never indexed.
  robots: { index: false, follow: false, nocache: true },
}

export default function PartnerLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[#0a0f1a] text-white">
      <header className="border-b border-gray-800">
        <div className="mx-auto max-w-4xl px-6 py-5 flex items-baseline justify-between">
          <span className="text-lg font-semibold tracking-tight">Shipo LLC</span>
          <span className="text-xs uppercase tracking-widest text-gray-500">Partner Statement</span>
        </div>
      </header>
      <main className="mx-auto max-w-4xl px-6 py-8">{children}</main>
      <footer className="mx-auto max-w-4xl px-6 py-10 text-xs text-gray-600 leading-relaxed">
        <p>
          Questions about a figure on this page? Email{' '}
          <a href="mailto:Support@shipousa.com" className="text-gray-400 underline">
            Support@shipousa.com
          </a>{' '}
          within 30 days of receiving the statement.
        </p>
        <p className="mt-2">
          These figures are private to your account. Shipo LLC · 310 Cornell Dr, Suite B4, Wilmington, DE 19801
        </p>
      </footer>
    </div>
  )
}
