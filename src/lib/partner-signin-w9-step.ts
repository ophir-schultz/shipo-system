import { holdsW9, type W9Candidate } from './partner-w9'
import { taxStatusOf } from './partner-tax-status'

// The W-9 that follows the agreement. Spec §2.3.
//
// =====================================================================
// WHAT §2.3 ASKS FOR, AND WHY THIS IS A PROMPT RATHER THAN AN ENVELOPE
//
// The spec says the W-9 follows automatically once the agreement is
// signed, and reads as though the completion webhook should build and
// send the envelope. It cannot.
//
// THE W-9 ENVELOPE IS EMBEDDED. buildW9Envelope sets a clientUserId,
// /api/partner/w9-sign promotes the draft to 'sent' and then calls
// createRecipientView to mint a signing URL — DocuSign will not produce
// one for a draft, and it mints it for whoever is on the screen right
// now. An envelope created by a webhook is addressed to nobody: there
// is no browser to hand the URL to, and the embedded recipient is not
// emailed by design.
//
// AND A SECOND ENVELOPE IS A SECOND TAXPAYER NUMBER. There is no
// w9_envelope_id column and no in-flight state anywhere —  holdsW9 is
// `w9_received_at != null` and nothing else. So an envelope minted by
// the webhook would be invisible to the dashboard, which would go on
// offering its own button, and the partner would be collected from
// twice. That is the exact condition w9SignRefusal's 409 exists to
// prevent.
//
// So the automatic part is the PROMPT, not the paperwork. The email
// that carries him into the portal the moment he signs also tells him
// what is waiting for him there — because without it he arrives
// expecting his statement and meets a tax form instead, with no idea
// whether it is routine or a problem with his account.
//
// THIS FUNCTION IS SILENT MORE OFTEN THAN IT SPEAKS, and the silence
// is the part worth reading. Three of four cases say nothing.
// =====================================================================

export interface W9StepCandidate extends W9Candidate {
  /** For the staff log. A condition staff must fix names the row. */
  id: string
  /** Null, blank or unrecognised all mean "not recorded". Never guessed. */
  tax_status?: string | null
}

export interface W9StepDecision {
  /**
   * Empty strings when the email says nothing about the W-9 — empty and
   * not null, so the caller concatenates unconditionally rather than
   * leaving a dangling heading behind a conditional it got wrong.
   */
  lines: { text: string; html: string }
  /** Staff-facing, or null when the silence is nobody's bug. */
  log: string | null
}

const SILENT = { text: '', html: '' }

/**
 * WHAT THIS PARAGRAPH IS CAREFUL ABOUT.
 *
 * It names the dashboard. "We need a W-9 from you" with no location is
 * an instruction he cannot carry out, and the obvious guess — reply to
 * this email with the form — is the one action that must never happen,
 * because the whole point of signing inside DocuSign is that the number
 * never touches our mail, our logs or our database.
 *
 * It names no amount and no client. This email is delivered before the
 * partner has ever opened the portal and travels through infrastructure
 * Shipo does not own; the W-9 is the one subject in it that invites a
 * figure.
 *
 * It does not say "that is all you need to do". The 6-digit code in the
 * same message is the fallback for every way a link can fail, and a
 * partner told the rest was unnecessary, who then meets a dead link, has
 * been told the only remaining way in does not apply to him.
 */
const W9_STEP = {
  text:
    `One thing is waiting for you inside: before we can pay you, the IRS needs us to hold a completed W-9 for you.\n\n` +
    `You sign it in your dashboard — legal name, address and taxpayer ID, typed straight into DocuSign, so none of it has to travel by email.\n\n`,
  html:
    `<p style="margin:0 0 8px">One thing is waiting for you inside: before we can pay you, the IRS needs us to hold a completed W-9 for you.</p>` +
    `<p style="margin:0 0 24px;color:#555">You sign it in your dashboard &mdash; legal name, address and taxpayer ID, typed straight into DocuSign, so none of it has to travel by email.</p>`,
}

/**
 * What the sign-in email says about the W-9, and what staff are told.
 *
 * Decided from the partner row rather than from which path sent the
 * email, so the webhook's copy, the staff invite and a partner's own
 * login request all say the same thing about the same partner. A
 * partner who gets a different-looking email depending on which path
 * fired cannot tell the automated one from a phishing attempt.
 *
 * REQUIRES THE TWO COLUMNS TO HAVE BEEN SELECTED. An unselected column
 * arrives as undefined, and undefined w9_received_at reads as "no W-9
 * on file" — which would nag a partner who already gave us his taxpayer
 * number into giving it again. See SIGN_IN_EMAIL_COLUMNS in
 * partner-signin-email.ts, which is why no caller writes its own list.
 */
export function w9NextStep(partner: W9StepCandidate): W9StepDecision {
  // Already done. Delegated to holdsW9 rather than re-reading the
  // column: a second predicate is how the dashboard gate and this
  // message come to disagree about what "absent" means, and the
  // disagreement that matters here tells a partner who has signed that
  // we never received it.
  if (holdsW9(partner)) return { lines: SILENT, log: null }

  const status = taxStatusOf(partner.tax_status)

  if (status === 'us_person') return { lines: W9_STEP, log: null }

  if (status === null) {
    // Not his problem and not his to fix, so he is told nothing and the
    // ordinary email goes out unchanged. /api/partner/w9-sign refuses
    // this partner, so a promise here would point him at a locked door
    // — Shipo's unfinished record-keeping presented as his next step.
    return {
      lines: SILENT,
      log:
        `partner ${partner.id} has no recorded tax_status, so the sign-in email said nothing ` +
        'about the W-9 — the dashboard form would refuse him. Record it on /referrals.',
    }
  }

  // Foreign: the IRS wants a W-8BEN or a W-8BEN-E, and Shipo builds
  // neither. Naming the form matters — "not a W-9 case" sends whoever
  // reads this away to look it up.
  const form = status === 'foreign_individual' ? 'W-8BEN' : 'W-8BEN-E'
  return {
    lines: SILENT,
    log:
      `partner ${partner.id} is recorded as ${status}, so the IRS form is a ${form}, not a W-9. ` +
      'Shipo builds no W-8 envelope — collect it outside the portal.',
  }
}
