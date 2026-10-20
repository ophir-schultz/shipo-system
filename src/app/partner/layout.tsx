import type { Metadata } from 'next'

// The partner portal is a separate surface from the staff app: no
// sidebar, no internal navigation, nothing that hints at the rest
// of the system.
export const metadata: Metadata = {
  title: 'Partner Statement — Shipo LLC',
  // Private per-partner financial data. Never indexed.
  robots: { index: false, follow: false, nocache: true },
}

// WHITE LOGO ON A NAVY BAR IS THE SITE'S OWN TREATMENT, NOT A CHOICE.
// The only logo shipousa.com serves is `white-transparent-bg.png`, and the
// site's `header-bar` is #0b3361. public/shipo-logo.svg is likewise
// fill="white" -- so placing it on the white page body would render it as
// nothing at all. The navy bar is what makes the asset visible.
export default function PartnerLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="partner-theme min-h-screen">
      <header className="bg-[var(--brand-ink)]">
        <div className="mx-auto max-w-4xl px-6 py-4 flex items-center justify-between gap-4">
          <a href="https://shipousa.com" className="shrink-0">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/shipo-logo.svg" alt="Shipo" width={120} height={42} />
          </a>
          <span className="text-xs uppercase tracking-widest text-white/80">
            Partner Portal
          </span>
        </div>
      </header>
      <main className="mx-auto max-w-4xl px-6 py-8">{children}</main>
      <footer className="mx-auto max-w-4xl px-6 py-10 mt-8 text-xs text-gray-600 leading-relaxed border-t border-[var(--brand-surface)]">
        <p>
          Questions about a figure on this page? Email{' '}
          <a
            href="mailto:Support@shipousa.com"
            className="text-[var(--brand-action)] underline"
          >
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
