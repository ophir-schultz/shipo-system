import { describe, expect, it } from 'vitest'
import {
  auditAgreements,
  docusignVerdict,
  type AgreementRow,
  type EnvelopeVerdict,
} from './partner-agreement-audit'

/**
 * The check that would have caught Jimi Maciel.
 *
 * He signed on 2026-10-23T23:38:42Z. DocuSign recorded `completed`. His
 * row stayed `agreement_status = 'sent'` with a null signed_at, so the
 * portal believed he had never signed and refused him entry for three
 * days. NOTHING ANNOUNCED IT. The webhook is the only thing that writes
 * that column, and a webhook that never arrives produces no error, no
 * log line and no failed request — it produces silence, and silence
 * looks exactly like a partner who has not got round to signing.
 *
 * So the audit compares two systems that should agree and reports where
 * they do not. It is deliberately NOT a webhook retry: the point is to
 * notice, loudly, that the two disagree.
 *
 * ⚠️ UNKNOWN IS NOT PASS. If DocuSign cannot be asked — wrong credential
 * world, API down, envelope not found — that is a finding in its own
 * right, never a quiet "nothing to report". The whole failure being
 * guarded against is a check that stays silent when it should not.
 */

const SENT_AT = '2026-10-20T10:00:00Z'
const NOW = new Date('2026-10-26T10:00:00Z')

function row(over: Partial<AgreementRow> = {}): AgreementRow {
  return {
    id: 'p1',
    name: 'Jimi Maciel',
    email: 'milemogul@gmail.com',
    agreement_status: 'sent',
    agreement_sent_at: SENT_AT,
    agreement_signed_at: null,
    agreement_envelope_id: 'env-1',
    ...over,
  }
}

const verdicts = (v: Record<string, EnvelopeVerdict>) => new Map(Object.entries(v))

describe('auditAgreements', () => {
  it('reports a partner DocuSign calls completed while we still call him sent', () => {
    // Jimi, exactly.
    const found = auditAgreements([row()], verdicts({ 'env-1': 'completed' }), NOW)

    expect(found).toHaveLength(1)
    expect(found[0].kind).toBe('webhook_missed')
    expect(found[0].severity).toBe('critical')
    expect(found[0].name).toBe('Jimi Maciel')
  })

  it('says nothing when both systems agree he has signed', () => {
    const found = auditAgreements(
      [row({ agreement_status: 'signed', agreement_signed_at: '2026-10-23T23:38:42Z' })],
      verdicts({ 'env-1': 'completed' }),
      NOW,
    )
    expect(found).toEqual([])
  })

  it('says nothing about a partner who genuinely has not signed yet', () => {
    // sent 6 days ago, DocuSign agrees he is still pending, inside the
    // stale window. A partner taking a week to read a contract is not an
    // incident.
    const found = auditAgreements([row()], verdicts({ 'env-1': 'pending' }), NOW, 10)
    expect(found).toEqual([])
  })

  it('flags an envelope that has sat unsigned past the stale window', () => {
    const found = auditAgreements([row()], verdicts({ 'env-1': 'pending' }), NOW, 3)

    expect(found).toHaveLength(1)
    expect(found[0].kind).toBe('stale_sent')
    expect(found[0].severity).toBe('warn')
  })

  // The reverse disagreement. Rarer and worse: we believe a contract is
  // signed and DocuSign says it was declined or cancelled, so a partner
  // may be reading a statement he has no agreement for.
  it.each(['declined', 'voided'] as const)('flags a row we call signed that DocuSign calls %s', (v) => {
    const found = auditAgreements(
      [row({ agreement_status: 'signed', agreement_signed_at: '2026-10-23T23:38:42Z' })],
      verdicts({ 'env-1': v }),
      NOW,
    )

    expect(found).toHaveLength(1)
    expect(found[0].kind).toBe('status_conflict')
    expect(found[0].severity).toBe('critical')
  })

  it('treats an unanswerable envelope as a finding, not as agreement', () => {
    // No verdict for env-1 at all — the lookup failed, the credentials
    // point at the wrong DocuSign world, the envelope was purged. Any of
    // those means we DO NOT KNOW, and not knowing is the state this audit
    // exists to make visible.
    const found = auditAgreements([row()], verdicts({}), NOW)

    expect(found).toHaveLength(1)
    expect(found[0].kind).toBe('unknown_envelope')
    expect(found[0].severity).toBe('warn')
  })

  it('reports a sent agreement that carries no envelope id to check', () => {
    // The row says an agreement went out and names nothing to verify it
    // against. Jimi's row looked like this for two days after the send,
    // because nothing records the envelope id at send time.
    const found = auditAgreements([row({ agreement_envelope_id: null })], verdicts({}), NOW)

    expect(found).toHaveLength(1)
    expect(found[0].kind).toBe('no_envelope_id')
  })

  it('ignores partners who were never sent an agreement', () => {
    for (const status of ['not_sent', null, '']) {
      expect(auditAgreements([row({ agreement_status: status })], verdicts({}), NOW)).toEqual([])
    }
  })

  it('reports every partner, not just the first', () => {
    // A single-finding bug would have reported Jimi and hidden the next
    // one behind him.
    const found = auditAgreements(
      [
        row({ id: 'a', name: 'A', agreement_envelope_id: 'env-a' }),
        row({ id: 'b', name: 'B', agreement_envelope_id: 'env-b' }),
      ],
      verdicts({ 'env-a': 'completed', 'env-b': 'completed' }),
      NOW,
    )

    expect(found.map((f) => f.name).sort()).toEqual(['A', 'B'])
  })

  it('puts critical findings before warnings', () => {
    const found = auditAgreements(
      [
        row({ id: 'a', name: 'Stale', agreement_envelope_id: 'env-a' }),
        row({ id: 'b', name: 'Missed', agreement_envelope_id: 'env-b' }),
      ],
      verdicts({ 'env-a': 'pending', 'env-b': 'completed' }),
      NOW,
      3,
    )

    expect(found.map((f) => f.severity)).toEqual(['critical', 'warn'])
  })
})

describe('docusignVerdict', () => {
  // ONE MAPPER, NOT TWO. The monitor route and the audit script both need
  // to turn DocuSign's status string into a verdict. Written twice, they
  // drift, and the half that drifts decides whether a locked-out partner
  // is reported — which is the failure this whole module exists for.
  it.each([
    ['completed', 'completed'],
    ['declined', 'declined'],
    ['voided', 'voided'],
  ] as const)('maps %s through unchanged', (status, expected) => {
    expect(docusignVerdict(status)).toBe(expected)
  })

  it.each(['sent', 'delivered', 'created'])('treats %s as still waiting on the signer', (status) => {
    // DocuSign distinguishes these three; the audit does not care which
    // kind of "not yet" it is.
    expect(docusignVerdict(status)).toBe('pending')
  })

  it.each([null, '', 'correcting', 'something-new'])('returns null for %j rather than guessing', (status) => {
    // A status nobody has seen before must NOT fall through to pending:
    // pending is an all-clear, and an unrecognised state is exactly when
    // a human should look. Null becomes unknown_envelope upstream.
    expect(docusignVerdict(status)).toBeNull()
  })
})
