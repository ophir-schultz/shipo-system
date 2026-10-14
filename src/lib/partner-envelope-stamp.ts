// What a completed DocuSign envelope is allowed to stamp on a partner row.
//
// Task 7 split one envelope into two, so the webhook now receives
// completions that mean entirely different things:
//
//   the AGREEMENT completed  -> the partner is signed, and may log in
//   the W-9 completed        -> we hold their tax form, and may be paid
//
// The decision lives here, as a pure function, because inline in the
// webhook it could only be checked by sending a real envelope. See
// partner-envelope-stamp.test.ts for what each conflation costs.

import { W9_CUSTOM_FIELD, W9_INCLUDED } from './partner-w9'

/**
 * The DocuSign custom field that says WHICH envelope this is.
 *
 * A positive marker, not an inference. The obvious discriminator — "does
 * it carry the w9 field?" — cannot work: the combined envelope we already
 * sent carries that field AND is an agreement, so the inference would
 * read it as a W-9 and never activate its partner.
 *
 * Shared with the builder in docusign-envelope.ts; see the test that pins
 * both constants.
 */
export const ENVELOPE_KIND_FIELD = 'envelope_kind'

/** The value buildW9Envelope sets. Absent or unrecognised => agreement. */
export const KIND_W9_ONLY = 'w9_only'

export interface StampInput {
  /** The ENVELOPE_KIND_FIELD custom field value, or null if absent. */
  kind: string | null
  /** The W9_CUSTOM_FIELD custom field value, or null if absent. */
  w9: string | null
  envelopeId: string
  /** ISO timestamp. Passed in so the caller stamps one consistent time. */
  now: string
}

export interface StampDecision {
  /** Columns to write on referral_partners. Keys absent = do not touch. */
  fields: Record<string, string>
  /** Whether to send the portal invite. */
  invites: boolean
  w9Received: boolean
  agreementSigned: boolean
  /** Something to log. Absent on both normal paths. */
  anomaly?: string
}

export function completedEnvelopeStamp(input: StampInput): StampDecision {
  const { kind, w9, envelopeId, now } = input

  const carriesW9 = w9?.trim().toLowerCase() === W9_INCLUDED
  const isW9Only = kind?.trim().toLowerCase() === KIND_W9_ONLY

  // An unrecognised kind is treated as an agreement, and the asymmetry is
  // deliberate: signing an unknown envelope grants portal access to
  // somebody who signed something, while stamping w9_received_at off an
  // envelope we cannot identify authorises a payout we cannot file a
  // 1099-NEC for.
  const unknownKind = kind !== null && kind.trim() !== '' && !isW9Only

  const fields: Record<string, string> = { updated_at: now }
  let anomaly: string | undefined

  if (isW9Only) {
    if (carriesW9) {
      fields.w9_received_at = now
    } else {
      // Not something this repo can build. The w9 field is the only
      // evidence the form's required tabs were filled; without it the
      // stamp would be a guess.
      anomaly =
        `envelope ${envelopeId} is marked ${KIND_W9_ONLY} but does not ` +
        `carry ${W9_CUSTOM_FIELD}=${W9_INCLUDED}; refusing to record a W-9`
    }

    return {
      fields,
      invites: false,
      w9Received: carriesW9,
      agreementSigned: false,
      ...(anomaly ? { anomaly } : {}),
    }
  }

  if (unknownKind) {
    anomaly =
      `envelope ${envelopeId} carries an unrecognised ${ENVELOPE_KIND_FIELD}=` +
      `${kind}; treating it as an agreement`
  }

  fields.agreement_status = 'signed'
  fields.agreement_signed_at = now
  fields.agreement_envelope_id = envelopeId
  fields.status = 'active'

  // The combined envelope already in flight: an agreement that also
  // carries the W-9. It must keep doing what it always did.
  if (carriesW9) fields.w9_received_at = now

  return {
    fields,
    invites: true,
    w9Received: carriesW9,
    agreementSigned: true,
    ...(anomaly ? { anomaly } : {}),
  }
}
