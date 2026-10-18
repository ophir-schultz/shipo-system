import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  W9_CUSTOM_FIELD,
  W9_INCLUDED,
  holdsW9,
  payoutBlockedReason,
  w9Label,
  w9Block,
  w9PartnerMessage,
} from './partner-w9'

describe('holdsW9', () => {
  it('is true only on a recorded date', () => {
    expect(holdsW9({ w9_received_at: '2026-10-13T09:00:00.000Z' })).toBe(true)
  })

  it('treats every flavour of absent as absent', () => {
    // Fail-closed, and the direction matters: a false positive here pays
    // money out against a taxpayer identification number we do not have.
    for (const w9_received_at of [null, undefined, '']) {
      expect(holdsW9({ w9_received_at })).toBe(false)
    }
    expect(holdsW9({})).toBe(false)
  })
})

describe('payoutBlockedReason', () => {
  it('passes a partner whose W-9 is on file', () => {
    expect(payoutBlockedReason({ w9_received_at: '2026-10-13T09:00:00.000Z' })).toBeNull()
  })

  it('refuses one whose is not, and says what to do about it', () => {
    const reason = payoutBlockedReason({ w9_received_at: null })
    expect(reason).toMatch(/W-9/)
    expect(reason!.length).toBeGreaterThan(20)
    expect(reason).not.toMatch(/^[A-Z_]+$/)
  })

  it('is about payment, not about portal access', () => {
    // The two gates are deliberately separate: the agreement opens the
    // portal, the W-9 opens payment. A partner reading their own statement
    // while we cannot yet pay them is a legitimate state, and a reason that
    // mentioned signing in would send staff to fix the wrong thing.
    const reason = payoutBlockedReason({})!
    expect(reason).not.toMatch(/sign in|log in|portal access/i)
    expect(reason).toMatch(/pay/i)
  })
})

describe('w9Block', () => {
  it('is null once we hold a W-9, and the single blocking key otherwise', () => {
    expect(w9Block({ w9_received_at: '2026-10-14T00:00:00Z' })).toBeNull()
    expect(w9Block({ w9_received_at: null })).toBe('not_held')
    expect(w9Block({})).toBe('not_held')
  })

  it('decides the same way holdsW9 does, with no second predicate', () => {
    // The drift this forbids: a gate that asks w9Block while the payout
    // check asks holdsW9, and the two disagree about what "absent" means.
    for (const w9_received_at of [null, undefined, '', '2026-10-14T00:00:00Z']) {
      expect(w9Block({ w9_received_at }) === null).toBe(holdsW9({ w9_received_at }))
    }
  })
})

