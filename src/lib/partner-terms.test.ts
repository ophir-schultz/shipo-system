import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import {
  PARTNER_TERMS_VERSION,
  PARTNER_TERMS_SECTIONS,
  needsAcceptance,
} from './partner-terms'

describe('needsAcceptance', () => {
  it('is true with no acceptances at all', () => {
    expect(needsAcceptance([])).toBe(true)
  })
  it('is false once the current version is accepted', () => {
    expect(needsAcceptance([{ terms_version: PARTNER_TERMS_VERSION }])).toBe(false)
  })
  it('is TRUE when only an older version was accepted', () => {
    expect(needsAcceptance([{ terms_version: '2026-01-01' }])).toBe(true)
  })
  it('is false when the current version appears among several', () => {
    expect(
      needsAcceptance([
        { terms_version: '2026-01-01' },
        { terms_version: PARTNER_TERMS_VERSION },
        { terms_version: '2025-06-06' },
      ]),
    ).toBe(false)
  })
  it('is TRUE when only a FUTURE version was accepted', () => {
    expect(needsAcceptance([{ terms_version: '2099-01-01' }])).toBe(true)
  })
})

describe('PARTNER_TERMS_SECTIONS', () => {
  it('covers all four risk areas', () => {
    expect(PARTNER_TERMS_SECTIONS).toHaveLength(5)
  })
  it('names confidentiality, estimates, client data and contractor status', () => {
    const headings = PARTNER_TERMS_SECTIONS.map((s) => s.heading.toLowerCase()).join(' | ')
    expect(headings).toMatch(/confidential/)
    expect(headings).toMatch(/estimate/)
    expect(headings).toMatch(/client/)
    expect(headings).toMatch(/contractor/)
  })
  it('states that the signed agreement governs', () => {
    const all = PARTNER_TERMS_SECTIONS.map((s) => s.body).join(' ')
    expect(all).toMatch(/agreement governs/i)
  })
  it('contains no staff instruction', () => {
    const all = PARTNER_TERMS_SECTIONS.map((s) => `${s.heading} ${s.body}`).join(' ')
    expect(all).not.toMatch(/reactivate|set the first-payment|re-send|send a new one/i)
  })
  it('has no empty heading or body', () => {
    for (const s of PARTNER_TERMS_SECTIONS) {
      expect(s.heading.trim().length).toBeGreaterThan(0)
      expect(s.body.trim().length).toBeGreaterThan(0)
    }
  })
})

// Spec §2.1: the gate must render WITHOUT reading any ledger data. The gate
// lives in a .tsx, which vitest's `include: ['src/**/*.test.ts']` cannot
// cover, so the property is asserted over the source text instead. That is
// weaker than executing it, and it is the only automated guard §2.1 has:
// `loadPartnerLedger` runs inside <Statement>, so an acceptance check that
// drifted BELOW the <Statement> construction would silently start serving
// client revenue figures to a partner who never agreed to the terms.
//
// BOTH ANCHORS ARE DELIBERATE, and the obvious spelling of this test does
// not work. `indexOf('needsAcceptance')` finds the IMPORT, which is at the
// top of the file by definition and therefore before everything; and
// `indexOf('<Statement')` matches the phrase inside this file's own header
// comment. Written that way, the assertion passed with a `return <Statement
// partner={partner} />` inserted ABOVE the gate — it was decoration. So:
// comments are stripped first, the gate is anchored at its CALL site
// (`needsAcceptance(`, with the paren), and the comparison is against the
// FIRST `<Statement` in code, because a second, earlier construction is
// exactly the regression this is here to catch.
describe('partner/page.tsx gate order', () => {
  const codeOf = (file: string) =>
    readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')

  it('the acceptance gate precedes every construction of the statement', () => {
    const src = codeOf('src/app/partner/page.tsx')
    const gate = src.indexOf('needsAcceptance(')
    const statement = src.indexOf('<Statement')
    expect(gate).toBeGreaterThan(-1)
    expect(statement).toBeGreaterThan(-1)
    expect(gate).toBeLessThan(statement)
  })

  it('the disclaimer precedes the W-9 screen', () => {
    // §2.1, and the reason is not cosmetic: the W-9 screen leads to a form
    // carrying a legal name, an address and a taxpayer ID, and the
    // disclaimer is where the partner is told what we do with what he
    // gives us. Reversing these two asks for a TIN from someone who has
    // agreed to nothing — which is the one ordering mistake here with a
    // consequence beyond annoyance.
    //
    // NOW HELD TRANSITIVELY, and the rewrite is not a weakening. This
    // test used to compare `needsAcceptance(` against `holdsW9(` in this
    // file, because the page returned <W9Gate /> itself. The W-9 is no
    // longer a full-page gate — it withholds money inside <Statement> —
    // so the only route to a TIN request is through <Statement>, and the
    // test above already pins the acceptance gate ahead of every
    // construction of it.
    //
    // What is left for THIS test is the thing that rewrite could hide: a
    // W-9 screen reappearing in this file as an early return, above or
    // below the gate. If any W-9 anchor is present at all, it must come
    // after the acceptance check — and src/lib/partner-w9.test.ts asserts
    // separately that <W9Gate /> is not rendered here at any position.
    const src = codeOf('src/app/partner/page.tsx')
    const terms = src.indexOf('needsAcceptance(')
    expect(terms).toBeGreaterThan(-1)
    for (const anchor of ['holdsW9(', 'W9Gate', 'w9PartnerMessage(']) {
      const at = src.indexOf(anchor)
      if (at === -1) continue
      expect(terms, anchor).toBeLessThan(at)
    }
  })

  it('reads no ledger data before the gate', () => {
    // §2.1: "A gate that fetches the data it is gating is not a gate."
    // loadPartnerLedger lives inside <Statement>; the page itself must not
    // reach for the ledger or its view on its own account.
    const src = codeOf('src/app/partner/page.tsx')
    expect(src).not.toMatch(/loadPartnerLedger|partner_client_monthly/)
  })
})
