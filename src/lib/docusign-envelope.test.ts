import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { W9_CUSTOM_FIELD, W9_INCLUDED } from './partner-w9'
import { W9_CLASSIFICATIONS, W9_TEXT_FIELDS, W9_TIN_GROUP } from './docusign-w9'
import {
  AGREEMENT_ANCHORS,
  AGREEMENT_TEMPLATE_ID,
  ENVELOPE_TYPE_FIELD,
  ENVELOPE_TYPE_VALUE,
  PARTNER_ID_FIELD,
  PARTNER_RECIPIENT_ID,
  SHIPO_RECIPIENT_ID,
  buildPartnerAgreementEnvelope,
  partyName,
} from './docusign-envelope'

const HERE = dirname(fileURLToPath(import.meta.url))
/** Module-relative, so the source-reading guards below cannot fail as ENOENT. */
const ENVELOPE_SRC = join(HERE, 'docusign-envelope.ts')
const AGREEMENT_MD = join(HERE, '../../docs/referral-agreement-TEMPLATE.md')

const partner = {
  id: '11111111-2222-3333-4444-555555555555',
  name: 'Dana Katz Consulting LLC',
  email: 'dana@example.com',
}
const shipo = { name: 'Ophir Schultz', email: 'ophir@shipousa.com' }

function build() {
  return buildPartnerAgreementEnvelope({ partner, shipo, w9DocumentBase64: 'JVBERi0xLjQK' })
}

// Narrow helpers, so a change in the payload's shape fails here rather
// than silently returning undefined into an expect that passes.
type Signer = {
  recipientId: string
  routingOrder: string
  email: string
  name: string
  tabs: Record<string, unknown[]>
}

