// ============================================================
// Rate sheets — per-prospect, shareable fulfillment pricing.
//
// A sheet lives at /rate-sheets/<slug>/<public_id>/<token> and is
// readable by anyone holding the link. See supabase/rate_sheets.sql
// for the storage model and why the token is not hashed.
//
// THIS MODULE MUST STAY FREE OF SERVER IMPORTS. The estimator is a
// client component and imports estimateMonthly from here; pulling in
// supabaseAdmin would bundle SUPABASE_SERVICE_ROLE_KEY into the
// browser. Database access lives in rate-sheets-db.ts instead.
//
// SCOPE IS FULFILLMENT FEES ONLY. Parcel and postage rates do not
// belong on this page — they are carrier rates that move, and the
// link is forwardable by whoever receives it.
//
// Every figure that ships as a default below is from the published
// rate card already live on shipousa.com. Nothing here may be an
// estimate, a rounding, or a number someone remembered. If a fee
// has no published figure, it is not in DEFAULT_RATE_CARD — staff
// add it per sheet, or it does not appear.
// ============================================================

/** How a line turns the prospect's profile into a monthly number. */
export type RateBasis =
  /** base for the first item, plus a smaller amount for each item after it */
  | 'per_order_plus_item'
  | 'per_pallet_month'
  | 'per_pallet'
  | 'per_unit'
  /** shown on the card, never priced into the estimate */
  | 'quoted'

/** Which profile field a basis multiplies against. */
export type RateDriver =
  | 'monthly_orders'
  | 'pallets_stored'
  | 'pallets_inbound'
  | 'fba_units'

export interface RateLine {
  id: string
  label: string
  /** Exactly as it should read on the page. Never derived from `amount`. */
  price: string
  note?: string
  basis: RateBasis
  driver?: RateDriver
  amount?: number
  /** Second figure for `per_order_plus_item` — the additional-item rate. */
  amountAdditional?: number
}

export interface SheetProfile {
  monthly_orders?: number
  items_per_order?: number
  pallets_stored?: number
  pallets_inbound?: number
  fba_units?: number
  channels?: string[]
  notes?: string
}

export interface RateSheet {
  id: string
  public_id: number
  slug: string
  token: string
  company_name: string
  contact_name: string | null
  contact_email: string | null
  prepared_by: string | null
  profile: SheetProfile
  rate_card: RateLine[]
  monthly_minimum: number
  intro: string | null
  status: string
  valid_until: string | null
  view_count: number
  created_at: string
}

/** The published 2026 list rates. Volume pricing is negotiated, not shown here. */
export const DEFAULT_RATE_CARD: RateLine[] = [
  {
    id: 'pick-pack',
    label: 'Pick and pack',
    price: '$2.50 per order, plus $0.50 per additional item',
    note: 'Covers picking, packing and standard packaging materials.',
    basis: 'per_order_plus_item',
    driver: 'monthly_orders',
    amount: 2.5,
    amountAdditional: 0.5,
  },
  {
    id: 'storage',
    label: 'Storage',
    price: '$25.00 per pallet per month',
    basis: 'per_pallet_month',
    driver: 'pallets_stored',
    amount: 25,
  },
  {
    id: 'receiving',
    label: 'Receiving',
    price: '$14.00 per pallet, or $0.18 per unit',
    note: 'Palletised inbound is billed per pallet. Floor-loaded containers and parcel receipts are billed per unit.',
    basis: 'per_pallet',
    driver: 'pallets_inbound',
    amount: 14,
  },
  {
    id: 'fba-prep',
    label: 'Amazon FBA prep',
    price: '$1.25 per unit',
    note: 'FNSKU labelling, poly bagging, bundling, kitting and inspection.',
    basis: 'per_unit',
    driver: 'fba_units',
    amount: 1.25,
  },
  {
    id: 'postage',
    label: 'Parcel and postage',
    price: 'Billed at carrier rates',
    note: 'Passed through at the rate the carrier charges for your parcels. Quoted separately against your own weights and destinations.',
    basis: 'quoted',
  },
]

