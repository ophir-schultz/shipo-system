import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { W9_CUSTOM_FIELD, W9_INCLUDED } from './partner-w9'
import { W9_CLASSIFICATIONS, W9_TEXT_FIELDS, W9_TIN_GROUP } from './docusign-w9'
import {
  ENVELOPE_KIND_FIELD,
  KIND_W9_ONLY,
  completedEnvelopeStamp,
} from './partner-envelope-stamp'
import {
  ACCOUNTANT_RECIPIENT_ID,
  AGREEMENT_ANCHORS,
  AGREEMENT_PARTNER_ROLE,
  AGREEMENT_SHIPO_ROLE,
  AGREEMENT_TEMPLATE_ID,
  ENVELOPE_TYPE_FIELD,
  ENVELOPE_TYPE_VALUE,
  PARTNER_ID_FIELD,
  PARTNER_RECIPIENT_ID,
  SHIPO_RECIPIENT_ID,
  buildPartnerAgreementEnvelope,
  buildW9Envelope,
  partyName,
  type BuildW9EnvelopeInput,
} from './docusign-envelope'

const HERE = dirname(fileURLToPath(import.meta.url))
/** Module-relative, so the source-reading guards below cannot fail as ENOENT. */
const ENVELOPE_SRC = join(HERE, 'docusign-envelope.ts')
const AGREEMENT_MD = join(HERE, '../../docs/referral-agreement-TEMPLATE.md')

const partner = {
  id: '11111111-2222-3333-4444-555555555555',
  name: 'Dana Katz Consulting LLC',
  email: 'dana@example.com',
  // Explicit, not incidental: §2a.7's guard refuses an UNSET status, so
  // every test below that expects an envelope needs a partner the builder
  // will actually build for. The refusal cases override this field.
  tax_status: 'us_person',
}
const shipo = { name: 'Ophir Schultz', email: 'ophir@shipousa.com' }

const WEBHOOK_URL = 'https://shipousa.com/api/partner/agreement-webhook'

function build() {
  return buildPartnerAgreementEnvelope({ partner, shipo, webhookUrl: WEBHOOK_URL })
}

// The W-9-only envelope (spec §2a). The partner signs this one from his
// dashboard, embedded, and the accountant gets a copy of the finished form
// — as a DocuSign carbon copy, never as an email we send, because we never
// hold the bytes (Risk 5, docusign-redact.ts).
const w9Input: BuildW9EnvelopeInput = {
  partner: { id: 'p1', name: 'Jane Doe', email: 'jane@example.com', tax_status: 'us_person' },
  w9DocumentBase64: 'JVBERi0=',
  accountantEmail: 'accountant@example.com',
  accountantName: 'Test Accountant',
  clientUserId: 'p1',
}

// Narrow helpers, so a change in the payload's shape fails here rather
// than silently returning undefined into an expect that passes.
type Signer = {
  recipientId: string
  routingOrder: string
  email: string
  name: string
  /** How the composite template matches this signer to the server template. */
  roleName: string
  tabs: Record<string, unknown[]>
}

function signersOf(
  env: ReturnType<typeof build> | ReturnType<typeof buildW9Envelope>,
  compositeIndex: number,
): Signer[] {
  const ct = env.compositeTemplates[compositeIndex] as {
    inlineTemplates: Array<{ recipients: { signers: Signer[] } }>
  }
  return ct.inlineTemplates[0].recipients.signers
}

type Recipients = {
  signers: Signer[]
  carbonCopies?: Array<{ recipientId: string; email: string; name: string; routingOrder: string }>
}

/** The recipients block of the one inline template on a W-9 envelope. */
function recipientsOf(env: ReturnType<typeof buildW9Envelope>): Recipients {
  const ct = env.compositeTemplates[0] as {
    inlineTemplates: Array<{ recipients: Recipients }>
  }
  return ct.inlineTemplates[0].recipients
}

/** The only signer on a W-9 envelope: the partner. */
function w9PartnerSigner(env = buildW9Envelope(w9Input)): Signer {
  return recipientsOf(env).signers.find((s) => s.recipientId === PARTNER_RECIPIENT_ID)!
}

function textCustomFieldsOf(env: {
  customFields: { textCustomFields: Array<{ name: string; value: string }> }
}) {
  return env.customFields.textCustomFields
}

/** Every tab label and tab-group label the partner carries, sorted. */
function w9TabLabels(env: ReturnType<typeof buildW9Envelope>): string[] {
  const labels: string[] = []
  for (const group of Object.values(w9PartnerSigner(env).tabs)) {
    for (const tab of group as Array<Record<string, unknown>>) {
      if (typeof tab.tabLabel === 'string') labels.push(tab.tabLabel)
      if (typeof tab.groupLabel === 'string') labels.push(tab.groupLabel)
    }
  }
  return labels.sort()
}

describe('it is always a draft', () => {
  it('never builds an envelope that sends itself', () => {
    // The single most expensive mistake available here. 'sent' mails a
    // contract to a real person with no review step, and there is no
    // unsending it.
    expect(build().status).toBe('created')
  })

  it('the source contains no path that sets status to sent', () => {
    const src = readFileSync(ENVELOPE_SRC, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*)/.test(l))
      .join('\n')
    expect(src).toContain("status: 'created'")
    expect(src).not.toMatch(/status:\s*'sent'/)
  })
})

