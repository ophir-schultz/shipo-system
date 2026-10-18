// May this partner be let into the portal yet?
//
// Asked in four places that must never disagree:
//
//   - the Referrals screen, to decide whether "Send invite" is live
//   - /api/referrals/portal-access, to decide whether to actually send
//   - /api/partner/request-code, to decide whether to mail a login code
//   - /api/partner/verify-code, to decide whether to issue a session
//
// A greyed-out button is a courtesy, not a control — anyone can POST to the
// route directly — so the routes are the things that enforce this and the
// button merely reflects it. Keeping the rule in one function is what stops
// them from drifting, which is the same failure that let the staff invite
// route carry its own stale copy of the invite email.
//
// The last two were added after a gap: for a while the rule was consulted
// ONLY on the staff invite. /partner/login is a public endpoint, so any
// address in referral_partners could have requested a code and signed in the
// moment an email provider was configured. "Signed before access" was being
// upheld by nobody having pressed the button yet, with email delivery as the
// de facto control — and a control that works because a feature is switched
// off is not a control.
//
// The order of the checks is the order a staff member can act on them: fix the
// email, then activate the partner, then get the agreement signed. Returning
// the FIRST problem rather than all of them is deliberate — a list of three
// faults reads as "this is broken", where one sentence reads as "do this next".

import { taxStatusOf } from './partner-tax-status'

/** The value the DocuSign webhook writes on envelope-completed. */
export const AGREEMENT_SIGNED = 'signed'

export interface AccessCandidate {
  name?: string | null
  email?: string | null
  status?: string | null
  agreement_status?: string | null
  /**
   * Read by invitePreconditionReason only. Absent is the same as unset,
   * which is the same as unrecognised — see taxStatusOf.
   */
  tax_status?: string | null
}

/**
 * Why this partner may not be in the portal, as a key rather than a sentence.
 *
 * The decision is separated from the wording because the same answer has to be
 * said twice in two different voices. Staff see "Reactivate them first", which
 * is an instruction. The partner sees "your access is paused", because telling
 * a partner to reactivate their own account names an action only Shipo can
 * take and reads as a brush-off.
 *
 * One function decides and two maps phrase it. The alternative — a second
 * function that re-states the conditions in partner language — is the drift
 * failure this module was written to avoid, and the dangerous direction is
 * specific: a blocking condition added to the staff copy and forgotten in the
 * login copy is not a wrong message, it is an OPEN DOOR. Record<AccessBlock,
 * string> makes a missing phrasing a compile error instead.
 */
export type AccessBlock = 'no_email' | 'inactive' | 'declined' | 'voided' | 'unsigned'

/**
 * null when the partner may be let in; otherwise which rule stopped them.
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
export function portalAccessBlock(partner: AccessCandidate): AccessBlock | null {
  if (!partner.email) return 'no_email'
  if (partner.status === 'inactive') return 'inactive'
  if (partner.agreement_status === 'declined') return 'declined'
  if (partner.agreement_status === 'voided') return 'voided'
  if (partner.agreement_status !== AGREEMENT_SIGNED) return 'unsigned'
  return null
}

/** Addressed to the staff member deciding whether to grant access. */
const STAFF_REASON: Record<AccessBlock, string> = {
  no_email: 'This partner has no email address. Add one first — the portal login is by email.',
  inactive: 'This partner is inactive, so they cannot sign in. Reactivate them first.',
  declined: 'This partner declined the agreement. Nothing can be shared until a new one is signed.',
  voided: 'This partner’s agreement was voided. Send a new one before granting access.',
  unsigned:
    'The partner agreement is not signed yet. The portal opens by itself the moment they finish signing.',
}

/**
 * Addressed to the partner standing at the login screen holding a valid code.
 *
 * Every one of these ends with something the partner can actually do, which is
 * either "finish signing" or "email us" — never an instruction aimed at Shipo
 * staff, and never a bare refusal. Support@shipousa.com appears in the three
 * cases a partner cannot resolve alone, because a dead end with no address is
 * how a signed partner quietly gives up.
 */
