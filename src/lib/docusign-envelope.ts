// Builds the two envelopes a partner signs: the Referral Partner
// Agreement (buildPartnerAgreementEnvelope) and, separately, a blank
// IRS Form W-9 carbon-copied to the accountant (buildW9Envelope).
//
// They were one envelope until Task 7. Splitting them costs a second
// round trip and buys three things: the accountant can be copied on the
// tax form without seeing the agreement's confidential commission terms
// (§6), the W-9 can be re-collected without re-signing the contract,
// and the two completions can stamp different columns — which the
// combined envelope could not, since one completion meant both.
//
// Nothing in this file talks to DocuSign. It builds a payload, and the
// send happens through the DocuSign MCP. That split is on purpose: the
// app holds no DocuSign credentials, so a route that sent envelopes
// could not run anyway. What the app CAN own is the shape of the
// envelope — and the shape is where the costly mistakes live, because
// an envelope is wrong only once you have emailed it to a partner.
//
// Three invariants are encoded here and asserted in the test file:
//
//   1. W-9 tabs are REQUIRED. The webhook stamps w9_received_at from
//      "completed AND carried a W-9"; that is only sound because
//      DocuSign refuses to complete an envelope with a required tab
//      unfilled. See docusign-w9.ts.
//   2. W-9 tabs belong to the PARTNER. DocuSign's transformPdfFields
//      assigns converted PDF fields to the first recipient by routing
//      order, which here is Shipo — so the transform is NOT used, and
//      every tab is declared against the partner explicitly. Left to
//      the transform, we would have mailed Ophir a request for the
//      partner's SSN.
//   3. status is 'created'. A draft, every time, reviewed before it
//      goes anywhere.

import { W9_CUSTOM_FIELD, W9_INCLUDED } from './partner-w9'
import { ENVELOPE_KIND_FIELD, KIND_W9_ONLY } from './partner-envelope-stamp'
import { taxStatusOf, w9Refusal } from './partner-tax-status'
import {
  W9_CLASSIFICATIONS,
  W9_CLASSIFICATION_GROUP,
  W9_LINE_3B,
  W9_PAGE,
  W9_REQUESTER_BOX,
  W9_REQUESTER_TEXT,
  W9_SIGNATURE_ANCHOR,
  W9_SIGNATURE_DATE_X_OFFSET,
  W9_SIGNATURE_X_OFFSET,
  W9_SIGNATURE_Y_OFFSET,
  W9_TEXT_FIELDS,
  W9_TIN_EIN,
  W9_TIN_GROUP,
  W9_TIN_SSN,
} from './docusign-w9'

/**
 * The server template holding the agreement PDF. Created 2026-10-13 in
 * the Shipo DocuSign account; 8 pages, document name
 * referral-agreement-TEMPLATE.pdf.
 *
 * We use the template as a DOCUMENT HOLDER: the inline template below
 * supplies the recipients and every tab, because the signer who matters
 * varies per envelope and the template's does not.
 */
export const AGREEMENT_TEMPLATE_ID = 'bba422c1-329e-4a60-ad32-0327e0d13672'

/**
 * The template's OWN role names — not labels we are free to pick.
 *
 * A composite template matches inline recipients to the server
 * template's recipients by role name. Matching replaces the template's
 * recipient; NOT matching adds a new one beside it. So a role name we
 * invented does not override anything, it supplements.
 *
 * Measured against the live account on 2026-10-15, preparing the first
 * real envelope: built with roleName 'Shipo' it came back with THREE
 * recipients — the template's CEO (Ophir), our Shipo (Ophir again), and
 * the partner. Ophir would have had to sign the same contract twice,
 * and until he did the envelope could not complete, so the webhook
 * would never have activated the partner. Built with 'CEO' it comes
 * back with two.
 *
 * Change these only to follow a change in the template.
 */
export const AGREEMENT_SHIPO_ROLE = 'CEO'
export const AGREEMENT_PARTNER_ROLE = 'Partner'