describe('the W-9 reaches the partner, not us', () => {
  // The defect this guards is quiet and specific: DocuSign's
  // transformPdfFields assigns converted PDF fields to the first
  // recipient in routing order. Left to the transform, every W-9 field —
  // the taxpayer identification number included — would have been
  // addressed to whoever routes first rather than to the partner.
  //
  // These moved onto buildW9Envelope in Task 7, with the document. The
  // transform is still disabled and the tabs are still explicit; what
  // changed is which envelope carries them.
  const env = buildW9Envelope(w9Input)

  it('does not use transformPdfFields', () => {
    const doc = env.compositeTemplates[0].document as { transformPdfFields: string }
    expect(doc.transformPdfFields).toBe('false')
  })

  it('gives every W-9 tab to the partner and lists nobody else as a signer', () => {
    // Shipo is deliberately NOT a recipient here. A listed signer with no
    // tabs is not free: DocuSign emails them and waits for them to click
    // Finish before the envelope COMPLETES, and completion is what
    // releases the accountant's copy and what the webhook stamps
    // w9_received_at on.
    const signers = recipientsOf(env).signers
    expect(signers).toHaveLength(1)
    expect(signers[0].recipientId).toBe(PARTNER_RECIPIENT_ID)

    const partnerSigner = w9PartnerSigner(env)
    expect(partnerSigner.tabs.textTabs.length).toBeGreaterThan(5)
    expect(partnerSigner.tabs.signHereTabs).toHaveLength(1)
    expect(partnerSigner.tabs.radioGroupTabs).toHaveLength(1)
  })

  it('puts the taxpayer number on the partner', () => {
    const labels = (w9PartnerSigner(env).tabs.textTabs as { tabLabel: string }[]).map(
      (t) => t.tabLabel,
    )
    expect(labels).toContain('w9_tin_ssn')
    expect(labels).toContain('w9_tin_ein')
  })
})

describe('the W-9 cannot be returned blank', () => {
  // The webhook stamps w9_received_at on the strength of "the envelope
  // completed AND it carried a W-9". That inference is sound only
  // because DocuSign refuses to complete an envelope with a required tab
  // unfilled. Relax these and the timestamp becomes a claim we hold a
  // form we have never read — which authorises a payout we cannot file a
  // 1099-NEC for.
  const partnerSigner = w9PartnerSigner()
  const textTabs = partnerSigner.tabs.textTabs as { tabLabel: string; required: string }[]

  it('marks the name and address tabs required', () => {
    const required = textTabs.filter((t) => t.required === 'true').map((t) => t.tabLabel).sort()
    expect(required).toEqual(['w9_f1_01', 'w9_f1_07', 'w9_f1_08'])
  })

  it('carries the required flag through from the field table', () => {
    // Couples the payload to docusign-w9.ts rather than restating it, so
    // a field flipped to optional there cannot stay required only here.
    for (const field of W9_TEXT_FIELDS) {
      const tab = textTabs.find((t) => t.tabLabel === `w9_${field.acroform}`)!
      expect(tab, `missing tab for ${field.acroform}`).toBeDefined()
      expect(tab.required).toBe(field.required ? 'true' : 'false')
    }
  })

  it('forces exactly one tax classification', () => {
    const group = partnerSigner.tabs.radioGroupTabs as {
      groupName: string
      radios: { required: string; value: string }[]
    }[]
    expect(group[0].radios).toHaveLength(W9_CLASSIFICATIONS.length)
    expect(group[0].radios.every((r) => r.required === 'true')).toBe(true)
  })

  it('forces one of the two TIN rows and does not demand both', () => {
    // Requiring both would produce an envelope no human could complete:
    // an individual has an SSN, an LLC an EIN, and nobody has both.
    const tabGroups = partnerSigner.tabs.tabGroups as {
      groupLabel: string
      groupRule: string
      minimumRequired: string
    }[]
    expect(tabGroups).toHaveLength(1)
    expect(tabGroups[0].groupLabel).toBe(W9_TIN_GROUP)
    expect(tabGroups[0].groupRule).toBe('SelectAtLeast')
    expect(tabGroups[0].minimumRequired).toBe('1')

    const tin = (partnerSigner.tabs.textTabs as { tabLabel: string; required: string }[]).filter(
      (t) => t.tabLabel.startsWith('w9_tin_'),
    )
    expect(tin).toHaveLength(2)
    expect(tin.every((t) => t.required === 'false')).toBe(true)
  })

  it('requires a signature on the W-9 itself', () => {
    // The certification under penalties of perjury is what makes the
    // form usable. An unsigned W-9 is a sheet of numbers.
    expect(partnerSigner.tabs.signHereTabs).toHaveLength(1)
  })
})