const PARTNER_REASON: Record<AccessBlock, string> = {
  // Unreachable in practice: a partner is found BY their email address, so a
  // row with none cannot be the one matched. Phrased anyway rather than left
  // to a non-null assertion, because "unreachable" is a claim about today's
  // query and the map must be total.
  no_email:
    'We cannot match this address to a partner record. Email Support@shipousa.com and we will sort it out.',
  inactive:
    'Your partner account is paused, so the portal is closed for now. Email Support@shipousa.com and we will look into it.',
  declined:
    'Our records show the partner agreement was declined, so there is nothing to show you yet. Email Support@shipousa.com and we will send a fresh one.',
  voided:
    'The partner agreement on file was cancelled before it was signed. Email Support@shipousa.com and we will send a new one.',
  unsigned:
    'Your partner agreement is not signed yet. Finish signing the DocuSign email we sent and the portal opens by itself — no second code needed.',
}

/** null when the partner may be invited; otherwise a sentence for staff. */
export function portalAccessBlockedReason(partner: AccessCandidate): string | null {
  const block = portalAccessBlock(partner)
  return block ? STAFF_REASON[block] : null
}

/** null when the partner may sign in; otherwise a sentence for the partner. */
export function portalAccessPartnerMessage(partner: AccessCandidate): string | null {
  const block = portalAccessBlock(partner)
  return block ? PARTNER_REASON[block] : null
}

/**
 * null when this partner may be SENT AN INVITE; otherwise a sentence for
 * staff. Checked in addition to portalAccessBlock, never instead of it.
 *
 * WHY THIS IS NOT AN AccessBlock. `referral_partners.tax_status` has no
 * default, so every partner added from today on starts with it unset —
 * and w9SignRefusal refuses to assemble a W-9 for a partner whose tax
 * status nobody recorded, deliberately vaguely, because our bookkeeping
 * is not his business. The ordinary path therefore ends with a partner
 * who cannot complete the one form standing between him and his money,
 * told to email support, over a dropdown nobody selected.
 *
 * This used to be worse and is still worth stopping. While the W-9 was a
 * full-page gate, an unset tax_status meant an EMPTY SCREEN: the partner
 * saw nothing but a refusal. The W-9 now withholds money alone, so he at
 * least has his roster and his claim form — but his commission still
 * cannot be paid, and he cannot fix it himself.
 *
 * The invite is the last moment we can prevent that, which is why the
 * rule lives here. It is deliberately NOT part of portalAccessBlock,
 * because that function is also consulted at login: adding it there would
 * throw out a partner who already holds a W-9 — stamped by the old
 * combined envelope — but whose tax_status was never recorded, taking
 * away a statement he is entitled to read. The cost of being wrong in
 * each direction is not the same, and it points the other way at login.
 *
 * A FOREIGN PARTNER MAY BE INVITED. He cannot be sent a W-9 and must not
 * be, but he has an agreement and the portal has a statement in it.
 * Refusing here would silently turn "we do not build W-8 envelopes yet"
 * into "you get no portal", which is a larger refusal than anybody
 * decided on.
 */
export function invitePreconditionReason(partner: AccessCandidate): string | null {
  // taxStatusOf, not a truthiness check on the column: unset and
  // unrecognised collapse to the same null there, and a value no human
  // chose must not read as recorded.
  if (taxStatusOf(partner.tax_status) === null) {
    return 'This partner has no tax status recorded. Set it in the partner editor on /referrals before inviting them — without it the portal opens on a W-9 we cannot generate, and the partner is told to email support.'
  }
  return null
}

/**
 * May this partner be in the portal at all?
 *
 * portalAccessBlock ONLY. This is the SESSION gate — partner-auth.ts calls
 * it on every request from getPartnerFromSession — so folding
 * invitePreconditionReason in here would sign out, mid-session, every
 * partner whose tax_status nobody has recorded, including ones whose W-9
 * is already on file. The invite precondition belongs to the invite; the
 * button asks for both separately.
 */
export function canAccessPortal(partner: AccessCandidate): boolean {
  return portalAccessBlock(partner) === null
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
    // 'not_sent' is the column DEFAULT in supabase/partner_onboarding.sql,
    // so it is the state most rows are actually in. Without this case it
    // fell to the default below and the screen read "not_sent", underscore
    // and all — a database value shown to a human.
    case 'not_sent':
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