/**
 * An account-level envelope custom field marked required:true on the
 * template. It has to be carried on every envelope we build or the send
 * is rejected — and the rejection would arrive on envelope number two,
 * long after this looked like it worked.
 */
export const ENVELOPE_TYPE_FIELD = 'envelopeTypes'
export const ENVELOPE_TYPE_VALUE = 'PartnershipAgreements'

/** The field the webhook reads to find the partner row. */
export const PARTNER_ID_FIELD = 'partner_id'

/**
 * Anchor strings printed in the agreement PDF. Verified present in the
 * extracted text layer of docs/referral-agreement-TEMPLATE.pdf — which
 * is the layer DocuSign itself searches, so "it is in the markdown" is
 * not evidence. docusign-envelope.test.ts re-checks the PDF.
 */
export const AGREEMENT_ANCHORS = {
  shipoSignature: '\\s1\\',
  shipoName: '\\n1\\',
  shipoDate: '\\d1\\',
  partnerSignature: '\\s2\\',
  partnerName: '\\n2\\',
  partnerDate: '\\d2\\',
  /** Appears twice — the parties block and the signature heading. */
  partnerNamePrefill: '\\pname\\',
  /**
   * Clause 1: 'with its address at \paddr\ ("Partner")'. The partner
   * types this, because referral_partners has no address column — see
   * agreementPartnerTabs for why it is nonetheless REQUIRED.
   */
  partnerAddressPrefill: '\\paddr\\',
  /** The notices clause: 'Notices to Partner may be given at \pemail\'. */
  partnerEmailPrefill: '\\pemail\\',
} as const

export const SHIPO_RECIPIENT_ID = '1'
export const PARTNER_RECIPIENT_ID = '2'
/**
 * The accountant, on the W-9-only envelope. A carbon copy, never a signer:
 * see buildW9Envelope.
 */
export const ACCOUNTANT_RECIPIENT_ID = '3'

export interface EnvelopePartner {
  id: string
  /** The human who signs. Goes over the signature, not in clause 1. */
  name: string
  email: string
  /**
   * The contracting entity, if there is one. referral_partners keeps the
   * person in `name` and the business in `company`, and clause 1 wants
   * the business: an agency's principal signs, but the agency is the
   * Party. Falls back to `name` for a sole trader, who is both.
   */
  company?: string | null
  /**
   * 'us_person' | 'foreign_individual' | 'foreign_entity', or null/absent
   * when nobody has recorded it. See partner-tax-status.ts: anything but a
   * US person REFUSES this builder, because the W-9 bundled here is the
   * wrong IRS form for them. Typed as a loose string because it arrives
   * straight off a Supabase row; taxStatusOf() narrows it.
   */
  tax_status?: string | null
}

/** Who clause 1 names as "Partner". See EnvelopePartner.company. */
export function partyName(partner: EnvelopePartner): string {
  return partner.company?.trim() || partner.name.trim()
}

export interface EnvelopeSigner {
  name: string
  email: string
}

export interface BuildEnvelopeInput {
  partner: EnvelopePartner
  /** Whoever signs for Shipo. Routing order 1 — they sign first. */
  shipo: EnvelopeSigner
}

/**
 * Anchored tab. `anchorIgnoreIfNotPresent` is 'false' on purpose: if the
 * anchor is ever missing from the document we want DocuSign to refuse
 * the envelope, not to quietly place no signature field and hand us an
 * agreement that can be "completed" without being signed.
 */
function anchored(anchorString: string, extra: Record<string, unknown> = {}) {
  return {
    anchorString,
    anchorUnits: 'pixels',
    anchorXOffset: '0',
    anchorYOffset: '0',
    anchorIgnoreIfNotPresent: 'false',
    ...extra,
  }
}

