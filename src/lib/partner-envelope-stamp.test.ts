// What a completed DocuSign envelope is allowed to stamp on a partner row.
//
// This decision used to be inline in the webhook, where it could only be
// checked by sending a real envelope. It had to come out because Task 7
// split one envelope into two, and the webhook now receives completions
// that mean entirely different things:
//
//   the AGREEMENT completed  -> the partner is signed, and may log in
//   the W-9 completed        -> we hold their tax form, and may pay them
//
// Conflate them and the failure is not cosmetic. A W-9 completion handled
// as an agreement completion re-stamps agreement_signed_at, re-sends the
// portal invite, and — worse — re-activates a partner somebody had set
// inactive. An agreement completion handled as a W-9 completion stamps
// w9_received_at off no form at all, which is the one stamp that
// authorises a payout we cannot file a 1099-NEC for.

import { describe, expect, it } from 'vitest'
import { W9_CUSTOM_FIELD, W9_INCLUDED } from './partner-w9'
import {
  ENVELOPE_KIND_FIELD,
  KIND_W9_ONLY,
  completedEnvelopeStamp,
  type StampInput,
} from './partner-envelope-stamp'

const NOW = '2026-10-14T12:00:00.000Z'
const ENV_ID = 'envelope-123'

/** An agreement envelope as Task 7 leaves it: no kind, no w9 field. */
const agreement: StampInput = { kind: null, w9: null, envelopeId: ENV_ID, now: NOW }

/** A W-9-only envelope as buildW9Envelope produces it. */
const w9Only: StampInput = {
  kind: KIND_W9_ONLY,
  w9: W9_INCLUDED,
  envelopeId: ENV_ID,
  now: NOW,
}

describe('an agreement envelope completing', () => {
  it('signs and activates the partner', () => {
    const d = completedEnvelopeStamp(agreement)
    expect(d.fields.agreement_status).toBe('signed')
    expect(d.fields.agreement_signed_at).toBe(NOW)
    expect(d.fields.agreement_envelope_id).toBe(ENV_ID)
    expect(d.fields.status).toBe('active')
    expect(d.agreementSigned).toBe(true)
  })

  it('leaves w9_received_at alone', () => {
    // The key must be ABSENT, not null. A null would write over a W-9 we
    // already hold from a separate envelope — and after the split the W-9
    // always arrives on a separate envelope, so that is the normal case,
    // not the edge one.
    const d = completedEnvelopeStamp(agreement)
    expect('w9_received_at' in d.fields).toBe(false)
    expect(d.w9Received).toBe(false)
  })

  it('invites the partner to the portal', () => {
    // The invite is the point of activating: the partner cannot know the
    // portal exists until somebody tells them.
    expect(completedEnvelopeStamp(agreement).invites).toBe(true)
  })
})

