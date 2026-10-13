// Where the fields are on page 1 of IRS Form W-9.
//
// Every number in this file was MEASURED off docs/irs-fw9.pdf — the
// AcroForm widget rectangles, converted from PDF coordinates (origin
// bottom-left) to DocuSign's (origin top-left). None of it is estimated
// from a picture of the form, because a tab placed 20pt off does not
// look wrong in a payload; it looks wrong to the partner, on a tax
// form, after we have already emailed it to them.
//
// The failure this file exists to prevent is the one with no symptom:
// the IRS revises Form W-9, someone drops the new PDF in, and every
// coordinate here silently points at blank paper. W9_PDF_SHA256 below
// is what makes that loud — see docusign-w9.test.ts.
//
// To re-derive after a form revision:
//
//   python3 -c "
//   import pypdf
//   r = pypdf.PdfReader('docs/irs-fw9.pdf'); p = r.pages[0]
//   ph = float(p.mediabox.height)
//   for a in p['/Annots'].get_object():
//       o = a.get_object()
//       n=[]; x=o
//       while x is not None:
//           if x.get('/T'): n.insert(0, str(x.get('/T')))
//           par = x.get('/Parent'); x = par.get_object() if par else None
//       r4=[float(v) for v in o['/Rect']]
//       print(n[-1], r4[0], ph-r4[3], r4[2]-r4[0], r4[3]-r4[1])"
//

/** SHA-256 of the docs/irs-fw9.pdf these coordinates were taken from. */
export const W9_PDF_SHA256 =
  '2d420cbb4123dcf1fb82595b2359cfbb5d81f00b9df9d359fcc7af361d093f53'

/** Page 1 is US Letter. Asserted, so a form on A4 cannot pass silently. */
export const W9_PAGE_WIDTH = 612
export const W9_PAGE_HEIGHT = 792

/**
 * The W-9 is 6 pages; pages 2-6 are IRS instructions. We send page 1
 * only. The certification the signer actually attests to is entirely on
 * page 1, and bolting five pages of instructions onto an 8-page contract
 * buys nothing but scrolling.
 */
export const W9_PAGE = 1

export interface W9Box {
  /** Points from the LEFT edge of the page. */
  x: number
  /** Points from the TOP edge of the page — DocuSign's axis, not the PDF's. */
  y: number
  w: number
  h: number
}

/** A field the partner fills, or that we fill for them. */
export interface W9Field extends W9Box {
  /** The AcroForm name it was measured from, so the derivation is checkable. */
  acroform: string
  /** What the line is called on the form, for the tab label. */
  label: string
  required: boolean
}

/**
 * Text fields the PARTNER completes.
 *
 * `required` is not a style choice. src/app/api/partner/agreement-webhook
 * stamps w9_received_at on the strength of "the envelope completed AND it
 * carried a W-9", and that inference is only sound because DocuSign will
 * not complete an envelope with a required tab left empty. Relax a
 * `required: true` here and that timestamp becomes a claim we hold a form
 * we have not read — which authorises a payout we cannot file a 1099-NEC
 * for. docusign-envelope.test.ts asserts the required set by name.
 */
export const W9_TEXT_FIELDS: readonly W9Field[] = [
  {
    acroform: 'f1_01',
    label: 'Name of entity/individual',
    x: 58.6,
    y: 118.0,
    w: 517.4,
    h: 14,
    required: true,
  },
  {
    acroform: 'f1_02',
    label: 'Business name/disregarded entity name',
    x: 58.6,
    y: 142.0,
    w: 517.4,
    h: 14,
    required: false,
  },
  {
    acroform: 'f1_03',
    label: 'LLC tax classification (C, S, or P)',
    x: 417.6,
    y: 192.0,
    w: 28.8,
    h: 11,
    required: false,
  },
  {
    acroform: 'f1_04',
    label: 'Other classification',
    x: 162.4,
    y: 228.0,
    w: 284.0,
    h: 12,
    required: false,
  },
  {
    acroform: 'f1_05',
    label: 'Exempt payee code',
    x: 543.6,
    y: 192.0,
    w: 32.4,
    h: 12,
    required: false,
  },
  {
    acroform: 'f1_06',
    label: 'FATCA exemption code',
    x: 500.6,
    y: 228.0,
    w: 75.4,
    h: 12,
    required: false,
  },
  {
    acroform: 'f1_07',
    label: 'Address (number, street, apt or suite)',
    x: 58.6,
    y: 286.0,
    w: 329.4,
    h: 14,
    required: true,
  },
  {
    acroform: 'f1_08',
    label: 'City, state, and ZIP code',
    x: 58.6,
    y: 310.0,
    w: 329.4,
    h: 14,
    required: true,
  },
  {
    acroform: 'f1_10',
    label: 'Account numbers',
    x: 58.6,
    y: 334.0,
    w: 517.4,
    h: 14,
    required: false,
  },
]