/**
 * The partner's tabs on the AGREEMENT (document 1).
 *
 * Three of these fill blanks in the contract prose rather than collecting
 * a signature, and they exist because of how the template is built: the
 * counterparty's details are not typed into the file — that would mean a
 * fresh copy of the whole agreement, and all its figures, per partner —
 * they are DocuSign anchors filled at send time.
 *
 * The anchors are rendered WHITE by scripts/build-agreement-pdf.mjs, so
 * they are in the text layer DocuSign searches and invisible on paper.
 * The consequence is that an unfilled anchor leaves no trace: clause 1
 * reads 'with its address at  ("Partner")' and the notices clause reads
 * 'Notices to Partner may be given at .' Both look like sloppy drafting
 * rather than a bug, on an executed contract, which is why these are
 * tabs and not a TODO.
 *
 * Name and email are LOCKED: they are our record of who we approved, and
 * a party block the counterparty can retype is a party block that can
 * name a different entity than the one we agreed to.
 *
 * The address is the partner's to type, and REQUIRED. We hold no address
 * for them — referral_partners has name/company/email/phone and nothing
 * else — so the alternatives were an empty notices clause or blocking
 * every send on data we would have to collect by email first. Required
 * borrows the W-9's guarantee: DocuSign will not complete an envelope
 * with a required tab empty, so the clause cannot end up blank.
 */
function agreementPartnerTabs(partner: EnvelopePartner) {
  return {
    signHereTabs: [anchored(AGREEMENT_ANCHORS.partnerSignature, { documentId: '1' })],
    fullNameTabs: [anchored(AGREEMENT_ANCHORS.partnerName, { documentId: '1' })],
    dateSignedTabs: [anchored(AGREEMENT_ANCHORS.partnerDate, { documentId: '1' })],
    textTabs: [
      anchored(AGREEMENT_ANCHORS.partnerNamePrefill, {
        documentId: '1',
        tabLabel: 'agreement_partner_name',
        value: partyName(partner),
        locked: 'true',
        required: 'false',
        width: '260',
        font: 'georgia',
        fontSize: 'size11',
        bold: 'true',
      }),
      anchored(AGREEMENT_ANCHORS.partnerEmailPrefill, {
        documentId: '1',
        tabLabel: 'agreement_partner_email',
        value: partner.email.trim(),
        locked: 'true',
        required: 'false',
        width: '220',
        font: 'georgia',
        fontSize: 'size11',
      }),
      anchored(AGREEMENT_ANCHORS.partnerAddressPrefill, {
        documentId: '1',
        tabLabel: 'agreement_partner_address',
        // No value: this is the one thing on the agreement the partner
        // tells US. Required, so the notices clause cannot ship blank.
        required: 'true',
        locked: 'false',
        width: '260',
        font: 'georgia',
        fontSize: 'size11',
      }),
    ],
  }
}

function w9Tab(box: { x: number; y: number; w: number; h: number }, extra: Record<string, unknown>) {
  return {
    documentId: '2',
    pageNumber: String(W9_PAGE),
    xPosition: String(Math.round(box.x)),
    yPosition: String(Math.round(box.y)),
    width: String(Math.round(box.w)),
    height: String(Math.round(box.h)),
    ...extra,
  }
}

/**
 * Tabs the partner fills on the W-9. Every one of them is explicit.
 *
 * Exported so the W-9-only envelope below uses THIS list rather than a
 * second copy of it. Required tabs are the whole basis for trusting a
 * `completed` envelope: DocuSign will not complete one with a required tab
 * unfilled, and the webhook stamps w9_received_at off that completion. Two
 * copies of the list means one of them can quietly lose a tab, and then the
 * stamp says "we have his W-9" about a form with no TIN on it.
 */