export const MONTHLY_MINIMUM = 395

export interface EstimateLine {
  id: string
  label: string
  detail: string
  amount: number
}

export interface Estimate {
  lines: EstimateLine[]
  subtotal: number
  minimum: number
  /** What the month actually bills: the greater of subtotal and minimum. */
  billed: number
  minimumApplied: boolean
  /** True when the profile has no quantities at all, so the total means nothing. */
  empty: boolean
}

function money(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
}

/** "1 pallet" / "8 pallets". This text goes on a document sent to a prospect. */
function plural(qty: number, word: string): string {
  return qty === 1 ? word : `${word}s`
}

/**
 * Monthly fulfillment estimate for a profile against a card.
 *
 * Postage is never included — it is not on this sheet, and a total
 * that silently omitted it while looking complete would understate
 * what a brand actually pays.
 */
export function estimateMonthly(
  card: RateLine[],
  profile: SheetProfile,
  minimum: number = MONTHLY_MINIMUM
): Estimate {
  const orders = Math.max(0, profile.monthly_orders ?? 0)
  // An order always contains at least the one item the base rate covers.
  const items = Math.max(1, profile.items_per_order ?? 1)
  const quantities: Record<RateDriver, number> = {
    monthly_orders: orders,
    pallets_stored: Math.max(0, profile.pallets_stored ?? 0),
    pallets_inbound: Math.max(0, profile.pallets_inbound ?? 0),
    fba_units: Math.max(0, profile.fba_units ?? 0),
  }

  const lines: EstimateLine[] = []

  for (const line of card) {
    if (line.basis === 'quoted' || !line.driver || line.amount == null) continue
    const qty = quantities[line.driver]
    if (qty <= 0) continue

    let amount: number
    let detail: string

    if (line.basis === 'per_order_plus_item') {
      const additional = line.amountAdditional ?? 0
      const perOrder = line.amount + additional * (items - 1)
      amount = qty * perOrder
      const extra = round2(items - 1)
      detail =
        items > 1
          ? `${qty.toLocaleString()} ${plural(qty, 'order')} x ${money(perOrder)} (${money(line.amount)} + ${extra} x ${money(additional)})`
          : `${qty.toLocaleString()} ${plural(qty, 'order')} x ${money(perOrder)}`
    } else {
      const unit =
        line.basis === 'per_pallet_month'
          ? plural(qty, 'pallet')
          : line.basis === 'per_pallet'
            ? `${plural(qty, 'pallet')} inbound`
            : plural(qty, 'unit')
      amount = qty * line.amount
      detail = `${qty.toLocaleString()} ${unit} x ${money(line.amount)}`
    }

    lines.push({ id: line.id, label: line.label, detail, amount: round2(amount) })
  }

  const subtotal = round2(lines.reduce((sum, l) => sum + l.amount, 0))

  return {
    lines,
    subtotal,
    minimum,
    billed: Math.max(subtotal, minimum),
    minimumApplied: subtotal < minimum,
    empty: lines.length === 0,
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * 24 random bytes, base64url. Same shape as the partner session token
 * in partner-auth.ts: 192 bits, so the link cannot be found by guessing.
 */
export function generateToken(): string {
  const bytes = new Uint8Array(24)
  crypto.getRandomValues(bytes)
  let binary = ''
  bytes.forEach((b) => (binary += String.fromCharCode(b)))
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * URL-safe slug from the company name plus today's date, e.g.
 * 'acme-supplements-2026-09-17'. Cosmetic — lookup is by id + token.
 */
export function buildSlug(companyName: string, date = new Date()): string {
  const name = companyName
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  const stamp = date.toISOString().slice(0, 10)
  return name ? `${name}-${stamp}` : `rate-sheet-${stamp}`
}

export function sheetPath(sheet: Pick<RateSheet, 'slug' | 'public_id' | 'token'>): string {
  return `/rate-sheets/${sheet.slug}/${sheet.public_id}/${sheet.token}`
}
