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
    // was true then. It is now the gate on the whole dashboard:
    // src/app/partner/page.tsx returns <W9Gate /> INSTEAD of <Statement />,
    // so a partner without a W-9 sees no client roster, no commission
    // window, no figures at all — and reads, on that very screen, that
    // nothing else about his account is waiting on it.
    //
    // The §1a failure class exactly: a sentence that stayed behind when
    // the behaviour around it tightened. A partner who believes it has no
    // reason to prioritise the form, and no reason to connect the empty
    // screen to the one thing that would fill it.
    const msg = w9PartnerMessage({ w9_received_at: null })!
    expect(msg).not.toMatch(/nothing else about your account/i)
    expect(msg).not.toMatch(/nothing else is waiting|only affects (?:your )?payment/i)
  })

  it('tells him what the form unlocks, since it is the whole screen', () => {
    // The replacement has to be positive, not merely not-false. "We
    // cannot show you anything" with no reason reads as a dispute; the
    // honest version names the form as the way to the figures.
    const msg = w9PartnerMessage({ w9_received_at: null })!
    expect(msg).toMatch(/clients|statement|figures|commission/i)
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