export function w9PartnerTabs() {
  const textTabs = W9_TEXT_FIELDS.map((f) =>
    w9Tab(f, {
      tabLabel: `w9_${f.acroform}`,
      name: f.label,
      required: f.required ? 'true' : 'false',
      font: 'helvetica',
      fontSize: 'size10',
    }),
  )

  // The TIN rows. Neither is required alone; the group below makes one
  // of the two compulsory. See docusign-w9.ts for why this is not five
  // tabs matching the five printed boxes.
  const tinTabs = [
    w9Tab(W9_TIN_SSN, {
      tabLabel: 'w9_tin_ssn',
      name: 'Social security number',
      required: 'false',
      font: 'helvetica',
      fontSize: 'size12',
      tabGroupLabels: [W9_TIN_GROUP],
    }),
    w9Tab(W9_TIN_EIN, {
      tabLabel: 'w9_tin_ein',
      name: 'Employer identification number',
      required: 'false',
      font: 'helvetica',
      fontSize: 'size12',
      tabGroupLabels: [W9_TIN_GROUP],
    }),
  ]

  // The requester block — line 'Requester's name and address'. OURS, so
  // it is filled and locked rather than offered as an empty box: a
  // partner asked to type the requester's address will guess it or skip
  // it, and either makes the form look like it came from nobody. Locked
  // because it is not a fact about them that they could correct.
  const requesterTab = w9Tab(W9_REQUESTER_BOX, {
    tabLabel: 'w9_requester',
    name: "Requester's name and address",
    value: W9_REQUESTER_TEXT,
    locked: 'true',
    required: 'false',
    font: 'helvetica',
    fontSize: 'size9',
  })

  return {
    textTabs: [...textTabs, ...tinTabs, requesterTab],

    radioGroupTabs: [
      {
        documentId: '2',
        groupName: W9_CLASSIFICATION_GROUP,
        // Exactly one classification, enforced by DocuSign rather than
        // by hoping. An untiered W-9 is one the IRS does not accept.
        requireInitialOnSharedChange: 'false',
        shared: 'false',
        radios: W9_CLASSIFICATIONS.map((c) => ({
          pageNumber: String(W9_PAGE),
          xPosition: String(Math.round(c.x)),
          yPosition: String(Math.round(c.y)),
          value: c.value,
          required: 'true',
        })),
      },
    ],

    checkboxTabs: [
      w9Tab(W9_LINE_3B, {
        tabLabel: 'w9_line_3b',
        name: 'Flow-through entity with foreign partners',
        required: 'false',
        selected: 'false',
      }),
    ],

    signHereTabs: [
      {
        documentId: '2',
        anchorString: W9_SIGNATURE_ANCHOR,
        anchorUnits: 'pixels',
        anchorXOffset: String(W9_SIGNATURE_X_OFFSET),
        anchorYOffset: String(W9_SIGNATURE_Y_OFFSET),
        anchorIgnoreIfNotPresent: 'false',
      },
    ],

    dateSignedTabs: [
      {
        documentId: '2',
        anchorString: W9_SIGNATURE_ANCHOR,
        anchorUnits: 'pixels',
        anchorXOffset: String(W9_SIGNATURE_DATE_X_OFFSET),
        anchorYOffset: String(W9_SIGNATURE_Y_OFFSET),
        anchorIgnoreIfNotPresent: 'false',
      },
    ],

    tabGroups: [
      {
        documentId: '2',
        pageNumber: String(W9_PAGE),
        groupLabel: W9_TIN_GROUP,
        groupRule: 'SelectAtLeast',
        minimumRequired: '1',
        maximumAllowed: '2',
        tabScope: 'Document',
        xPosition: String(Math.round(W9_TIN_SSN.x)),
        yPosition: String(Math.round(W9_TIN_SSN.y)),
      },
    ],
  }
}

/**
 * The agreement envelope, as a draft.
 *
 * ONE document, since Task 7 split the W-9 out into buildW9Envelope
 * (spec §2a.3). The agreement is signed once, at onboarding; the W-9 is
 * a tax form that may be re-collected, goes to the accountant, and must
 * not drag the agreement's confidential commission terms along with it.
 */
