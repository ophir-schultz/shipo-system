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
// site's `header-bar` is #0b3361. The asset is white ink on transparency,
// so on the white page body it would render as nothing at all. The navy
// bar is what makes it visible.
//
// THIS IS THE REAL ASSET NOW. It used to be public/shipo-logo.svg: 594
// bytes of hand-written SVG setting the word "Shipo" in Arial Black
// italic with two straight rules beneath it. Shipo's actual wordmark has
// custom letterforms and an angled underline, so that was a drawing OF
// the logo, not the logo -- and every test passed, because they asked
// whether the file was referenced and whether it was white, never whose
// mark it was.
//
// public/shipo-logo.png is wp-content/uploads/2021/07/white-transparent-
// bg.png, trimmed of transparent padding: 514x500 of which 322x122 is
// ink, so untrimmed it renders as a stamp in the middle of its own box.
// 111x42 is that 2.639 ratio; the old 120x42 was 2.857 and stretched it.
// Pinned in src/lib/partner-brand.test.ts.
export default function PartnerLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="partner-theme min-h-screen">
      {/* The lime rule is the site's own header treatment, not decoration:
          shipousa.com sets border-bottom 5px solid #e0ee47 on
          .ast-primary-header-bar, and --brand-accent already holds that
          hex. The width is read off that stylesheet rather than chosen —
          4px or 6px would each look right in isolation, which is exactly
          how a brand detail drifts. The site gates the rule at >=922px;
          the portal shows it at every width, because the stripe is the
          part a partner recognises and the layout is one narrow column
          on a phone either way. */}
      <header className="bg-[var(--brand-ink)] border-b-[5px] border-[var(--brand-accent)]">
        <div className="mx-auto max-w-4xl px-6 py-4 flex items-center justify-between gap-4">
          <a href="https://shipousa.com" className="shrink-0">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/shipo-logo.png" alt="Shipo" width={111} height={42} />
          </a>
          <span className="text-xs font-bold uppercase tracking-widest text-[#0B1220]">
            Partner Portal
          </span>
        </div>
      </header>
      <main className="mx-auto max-w-4xl px-6 py-8">{children}</main>
      <footer className="mx-auto max-w-4xl px-6 py-10 mt-8 text-xs text-[#6B7A8D] leading-relaxed border-t border-[var(--brand-surface)]">
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
