// Do we hold this partner's W-9?
//
// src/components/partner/Statement.tsx tells every partner, in writing,
// "We can only pay once we hold your completed W-9 or W-8 form." Until
// referral_partners.w9_received_at existed that promise was kept by
// memory, and the failure runs one way only: pay first, and we are left
// owing the IRS a 1099-NEC we have no taxpayer identification number to
// file it with.
//
// The form itself is never stored here. The W-9 travels inside the same
// DocuSign envelope as the agreement and stays in DocuSign's vault; what
// this system records is a timestamp saying it came back. The TIN is
// kept OUT of our database by src/lib/docusign-redact.ts.

/**
 * The envelope custom field the sender sets, and the webhook reads, to
 * say this envelope carries a W-9.
 *
 * Both sides import these two constants rather than spelling the
 * strings out, because this is the same drift that would silently break
 * the agreement gate: rename it on one side and every W-9 we receive is
 * recorded as not received — a failure nobody notices until a partner
 * is told we cannot pay them.
 */
export const W9_CUSTOM_FIELD = 'w9'

/** The value of that field when a W-9 is attached. */
export const W9_INCLUDED = 'included'

export interface W9Candidate {
  w9_received_at?: string | null
}

/** True only on evidence. Absent means absent, never "probably fine". */
export function holdsW9(partner: W9Candidate): boolean {
  return Boolean(partner.w9_received_at)
}

/**
 * null when the partner may be paid; otherwise a sentence for a human.
 *
 * Separate from portalAccessBlockedReason on purpose. Signing the
 * agreement opens the PORTAL; the W-9 opens PAYMENT. A partner can
 * legitimately be in the portal reading a statement while we are not
 * yet able to pay them, and collapsing the two would either lock them
 * out of their own numbers or pay them without a TIN.
 */
export function payoutBlockedReason(partner: W9Candidate): string | null {
  if (!holdsW9(partner)) {
    return 'No W-9 on file. We cannot pay this partner until they complete one — it is page 2 of the agreement envelope, so re-sending the agreement collects it.'
  }
  return null
}

/**
 * Why this partner cannot be paid yet, as a key rather than a sentence.
 *
 * Same shape as `AccessBlock` in partner-access.ts, and for the same reason:
 * one function decides, two maps phrase it, and `Record<W9Block, string>`
 * makes a missing phrasing a compile error. The dangerous direction is
 * specific — a blocking state added to the staff copy and forgotten in the
 * partner copy is not a wrong message, it is a partner staring at a screen
 * that will not tell him what is wrong.
 *
 * A ONE-MEMBER UNION IS NOT REDUNDANT HERE. It looks like ceremony around a
 * single boolean, and what it buys is that the second blocking state — a
 * W-8 path for a non-US person, an expired certification, a TIN mismatch
 * from the IRS — cannot be added to `payoutBlockedReason` without the
 * compiler demanding the partner-facing sentence too. Collapsing it to a
 * boolean is the edit that makes that silent.
 */
export type W9Block = 'not_held'

/** null when the partner may be paid; otherwise which rule stopped it. */
export function w9Block(partner: W9Candidate): W9Block | null {
  // Delegates to holdsW9 rather than re-reading the field. A second
  // predicate is how the payout check and the dashboard gate come to
  // disagree about what "absent" means.
  return holdsW9(partner) ? null : 'not_held'
}

/**
 * Addressed to the partner, in the dashboard, where they can act on it.
 *
 * The staff sentence names page 2 of the agreement envelope and tells
 * somebody to re-send it. Handed to a partner, that is an instruction aimed
 * at Shipo: he cannot re-send himself an envelope, and reading it leaves him
 * waiting for us while we wait for him. So this says what HE does next, and
 * says why, because "we cannot pay you" with no reason reads as a dispute
 * rather than as paperwork.
 *
 * IT MUST BE TRUE ABOUT THE SCREEN IT IS PRINTED ON. This sentence once
 * ended "nothing else about your account is waiting on it", which was
 * accurate while the W-9 gated PAYMENT alone. It now gates the whole
 * dashboard — src/app/partner/page.tsx returns <W9Gate /> INSTEAD of
 * <Statement />, so the partner reading this has no client roster, no
 * commission window and no figures on the page. A reassurance that the rest
 * of his account is unaffected, printed on the screen withholding all of
 * it, is the one sentence every blocked partner reads and it was false.
 *
 * So it names what the form unlocks. Not as a threat — as the connection
 * between the empty screen and the one thing that fills it, which is the
 * only reason he has to prioritise a tax form.
 */
const PARTNER_REASON: Record<W9Block, string> = {
  not_held:
    'Before we can pay you, the IRS needs us to hold a completed W-9 for you — it is one short form with your legal name, address and taxpayer ID. Sign it here and your clients, your commission window and your monthly figures all open up, and your commission starts accruing straight away.',
}

/** null when the partner may be paid; otherwise a sentence for the partner. */
export function w9PartnerMessage(partner: W9Candidate): string | null {
  const block = w9Block(partner)
  return block ? PARTNER_REASON[block] : null
}

/** Short label for the W-9 column. */
export function w9Label(partner: W9Candidate): { text: string; tone: 'good' | 'bad' } {
  return holdsW9(partner) ? { text: 'on file', tone: 'good' } : { text: 'missing', tone: 'bad' }
}
