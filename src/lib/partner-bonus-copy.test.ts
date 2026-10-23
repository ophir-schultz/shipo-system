import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * The statement may not state qualifying conditions the Agreement does
 * not impose.
 *
 * Section 3.1 required "$500 USD or more in a single calendar month" and
 * 3.2 withheld the bonus until a client had been active 60 days. Both
 * were removed from the Agreement on 2026-10-12, leaving 3.9's
 * offset-only clawback as the only protection.
 *
 * referral-agreement-terms.test.ts pinned the AGREEMENT against their
 * return. Nothing pinned the SCREEN — so Statement.tsx went on telling
 * every partner he had to wait 60 days and bill $500 for eleven days
 * after the contract stopped asking for either. A partner reading his own
 * statement was being quoted terms he had not signed, understating what
 * he was owed.
 *
 * Which way the error ran matters. Copy that promises MORE than the
 * contract is a liability; copy that promises LESS is a partner who never
 * chases a bonus he is owed, and he has no way to discover it — the
 * screen is the only version of the deal he reads after signing.
 *
 * COMMENTS ARE STRIPPED FIRST. The explanation above the block in
 * Statement.tsx names both withdrawn gates, as does this docstring. A
 * grep over source counts its own prose, and an unstripped scan here
 * would fail on the sentence explaining the rule.
 */

const STATEMENT = 'src/components/partner/Statement.tsx'

function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '') // JSX comment blocks
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

describe('the statement does not reimpose the withdrawn bonus gates', () => {
  const code = codeOf(STATEMENT)

  it('reads the statement and finds real code (control)', () => {
    // Every absence assertion below passes over an empty string, so a
    // renamed file or a bad path would otherwise read as a clean bill of
    // health.
    expect(code.length).toBeGreaterThan(1000)
    expect(code).toContain('How this is calculated')
  })

  it('names no $500 revenue threshold', () => {
    expect(code).not.toMatch(/\$500/)
    expect(code).not.toMatch(/500 or more/)
  })

  it('names no 60-day waiting period', () => {
    expect(code).not.toMatch(/\b60 days\b/)
    expect(code).not.toMatch(/active 60/)
  })

  it('still states the two things that ARE conditions', () => {
    // The bonus does depend on a first paid invoice, and the commission
    // window does run from it. Removing the withdrawn gates must not take
    // the surviving ones with it.
    expect(code).toMatch(/first invoice|first paid invoice/)
  })

  // ---- controls: the detectors must be able to report a violation ----

  it('detects a $500 threshold when one is present (control)', () => {
    expect('billed $500 or more').toMatch(/\$500/)
  })

  it('detects a 60-day wait when one is present (control)', () => {
    expect('has been active 60 days').toMatch(/\b60 days\b/)
  })

  it('strips a comment that names the gates, which the checks depend on (control)', () => {
    // Exactly the shape of the explanation sitting above the block in
    // Statement.tsx. Without stripping, that comment fails the scan.
    const withComment = '{/* this used to require $500 and 60 days */}\nconst ok = 1'
    expect(codeOfString(withComment)).not.toMatch(/\$500/)
    expect(codeOfString(withComment)).not.toMatch(/\b60 days\b/)
  })
})

/** Same stripper as codeOf, over a string rather than a file. */
function codeOfString(src: string): string {
  return src
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}