describe('w9PartnerMessage', () => {
  it('is null once we hold a W-9', () => {
    expect(w9PartnerMessage({ w9_received_at: '2026-10-14T00:00:00Z' })).toBeNull()
  })
  it('blocks on a null, undefined or blank timestamp', () => {
    expect(w9PartnerMessage({ w9_received_at: null })).not.toBeNull()
    expect(w9PartnerMessage({})).not.toBeNull()
    expect(w9PartnerMessage({ w9_received_at: '' })).not.toBeNull()
  })
  it('never hands the partner a staff instruction', () => {
    const msg = w9PartnerMessage({ w9_received_at: null })!
    expect(msg).not.toMatch(/re-send|re-sending the agreement|send a new one|reactivate/i)
  })
  it('says something the partner can do here', () => {
    expect(w9PartnerMessage({ w9_received_at: null })!).toMatch(/sign|complete/i)
  })
  it('differs from the staff sentence', () => {
    const p = { w9_received_at: null }
    expect(w9PartnerMessage(p)).not.toBe(payoutBlockedReason(p))
  })

  it('does not claim the rest of his account is unaffected', () => {
    // This sentence was written when the W-9 gated PAYMENT only, and it
    // was true then. It became the gate on the whole dashboard —
    // src/app/partner/page.tsx returned <W9Gate /> INSTEAD of <Statement />
    // — so a partner without a W-9 saw no client roster, no commission
    // window, no figures at all, and read on that very screen that nothing
    // else about his account was waiting on it.
    //
    // The §1a failure class exactly: a sentence that stayed behind when
    // the behaviour around it tightened. A partner who believes it has no
    // reason to prioritise the form, and no reason to connect the empty
    // screen to the one thing that would fill it.
    //
    // THE BAN SURVIVES THE SPLIT, and it is worth saying why rather than
    // leaving it as inherited furniture. The W-9 withholds money only now,
    // so the sentence is closer to true than it was — but still not true:
    // the AMOUNTS are part of his account and they are exactly what is
    // waiting on the form. "Only affects your payment" fails the same way,
    // because the figures are a display, not a payment.
    const msg = w9PartnerMessage({ w9_received_at: null })!
    expect(msg).not.toMatch(/nothing else about your account/i)
    expect(msg).not.toMatch(/nothing else is waiting|only affects (?:your )?payment/i)
  })

  it('tells him what the form unlocks', () => {
    // The replacement has to be positive, not merely not-false. "We
    // cannot show you anything" with no reason reads as a dispute; the
    // honest version names the form as the way to the figures.
    //
    // `clients` IS DELIBERATELY NOT IN THIS ALTERNATION. The sibling test
    // below bans that word outright, because the roster is printed beside
    // this sentence and is not waiting on anything. An alternation that
    // offered it would let the message satisfy this test with the one word
    // the next test forbids — a pair of guards that cannot both be met is
    // a trap, not a specification.
    const msg = w9PartnerMessage({ w9_received_at: null })!
    expect(msg).toMatch(/statement|figures|amounts|commission/i)
  })

  it('does not promise the roster and the window open on signing', () => {
    // THE SAME FAILURE CLASS AS THE TEST ABOVE, IN THE OTHER DIRECTION,
    // and that is why both stay. This sentence was corrected once already
    // — it used to reassure a blocked partner that "nothing else about
    // your account is waiting on it" while the W-9 withheld the entire
    // dashboard. The correction named what the form unlocked: "your
    // clients, your commission window and your monthly figures all open
    // up".
    //
    // The W-9 now withholds MONEY ONLY. A partner who has signed the
    // agreement sees his client roster, his commission window and his
    // claim form without ever touching a tax form, so a sentence saying
    // the form is what opens them is false again — and false in the
    // expensive direction, because it is the screen already showing them.
    //
    // "Clients" and "commission window" are named because they are
    // literally columns on the table printed beside this sentence.
    const msg = w9PartnerMessage({ w9_received_at: null })!
    expect(msg).not.toMatch(/\bclients\b/i)
    expect(msg).not.toMatch(/commission window/i)
  })

  it('names money, which is the only thing actually held back', () => {
    const msg = w9PartnerMessage({ w9_received_at: null })!
    expect(msg).toMatch(/amount|figure|earning|pay/i)
  })

  it('says the commission is still accruing, because it is', () => {
    // The one thing a partner reading this needs to know and cannot
    // deduce: the delay costs him nothing. Without it the rational move
    // is to assume the clock has not started and stop referring.
    const msg = w9PartnerMessage({ w9_received_at: null })!
    expect(msg).toMatch(/accru|still earning|nothing is lost/i)
  })
})