describe('anchors', () => {
  const env = build()

  it('refuses to silently skip a missing anchor', () => {
    // anchorIgnoreIfNotPresent: 'true' is the dangerous default to reach
    // for when an anchor misbehaves. It would leave the agreement with
    // NO signature field and let the envelope complete unsigned.
    // BOTH envelopes. The W-9's signature and date tabs are anchored too,
    // and after Task 7 they live on a different envelope — a version of
    // this test that still read only the agreement would have gone on
    // passing while covering half of what it used to.
    const tabsOf = (e: { compositeTemplates: unknown[] }) =>
      e.compositeTemplates.flatMap((c) =>
        (
          c as { inlineTemplates: Array<{ recipients: { signers: Signer[] } }> }
        ).inlineTemplates[0].recipients.signers.flatMap(
          (s) => Object.values(s.tabs).flat() as Record<string, unknown>[],
        ),
      )
    const all = [...tabsOf(env), ...tabsOf(buildW9Envelope(w9Input))]
    const anchoredTabs = all.filter((t) => t && typeof t.anchorString === 'string')
    expect(anchoredTabs.length).toBeGreaterThan(4)
    for (const tab of anchoredTabs) {
      expect(tab.anchorIgnoreIfNotPresent).toBe('false')
    }
  })

  it('every agreement anchor is really in the PDF text layer', () => {
    // Not in the markdown — in the PDF, which is the layer DocuSign
    // searches. These have diverged before: the markdown is the source
    // but the PDF is the artifact that gets signed, and a renderer that
    // ligatures or re-wraps the anchor breaks the match with no visible
    // symptom until a partner receives a contract with no signature box.
    const pdf = readFileSync(join(HERE, '../../docs/referral-agreement-TEMPLATE.pdf'), 'latin1')
    const text = readFileSync(AGREEMENT_MD, 'utf8')
    for (const anchor of Object.values(AGREEMENT_ANCHORS)) {
      expect(text, `${anchor} missing from the markdown`).toContain(anchor)
    }
    // The PDF is compressed, so a raw byte search is not meaningful on
    // its own; the markdown check above is the readable one, and
    // referral-agreement-terms.test.ts holds the md-to-PDF guard.
    expect(pdf.length).toBeGreaterThan(1000)
  })

  it('uses distinct anchors for the two signers', () => {
    // \s1\ and \s2\ differing by one character is exactly the kind of
    // thing a careless edit collapses, and the result is both signature
    // tabs landing on one party.
    const values = Object.values(AGREEMENT_ANCHORS)
    expect(new Set(values).size).toBe(values.length)
  })
})

describe('custom fields — what the webhook reads back', () => {
  const fields = build().customFields.textCustomFields

  it('carries the partner id', () => {
    const f = fields.find((x) => x.name === PARTNER_ID_FIELD)!
    expect(f.value).toBe(partner.id)
  })

  it('no longer declares a W-9, because it no longer carries one', () => {
    // Task 7. This field is the webhook's whole evidence for stamping
    // w9_received_at. Leaving it on an envelope that no longer attaches
    // the form would record a W-9 as received the moment the AGREEMENT
    // completes — a payable partner whose tax form nobody has ever seen.
    expect(fields.find((x) => x.name === W9_CUSTOM_FIELD)).toBeUndefined()
  })

  it('does not retype the shared W-9 literals anywhere in the source', () => {
    // A rename on either side would otherwise record every W-9 we collect
    // as not collected — silent, and surfacing only as a partner being
    // told we cannot pay them.
    const src = readFileSync(ENVELOPE_SRC, 'utf8')
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*)/.test(l))
      .filter((l) => !/^\s*import\b/.test(l))
      .join('\n')
    expect(src).not.toContain(`'${W9_CUSTOM_FIELD}'`)
    expect(src).not.toContain(`'${W9_INCLUDED}'`)
  })

  it('carries the account-required envelope type', () => {
    // Marked required:true on the template. Omit it and DocuSign rejects
    // the send — which would surface on envelope two, long after this
    // looked like it worked.
    const f = fields.find((x) => x.name === ENVELOPE_TYPE_FIELD)!
    expect(f.value).toBe(ENVELOPE_TYPE_VALUE)
    expect(f.required).toBe('true')
  })

  it('spells the envelope type the way the ACCOUNT spells it', () => {
    // The literals are deliberate here, and deliberately the opposite
    // choice from the W-9 field above. That name is ours: both sides read
    // one constant, so a rename stays consistent and the test guards
    // against anyone bypassing the constant. This value is NOT ours — it
    // is a list configured in DocuSign admin, and the account rejects a
    // send carrying a value it does not know.
    //
    // Comparing the payload against the constant therefore proves
    // nothing: a typo in the constant moves both sides together and the
    // assertion follows it. Reversion-testing found exactly that — the
    // value could be changed to anything and the suite stayed green. So
    // the expected string is written out, and changing it means
    // re-checking DocuSign admin rather than satisfying a test.
    expect(ENVELOPE_TYPE_FIELD).toBe('envelopeTypes')
    expect(ENVELOPE_TYPE_VALUE).toBe('PartnershipAgreements')
  })
})