export function buildPartnerAgreementEnvelope(input: BuildEnvelopeInput) {
  const { partner, shipo } = input

  if (!partner.id) throw new Error('buildPartnerAgreementEnvelope: partner.id is required')
  if (!partner.name?.trim()) throw new Error('buildPartnerAgreementEnvelope: partner.name is required')
  if (!partner.email?.trim()) throw new Error('buildPartnerAgreementEnvelope: partner.email is required')

  // US PERSONS ONLY, AND THE CHECK IS HERE RATHER THAN AT THE CALL SITE
  // (spec §2a.7). The guard stays on this builder even though the W-9 is
  // no longer attached: a partner we cannot collect a W-9 from is a
  // partner we cannot pay, so sending them the agreement promises a
  // commission we have no lawful way to disburse. Neither W-8 path is
  // built, deliberately, so the only correct behaviour is to refuse the
  // agreement too.
  //
  // It sits above every line that assembles a document or a tab, so a
  // refusal cannot leave a half-built envelope for a caller to send. A
  // guard that runs after assembly protects nothing an exception does not
  // already -- but it does invite someone to "just use the part that got
  // built".
  const refusal = w9Refusal(taxStatusOf(partner.tax_status))
  if (refusal) throw new Error(`buildPartnerAgreementEnvelope: ${refusal}`)

  const shipoSigner = {
    recipientId: SHIPO_RECIPIENT_ID,
    name: shipo.name,
    email: shipo.email,
    // Shipo signs FIRST. The envelope then completes the moment the
    // partner finishes, so the webhook activates them with no further
    // action from us. The other order works too, but it leaves a signed
    // partner locked out of their own portal until someone countersigns.
    routingOrder: '1',
    roleName: AGREEMENT_SHIPO_ROLE,
  }

  const partnerSigner = {
    recipientId: PARTNER_RECIPIENT_ID,
    name: partner.name,
    email: partner.email,
    routingOrder: '2',
    roleName: AGREEMENT_PARTNER_ROLE,
  }

  return {
    emailSubject: `Shipo Referral Partner Agreement — ${partner.name}`,
    // No mention of the W-9. It is a separate envelope now (§2a.3), and
    // the partner completes it in their dashboard — telling them it is
    // attached here would send them looking for a page that is not there.
    emailBlurb:
      'Please review and sign the Shipo Referral Partner Agreement. ' +
      'Once both parties have signed you will receive a link to your partner portal.',

    // A draft. Always. Reviewed before it reaches anybody.
    status: 'created',

    customFields: {
      textCustomFields: [
        // How the webhook finds the partner row. Ours, so the signer
        // cannot alter it — which is why resolvePartner trusts it over
        // the signer's email address.
        { name: PARTNER_ID_FIELD, value: partner.id, show: 'false', required: 'false' },
        // No W9_CUSTOM_FIELD here, deliberately. That field is the
        // evidence the webhook stamps w9_received_at on, and this
        // envelope no longer carries a W-9. Setting it would stamp "we
        // hold his tax form" off a document that does not exist.
        //
        // No ENVELOPE_KIND_FIELD either: absent means agreement, which
        // is what keeps the combined envelope already in flight working.
        // See completedEnvelopeStamp.
        //
        // Required by the account. Omit it and the send is rejected.
        {
          name: ENVELOPE_TYPE_FIELD,
          value: ENVELOPE_TYPE_VALUE,
          show: 'false',
          required: 'true',
        },
      ],
    },

    compositeTemplates: [
      {
        compositeTemplateId: '1',
        serverTemplates: [{ sequence: '1', templateId: AGREEMENT_TEMPLATE_ID }],
        inlineTemplates: [
          {
            sequence: '2',
            recipients: {
              signers: [
                {
                  ...shipoSigner,
                  tabs: {
                    signHereTabs: [anchored(AGREEMENT_ANCHORS.shipoSignature, { documentId: '1' })],
                    dateSignedTabs: [anchored(AGREEMENT_ANCHORS.shipoDate, { documentId: '1' })],
                  },
                },
                {
                  ...partnerSigner,
                  tabs: agreementPartnerTabs(partner),
                },
              ],
            },
            documents: [],
          },
        ],
      },
    ],
  }
}