// The W-9 gate was a FULL-PAGE gate: src/app/partner/page.tsx returned
// <W9Gate /> INSTEAD of <Statement />, so a partner who had signed the
// agreement but not the tax form saw no client roster, no commission
// window, no claim form — nothing he could act on except the form itself.
//
// It now withholds money alone. These guards hold that line in the two
// places it can quietly fall back:
//
//   1. the page re-acquiring an early return, and
//   2. the statement reading or computing a figure BEFORE it has asked
//      whether it may show one. The reads are the thing: a payout read
//      that happens unconditionally is one `fmt()` away from being
//      rendered, and the W-9 check becomes decoration.
//
// Source text, not behaviour, because both files are .tsx and vitest's
// include is `src/**/*.test.ts`. Comments are stripped first — a grep
// over source otherwise counts its own prose, and this file's own header
// names every anchor below.
describe('the W-9 withholds money, not the portal', () => {
  const codeOf = (file: string) =>
    readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')

  it('the stripper drops prose and keeps code', () => {
    // A CONTROL, AND IT MUST BIND TO TEXT THAT IS REALLY THERE. Its first
    // version asserted the stripped page did not contain "returns <W9Gate
    // /> INSTEAD" — a phrase page.tsx stopped containing the moment this
    // change rewrote that comment. It would have passed by ABSENCE rather
    // than by stripping, and a control that passes for the wrong reason
    // certifies the two guards below while proving nothing about them.
    //
    // So both halves are asserted against the same needle: present in the
    // raw file, gone from the stripped one. If the comment is ever
    // reworded, the first expectation fails loudly instead of the control
    // going quietly hollow.
    const PAGE = 'src/app/partner/page.tsx'
    const needle = 'ITS REMOVAL IS THE POINT'
    expect(readFileSync(PAGE, 'utf8')).toContain(needle)
    expect(codeOf(PAGE)).not.toContain(needle)
    expect(codeOf(PAGE)).toContain('<Statement')
  })

  it('the page no longer replaces the statement with the W-9 screen', () => {
    // THE PARTNER PAGE KNOWS NOTHING ABOUT THE W-9, and that is stated as
    // a ban on the whole vocabulary rather than on one component name.
    //
    // THE FIRST VERSION OF THIS TEST WAS DECORATION, AND IT WAS CAUGHT BY
    // REVERSION RATHER THAN BY READING IT. It asserted `not.toContain(
    // '<W9Gate')` — the name of the component this change DELETED. With
    // `if (!holdsW9(partner)) return <W9Prompt partner={partner} />`
    // restored to this file below the acceptance gate, the entire suite
    // stayed green: 42/42. The exact regression these guards exist to
    // prevent was reinstatable without turning anything red, because the
    // guard was spelled against a name that can no longer appear.
    //
    // The sibling in partner-terms.test.ts does not cover it either. That
    // one pins the acceptance gate AHEAD of any W-9 anchor, so it catches
    // an early return placed ABOVE the disclaimer — a §2.1 violation —
    // and passes an early return placed below it, which is §2.1-clean and
    // still the full-page gate.
    //
    // So: no W-9 anchor of any spelling, in code, anywhere in this file.
    // The partner page's only job is the session and the disclaimer.
    const src = codeOf('src/app/partner/page.tsx')
    expect(src).not.toMatch(/W9|w9|W-9/)
    expect(src).toContain('<Statement')
  })

  it('the statement asks the W-9 before it reads payouts or computes a figure', () => {
    // Anchored at CALL sites, with the paren. `holdsW9` without it finds
    // the import, which is before everything by definition and would make
    // this assertion pass with the check deleted.
    const src = codeOf('src/components/partner/Statement.tsx')
    const gate = src.indexOf('holdsW9(')
    expect(gate).toBeGreaterThan(-1)
    for (const anchor of ["'referral_payouts'", 'computeOwed(', 'buildStatement(']) {
      const at = src.indexOf(anchor)
      expect(at, anchor).toBeGreaterThan(-1)
      expect(at, anchor).toBeGreaterThan(gate)
    }
  })

  it('reads payouts in exactly one place', () => {
    // Two reads is how one of them comes to sit outside the gate.
    const src = codeOf('src/components/partner/Statement.tsx')
    expect(src.match(/'referral_payouts'/g)).toHaveLength(1)
  })

  it('still builds the roster, and carries the W-9 prompt beside it', () => {
    // The prompt is where the four headline tiles would have been, which
    // is the one place it answers the question the partner actually has.
    // Rendering it and NOT the roster is the regression this pins: the
    // roster is not waiting on a tax form.
    const src = codeOf('src/components/partner/Statement.tsx')
    expect(src).toContain('rosterRows(')
    expect(src).toContain('<W9Prompt')
  })

  it('the prompt is the only thing that says the W-9 sentence', () => {
    // The sentence moved out of <Statement> when the gate became a banner,
    // so asserting it in <Statement> would now fail — and relaxing that
    // assertion away is how the sentence goes missing altogether. It is
    // pinned at its new home instead, and the prompt must carry the
    // signing ACTION with it: nothing but the DocuSign webhook can record
    // a W-9, so a prompt without the button is a dead end dressed as an
    // instruction.
    const prompt = codeOf('src/components/partner/W9Prompt.tsx')
    expect(prompt).toContain('w9PartnerMessage(')
    expect(prompt).toContain("'/api/partner/w9-sign'")
    expect(prompt).toContain('Support@shipousa.com')
  })
})

describe('w9Label', () => {
  it('names both states plainly', () => {
    expect(w9Label({ w9_received_at: '2026-10-13T09:00:00.000Z' })).toEqual({
      text: 'on file',
      tone: 'good',
    })
    expect(w9Label({}).text).toBe('missing')
    expect(w9Label({}).tone).toBe('bad')
  })
})