/**
 * Line 3a — entity classification. Exactly one must be ticked, which is
 * what a DocuSign radio GROUP enforces and seven independent checkboxes
 * do not. Seven checkboxes would let a partner tick none, or tick both
 * "Individual" and "C corporation", and we would have a completed
 * envelope carrying a W-9 the IRS does not accept.
 */
export const W9_CLASSIFICATION_GROUP = 'w9_tax_classification'

export const W9_CLASSIFICATIONS: readonly (W9Box & { value: string })[] = [
  { value: 'individual', x: 73.0, y: 180.2, w: 8, h: 8 },
  { value: 'c_corporation', x: 180.0, y: 180.2, w: 8, h: 8 },
  { value: 's_corporation', x: 252.0, y: 180.2, w: 8, h: 8 },
  { value: 'partnership', x: 324.0, y: 180.2, w: 8, h: 8 },
  { value: 'trust_estate', x: 388.8, y: 180.2, w: 8, h: 8 },
  { value: 'llc', x: 73.0, y: 193.5, w: 8, h: 8 },
  { value: 'other', x: 73.0, y: 230.0, w: 8, h: 8 },
]

/** Line 3b — flow-through entity with foreign partners. Optional by design. */
export const W9_LINE_3B: W9Box = { x: 440.6, y: 263.0, w: 8, h: 8 }

/**
 * Part I — the TIN.
 *
 * Deliberately NOT one tab per AcroForm box. The form splits the SSN into
 * three boxes (f1_11/12/13) and the EIN into two (f1_14/15), and a
 * "fill at least one of these five" rule is satisfied by typing three
 * digits and stopping. So each row is ONE tab spanning its boxes: the
 * printed cells stay as a visual guide, and "filled" means a whole
 * number was typed rather than a fragment.
 *
 * The two rows are an either/or — a sole proprietor has an SSN, an LLC
 * has an EIN, and NOBODY fills both. That is why neither is `required`
 * on its own; the rule lives in the tab group, which is the only
 * construct that can say "one of these two". Marking both required
 * would produce an envelope no human being on earth could complete.
 */
export const W9_TIN_GROUP = 'w9_taxpayer_id'

/** SSN row: spans f1_11 (x 417.6) through f1_13 (ends x 576.0). */
export const W9_TIN_SSN: W9Box = { x: 417.6, y: 372.0, w: 158.4, h: 24 }

/** EIN row: spans f1_14 (x 417.6) through f1_15 (ends x 561.6). */
export const W9_TIN_EIN: W9Box = { x: 417.6, y: 420.0, w: 144.0, h: 24 }

/**
 * The requester block — line "Requester's name and address (optional)".
 * This one is OURS, not the partner's, so it is prefilled by the sender
 * rather than offered as an empty box. A partner asked to type the
 * requester's address will either guess it or leave it blank, and both
 * make the form look like it came from nobody.
 */
export const W9_REQUESTER_BOX: W9Box = { x: 389.8, y: 286.0, w: 186.2, h: 38 }

export const W9_REQUESTER_TEXT = 'Shipo LLC\n310 Cornell Dr\nWilmington, DE 19801'

/**
 * The signature row has no AcroForm widget — the IRS draws it as a rule,
 * not a field — so it is placed against the text "Signature of", which
 * sits at x 76.0 / y 587.6 and appears exactly once on page 1. Anchoring
 * to text rather than to a measured point means a reflow of the form
 * moves the tab with it instead of leaving it behind.
 */
export const W9_SIGNATURE_ANCHOR = 'Signature of'
export const W9_SIGNATURE_X_OFFSET = 80
export const W9_SIGNATURE_Y_OFFSET = -4
export const W9_SIGNATURE_DATE_X_OFFSET = 380
