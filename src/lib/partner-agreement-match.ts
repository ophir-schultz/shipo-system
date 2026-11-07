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

export interface AgreementEventRow {
  envelopeId: string
  event: string
  referralPartnerId: string | null
}

export interface AgreementLinkRequest {
  envelopeId: string
  partnerId: string
}

export type AgreementLinkPlan =
  | { action: 'unmatched'; envelopeId: string; reason: string }
  | { action: 'noop'; envelopeId: string; partnerId: string; reason: string }
  | { action: 'refuse'; envelopeId: string; reason: string }
  | {
      action: 'link'
      envelopeId: string
      partnerId: string
      grantsAccess: false
      setsAgreementStatus: false
      setsW9: false
      reason: string
    }

function folded(value: string): string {
  return value.trim().toLowerCase()
}

/**
 * What a later write could do with one staff match.
 *
 * The staff member must name the partner. A voided envelope is not
 * consent. A completed envelope does not become a signed agreement or
 * a W-9. Calling this twice with the same already-linked pair is a no-op.
 * Nothing here writes.
 */
export function planAgreementLink(
  event: AgreementEventRow,
  request: AgreementLinkRequest | null,
): AgreementLinkPlan {
  const envelopeId = event.envelopeId.trim()
  if (!envelopeId) {
    return { action: 'refuse', envelopeId: '', reason: 'The event has no envelope id.' }
  }
  if (!request || request.envelopeId.trim() !== envelopeId || !request.partnerId.trim()) {
    return {
      action: 'unmatched',
      envelopeId,
      reason: 'No staff match was entered. Name and email are not used.',
    }
  }
  const partnerId = request.partnerId.trim()
  const already = event.referralPartnerId?.trim() ?? ''
  if (already && already === partnerId) {
    return {
      action: 'noop',
      envelopeId,
      partnerId,
      reason: 'This envelope is already linked to that partner. Linking it again changes nothing.',
    }
  }
  if (already) {
    return {
      action: 'refuse',
      envelopeId,
      reason: 'This envelope is already linked to a different partner. It is not moved.',
    }
  }
  if (folded(event.event) === 'voided') {
    return {
      action: 'refuse',
      envelopeId,
      reason: 'A voided envelope is not a signature and is not linked.',
    }
  }
  if (folded(event.event) !== 'completed') {
    return {
      action: 'refuse',
      envelopeId,
      reason: 'Only a completed event can be proposed for a staff link.',
    }
  }
  return {
    action: 'link',
    envelopeId,
    partnerId,
    grantsAccess: false,
    setsAgreementStatus: false,
    setsW9: false,
    reason: 'Staff named this partner. The plan does not sign the agreement, record a W-9, or open the portal. It has not been written.',
  }
}

/** One plan per envelope. A repeated request for the same pair collapses. */
export function planAgreementLinks(
  events: readonly AgreementEventRow[],
  requests: readonly AgreementLinkRequest[],
): AgreementLinkPlan[] {
  const seen = new Set<string>()
  const plans: AgreementLinkPlan[] = []
  for (const event of events) {
    const envelopeId = event.envelopeId.trim()
    if (seen.has(envelopeId)) {
      plans.push({
        action: 'noop',
        envelopeId,
        partnerId: event.referralPartnerId?.trim() || '',
        reason: 'This envelope was already planned in this batch.',
      })
      continue
    }
    seen.add(envelopeId)
    const request = requests.find((item) => item.envelopeId.trim() === envelopeId) ?? null
    const plan = planAgreementLink(event, request)
    plans.push(plan)
    if (plan.action === 'link') {
      // A second event row for the same envelope later in the list is a no-op
      // because `seen` already holds the id. The link itself is not applied
      // back onto the input, so the function does not pretend the row changed.
    }
  }
  return plans
}