describe('the webhook records the W-9 only on evidence', () => {
  // The stamp is the whole mechanism: if it fires unconditionally then
  // every partner who signs is marked payable, including the ones whose
  // envelope predated the W-9 — and the column becomes a worse lie than
  // the memory it replaced, because now it looks like a record.
  function body(src: string): string {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*)/.test(line))
      .filter((line) => !/^\s*import\b/.test(line))
      .join('\n')
  }

  const ROUTE = 'src/app/api/partner/agreement-webhook/route.ts'
  const STAMP = 'src/lib/partner-envelope-stamp.ts'
  const src = body(readFileSync(ROUTE, 'utf8'))
  const stamp = body(readFileSync(STAMP, 'utf8'))

  it('the stripper keeps code and drops prose and imports', () => {
    expect(body('  w9_received_at: now,\n')).toContain('w9_received_at')
    expect(body('  // w9_received_at is stamped below\n')).not.toContain('w9_received_at')
    expect(body("import { W9_INCLUDED } from '@/lib/partner-w9'\n")).not.toContain('W9_INCLUDED')
  })

  it('asks the envelope whether it carried one', () => {
    expect(src).toContain(`customField(payload, W9_CUSTOM_FIELD)`)
  })

  it('shares this module’s vocabulary instead of its own literals', () => {
    // A rename on either side would otherwise record every W-9 we receive
    // as not received — a silent failure that surfaces as a partner being
    // told we cannot pay them. Importing the constants is what makes that
    // impossible rather than merely unlikely, so a copy of either literal
    // is itself the defect.
    //
    // The route reads the field off the payload; the stamp module compares
    // its value. Each must use the constant for its own half, so both are
    // checked — the route no longer mentions W9_INCLUDED at all.
    expect(src).toContain('W9_CUSTOM_FIELD')
    expect(src).not.toContain(`'${W9_CUSTOM_FIELD}'`)
    expect(stamp).toContain('W9_INCLUDED')
    expect(stamp).not.toContain(`'${W9_INCLUDED}'`)
  })

  it('decides the stamp somewhere a test can reach, not inline in the route', () => {
    // WHY THIS REPLACED A SOURCE GREP FOR A CONDITIONAL SPREAD. The route
    // used to hold the decision, so the only available guard was "every
    // line mentioning the column looks guarded" — a check on the shape of
    // the text, which a plausible rewrite satisfies while being wrong.
    //
    // Now the decision is a pure function and
    // partner-envelope-stamp.test.ts asserts the real behaviour: that an
    // agreement completion leaves the key ABSENT. That is strictly
    // stronger. What is left for the source to answer is whether the route
    // still delegates, so the column name must not appear in it at all.
    expect(src).not.toContain('w9_received_at')
    expect(src).toContain('completedEnvelopeStamp(')
  })

  // NO SOURCE GREP FOR "the column is written conditionally" ANY MORE, and
  // the deletion is deliberate rather than a concession.
  //
  // The old guard scanned each line mentioning the column and required a
  // `?` or a `...(` on it. That worked while the write was a conditional
  // spread inside one object literal. In the stamp module the guard is a
  // block — `if (carriesW9) fields.w9_received_at = now` and its `if
  // (isW9Only)` sibling — so the assignment line carries no conditional
  // token of its own and a per-line regex cannot see the `if` above it.
  // Loosening the pattern until it passed would have left a check that
  // greps for the shape of text rather than the property.
  //
  // The property itself is asserted directly, as behaviour, in
  // partner-envelope-stamp.test.ts: an agreement completion must leave
  // 'w9_received_at' ABSENT from fields (not null), and a W-9 envelope
  // that does not declare a W-9 must leave it absent too. Those run the
  // real function over the real inputs, which is what the grep was
  // approximating.

  it('records the column name the migration actually adds', () => {
    // The phantom-column class: a name consistent everywhere in the code
    // and absent from the database. supabase/partner_w9.sql is the only
    // place it is created.
    const sql = readFileSync('supabase/partner_w9.sql', 'utf8')
    expect(sql).toMatch(/alter table referral_partners add column if not exists w9_received_at/)
    expect(stamp).toContain('w9_received_at')
  })
})
