// May this partner be let into the portal yet?
//
// Asked in two places that must never disagree: the Referrals screen, to
// decide whether the "Send invite" button is live, and /api/referrals/portal-
// access, to decide whether to actually send. A greyed-out button is a
// courtesy, not a control — anyone can POST to the route directly — so the
// route is the thing that enforces this and the button merely reflects it.
// Keeping the rule in one function is what stops the two from drifting, which
// is the same failure that let the staff invite route carry its own stale copy
// of the invite email.
//
// The order of the checks is the order a staff member can act on them: fix the
// email, then activate the partner, then get the agreement signed. Returning
// the FIRST problem rather than all of them is deliberate — a list of three
// faults reads as "this is broken", where one sentence reads as "do this next".

/** The value the DocuSign webhook writes on envelope-completed. */
export const AGREEMENT_SIGNED = 'signed'

export interface AccessCandidate {
  name?: string | null
  email?: string | null
  status?: string | null
  agreement_status?: string | null
}

/**
 * null when the partner may be invited; otherwise a sentence for a human.
 *
 * The agreement check is why this exists. Shipo's rule is that the agreement
 * is signed BEFORE access, which means the ordering has to be enforced
 * somewhere other than the memory of whoever is clicking. A partner reaching
 * their statement before signing would be reading commission figures under
 * terms they have not agreed to, and the figures are confidential under
 * Section 6 of the agreement itself.
 *
 * A NULL agreement_status is treated as not signed. Every row predating the
 * DocuSign flow carries NULL, so if this ever ran against such rows it would
 * lock out people already working with us — measured at the time of writing:
 * referral_partners held 0 rows, so the gate locks out nobody today. If a
 * partner ever signs on paper, the remedy is to set agreement_status to
 * 'signed' deliberately, which is a recorded act rather than a silent default.
 */
export function portalAccessBlockedReason(partner: AccessCandidate): string | null {
  if (!partner.email) {
    return 'This partner has no email address. Add one first — the portal login is by email.'
  }
  if (partner.status === 'inactive') {
    return 'This partner is inactive, so they cannot sign in. Reactivate them first.'
  }
  if (partner.agreement_status === 'declined') {
    return 'This partner declined the agreement. Nothing can be shared until a new one is signed.'
  }
  if (partner.agreement_status === 'voided') {
    return 'This partner’s agreement was voided. Send a new one before granting access.'
  }
  if (partner.agreement_status !== AGREEMENT_SIGNED) {
    return 'The partner agreement is not signed yet. The portal opens by itself the moment they finish signing.'
  }
  return null
}

/** Convenience for the UI: can the invite button be live? */
export function canAccessPortal(partner: AccessCandidate): boolean {
  return portalAccessBlockedReason(partner) === null
}

/** Short label for the Agreement column. Never invents a state it was not given. */
export function agreementLabel(agreementStatus?: string | null): {
  text: string
  tone: 'good' | 'bad' | 'wait'
} {
  switch (agreementStatus) {
    case AGREEMENT_SIGNED:
      return { text: 'signed', tone: 'good' }
    case 'declined':
      return { text: 'declined', tone: 'bad' }
    case 'voided':
      return { text: 'voided', tone: 'bad' }
    case 'sent':
      return { text: 'out for signature', tone: 'wait' }
    case null:
    case undefined:
    case '':
      return { text: 'not sent', tone: 'wait' }
    default:
      // An unrecognised value is shown as itself rather than mapped to a
      // friendly word. Guessing here would let a new webhook state render as
      // something reassuring that it is not.
      return { text: agreementStatus, tone: 'wait' }
  }
}
