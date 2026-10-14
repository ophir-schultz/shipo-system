import { redirect } from 'next/navigation'
import { getPartnerFromSession } from '@/lib/partner-auth'
import { supabaseAdmin } from '@/lib/supabase'
import {
  needsAcceptance,
  PARTNER_TERMS_SECTIONS,
  PARTNER_TERMS_VERSION,
} from '@/lib/partner-terms'
import { holdsW9 } from '@/lib/partner-w9'
import TermsGate from '@/components/partner/TermsGate'
import W9Gate from '@/components/partner/W9Gate'
import Statement from '@/components/partner/Statement'

export const dynamic = 'force-dynamic'

// The partner statement, gated on a partner session cookie.
//
// This is NOT a Supabase Auth session. A partner can never satisfy
// the staff check in src/proxy.ts, so this page cannot become a way
// into /dashboard, /clients or /billing.
//
// ORDER IS LOAD-BEARING (spec §2.1). The acceptance check runs before
// <Statement> is constructed, and `loadPartnerLedger` is called inside
// <Statement> -- so an unaccepted partner's request never touches
// partner_client_monthly. A gate that fetches the data it is gating is
// not a gate. src/lib/partner-terms.test.ts asserts this ordering over
// this file's source text, because vitest cannot cover a .tsx.

export default async function PartnerPage() {
  const partner = await getPartnerFromSession()
  if (!partner) redirect('/partner/login')

  const { data: acceptances, error } = await supabaseAdmin
    .from('partner_terms_acceptances')
    .select('terms_version')
    .eq('referral_partner_id', partner.id)

  // A FAILED READ MUST GATE, NOT PASS. On an unreadable acceptance
  // table the two options are "show the statement to someone who may
  // never have agreed to the terms" and "ask them to agree again".
  // Only the first has a legal consequence, so `error` falls through to
  // the gate with an empty list: a re-prompt is an annoyance, and the
  // acceptance route is idempotent, so a partner who HAD accepted just
  // accepts again and writes no second row.
  if (error || needsAcceptance(acceptances ?? [])) {
    return <TermsGate sections={PARTNER_TERMS_SECTIONS} version={PARTNER_TERMS_VERSION} />
  }

  // SECOND, never first. The W-9 screen leads to a form carrying a legal
  // name, an address and a taxpayer ID; the disclaimer above is where the
  // partner is told what we do with what he gives us. Asking for a TIN
  // before he has read that is what §2.1's ordering prevents.
  //
  // No new read: w9_received_at rides on the select getPartnerFromSession
  // already performs. `holdsW9` is the one predicate — the payout check in
  // /referrals asks the same function, so the dashboard and the money path
  // cannot come to disagree about what "absent" means.
  if (!holdsW9(partner)) {
    return <W9Gate partner={partner} />
  }

  return <Statement partner={partner} />
}
