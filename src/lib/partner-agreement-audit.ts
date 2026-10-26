// Does what Shipo believes about a partner's agreement match what
// DocuSign believes?
//
// WHY THIS EXISTS, PRECISELY. Jimi Maciel signed at 2026-10-23T23:38:42Z.
// DocuSign recorded `completed`. His row stayed `agreement_status =
// 'sent'` with a null signed_at, so canAccessPortal refused him and the
// portal he had just signed a contract to reach told him nothing was
// wrong. He was locked out for three days and the only reason anyone
// found out is that Ophir mentioned he had signed.
//
// The agreement webhook is the ONLY writer of that column. A webhook that
// never arrives raises no error, writes no log line and fails no request:
// it produces silence, and silence is indistinguishable from a partner
// who simply has not signed yet. Every other failure in this system
// announces itself. This one cannot, so something has to go looking.
//
// IT IS NOT A RETRY. It does not stamp the row, because a cron that
// quietly repairs state hides how often the webhook fails, and the
// repair is one `update` a human can run with the DocuSign timestamp in
// front of them. The job here is to NOTICE, loudly, and name who.

/** The shape this reads off referral_partners. */
export interface AgreementRow {
  id: string
  name: string
  email: string | null
  agreement_status: string | null
  agreement_sent_at: string | null
  agreement_signed_at: string | null
  agreement_envelope_id: string | null
}

/** What DocuSign says about one envelope. */
export type EnvelopeVerdict = 'completed' | 'declined' | 'voided' | 'pending'

export type FindingKind =
  /** DocuSign says completed, we still say sent. The Jimi case. */
  | 'webhook_missed'
  /** We say signed, DocuSign says declined or voided. */
  | 'status_conflict'
  /** Out for signature longer than anyone should take. */
  | 'stale_sent'
  /** We could not ask DocuSign about it at all. */
  | 'unknown_envelope'
  /** Sent, apparently, but nothing recorded to check it against. */
  | 'no_envelope_id'

export interface Finding {
  kind: FindingKind
  severity: 'critical' | 'warn'
  partnerId: string
  name: string
  email: string | null
  envelopeId: string | null
  detail: string
}

/**
 * DocuSign's own status string → the verdict this module reasons about.
 *
 * ONE MAPPER, NOT TWO. The monitor route and the audit script both need
 * it; written separately they drift, and the half that drifts decides
 * whether a locked-out partner gets reported.
 *
 * AN UNRECOGNISED STATUS RETURNS NULL, never 'pending'. `pending` is an
 * all-clear inside the stale window, so defaulting to it would mean any
 * state DocuSign adds later is silently treated as fine — the exact
 * shape of the failure this file exists to catch. Null surfaces as
 * `unknown_envelope`, which asks a human to look.
 */
export function docusignVerdict(status: string | null | undefined): EnvelopeVerdict | null {
  switch (status) {
    case 'completed':
      return 'completed'
    case 'declined':
      return 'declined'
    case 'voided':
      return 'voided'
    // DocuSign distinguishes these three; the audit only needs "not yet".
    case 'sent':
    case 'delivered':
    case 'created':
      return 'pending'
    default:
      return null
  }
}

/** Agreements that have gone out and are waiting on the partner. */
const SENT = 'sent'
const SIGNED = 'signed'

const DAY_MS = 24 * 60 * 60 * 1000

function daysSince(iso: string | null, now: Date): number | null {
  if (!iso) return null
  const t = Date.parse(iso)
  return Number.isNaN(t) ? null : Math.floor((now.getTime() - t) / DAY_MS)
}

/**
 * Compare both systems and return what disagrees.
 *
 * `verdicts` maps envelope id to what DocuSign said. An envelope MISSING
 * from that map is not "fine" — it means the lookup did not answer, and
 * that is reported as `unknown_envelope`. The failure this whole module
 * guards against is a check that goes quiet when it should not, so the
 * one thing it may never do is treat an absent answer as agreement.
 *
 * `staleDays` is how long an unsigned agreement may sit before it is
 * worth a mention. It is a warning, not an incident: a partner taking a
 * week over a contract is a partner reading it.
 */
export function auditAgreements(
  rows: AgreementRow[],
  verdicts: Map<string, EnvelopeVerdict>,
  now: Date,
  staleDays = 7,
): Finding[] {
  const found: Finding[] = []

  for (const row of rows) {
    const status = (row.agreement_status ?? '').trim()
    if (status !== SENT && status !== SIGNED) continue

    const base = {
      partnerId: row.id,
      name: row.name,
      email: row.email,
      envelopeId: row.agreement_envelope_id,
    }

    if (!row.agreement_envelope_id) {
      // Only worth saying for an agreement that went OUT. A signed row
      // with no envelope id is history we cannot check and need not.
      if (status === SENT) {
        found.push({
          ...base,
          kind: 'no_envelope_id',
          severity: 'warn',
          detail: 'Agreement recorded as sent, but no envelope id was stored, so nothing can verify it.',
        })
      }
      continue
    }

    const verdict = verdicts.get(row.agreement_envelope_id)

    if (!verdict) {
      found.push({
        ...base,
        kind: 'unknown_envelope',
        severity: 'warn',
        detail:
          'DocuSign could not be asked about this envelope. Not an all-clear — check the credentials ' +
          'point at the same DocuSign account the envelope lives in.',
      })
      continue
    }

    if (status === SENT && verdict === 'completed') {
      found.push({
        ...base,
        kind: 'webhook_missed',
        severity: 'critical',
        detail:
          'DocuSign reports this envelope COMPLETED while the partner is still marked sent. ' +
          'He signed and the portal is refusing him. The completion webhook did not land.',
      })
      continue
    }

    if (status === SIGNED && (verdict === 'declined' || verdict === 'voided')) {
      found.push({
        ...base,
        kind: 'status_conflict',
        severity: 'critical',
        detail: `We record this agreement as signed; DocuSign reports it ${verdict}. The partner may be reading a statement he has no agreement for.`,
      })
      continue
    }

    if (status === SENT && verdict === 'pending') {
      const age = daysSince(row.agreement_sent_at, now)
      if (age !== null && age >= staleDays) {
        found.push({
          ...base,
          kind: 'stale_sent',
          severity: 'warn',
          detail: `Out for signature ${age} days and still unsigned. DocuSign agrees it is pending, so this is a nudge, not a fault.`,
        })
      }
    }
  }

  // Critical first. A warning printed above an incident is a warning that
  // buries it, and this report is read at a glance or not at all.
  return [...found.filter((f) => f.severity === 'critical'), ...found.filter((f) => f.severity === 'warn')]
}
