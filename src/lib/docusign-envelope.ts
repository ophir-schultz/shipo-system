// Builds the envelope that gets a partner signed up: the Referral
// Partner Agreement plus a blank IRS Form W-9, in one sitting.
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
  /** Page 1 of the IRS W-9, base64. See w9Page1Base64 in the send script. */
  w9DocumentBase64: string
  /**
   * Absolute HTTPS URL DocuSign POSTs envelope events to. Required —
   * if omitted, the envelope ships without an `eventNotification` and
   * the partner-promotion webhook (`/api/partner/agreement-webhook`)
   * never fires on completion, which looks healthy from the sender's
   * side and silently never promotes anyone. Pattern:
   * `${NEXT_PUBLIC_SITE_URL}/api/partner/agreement-webhook`. HMAC-signed
   * by DocuSign using the account-level HMAC key (one key is enough;
   * configured once at Admin → Connect → Connect Keys, verified in the
   * route against DOCUSIGN_CONNECT_SECRET). There is no per-envelope
   * HMAC key — this field only names WHERE events go, not how they are
   * signed.
   */
  webhookUrl: string
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

/** Tabs the partner fills on the W-9. Every one of them is explicit. */
function w9PartnerTabs() {
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
 * The envelope, as a draft.
 *
 * Two composite templates, because the two documents come from
 * different places: the agreement from the server template, the W-9 as
 * bytes. Recipient ids are shared across both so DocuSign treats them
 * as the same two people rather than four.
 */
export function buildPartnerAgreementEnvelope(input: BuildEnvelopeInput) {
  const { partner, shipo, w9DocumentBase64, webhookUrl } = input

  if (!partner.id) throw new Error('buildPartnerAgreementEnvelope: partner.id is required')
  if (!partner.name?.trim()) throw new Error('buildPartnerAgreementEnvelope: partner.name is required')
  if (!partner.email?.trim()) throw new Error('buildPartnerAgreementEnvelope: partner.email is required')
  if (!w9DocumentBase64) throw new Error('buildPartnerAgreementEnvelope: w9DocumentBase64 is required')
  // webhookUrl is required at the type level and asserted at runtime
  // because a quietly-missing eventNotification would ship — the
  // envelope sends, DocuSign silently has nowhere to deliver completion
  // events, and the partner would stay 'pending' forever. HTTPS is
  // enforced because DocuSign refuses to deliver to plain HTTP.
  if (!webhookUrl?.trim()) throw new Error('buildPartnerAgreementEnvelope: webhookUrl is required')
  if (!/^https:\/\//.test(webhookUrl)) {
    throw new Error('buildPartnerAgreementEnvelope: webhookUrl must be https://')
  }

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
    emailBlurb:
      'Please review and sign the Shipo Referral Partner Agreement. ' +
      'The second page is a blank IRS Form W-9 — we need it on file before we can pay you, ' +
      'so completing it here saves a second round trip.',

    // A draft. Always. Reviewed before it reaches anybody.
    status: 'created',

    // The webhook that promotes the partner on completion. Travels on
    // the envelope rather than relying on an account-level Connect
    // listener because (1) the account listener was the single config
    // step most likely to be forgotten and (2) a per-envelope config
    // means a test envelope cannot accidentally fire against the
    // production endpoint — the webhook URL is whatever this build
    // was handed. Events match the webhook route's switch: completed,
    // declined, voided. `loggingEnabled: 'true'` keeps the delivery
    // visible under Connect → Logs when debugging a stuck envelope.
    // `requireAcknowledgment: 'true'` makes DocuSign retry on a 5xx —
    // without it, a transient outage silently loses the completion.
    eventNotification: {
      url: webhookUrl,
      loggingEnabled: 'true',
      requireAcknowledgment: 'true',
      envelopeEvents: [
        { envelopeEventStatusCode: 'completed' },
        { envelopeEventStatusCode: 'declined' },
        { envelopeEventStatusCode: 'voided' },
      ],
    },

    customFields: {
      textCustomFields: [
        // How the webhook finds the partner row. Ours, so the signer
        // cannot alter it — which is why resolvePartner trusts it over
        // the signer's email address.
        { name: PARTNER_ID_FIELD, value: partner.id, show: 'false', required: 'false' },
        // The evidence the webhook stamps w9_received_at on. Taken from
        // the shared constants, never spelled out here, so a rename on
        // either side is a failed build rather than a W-9 recorded as
        // never received.
        { name: W9_CUSTOM_FIELD, value: W9_INCLUDED, show: 'false', required: 'false' },
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
      {
        compositeTemplateId: '2',
        document: {
          documentId: '2',
          name: 'IRS Form W-9',
          fileExtension: 'pdf',
          documentBase64: w9DocumentBase64,
          // NOT transformPdfFields. See the header: the transform would
          // assign every field — the TIN included — to routing order 1,
          // which is Shipo.
          transformPdfFields: 'false',
        },
        inlineTemplates: [
          {
            sequence: '1',
            recipients: {
              signers: [
                // Shipo is listed so the routing order is unambiguous
                // across both documents, but holds no tabs on the W-9.
                // It is the partner's tax form, not ours to fill.
                { ...shipoSigner, tabs: {} },
                { ...partnerSigner, tabs: w9PartnerTabs() },
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