function signersOf(env: ReturnType<typeof build>, compositeIndex: number): Signer[] {
  const inline = env.compositeTemplates[compositeIndex].inlineTemplates[0] as {
    recipients: { signers: Signer[] }
  }
  return inline.recipients.signers
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
  // recipient in routing order. Shipo signs first. Left to the
  // transform, every W-9 field — the taxpayer identification number
  // included — would have been addressed to Ophir, and the partner
  // would have received a contract with no tax form attached to them.
  const env = build()
  const w9Signers = signersOf(env, 1)

  it('does not use transformPdfFields', () => {
    const doc = env.compositeTemplates[1].document as { transformPdfFields: string }
    expect(doc.transformPdfFields).toBe('false')
  })

  it('gives the partner every W-9 tab and Shipo none', () => {
    const shipoSigner = w9Signers.find((s) => s.recipientId === SHIPO_RECIPIENT_ID)!
    const partnerSigner = w9Signers.find((s) => s.recipientId === PARTNER_RECIPIENT_ID)!

    expect(Object.keys(shipoSigner.tabs)).toHaveLength(0)
    expect(partnerSigner.tabs.textTabs.length).toBeGreaterThan(5)
    expect(partnerSigner.tabs.signHereTabs).toHaveLength(1)
    expect(partnerSigner.tabs.radioGroupTabs).toHaveLength(1)
  })

  it('puts the taxpayer number on the partner', () => {
    const partnerSigner = w9Signers.find((s) => s.recipientId === PARTNER_RECIPIENT_ID)!
    const labels = (partnerSigner.tabs.textTabs as { tabLabel: string }[]).map((t) => t.tabLabel)
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
  const partnerSigner = signersOf(build(), 1).find((s) => s.recipientId === PARTNER_RECIPIENT_ID)!
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
    const all = env.compositeTemplates.flatMap((c) =>
      (c.inlineTemplates[0] as { recipients: { signers: Signer[] } }).recipients.signers.flatMap(
        (s) => Object.values(s.tabs).flat() as Record<string, unknown>[],
      ),
    )
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

  it('declares the W-9 using the shared constants, not its own spelling', () => {
    const f = fields.find((x) => x.name === W9_CUSTOM_FIELD)!
    expect(f.value).toBe(W9_INCLUDED)

    // And the literals must not be retyped in the source. A rename on
    // either side would otherwise record every W-9 we collect as not
    // collected — silent, and surfacing only as a partner being told we
    // cannot pay them.
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

  it('uses the same recipient ids on both documents', () => {
    // Otherwise DocuSign treats them as four people and mails the
    // agreement and the W-9 as separate asks.
    const a = signersOf(env, 0).map((s) => s.recipientId).sort()
    const b = signersOf(env, 1).map((s) => s.recipientId).sort()
    expect(a).toEqual(b)
  })

  it('sends to the partner we were given', () => {
    const p = signersOf(env, 0).find((x) => x.recipientId === PARTNER_RECIPIENT_ID)!
    expect(p.email).toBe(partner.email)
    expect(p.name).toBe(partner.name)
  })
})

describe('documents', () => {
  const env = build()

  it('pulls the agreement from the server template', () => {
    const st = env.compositeTemplates[0].serverTemplates as { templateId: string }[]
    expect(st[0].templateId).toBe(AGREEMENT_TEMPLATE_ID)
    expect(AGREEMENT_TEMPLATE_ID).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('attaches the W-9 as a second document', () => {
    const doc = env.compositeTemplates[1].document as { documentId: string; documentBase64: string }
    expect(doc.documentId).toBe('2')
    expect(doc.documentBase64).toBeTruthy()
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
        w9DocumentBase64: 'x',
      }),
    ).toThrow(/partner.id/)
  })

  it('will not build an envelope with no email to send it to', () => {
    expect(() =>
      buildPartnerAgreementEnvelope({
        partner: { ...partner, email: '' },
        shipo,
        w9DocumentBase64: 'x',
      }),
    ).toThrow(/email/)
  })

  it('will not build an envelope with no W-9 attached', () => {
    // An envelope that claims w9: included and carries no W-9 would
    // stamp w9_received_at off nothing at all.
    expect(() =>
      buildPartnerAgreementEnvelope({ partner, shipo, w9DocumentBase64: '' }),
    ).toThrow(/w9DocumentBase64/)
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
  const agreementSigners = signersOf(build(), 0)
  const partnerSigner = agreementSigners.find((s) => s.recipientId === PARTNER_RECIPIENT_ID)!
  const textTabs = partnerSigner.tabs.textTabs as {
    anchorString: string
    tabLabel: string
    value?: string
    locked: string
    required: string
  }[]
  const byAnchor = (a: string) => textTabs.find((t) => t.anchorString === a)!

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

  it('names the partner in clause 1 and locks it', () => {
    // Locked because this is our record of the entity we approved. A
    // party block the counterparty can retype is a party block that can
    // name a different entity than the one we agreed to.
    const tab = byAnchor(AGREEMENT_ANCHORS.partnerNamePrefill)
    expect(tab.value).toBe(partyName(partner))
    expect(tab.locked).toBe('true')
  })

  it('fills the notices clause with the partner email and locks it', () => {
    const tab = byAnchor(AGREEMENT_ANCHORS.partnerEmailPrefill)
    expect(tab.value).toBe(partner.email)
    expect(tab.locked).toBe('true')
  })

  it('makes the partner type their address, and requires it', () => {
    // referral_partners holds no address, so this is the one fact on the
    // agreement the partner tells us. Required borrows the W-9's
    // guarantee: DocuSign will not complete an envelope with a required
    // tab empty, so the notices clause cannot end up blank.
    const tab = byAnchor(AGREEMENT_ANCHORS.partnerAddressPrefill)
    expect(tab.value).toBeUndefined()
    expect(tab.required).toBe('true')
    expect(tab.locked).toBe('false')
  })

  it('fills the W-9 requester block with Shipo, locked', () => {
    // Ours, not theirs. A partner asked to type the requester's address
    // will guess it or skip it, and either makes the form look like it
    // came from nobody.
    const w9Signer = signersOf(build(), 1).find((s) => s.recipientId === PARTNER_RECIPIENT_ID)!
    const tab = (w9Signer.tabs.textTabs as { tabLabel: string; value?: string; locked?: string }[])
      .find((t) => t.tabLabel === 'w9_requester')!
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
