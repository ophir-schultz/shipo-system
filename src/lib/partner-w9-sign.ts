// Everything that has to be true before Shipo sends a partner a W-9.
//
// This is the only send the application performs. The agreement goes out
// by hand from a script, reviewed as a draft first; this one is triggered
// by a partner clicking a button in his own dashboard, with nobody
// watching. That is the reason the refusals are a pure function here
// rather than four early returns in the route: each one is wrong in a
// different expensive way, and none of them can be exercised by a test
// that must stand up a session and a DocuSign account first.
//
//   already on file  a second envelope is a second taxpayer
//                    identification number collected from one person
//   foreign partner  the IRS wants a W-8BEN or a W-8BEN-E, and sending a
//                    W-9 produces a form that is void on arrival
//   no accountant    a tax form that reaches nobody, which everyone
//                    downstream believes was delivered (spec 2a.5)
//   no credentials   nothing happens, and the partner must be told so in
//                    words he can act on
//
// THE PARTNER IS NOT THE AUDIENCE FOR OUR CONFIGURATION. Two of those are
// staff bugs; the partner's half of a staff bug is a way out of the
// screen, not a diagnosis. The staff half goes to `log`.

import { holdsW9 } from './partner-w9'
import { taxStatusOf } from './partner-tax-status'

/**
 * §2a.9.1. The sentence a partner gets when signing cannot happen —
 * shared, because the route returns it and W9Gate renders it, and the
 * version he acts on has to be the version we meant.
 *
 * It does not ask him to email anything back. The whole point of signing
 * inside DocuSign is that the number never touches our mail, our logs or
 * our database, and "email us your W-9" undoes that in one sentence.
 */
export const W9_SIGN_FALLBACK =
  'We cannot open the W-9 form right now. Email Support@shipousa.com and we will send it to you directly — your statement is not affected.'

export interface W9SignPartner {
  id: string
  name: string
  email: string | null
  /** Null, blank or unrecognised all mean "not recorded". Never guessed. */
  tax_status?: string | null
  w9_received_at?: string | null
}

export interface W9SignContext {
  /** Null when there is no valid session. */
  partner: W9SignPartner | null
  accountantEmail: string | null | undefined
  accountantName: string | null | undefined
  /** Whether the app holds credentials that can reach the DocuSign API. */
  docusignConfigured: boolean
}

export interface W9SignRefusalResult {
  status: 401 | 409 | 502 | 503
  /** Partner-safe. Rendered on his screen verbatim. */
  message: string
  /** Staff-facing, or null when the refusal is nobody's bug. */
  log: string | null
}

const present = (v: string | null | undefined): boolean => typeof v === 'string' && v.trim() !== ''

/**
 * The form a partner should be filling in instead, in partner-voice.
 *
 * partner-tax-status.ts has the staff version of these sentences, which
 * says "this partner is recorded as" and tells the reader to go edit a
 * row. Handing that to the partner would read as an instruction he cannot
 * carry out, so the names of the forms are shared and the voice is not.
 */
function wrongFormMessage(taxStatus: string | null | undefined): string | null {
  const status = taxStatusOf(taxStatus)

  if (status === null) {
    // Deliberately vague: "we have no tax status on file for you" is a
    // description of our own record-keeping, and he cannot fix it.
    return (
      'We need to confirm one detail about your account before we can send your W-9. ' +
      'Email Support@shipousa.com and we will sort it out with you.'
    )
  }
  if (status === 'foreign_individual') {
    return (
      'The IRS form for your situation is a W-8BEN, not a W-9, and we cannot generate that here yet. ' +
      'Email Support@shipousa.com and we will send you the right form.'
    )
  }
  if (status === 'foreign_entity') {
    return (
      'The IRS form for your situation is a W-8BEN-E, not a W-9, and we cannot generate that here yet. ' +
      'Email Support@shipousa.com and we will send you the right form.'
    )
  }
  return null
}

/**
 * The refusal that applies, or null to proceed.
 *
 * ORDER IS LOAD-BEARING in one place. Who a partner is does not depend on
 * whether we have an accountant's address on file, so the wrong-form
 * refusal is decided BEFORE configuration. Reversed, a foreign partner is
 * told "try again later" forever while the real answer — we will never
 * send you a W-9 — stays invisible until somebody sets an environment
 * variable that has nothing to do with him.
 */
export function w9SignRefusal(ctx: W9SignContext): W9SignRefusalResult | null {
  const { partner, accountantEmail, accountantName, docusignConfigured } = ctx

  if (!partner) {
    return {
      status: 401,
      message: 'Your session has expired. Sign in again to open your W-9.',
      log: null,
    }
  }

  // Same predicate the gate on /partner opens on, not a second reading of
  // the column. Drift here means a partner whose statement is already
  // visible gets sent a second envelope.
  if (holdsW9(partner)) {
    return {
      status: 409,
      message: 'Your W-9 is already on file — there is nothing to sign. Reload this page for your statement.',
      log: null,
    }
  }

  // DocuSign addresses the recipient by email even when the recipient is
  // embedded, and matches the view request against the same address. A
  // blank one surfaces as a builder throw several frames later; here it
  // is an answer, with a log line somebody can act on.
  if (!present(partner.email)) {
    return {
      status: 409,
      message:
        'We do not have an email address on file for your account, which the form needs. ' +
        'Email Support@shipousa.com and we will add it.',
      log: `w9-sign: partner ${partner.id} has no email address on the row`,
    }
  }

  const wrongForm = wrongFormMessage(partner.tax_status)
  if (wrongForm) {
    return {
      status: 409,
      message: wrongForm,
      // Worth a line: either he is genuinely foreign and somebody has to
      // collect the right form by hand, or the column is wrong and a US
      // partner is being turned away from a form he needs.
      log: `w9-sign: refused partner ${partner.id} — tax status '${partner.tax_status ?? 'not recorded'}' is not a W-9 case`,
      }
  }

  // Both halves of the accountant, because buildW9Envelope demands both
  // and a carbon copy addressed to "" is not a delivery.
  const missing: string[] = []
  if (!present(accountantEmail)) missing.push('ACCOUNTANT_W9_EMAIL')
  if (!present(accountantName)) missing.push('ACCOUNTANT_W9_NAME')
  if (!docusignConfigured) missing.push('DOCUSIGN_* API credentials')

  if (missing.length > 0) {
    return {
      status: 503,
      message: W9_SIGN_FALLBACK,
      // Names the variables and nothing else. No row, no email address,
      // nothing TIN-shaped — this line lands in a log aggregator.
      log: `w9-sign: cannot send, not configured — missing ${missing.join(', ')}`,
    }
  }

  return null
}