export interface BuildW9EnvelopeInput {
  partner: EnvelopePartner
  /** Page 1 of the IRS W-9, base64. Same bytes the agreement bundle uses. */
  w9DocumentBase64: string
  /**
   * ACCOUNTANT_W9_EMAIL. Configuration, never a literal in this repo: the
   * accountant is a person who can change, and a hardcoded address would
   * keep mailing tax forms to whoever used to hold the job.
   */
  accountantEmail: string
  /** A named human at the firm, not "Accounting". DocuSign shows this. */
  accountantName: string
  /**
   * What makes the partner an EMBEDDED signer. DocuSign stops emailing a
   * recipient that carries one and expects a recipient-view URL instead,
   * which is how the dashboard opens the form in place. We use the partner
   * row id — stable, and already what the webhook resolves on.
   */
  clientUserId: string
}

/**
 * The W-9 on its own, as a draft, for a partner who already signed the
 * agreement (spec §2a).
 *
 * WHY THIS IS SEPARATE FROM THE AGREEMENT ENVELOPE. The agreement is signed
 * once, before anything; the W-9 is signed from the dashboard, is due again
 * whenever the partner's details change, and — the reason that forces the
 * split — must reach the accountant, which the agreement must NOT, because
 * §6 makes the commission terms confidential. One envelope carrying both
 * documents cannot copy a third party on only one of them.
 *
 * THE ACCOUNTANT IS A CARBON COPY, NOT SOMETHING WE SEND. We never fetch
 * the signed PDF into this process and never attach it to an email of our
 * own: a completed W-9 carries a TIN, and the only safe number of copies of
 * a TIN in our logs, our mail provider and our storage is zero. DocuSign
 * holds the bytes and delivers them. See docusign-redact.ts and Risk 5.
 *
 * SHIPO IS NOT A RECIPIENT HERE. On the agreement envelope Shipo is listed
 * on both composite templates so the routing order is unambiguous across
 * two documents. This envelope has one document and nothing for Shipo to
 * sign, and a tabless signer is not free: DocuSign emails them and waits
 * for them to click Finish before the envelope completes. Completion is
 * what releases the accountant's copy and what the webhook stamps
 * w9_received_at on, so listing Shipo would park a finished W-9 behind a
 * click nobody is waiting for.
 */
