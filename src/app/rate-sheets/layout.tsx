import type { Metadata } from 'next'

// A prospect-facing commercial document, not part of the staff app:
// no sidebar, no internal navigation, and a light palette rather than
// the ops dark theme — this page is meant to be read by a stranger and
// printed to PDF, and #0a0f1a prints as a sheet of solid ink.
export const metadata: Metadata = {
  title: 'Fulfillment Rate Sheet — Shipo LLC',
  // Pricing prepared for one named prospect. Never indexed, and
  // nocache so it does not sit in a search engine's copy after the
  // quote expires.
  robots: { index: false, follow: false, nocache: true },
}

export default function RateSheetLayout({ children }: { children: React.ReactNode }) {
  return <div className="min-h-screen bg-white text-slate-900">{children}</div>
}
