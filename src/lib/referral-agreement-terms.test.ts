import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REFERRAL_TERMS } from '@/lib/referrals'

// Three documents have to say the same thing about this deal: the website, the
// Referral Partner Agreement, and the code that calculates the payment. The
// code is the one with a test suite, so it drifts last; the agreement is a
// markdown file nobody runs, so it drifts first — and it already had, badly.
// Before 2026-10-12 its Section 3 described a one-time $300 commission and
// never mentioned the 5% revenue share at all, which is the larger obligation.
//
// This is the guard for that. It is not a spell-check: it reads the OPERATIVE
// text of Section 3 and asserts that each figure the billing system uses is
// stated there.
//
// WHY THE ATTORNEY NOTES ARE STRIPPED OUT: the notes discuss the terms, so they
// contain the same numbers as the clauses. A check that searched the whole
// section would pass on a document where the operative clause had been deleted
// and only a note about it survived — which is the exact shape of the failure
// this test exists to catch. A drift is an OMISSION, and an omission leaves no
// word behind to search for; the only way to detect it is to confirm the
// positive statement is still present where it has legal effect.

const DOC = join(process.cwd(), 'docs/referral-agreement-DRAFT-for-attorney-review.md')

function agreement(): string {
  return readFileSync(DOC, 'utf8')
}

/**
 * Strip blockquote lines, then collapse every run of whitespace to a single
 * space.
 *
 * The collapse is not cosmetic. This document is hand-wrapped at about 90
 * columns, so a phrase like "the first ten (10) referred clients" is split
 * across a newline in the source and a plain substring search for it fails on
 * a document that says exactly the right thing. Without this, the assertions
 * below would be testing the line-wrapping and not the terms — and any
 * re-wrap of the paragraph would look like a terms change.
 */
function operative(text: string): string {
  return text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('>'))
    .join('\n')
    .replace(/\s+/g, ' ')
}

/** Section 3 only, with every blockquote (ATTORNEY NOTE) line removed. */
function operativeSection3(): string {
  const text = agreement()
  const start = text.indexOf('## 3. Qualification & Compensation')
  expect(start, 'Section 3 heading not found — was the section renamed?').toBeGreaterThan(-1)
  const end = text.indexOf('\n## 4.', start)
  expect(end, 'Section 4 heading not found — cannot bound Section 3').toBeGreaterThan(start)

  return operative(text.slice(start, end))
}

describe('the agreement states the standing terms the system pays on', () => {
  it('still has every operative clause of Section 3, by number', () => {
    // The phrase assertions below would survive a clause being PARTIALLY
    // demoted into a blockquote: prefix only its first line with ">" and the
    // numbered heading loses legal effect while every phrase on the following
    // lines is still found. Checking the headings themselves is what makes
    // that visible. It also catches a renumbering, which silently breaks the
    // cross-references in 3.10, 3.11, 4.2 and 7.3.
    const s3 = operativeSection3()
    for (const clause of ['3.1 ', '3.2 ', '3.3 ', '3.4 ', '3.5 ', '3.6 ', '3.7 ', '3.9 ', '3.10 ', '3.11 ']) {
      expect(s3, `clause ${clause.trim()} is missing from the operative text`).toContain(clause)
    }
  })

  it('still carries the NOT FOR SIGNATURE banner', () => {
    // No executed partner agreement exists. Until a Delaware attorney has
    // cleared this text, anything that removes the banner is removing the one
    // thing stopping it being sent to a partner.
    expect(agreement()).toContain('NOT FOR USE OR SIGNATURE')
  })

  it('states the signup bonus', () => {
    expect(REFERRAL_TERMS.SIGNUP_BONUS).toBe(300)
    expect(operativeSection3()).toContain('$300 USD')
  })

  it('states the commission rate as a percentage of net profit', () => {
    expect(REFERRAL_TERMS.COMMISSION_RATE).toBe(0.05)
    const s3 = operativeSection3()
    expect(s3).toContain('5% of the Net Profit')
  })

  it('states the length of the revenue-share window', () => {
    expect(REFERRAL_TERMS.COMMISSION_MONTHS).toBe(12)
    const s3 = operativeSection3()
    expect(s3).toContain('twelve (12) consecutive months')
    // And says what it is measured from. "12 months" with no start date is the
    // ambiguity, not the number.
    expect(s3).toContain('first paid invoice')
  })

  it('states the qualification threshold and that it is per calendar month', () => {
    expect(REFERRAL_TERMS.QUALIFY_MIN_REVENUE).toBe(500)
    const s3 = operativeSection3()
    expect(s3).toContain('$500 USD or more in a single calendar month')
    // at-or-above, not above — the published wording, and what the code does.
    expect(s3).toContain('at-or-above $500, not more than $500')
  })

  it('states the 60-day release condition', () => {
    expect(REFERRAL_TERMS.QUALIFY_MIN_DAYS_ACTIVE).toBe(60)
    expect(operativeSection3()).toContain('at least **60 days**')
  })

  it('states the minimum payment and that a short balance carries forward', () => {
    expect(REFERRAL_TERMS.MIN_PAYOUT).toBe(50)
    const s3 = operativeSection3()
    expect(s3).toContain('less than $50 USD')
    expect(s3).toContain('rolls forward')
    // A carry that can expire is a different deal from one that cannot.
    expect(s3).toContain('never forfeited')
  })

  it('states that the bonus and the share are additive, not alternatives', () => {
    // buildStatement adds them into one monthly balance. A partner reading
    // "either/or" would be reading a smaller deal than the one being paid.
    expect(operativeSection3()).toContain('additive')
  })

  it('has no standing unit or order qualification to describe', () => {
    // If a standing volume bar is ever introduced in code, the published
    // qualification stops being dollars-only and Section 3.1 becomes wrong.
    expect(REFERRAL_TERMS.QUALIFY_MIN_UNITS).toBeNull()
    expect(REFERRAL_TERMS.QUALIFY_MIN_ORDERS).toBeNull()
  })
})

