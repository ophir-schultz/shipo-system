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

/** Short label for the W-9 column. */
export function w9Label(partner: W9Candidate): { text: string; tone: 'good' | 'bad' } {
  return holdsW9(partner) ? { text: 'on file', tone: 'good' } : { text: 'missing', tone: 'bad' }
}
