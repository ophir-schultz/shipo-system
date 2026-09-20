import { redirect } from 'next/navigation'
import { getPartnerFromSession } from '@/lib/partner-auth'
import PartnerLoginForm from '@/components/partner/LoginForm'

export const dynamic = 'force-dynamic'

export default async function PartnerLoginPage() {
  // Already signed in — no reason to show the form again.
  const partner = await getPartnerFromSession()
  if (partner) redirect('/partner')

  return <PartnerLoginForm />
}