describe('recipients', () => {
  const env = build()

  it('has Shipo sign first so the partner activates on their own signature', () => {
    // Routing order is the whole reason the portal opens without a
    // second action from us: the envelope completes when the LAST signer
    // finishes, and the webhook activates on completion.
    const signers = signersOf(env, 0)
    const s = signers.find((x) => x.recipientId === SHIPO_RECIPIENT_ID)!
    const p = signers.find((x) => x.recipientId === PARTNER_RECIPIENT_ID)!
    expect(s.routingOrder).toBe('1')
    expect(p.routingOrder).toBe('2')
    expect(Number(p.routingOrder)).toBeGreaterThan(Number(s.routingOrder))
  })

  it('sends to the partner we were given', () => {
    const p = signersOf(env, 0).find((x) => x.recipientId === PARTNER_RECIPIENT_ID)!
    expect(p.email).toBe(partner.email)
    expect(p.name).toBe(partner.name)
  })

  it('names each signer with the role the SERVER TEMPLATE uses', () => {
    // A composite template matches inline recipients to the server
    // template's recipients BY ROLE NAME. A role name that matches
    // nothing does not override the template's recipient -- it ADDS one.
    //
    // This is not theory. Measured against the live account on
    // 2026-10-15: an envelope built with roleName 'Shipo' produced THREE
    // recipients (the template's CEO/Ophir, our Shipo/Ophir, and the
    // partner), so Ophir would have been asked to sign the same contract
    // twice and the envelope could not complete until he did. With the
    // template's own role names it returns recipientCount 2.
    //
    // The values below are the template's, not ours to choose. Changing
    // one means the template changed.
    const signers = signersOf(env, 0)
    const s = signers.find((x) => x.recipientId === SHIPO_RECIPIENT_ID)!
    const p = signers.find((x) => x.recipientId === PARTNER_RECIPIENT_ID)!
    expect(s.roleName).toBe(AGREEMENT_SHIPO_ROLE)
    expect(p.roleName).toBe(AGREEMENT_PARTNER_ROLE)
    expect(AGREEMENT_SHIPO_ROLE).toBe('CEO')
    expect(AGREEMENT_PARTNER_ROLE).toBe('Partner')
    // Distinct, or the two inline signers compete for one template slot.
    expect(s.roleName).not.toBe(p.roleName)
  })
})

