import { redirect } from 'next/navigation'
import { getPartnerFromSession } from '@/lib/partner-auth'
import { linkTokenFromQuery, LINK_PARAM } from '@/lib/partner-login-link'
import PartnerSignInLink from '@/components/partner/SignInLink'

// The page the emailed sign-in link lands on. Spec §2.1.
//
// ============================================================
// THIS PAGE SIGNS NOBODY IN, AND THAT IS THE WHOLE POINT.
//
// It reads a token out of the query string and hands it to a button.
// It does not hash it, does not look it up, does not consume it and
// does not mint a session. Every one of those happens in the POST the
// button makes.
//
// The reason is that nobody controls who fetches a URL in an email.
// Defender, Proofpoint, Gmail's proxy, iOS Mail's link preview and
// every corporate security gateway open links in messages before a
// human does. If redemption happened during render, the first fetch
// would spend the credential, and the partner's first contact with his
// own portal would be "this link has expired" — with nothing in the
// logs to distinguish that from an attack.
//
// src/lib/partner-login-link.test.ts asserts over this file's SOURCE
// that it names neither the database client, nor the credentials
// table, nor the session minter — the three literals are deliberately
// not repeated here, because the check strips comments and prose that
// quoted them would read like the very code it forbids. A server
// component that redeemed the token during render would be a GET login
// wearing a page's clothes, and that is what the assertions stop.
// ============================================================

export const dynamic = 'force-dynamic'

export default async function PartnerSignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  // Already signed in. Clicking a week-old link from a mailbox on a
  // device that still has a session should land him on his statement,
  // not ask him to redeem a credential he no longer needs — and
  // crucially should not BURN that credential, which a POST would.
  const partner = await getPartnerFromSession()
  if (partner) redirect('/partner')

  // Shape-checked HERE as well as in the route. Not belt-and-braces:
  // `?t=a&t=b` arrives as an array and `?t=` as an empty string, and
  // either one would otherwise be rendered into a button that POSTs
  // garbage and comes back refused. Knowing now that there is no
  // usable token lets the page say so instead of staging a click that
  // cannot succeed.
  const params = await searchParams
  const token = linkTokenFromQuery(params[LINK_PARAM])

  return <PartnerSignInLink token={token} />
}