describe('the agreement defines net profit the way the system computes it', () => {
  it('names all four deducted cost buckets', () => {
    const s3 = operativeSection3()
    for (const bucket of ['freight', 'carrier', 'return shipping', 'materials', 'storage', 'payment-processing']) {
      expect(s3, `net-profit definition does not mention ${bucket}`).toContain(bucket)
    }
  })

  it('says in terms that warehouse labor is not deducted', () => {
    // This is the clause that costs Shipo money and therefore the one most
    // likely to be "corrected" by someone who assumes labor must be a cost.
    // It is also the clause a partner would most want in writing.
    const s3 = operativeSection3()
    expect(s3).toContain('Warehouse labor is NOT deducted')
    expect(s3).toContain('Pick, pack, and receiving')
  })

  it('keeps the deduction list closed', () => {
    // An open list ("including without limitation...") would let any new cost
    // category reduce the partner's share without amending the agreement.
    expect(operativeSection3()).toContain('less only the following')
  })

  it('says the share is on the whole account, not one service line', () => {
    expect(operativeSection3()).toContain("client's **entire account**")
  })
})

describe('there is no promotional tier in the code or the agreement', () => {
  // Withdrawn by Ophir on 2026-10-12: a $500 bonus instead of $300 for the
  // first ten referred clients clearing a volume bar, with the revenue-share
  // window shifted to the client's second month. Nothing had been paid.
  //
  // This block is the guard in the OTHER direction from the ones above. Those
  // ask "is the term we pay on still written down?". These ask "has a term we
  // do NOT pay on come back?" — because the expensive version of this drift is
  // code quietly regaining a raised bonus the agreement does not promise, or
  // an agreement promising one the code will never pay.

  it('exports no promotional-tier constant', async () => {
    // Asserting on the MODULE, not on a constant — a test that imported
    // FOUNDING_CLIENT_TERMS to check it was gone would not compile, so the
    // only way to express this is to look at what the module exports.
    const mod = await import('@/lib/referrals')
    for (const name of ['FOUNDING_CLIENT_TERMS', 'foundingPlaces', 'clearsLaunchBar', 'launchQualifyingInvoice']) {
      expect(mod, `${name} is back — see 3.11, which says no promotional tier exists`)
        .not.toHaveProperty(name)
    }
  })

  it('has one signup bonus and one commission start, both standing', () => {
    // If a raised bonus ever returns it will need a second figure to live in.
    // These two assertions are what make that a visible change.
    expect(REFERRAL_TERMS.SIGNUP_BONUS).toBe(300)
    expect(Object.keys(REFERRAL_TERMS)).not.toContain('COMMISSION_START_MONTH')
  })

  it('says in the agreement that no promotional tier exists', () => {
    // A positive statement, not an absence. An omission leaves no word behind
    // to search for — the same reason the attorney notes are stripped above.
    // If 3.11 is ever rewritten back into an offer, this phrase goes with it.
    const s3 = operativeSection3()
    expect(s3).toContain('There is no promotional, launch, or founding tier')
    expect(s3).toContain('Every Qualified Referral earns the same bonus')
  })

  it('no longer promises a raised bonus or a shifted window anywhere in Section 3', () => {
    const s3 = operativeSection3()
    for (const gone of [
      '**$500 USD** instead of $300',
      'first ten (10) referred clients',
      'more than 1,500 FBA prep units',
      'The window shifts',
    ]) {
      expect(s3, `the withdrawn offer's wording is back in the operative text: ${gone}`)
        .not.toContain(gone)
    }
  })
})

describe('the twelve-month tail survives termination', () => {
  it('says so in Section 7', () => {
    // Without this, a 30-day termination-for-convenience right could be read
    // as ending a twelve-month obligation in its second month.
    const text = agreement()
    const start = text.indexOf('## 7. Term & Termination')
    const end = text.indexOf('\n## 8.', start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)

    const s7 = operative(text.slice(start, end))

    expect(s7).toContain('Termination does not end the twelve-month')
    expect(s7).toContain('until that client')
  })
})