describe('documents', () => {
  const env = build()

  it('pulls the agreement from the server template', () => {
    const st = env.compositeTemplates[0].serverTemplates as { templateId: string }[]
    expect(st[0].templateId).toBe(AGREEMENT_TEMPLATE_ID)
    expect(AGREEMENT_TEMPLATE_ID).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('no longer carries the W-9 document', () => {
    // Task 7, §2a.3. One envelope cannot carry both documents and copy the
    // accountant on only one of them, and §6 makes the commission terms
    // confidential — so the W-9 left, and the agreement stays agreement-
    // only. The cost is honest: the partner now signs twice.
    expect(env.compositeTemplates).toHaveLength(1)
    expect(JSON.stringify(env)).not.toContain('IRS Form W-9')
  })

  it('no longer advertises the W-9 in the email blurb', () => {
    // The blurb promised the W-9 "saves a second round trip". After the
    // split that is exactly the thing it no longer does, and the partner
    // reads this sentence before discovering otherwise.
    expect(env.emailBlurb).not.toMatch(/W-9|round trip/i)
  })
})

describe('refusals', () => {
  it('will not build an envelope with no partner id', () => {
    // The webhook resolves the partner by this field first precisely
    // because it cannot be spoofed by the signer. Without it, resolution
    // falls back to the signer's email — which a forwarded envelope can
    // change, attaching the signature to the wrong partner row.
    expect(() =>
      buildPartnerAgreementEnvelope({
        partner: { ...partner, id: '' },
        shipo,
        webhookUrl: WEBHOOK_URL,
      }),
    ).toThrow(/partner.id/)
  })

  it('will not build an envelope with no email to send it to', () => {
    expect(() =>
      buildPartnerAgreementEnvelope({
        partner: { ...partner, email: '' },
        shipo,
        webhookUrl: WEBHOOK_URL,
      }),
    ).toThrow(/email/)
  })

  it('will not build an envelope with no name on it', () => {
    expect(() =>
      buildPartnerAgreementEnvelope({
        partner: { ...partner, name: '  ' },
        shipo,
        webhookUrl: WEBHOOK_URL,
      }),
    ).toThrow(/name/)
  })

  it('will not build an envelope with no webhookUrl', () => {
    // Without eventNotification, the envelope completes without
    // notifying the app — the partner stays 'pending' forever. We refuse
    // rather than silently ship a dead-end envelope.
    expect(() =>
      buildPartnerAgreementEnvelope({ partner, shipo, webhookUrl: '' }),
    ).toThrow(/webhookUrl/)
  })

  it('refuses a plain-http webhookUrl', () => {
    // DocuSign silently will not deliver to http://; it discards the
    // event. Catch that at build time rather than at the first signed
    // envelope none of us watch.
    expect(() =>
      buildPartnerAgreementEnvelope({
        partner,
        shipo,
        webhookUrl: 'http://shipousa.com/api/partner/agreement-webhook',
      }),
    ).toThrow(/https/)
  })
})

// §2a.7, and the spec calls these "the test that matters". A signed W-9
// from a non-US person is not a defective form, it is the WRONG form --
// the IRS wants a W-8BEN or a W-8BEN-E, with a different withholding
// regime behind each, and neither is built. The guard is what makes
// "US only for now" a property of the software rather than of somebody's
// memory. Task 7 keeps it on this builder after the W-9 is split out:
// a foreign partner must not be sent the AGREEMENT either, until a W-8
// path exists.
describe('refuses anything but a US person', () => {
  it('refuses to build for a foreign individual', () => {
    expect(() =>
      buildPartnerAgreementEnvelope({
        partner: { ...partner, tax_status: 'foreign_individual' },
        shipo,
        webhookUrl: WEBHOOK_URL,
      }),
    ).toThrow(/W-8BEN/)
  })

  it('refuses to build for a foreign entity', () => {
    expect(() =>
      buildPartnerAgreementEnvelope({
        partner: { ...partner, tax_status: 'foreign_entity' },
        shipo,
        webhookUrl: WEBHOOK_URL,
      }),
    ).toThrow(/W-8BEN-E/)
  })

  it('refuses to build when the tax status is UNSET', () => {
    // Unset is its own refusal, not a pass. A default that happens to be
    // the safe answer for today's roster is not a guard.
    expect(() =>
      buildPartnerAgreementEnvelope({
        partner: { ...partner, tax_status: null },
        shipo,
        webhookUrl: WEBHOOK_URL,
      }),
    ).toThrow(/tax status/i)
  })

  it('refuses an unrecognised value rather than treating it as US', () => {
    // The CHECK constraint should make this unreachable from the database.
    // Asserted anyway, because "unreachable" is a claim about today's
    // schema and the failure direction here is a wrong IRS form.
    expect(() =>
      buildPartnerAgreementEnvelope({
        partner: { ...partner, tax_status: 'US_PERSON' },
        shipo,
        webhookUrl: WEBHOOK_URL,
      }),
    ).toThrow(/tax status/i)
  })

  it('never returns a partially built envelope on refusal', () => {
    // The throw IS the assertion: the guard sits before any document
    // assembly, so there is no object to inspect and no half-built
    // envelope a caller could send by accident.
    expect(() =>
      buildPartnerAgreementEnvelope({
        partner: { ...partner, tax_status: null },
        shipo,
        webhookUrl: WEBHOOK_URL,
      }),
    ).toThrow()
  })

  it('builds for a US person', () => {
    // The control. Without it, a guard that refused EVERYTHING would
    // pass all four refusals above.
    expect(() =>
      buildPartnerAgreementEnvelope({
        partner: { ...partner, tax_status: 'us_person' },
        shipo,
        webhookUrl: WEBHOOK_URL,
      }),
    ).not.toThrow()
  })
})

describe('eventNotification — the webhook that promotes the partner', () => {
  it('ships the configured webhook URL on every envelope', () => {
    const env = build() as { eventNotification: { url: string } }
    // Not a literal — the whole point of threading webhookUrl through
    // the input is that a test envelope cannot accidentally fire against
    // production. If this ever hard-codes shipousa.com, the next time
    // someone runs the script against localhost the webhook will post
    // to the live site.
    expect(env.eventNotification.url).toBe(WEBHOOK_URL)
  })

  it('subscribes to completed, declined, voided — the three the route handles', () => {
    const env = build() as {
      eventNotification: { envelopeEvents: Array<{ envelopeEventStatusCode: string }> }
    }
    const codes = env.eventNotification.envelopeEvents.map((e) => e.envelopeEventStatusCode)
    // These are the three branches of the webhook's switch. Add a code
    // here without a branch there and DocuSign fires events the route
    // discards — add a branch there without a code here and the route
    // never hears about the state change.
    expect(codes).toEqual(expect.arrayContaining(['completed', 'declined', 'voided']))
  })

  it('requires acknowledgment so a transient 5xx retries', () => {
    const env = build() as { eventNotification: { requireAcknowledgment: string } }
    // Without this, one bad deploy during the exact minute a partner
    // signs quietly loses the promotion. DocuSign keeps the event for
    // 24h of retries when acknowledgment is required.
    expect(env.eventNotification.requireAcknowledgment).toBe('true')
  })
})

describe('the contract prose has no blanks left in it', () => {
  // The anchors are rendered WHITE in the PDF, so an unfilled one leaves
  // no visible trace at all. Clause 1 would read 'with its address at
  // ("Partner")' and the notices clause 'Notices to Partner may be given
  // at .' — both of which read as sloppy drafting on an executed
  // contract rather than as a bug. These three tabs were missing from
  // the first cut of this file for exactly that reason: nothing looked
  // wrong.
  type TextTab = {
    anchorString: string
    tabLabel: string
    value?: string
    locked: string
    required: string
    width?: string
  }

  /**
   * Every text tab on the agreement, with the recipient it belongs to.
   *
   * Which recipient owns a prose-fill tab is the whole point of the
   * tests below, so these helpers deliberately do NOT narrow to one
   * signer first: a tab that moved to the wrong side has to fail on the
   * ownership assertion, not vanish into an undefined.
   */
  function agreementTextTabs(env = build()): Array<TextTab & { owner: string }> {
    return signersOf(env, 0).flatMap((s) =>
      ((s.tabs.textTabs ?? []) as TextTab[]).map((t) => ({ ...t, owner: s.recipientId })),
    )
  }
  const byAnchor = (a: string, env?: ReturnType<typeof build>) =>
    agreementTextTabs(env).find((t) => t.anchorString === a)!

  it('fills every fill-anchor the document contains', () => {
    // Derived from the document, not from a list kept here: the md is
    // the source of truth for which anchors exist, so an anchor added to
    // the contract without a tab fails HERE rather than shipping blank.
    const md = readFileSync(AGREEMENT_MD, 'utf8')
    const inDoc = new Set(md.match(/\\(pname|paddr|pemail)\\/g) ?? [])
    expect(inDoc.size).toBe(3)
    for (const anchor of inDoc) {
      expect(byAnchor(anchor), `no tab fills ${anchor}`).toBeDefined()
    }
  })

  it('shows the counterparty to BOTH signers, not only to the partner', () => {
    // DocuSign renders only the CURRENT recipient's tabs. A prefilled
    // value assigned to recipient 2 is invisible to recipient 1 -- so
    // with these tabs on the partner's side, Shipo signs a contract
    // whose clause 1 and whose page-8 'Partner --' heading read blank.
    //
    // Measured, not theorised: envelope 79dee1b4 went out on 2026-10-15
    // built exactly that way, and Ophir's reply was 'where is the
    // partner details?'. It was voided and reissued with these tabs on
    // recipient 1. The values were provably on the envelope the whole
    // time; the ASSIGNMENT was the defect.
    //
    // Shipo's side is the right home for them because they are values WE
    // supply from our own record, not facts the partner tells us.
    for (const anchor of [
      AGREEMENT_ANCHORS.partnerNamePrefill,
      AGREEMENT_ANCHORS.partnerEmailPrefill,
    ]) {
      const tab = byAnchor(anchor)
      expect(tab.owner, `${anchor} must be on Shipo's side to be visible to both`).toBe(
        SHIPO_RECIPIENT_ID,
      )
    }
  })

  it('names the partner in clause 1 and locks it', () => {
    // Locked because this is our record of the entity we approved. A
    // party block the counterparty can retype is a party block that can
    // name a different entity than the one we agreed to.
    const tab = byAnchor(AGREEMENT_ANCHORS.partnerNamePrefill)
    expect(tab.value).toBe(partyName(partner))
    expect(tab.locked).toBe('true')
    // Locked but NOT required. We supply the value, so requiredness
    // protects nothing -- and a required+locked tab on the signer's own
    // side can block them from completing their signature.
    expect(tab.required).toBe('false')
  })

  it('keeps the name box clear of the signature column on page 8', () => {
    // \pname\ appears TWICE -- clause 1 on page 1, and the 'Partner --'
    // heading on page 8 -- and one anchor definition sizes both. On page
    // 8 the box starts at x127 and the partner's signature column starts
    // at x274, so a 260-wide box runs 53px into it and the rendered
    // entity name overlaps the signature. 170 keeps it clear, at the
    // cost of a narrower box on page 1, which has room to spare.
    const tab = byAnchor(AGREEMENT_ANCHORS.partnerNamePrefill)
    expect(Number(tab.width)).toBeLessThanOrEqual(170)
  })

  it('fills the notices clause with the partner email and locks it', () => {
    const tab = byAnchor(AGREEMENT_ANCHORS.partnerEmailPrefill)
    expect(tab.value).toBe(partner.email)
    expect(tab.locked).toBe('true')
    expect(tab.required).toBe('false')
  })

  it('makes the partner type their address when we hold none, and requires it', () => {
    // referral_partners has no address column, so with nothing passed in
    // this is the one fact on the agreement the partner tells us. It
    // stays on the PARTNER's side precisely because it is theirs to
    // supply -- an empty tab on Shipo's side would be Ophir guessing it.
    // Required borrows the W-9's guarantee: DocuSign will not complete
    // an envelope with a required tab empty, so the notices clause
    // cannot end up blank.
    const tab = byAnchor(AGREEMENT_ANCHORS.partnerAddressPrefill)
    expect(tab.value).toBeUndefined()
    expect(tab.required).toBe('true')
    expect(tab.locked).toBe('false')
    expect(tab.owner).toBe(PARTNER_RECIPIENT_ID)
  })

  it('prefills the address on Shipo’s side when the caller supplies one', () => {
    // When we DO hold the address -- Dr. Halloon sent his with his
    // application -- it becomes a value we supply, so it moves to
    // recipient 1 and locks, like the name and email. Otherwise Ophir
    // signs a notices clause he cannot read and the partner can retype
    // the address we were given.
    const env = buildPartnerAgreementEnvelope({
      partner: { ...partner, address: '4291 Express Ln, Ste 4995-901, Sarasota, FL 34249, USA' },
      shipo,
      webhookUrl: WEBHOOK_URL,
    })
    const tab = byAnchor(AGREEMENT_ANCHORS.partnerAddressPrefill, env)
    expect(tab.value).toBe('4291 Express Ln, Ste 4995-901, Sarasota, FL 34249, USA')
    expect(tab.owner).toBe(SHIPO_RECIPIENT_ID)
    expect(tab.locked).toBe('true')
    expect(tab.required).toBe('false')
  })

  it('treats a blank address as no address at all', () => {
    // A whitespace-only column value must not become a locked, blank,
    // unfillable notices clause -- that is strictly worse than asking
    // the partner for it, because nobody can fix it after the send.
    const env = buildPartnerAgreementEnvelope({
      partner: { ...partner, address: '   ' },
      shipo,
      webhookUrl: WEBHOOK_URL,
    })
    const tab = byAnchor(AGREEMENT_ANCHORS.partnerAddressPrefill, env)
    expect(tab.value).toBeUndefined()
    expect(tab.required).toBe('true')
    expect(tab.owner).toBe(PARTNER_RECIPIENT_ID)
  })

  it('fills the W-9 requester block with Shipo, locked', () => {
    // Ours, not theirs. A partner asked to type the requester's address
    // will guess it or skip it, and either makes the form look like it
    // came from nobody.
    const tab = (
      w9PartnerSigner().tabs.textTabs as { tabLabel: string; value?: string; locked?: string }[]
    ).find((t) => t.tabLabel === 'w9_requester')!
    expect(tab).toBeDefined()
    expect(tab.value).toMatch(/Shipo LLC/)
    expect(tab.locked).toBe('true')
  })
})

describe('who clause 1 calls "Partner"', () => {
  it('uses the company when there is one', () => {
    // An agency's principal signs, but the agency is the Party. The
    // signature block has its own Name line for the human.
    expect(partyName({ id: 'x', name: 'Dana Katz', email: 'd@e.com', company: 'Katz Media LLC' }))
      .toBe('Katz Media LLC')
  })

  it('falls back to the person for a sole trader', () => {
    expect(partyName({ id: 'x', name: 'Dana Katz', email: 'd@e.com' })).toBe('Dana Katz')
  })

  it('ignores a blank company rather than naming nobody', () => {
    // referral_partners.company is nullable and the intake form does not
    // require it, so empty string and whitespace both arrive in practice.
    expect(partyName({ id: 'x', name: 'Dana Katz', email: 'd@e.com', company: '   ' }))
      .toBe('Dana Katz')
    expect(partyName({ id: 'x', name: 'Dana Katz', email: 'd@e.com', company: null }))
      .toBe('Dana Katz')
  })
})

// ============================================================
// The W-9-ONLY envelope (spec §2a). The partner signs this one from his
// dashboard, embedded, and the accountant gets a copy of the finished
// form — as a DocuSign carbon copy, never as an email we send, because
// we never hold the bytes (Risk 5, docusign-redact.ts).
// ============================================================


describe('buildW9Envelope', () => {
  it('is a draft', () => {
    expect(buildW9Envelope(w9Input).status).toBe('created')
  })

  it('sets the w9 custom field from the shared constants, by name', () => {
    const f = textCustomFieldsOf(buildW9Envelope(w9Input)).find((x) => x.name === W9_CUSTOM_FIELD)
    expect(f).toBeDefined()
    expect(f!.value).toBe(W9_INCLUDED)
  })

  it('carries the partner id so the webhook can resolve the row', () => {
    const f = textCustomFieldsOf(buildW9Envelope(w9Input)).find((x) => x.name === PARTNER_ID_FIELD)
    expect(f!.value).toBe('p1')
  })

  it('sets the account-required envelope type', () => {
    const f = textCustomFieldsOf(buildW9Envelope(w9Input)).find(
      (x) => x.name === ENVELOPE_TYPE_FIELD,
    )
    expect(f!.value).toBe(ENVELOPE_TYPE_VALUE)
  })

  it('marks itself W-9-only so the webhook does not read it as an agreement', () => {
    // Without this marker the completion looks exactly like an agreement
    // completion: re-stamped agreement_signed_at, re-sent portal invite,
    // and a partner somebody deliberately deactivated silently reactivated.
    // completedEnvelopeStamp reads THIS field; the agreement envelope
    // deliberately omits it.
    const f = textCustomFieldsOf(buildW9Envelope(w9Input)).find(
      (x) => x.name === ENVELOPE_KIND_FIELD,
    )
    expect(f).toBeDefined()
    expect(f!.value).toBe(KIND_W9_ONLY)
  })

  it('is read as a W-9 by the stamp decision it is built for', () => {
    // The two halves in one assertion: the builder's output, fed to the
    // consumer, must produce the W-9 decision. Pinning the constant alone
    // would pass even if the stamp read a different field.
    const fields = textCustomFieldsOf(buildW9Envelope(w9Input))
    const d = completedEnvelopeStamp({
      kind: fields.find((x) => x.name === ENVELOPE_KIND_FIELD)?.value ?? null,
      w9: fields.find((x) => x.name === W9_CUSTOM_FIELD)?.value ?? null,
      envelopeId: 'e1',
      now: '2026-10-14T12:00:00.000Z',
    })
    expect(d.w9Received).toBe(true)
    expect(d.agreementSigned).toBe(false)
    expect('status' in d.fields).toBe(false)
    expect(d.anomaly).toBeUndefined()
  })

  it('the agreement envelope is read as an agreement by that same decision', () => {
    // The other side of the same contract, and the reason the agreement
    // builder must NOT set either field.
    const fields = textCustomFieldsOf(build())
    const d = completedEnvelopeStamp({
      kind: fields.find((x) => x.name === ENVELOPE_KIND_FIELD)?.value ?? null,
      w9: fields.find((x) => x.name === W9_CUSTOM_FIELD)?.value ?? null,
      envelopeId: 'e1',
      now: '2026-10-14T12:00:00.000Z',
    })
    expect(d.agreementSigned).toBe(true)
    expect(d.w9Received).toBe(false)
    expect('w9_received_at' in d.fields).toBe(false)
    expect(d.anomaly).toBeUndefined()
  })

  it('carbon-copies the accountant exactly once', () => {
    const ccs = recipientsOf(buildW9Envelope(w9Input)).carbonCopies!
    expect(ccs).toHaveLength(1)
    expect(ccs[0].email).toBe('accountant@example.com')
    expect(ccs[0].name).toBe('Test Accountant')
    expect(ccs[0].recipientId).toBe(ACCOUNTANT_RECIPIENT_ID)
  })

  it('routes the carbon copy AFTER the signer', () => {
    // A CC at or before the signer's routing order gets the envelope in its
    // UNSIGNED state. The accountant would receive a blank W-9 and nothing
    // afterwards -- which looks exactly like a delivered form.
    const r = recipientsOf(buildW9Envelope(w9Input))
    const partner = r.signers.find((s) => s.recipientId === PARTNER_RECIPIENT_ID)!
    expect(Number(r.carbonCopies![0].routingOrder)).toBeGreaterThan(Number(partner.routingOrder))
  })

  it('THROWS when the accountant address is missing or blank', () => {
    // The control the spec §6 names: "A test that only checks the happy
    // path would stay green on an envelope silently CC'd to nobody."
    // ACCOUNTANT_W9_EMAIL is unset in Vercel today, so an unguarded
    // builder would have produced exactly that.
    expect(() => buildW9Envelope({ ...w9Input, accountantEmail: '' })).toThrow(/accountant/i)
    expect(() => buildW9Envelope({ ...w9Input, accountantEmail: '   ' })).toThrow(/accountant/i)
    expect(() => buildW9Envelope({ ...w9Input, accountantName: '' })).toThrow(/accountant/i)
  })

  it('sets clientUserId on the partner signer, so DocuSign sends no email', () => {
    const signer = recipientsOf(buildW9Envelope(w9Input)).signers.find(
      (s) => s.recipientId === PARTNER_RECIPIENT_ID,
    )!
    expect((signer as unknown as { clientUserId: string }).clientUserId).toBe('p1')
  })

  it('does NOT set clientUserId on anyone else', () => {
    // clientUserId is what makes a recipient "embedded": DocuSign stops
    // emailing them and expects us to produce a signing URL instead. Set it
    // on Shipo or the accountant and that person silently never hears about
    // the envelope at all.
    const r = recipientsOf(buildW9Envelope(w9Input))
    const shipo = r.signers.find((s) => s.recipientId === SHIPO_RECIPIENT_ID)
    if (shipo) expect(shipo).not.toHaveProperty('clientUserId')
    expect(r.carbonCopies![0]).not.toHaveProperty('clientUserId')
  })

  it('refuses a blank clientUserId', () => {
    // An empty string is not "no embedded signing", it is an embedded
    // recipient DocuSign cannot match -- a 400 at send time, or worse a
    // recipient who is neither emailed nor reachable by URL.
    expect(() => buildW9Envelope({ ...w9Input, clientUserId: '' })).toThrow(/clientUserId/i)
  })

  it('contains the W-9 document and no agreement template', () => {
    const env = buildW9Envelope(w9Input)
    expect(JSON.stringify(env)).not.toContain(AGREEMENT_TEMPLATE_ID)
    expect(JSON.stringify(env)).toContain('JVBERi0=')
  })

  it('kept every W-9 tab through the split out of the agreement envelope', () => {
    // Anchored in docusign-w9.ts, not in the other envelope: after Task 7
    // the agreement carries no W-9 tabs at all, so comparing the two
    // envelopes would compare this list against an EMPTY one and pass on
    // a W-9 with nothing on it.
    //
    // Why it matters that nothing was lost: DocuSign refuses to complete
    // an envelope with an unfilled REQUIRED tab, and that refusal is the
    // entire basis for the webhook stamping w9_received_at. A dropped
    // required tab turns that stamp into a claim we hold a form nobody
    // filled in.
    const labels = w9TabLabels(buildW9Envelope(w9Input))
    for (const f of W9_TEXT_FIELDS) {
      expect(labels, `lost the tab for ${f.acroform}`).toContain(`w9_${f.acroform}`)
    }
    expect(labels).toContain('w9_tin_ssn')
    expect(labels).toContain('w9_tin_ein')
    expect(labels).toContain('w9_requester')
    expect(labels).toContain('w9_line_3b')
    expect(labels).toContain(W9_TIN_GROUP)
  })

  it('refuses a foreign individual, a foreign entity and an UNSET tax status', () => {
    const at = (tax_status: string | null) => () =>
      buildW9Envelope({ ...w9Input, partner: { ...w9Input.partner, tax_status } })
    expect(at('foreign_individual')).toThrow(/W-8BEN/)
    expect(at('foreign_entity')).toThrow(/W-8BEN-E/)
    expect(at(null)).toThrow(/tax status/i)
  })

  it('builds for a US person', () => {
    // The control. Without it a builder that threw on everything would
    // satisfy every refusal above.
    expect(() => buildW9Envelope(w9Input)).not.toThrow()
  })

  it('names the partner and the form in the subject the accountant receives', () => {
    // The partner signs embedded and gets no email, so this subject line
    // exists for exactly one reader: the accountant, who will have a folder
    // of these. "Completed" with no name in it is unfileable.
    const subject = String((buildW9Envelope(w9Input) as { emailSubject: string }).emailSubject)
    expect(subject).toContain('Jane Doe')
    expect(subject).toMatch(/W-9/)
  })

  it('refuses without a partner id, name, email or document', () => {
    const bad = (over: Partial<BuildW9EnvelopeInput['partner']>) => () =>
      buildW9Envelope({ ...w9Input, partner: { ...w9Input.partner, ...over } })
    expect(bad({ id: '' })).toThrow(/id/i)
    expect(bad({ name: '  ' })).toThrow(/name/i)
    expect(bad({ email: '' })).toThrow(/email/i)
    expect(() => buildW9Envelope({ ...w9Input, w9DocumentBase64: '' })).toThrow(/w9Document/i)
  })
})
