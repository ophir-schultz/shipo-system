import { redirect } from 'next/navigation'
import { getPartnerFromSession } from '@/lib/partner-auth'
import { supabaseAdmin } from '@/lib/supabase'
import {
  needsAcceptance,
  PARTNER_TERMS_SECTIONS,
  PARTNER_TERMS_VERSION,
} from '@/lib/partner-terms'
import TermsGate from '@/components/partner/TermsGate'
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

  // NO W-9 GATE HERE, AND ITS REMOVAL IS THE POINT.
  //
  // This file used to return <W9Gate /> INSTEAD of <Statement /> for a
  // partner whose W-9 we do not hold. Two gates stood between a new
  // partner and anything he could use, and only one of them is a
  // condition of having a partnership at all:
  //
  //   the AGREEMENT opens the portal — enforced at login by
  //   portalAccessBlock, so an unsigned partner never reaches this page;
  //
  //   the W-9 opens PAYMENT, and nothing else. It is a tax form, not a
  //   term of the deal. A partner who has signed and been linked to
  //   clients can read his roster, see his commission window and file a
  //   claim before he has ever opened a tax form, and his commission
  //   accrues while he does.
  //
  // Collapsing the two meant the first thing a brand-new partner saw was
  // a request for his taxpayer ID, with no clients, no figures and
  // nothing else on the page to tell him the partnership was real.
  //
  // THE TIN REQUEST IS STILL BEHIND THE DISCLAIMER (§2.1), transitively:
  // the W-9 prompt now lives inside <Statement>, which is constructed
  // only below the acceptance gate above. src/lib/partner-terms.test.ts
  // asserts that ordering, and src/lib/partner-w9.test.ts asserts that
  // the W-9 screen has not reappeared here as an early return.
  //
  // <Statement> withholds the money surfaces itself, from the same
  // `holdsW9` predicate /referrals asks, so the dashboard and the payout
  // path cannot disagree about what "absent" means.
  return <Statement partner={partner} />
}