describe('a W-9 envelope completing', () => {
  it('records the W-9', () => {
    const d = completedEnvelopeStamp(w9Only)
    expect(d.fields.w9_received_at).toBe(NOW)
    expect(d.w9Received).toBe(true)
  })

  it('does NOT touch the agreement columns', () => {
    // The partner signed the agreement weeks earlier. Re-stamping it would
    // move agreement_signed_at forward onto a date no contract was signed
    // on, which is the date a dispute would turn on.
    const d = completedEnvelopeStamp(w9Only)
    expect('agreement_status' in d.fields).toBe(false)
    expect('agreement_signed_at' in d.fields).toBe(false)
    expect('agreement_envelope_id' in d.fields).toBe(false)
    expect(d.agreementSigned).toBe(false)
  })

  it('does NOT re-activate the partner', () => {
    // THE DEFECT THIS EXISTS FOR. `status: 'active'` is what
    // /api/partner/request-code checks before issuing a login code. A
    // partner we deliberately set inactive — for cause, or because the
    // relationship ended — signs the W-9 that was already sitting in their
    // dashboard, and silently has portal access again.
    const d = completedEnvelopeStamp(w9Only)
    expect('status' in d.fields).toBe(false)
  })

  it('does NOT re-send the portal invite', () => {
    expect(completedEnvelopeStamp(w9Only).invites).toBe(false)
  })

  it('refuses to record a W-9 the envelope does not claim to carry', () => {
    // A W-9-kind envelope with no w9 field is not something this repo can
    // build, so it means someone hand-made an envelope or the field was
    // dropped. Either way the field is the ONLY evidence that the form's
    // required tabs were filled, and without it the stamp is a guess.
    const d = completedEnvelopeStamp({ ...w9Only, w9: null })
    expect('w9_received_at' in d.fields).toBe(false)
    expect(d.w9Received).toBe(false)
    expect(d.anomaly).toMatch(/W-9/)
  })

  it('reads the w9 value case-insensitively', () => {
    // DocuSign echoes custom fields back as configured, and the value has
    // been typed by hand in the admin UI at least once.
    expect(completedEnvelopeStamp({ ...w9Only, w9: 'INCLUDED' }).w9Received).toBe(true)
  })
})

describe('the envelope already sent, which carries both documents', () => {
  // One combined envelope exists and may still complete. It has the w9
  // field (the old builder set it) and no kind field (the field did not
  // exist). It must do what it always did: sign, activate AND record.
  const legacy: StampInput = { kind: null, w9: W9_INCLUDED, envelopeId: ENV_ID, now: NOW }

  it('signs, activates and records the W-9', () => {
    const d = completedEnvelopeStamp(legacy)
    expect(d.fields.agreement_status).toBe('signed')
    expect(d.fields.status).toBe('active')
    expect(d.fields.w9_received_at).toBe(NOW)
    expect(d.invites).toBe(true)
  })
})

describe('an unknown envelope kind', () => {
  it('is treated as an agreement, not as a W-9', () => {
    // The safe direction, and it is not symmetric. Treating an unknown
    // envelope as an agreement grants portal access to somebody who
    // signed something; treating it as a W-9 would stamp "we hold their
    // tax form" off an envelope we cannot identify.
    const d = completedEnvelopeStamp({ ...agreement, kind: 'something_else' })
    expect(d.fields.agreement_status).toBe('signed')
    expect('w9_received_at' in d.fields).toBe(false)
    expect(d.anomaly).toMatch(/something_else/)
  })
})

describe('every stamp', () => {
  it('sets updated_at', () => {
    expect(completedEnvelopeStamp(agreement).fields.updated_at).toBe(NOW)
    expect(completedEnvelopeStamp(w9Only).fields.updated_at).toBe(NOW)
  })

  it('never writes a column it was not asked about', () => {
    // An allowlist in assertion form. The webhook applies these fields
    // straight to referral_partners with the service role, so a typo'd
    // key here is a silently ignored column at best and the wrong column
    // written at worst.
    const allowed = new Set([
      'agreement_status',
      'agreement_signed_at',
      'agreement_envelope_id',
      'status',
      'w9_received_at',
      'updated_at',
    ])
    for (const input of [agreement, w9Only, { ...agreement, w9: W9_INCLUDED }]) {
      for (const key of Object.keys(completedEnvelopeStamp(input).fields)) {
        expect(allowed.has(key), `unexpected column ${key}`).toBe(true)
      }
    }
  })
})

describe('the kind field is shared, not retyped', () => {
  it('is what the builder sets', () => {
    // The same drift that W9_CUSTOM_FIELD guards against: the webhook and
    // the builder must read one constant, or a rename on one side makes
    // every W-9 envelope look like an agreement — which re-activates
    // partners and never records a single tax form.
    expect(ENVELOPE_KIND_FIELD).toBe('envelope_kind')
    expect(KIND_W9_ONLY).toBe('w9_only')
    expect(W9_CUSTOM_FIELD).toBe('w9')
  })
})
