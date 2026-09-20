import { redirect } from 'next/navigation'
import { getPartnerFromSession } from '@/lib/partner-auth'
import Statement from '@/components/partner/Statement'

export const dynamic = 'force-dynamic'

// The partner statement, gated on a partner session cookie.
//
// This is NOT a Supabase Auth session. A partner can never satisfy
// the staff check in src/proxy.ts, so this page cannot become a way
// into /dashboard, /clients or /billing.

export default async function PartnerPage() {
  const partner = await getPartnerFromSession()
  if (!partner) redirect('/partner/login')

  return <Statement partner={partner} />
}
