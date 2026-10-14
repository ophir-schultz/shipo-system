// Partner portal terms of use — the disclaimer shown once, inside the portal,
// before the statement renders. Spec §2.4.
//
// TWO LOAD-BEARING FACTS ABOUT THIS FILE:
//
//   1. THE TEXT BELOW IS A DRAFT FOR THE ATTORNEY TO REDLINE. It was written
//      from spec §2.4 so the mechanism could be built and tested without
//      waiting on counsel. Replace the bodies after redline; the shape of this
//      module and everything that consumes it does not change when you do.
//      §2.5 carries one open question for the same pass: showing a partner a
//      CLIENT's order-level detail probably needs a clause in the CLIENT
//      agreement, which §2.4(c) does not obtain.
//
//   2. BUMPING `PARTNER_TERMS_VERSION` RE-PROMPTS EVERY PARTNER. That is the
//      point, not a side effect — silently re-wording terms somebody already
//      agreed to is the failure mode this guards against. So changing the text
//      and changing the version are one act, and both are deliberate.
//
// Each section exists because a specific thing on the screen behind it could
// otherwise be turned against Shipo. The statement discloses Shipo's own margin
// on named accounts; (a) and (c) are the price of showing it.
//
// This is a `.ts` and not part of the component because `vitest.config.ts` has
// `include: ['src/**/*.test.ts']` — nothing in a `.tsx` can be covered.

export const PARTNER_TERMS_VERSION = '2026-10-13'

export interface TermsSection {
  heading: string
  body: string
}

export const PARTNER_TERMS_SECTIONS: ReadonlyArray<TermsSection> = [
  {
    heading: 'Confidentiality',
    body:
      "The figures in this portal are Shipo's confidential business information " +
      'under Section 6 of your Partner Agreement. That includes revenue, cost ' +
      'categories, and margin on named accounts. You may use them to check your ' +
      'own commission and for nothing else. Do not disclose them, republish them, ' +
      'or use them competitively.',
  },
  {
    heading: 'These figures are good-faith estimates, not an account stated',
    body:
      'Amounts shown here are our good-faith calculation at the time you look at ' +
      'them, not a final account. Lines marked "not final" or "not priced yet" are ' +
      'not owed, and any figure may be restated once the underlying charges are ' +
      'priced. If you disagree with a figure, tell us in writing within 30 days of ' +
      'receiving the statement it appears on. If we overpay you, we recover it by ' +
      'offsetting the amount against what we owe you later — offset only, never a ' +
      'demand that you refund money — as set out in Section 3.9 of your agreement.',
  },
  {
    heading: 'No client solicitation, and no use of client data',
    body:
      'Client names, order counts, and billing figures appear here for one reason: ' +
      'so you can check your own commission. You may not approach these clients ' +
      'about their fulfillment, broker them to anyone else, or build a list, a ' +
      'database, or a prospecting file from anything you see in this portal. This ' +
      'applies during the partnership and after it ends.',
  },
  {
    heading: 'Independent contractor, your own taxes, W-9 first',
    body:
      'You are an independent contractor. Nothing here creates employment, a ' +
      'partnership, a joint venture, or an agency relationship, and you may not ' +
      'hold yourself out as able to bind Shipo. You are responsible for your own ' +
      'taxes. Shipo files information returns for amounts it pays you, and cannot ' +
      'pay you at all until it holds your completed W-9 or W-8. Nothing in this ' +
      'portal is tax, legal, or financial advice.',
  },
  {
    heading: 'Your signed agreement controls',
    body:
      'If anything on this screen and your signed Partner Agreement disagree, the ' +
      'agreement governs. Nothing on this screen varies it, adds to it, or waives ' +
      'any part of it. Accepting these terms records that you have read this page; ' +
      'it does not change what you signed.',
  },
]

export interface Acceptance {
  terms_version: string
}

/**
 * True unless this partner has accepted the CURRENT version.
 *
 * The comparison is an exact match on `PARTNER_TERMS_VERSION` — never `>=`,
 * never a date comparison. A version string that sorts later than the current
 * one is not an acceptance of the current one: it is either a clock problem or
 * a row from a deploy that has since been rolled back, and in both cases the
 * right answer is to show the text we are actually standing behind today and
 * record a fresh acceptance of it.
 */
export function needsAcceptance(acceptances: ReadonlyArray<Acceptance>): boolean {
  return !acceptances.some((a) => a.terms_version === PARTNER_TERMS_VERSION)
}
