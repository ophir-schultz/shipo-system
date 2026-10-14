// Is this partner a US person? Spec §2a.7.
//
// A signed W-9 from a non-US person is not a defective form, it is the
// WRONG form: the IRS wants a W-8BEN from a foreign individual and a
// W-8BEN-E from a foreign entity, each with its own treaty claims and
// withholding regime. NEITHER W-8 IS BUILT, deliberately -- this module
// exists so the absence is enforced rather than remembered.
//
// The column is `referral_partners.tax_status` (supabase/partner_tax_status.sql),
// with no default. Staff record it from the paperwork; the partner is
// never asked to self-certify it in a web form.

export type PartnerTaxStatus = 'us_person' | 'foreign_individual' | 'foreign_entity'

const KNOWN: readonly PartnerTaxStatus[] = ['us_person', 'foreign_individual', 'foreign_entity']

/**
 * The partner's recorded tax status, or null when nothing usable is on file.
 *
 * UNSET AND UNRECOGNISED COLLAPSE TO THE SAME null, AND NEITHER DEFAULTS TO
 * 'us_person'. A default would be the safe answer for today's roster and
 * silently the wrong answer the first time somebody abroad is added. null
 * reads downstream as a refusal, so a typo that slips past the database
 * CHECK constraint fails in the safe direction: nobody is sent a W-9 on the
 * strength of a value no human chose.
 */
export function taxStatusOf(value: string | null | undefined): PartnerTaxStatus | null {
  if (typeof value !== 'string') return null
  return KNOWN.includes(value as PartnerTaxStatus) ? (value as PartnerTaxStatus) : null
}

const STAFF_LABEL: Record<PartnerTaxStatus, string> = {
  us_person: 'US person',
  foreign_individual: 'Foreign individual',
  foreign_entity: 'Foreign entity',
}

/**
 * The staff dropdown on /referrals, in display order.
 *
 * Derived from the union through a `Record`, not typed out in the .tsx.
 * vitest's `include: ['src/**\/*.test.ts']` cannot cover a component, so a
 * hardcoded list of four <option>s would be the one place a fourth status
 * could be added to the database and silently never offered to staff —
 * leaving the only way to record it a hand-written UPDATE. Here the
 * compiler demands the label.
 */
export const TAX_STATUS_OPTIONS: ReadonlyArray<{ value: PartnerTaxStatus; label: string }> =
  KNOWN.map((value) => ({ value, label: STAFF_LABEL[value] }))

/** What the staff screen shows when nothing has been recorded. */
export const TAX_STATUS_UNSET_LABEL = 'Not recorded'

const REFUSAL: Record<PartnerTaxStatus, string | null> = {
  us_person: null,
  foreign_individual:
    'This partner is recorded as a foreign individual, so the IRS form is a W-8BEN, not a W-9. Shipo does not build W-8BEN envelopes yet — collect the form outside the portal and email it in.',
  foreign_entity:
    'This partner is recorded as a foreign entity, so the IRS form is a W-8BEN-E, not a W-9. Shipo does not build W-8BEN-E envelopes yet — collect the form outside the portal and email it in.',
}

/**
 * null when a W-9 is the right form for this partner; otherwise the reason
 * we refuse to assemble one.
 *
 * The UNSET case is its own sentence on purpose. "We have not recorded this
 * partner's tax status" is a different problem from "this partner needs a
 * different form" -- the first is fixed by staff opening the partner editor,
 * the second needs a form that does not exist yet.
 */
export function w9Refusal(status: PartnerTaxStatus | null): string | null {
  if (status === null) {
    return 'This partner has no tax status on file. Record it in the partner editor on /referrals before sending any IRS form — we will not guess that somebody is a US person.'
  }
  return REFUSAL[status]
}