export function buildW9Envelope(input: BuildW9EnvelopeInput) {
  const { partner, w9DocumentBase64, accountantEmail, accountantName, clientUserId } = input

  if (!partner.id) throw new Error('buildW9Envelope: partner.id is required')
  if (!partner.name?.trim()) throw new Error('buildW9Envelope: partner.name is required')
  if (!partner.email?.trim()) throw new Error('buildW9Envelope: partner.email is required')
  if (!w9DocumentBase64) throw new Error('buildW9Envelope: w9DocumentBase64 is required')

  // Same refusal as the agreement builder, same reason (§2a.7): a W-9 is
  // the wrong form for anyone who is not a US person, and a signed wrong
  // form is a false certification in our file.
  const refusal = w9Refusal(taxStatusOf(partner.tax_status))
  if (refusal) throw new Error(`buildW9Envelope: ${refusal}`)

  // ACCOUNTANT_W9_EMAIL is unset in Vercel today. Without this guard the
  // builder would happily produce an envelope carbon-copied to nobody --
  // which completes, stamps w9_received_at, and looks in every way like a
  // W-9 that reached the accountant.
  if (!accountantEmail?.trim()) {
    throw new Error('buildW9Envelope: accountantEmail is required (ACCOUNTANT_W9_EMAIL)')
  }
  if (!accountantName?.trim()) {
    throw new Error('buildW9Envelope: accountantName is required (a named human at the firm)')
  }

  // An empty clientUserId is not "not embedded". It is an embedded
  // recipient DocuSign cannot match: a 400 at send time if we are lucky,
  // and a recipient who is neither emailed nor reachable by URL if we are
  // not.
  if (!clientUserId?.trim()) throw new Error('buildW9Envelope: clientUserId is required')

  return {
    // The partner signs embedded and is never emailed, so this subject has
    // exactly one reader: the accountant, who will hold a folder of them.
    emailSubject: `IRS Form W-9 — ${partner.name} (Shipo referral partner)`,
    emailBlurb:
      'Attached is the completed IRS Form W-9 for a Shipo referral partner, ' +
      'signed electronically. No action is needed — this copy is for your records.',

    // A draft. Always. Nothing in this repo sends it.
    status: 'created',

    customFields: {
      textCustomFields: [
        { name: PARTNER_ID_FIELD, value: partner.id, show: 'false', required: 'false' },
        // The evidence the webhook stamps w9_received_at on, taken from the
        // shared constants so a rename breaks the build rather than
        // recording a received W-9 as never received.
        { name: W9_CUSTOM_FIELD, value: W9_INCLUDED, show: 'false', required: 'false' },
        // WHAT KEEPS THIS COMPLETION FROM BEING READ AS AN AGREEMENT.
        // Without it the webhook re-stamps agreement_signed_at onto a date
        // no contract was signed on, re-sends the portal invite, and
        // re-activates a partner somebody had deliberately set inactive.
        // See completedEnvelopeStamp.
        // WHAT KEEPS THIS COMPLETION FROM BEING READ AS AN AGREEMENT.
        // Without it the webhook re-stamps agreement_signed_at onto a date
        // no contract was signed on, re-sends the portal invite, and
        // re-activates a partner somebody had deliberately set inactive.
        // See completedEnvelopeStamp.
        { name: ENVELOPE_KIND_FIELD, value: KIND_W9_ONLY, show: 'false', required: 'false' },
        // Required by the account. Omit it and the send is rejected.
        { name: ENVELOPE_TYPE_FIELD, value: ENVELOPE_TYPE_VALUE, show: 'false', required: 'true' },
      ],
    },

    compositeTemplates: [
      {
        compositeTemplateId: '1',
        document: {
          // '2', not '1', because w9Tab() positions every tab against
          // documentId '2' -- the id the W-9 carries in the agreement
          // bundle. Renumbering the document here would leave every tab
          // pointing at a document that does not exist in this envelope.
          documentId: '2',
          name: 'IRS Form W-9',
          fileExtension: 'pdf',
          documentBase64: w9DocumentBase64,
          // NOT transformPdfFields: the transform assigns every AcroForm
          // field -- the TIN included -- to routing order 1.
          transformPdfFields: 'false',
        },
        inlineTemplates: [
          {
            sequence: '1',
            recipients: {
              signers: [
                {
                  recipientId: PARTNER_RECIPIENT_ID,
                  name: partner.name,
                  email: partner.email,
                  routingOrder: '1',
                  roleName: 'Partner',
                  clientUserId,
                  tabs: w9PartnerTabs(),
                },
              ],
              carbonCopies: [
                {
                  recipientId: ACCOUNTANT_RECIPIENT_ID,
                  name: accountantName,
                  email: accountantEmail,
                  // AFTER the signer. A carbon copy at or before the
                  // signer's routing order receives the envelope in its
                  // UNSIGNED state -- the accountant would be sent a blank
                  // form and nothing afterwards, which is indistinguishable
                  // from a delivered one.
                  routingOrder: '2',
                },
              ],
            },
          },
        ],
      },
    ],
  }
}

// There was a prefillValues() here, and deleting it is the point.
//
// It returned the values to fill keyed by anchor, for a send script to
// apply "however this API version wants". But the tabs now carry their
// own values, so it was a second place the same facts were written —
// and it had already drifted: it said partner.name where clause 1 needs
// partyName(partner), which for an agency is the principal's name in
// the box reserved for the agency. Nothing consumed it, so nothing
// caught that. A helper whose only job is to restate what the tabs
// already own cannot be kept honest; the tabs are the single source.

export { W9_REQUESTER_BOX }
