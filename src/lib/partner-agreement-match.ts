// How a DocuSign Connect event may be attached to a partner row.
//
// Production recorded four events — three completed, one voided — and
// every one of them matched nobody. Those payloads had no partner_id
// and no envelope_kind. The signer email was present and was not used
// as a successful match, which is the outcome this module now requires.
//
// Email is not a key. A signer can forward an envelope, and two partners
// can share a mailbox. Attaching a completion to "the row whose email
// looks like the signer" would mark the wrong person signed and mail
// them a portal login. A miss stays a miss. Staff can see the unmatched
// envelope id. Nothing here grants access.

export interface AgreementLookupInput {
  /** The partner_id custom field we set when we build an envelope. */
  partnerIdField: string | null
  envelopeId: string
}

export type AgreementLookupStep =
  | { via: 'partner_id'; partnerId: string }
  | { via: 'stored_envelope'; envelopeId: string }

/**
 * The lookups the webhook may run, in order.
 *
 * A partner_id that does not find a row does not become permission to
 * guess. The only remaining lookup is an envelope id already stored on
 * a partner row — an id we wrote, not one the signer typed. If neither
 * is present, the list is empty and the event is recorded unmatched.
 */
export function agreementLookupSteps(input: AgreementLookupInput): AgreementLookupStep[] {
  const steps: AgreementLookupStep[] = []
  const partnerId = input.partnerIdField?.trim() ?? ''
  if (partnerId) steps.push({ via: 'partner_id', partnerId })
  const envelopeId = input.envelopeId.trim()
  if (envelopeId) steps.push({ via: 'stored_envelope', envelopeId })
  return steps
}

/**
 * Shown on the staff referrals screen. The dashboard has no envelope
 * send. Saying the webhook "stays off until variables are set" was wrong
 * in production, where the Connect secret exists and the six API
 * variables do not: Connect can receive, and it still must not guess.
 */
export const AGREEMENT_NOT_SENT_FROM_DASHBOARD =
  'This dashboard does not create or send partner agreements. There is no send action here. ' +
  'A partner can sign in only when agreement status is exactly signed. DocuSign Connect sets that ' +
  'only when the event carries the partner_id we placed on the envelope, or when the envelope id ' +
  'is already stored on that partner. A signer name or email is never enough, and an event that ' +
  'matches nobody does not change access for anyone. A signed row with no matching event was recorded by hand.'

export const CONNECT_CAN_RECEIVE =
  'Connect can receive events. It still cannot send an agreement. It updates a partner only on the match above.'

export const CONNECT_IS_OFF =
  'DOCUSIGN_CONNECT_SECRET is not set, so a finished envelope cannot update agreement status. The webhook refuses the call.'

/** Columns the staff list may read. The stored payload is never one of them. */
export const UNMATCHED_EVENT_COLUMNS = 'envelope_id, event, processed_at'
