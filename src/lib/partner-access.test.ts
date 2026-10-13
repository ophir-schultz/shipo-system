import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  AGREEMENT_SIGNED,
  agreementLabel,
  canAccessPortal,
  portalAccessBlock,
  portalAccessBlockedReason,
  portalAccessPartnerMessage,
} from './partner-access'

const signed = {
  name: 'Dana Katz',
  email: 'dana@example.com',
  status: 'active',
  agreement_status: AGREEMENT_SIGNED,
}

describe('portalAccessBlockedReason', () => {
  it('lets a signed, active partner with an email through', () => {
    expect(portalAccessBlockedReason(signed)).toBeNull()
    expect(canAccessPortal(signed)).toBe(true)
  })

  it('refuses when the agreement is not signed', () => {
    // The whole point of the gate. A partner who reaches their statement
    // before signing is reading commission figures that Section 6 of the
    // unsigned agreement makes confidential.
    expect(portalAccessBlockedReason({ ...signed, agreement_status: null })).toMatch(/not signed/i)
    expect(portalAccessBlockedReason({ ...signed, agreement_status: 'sent' })).toMatch(/not signed/i)
    expect(portalAccessBlockedReason({ ...signed, agreement_status: 'declined' })).toMatch(
      /declined/i,
    )
    expect(portalAccessBlockedReason({ ...signed, agreement_status: 'voided' })).toMatch(/voided/i)
  })

  it('treats an absent agreement_status as not signed, never as fine', () => {
    // Fail-closed. A missing column, a partner row created by hand, a webhook
    // that never fired — all arrive here as undefined, and all of them mean
    // "we have no evidence they signed", which is not the same as "they did".
    for (const agreement_status of [null, undefined, '']) {
      expect(canAccessPortal({ ...signed, agreement_status })).toBe(false)
    }
    // And a value we have never seen is also not a pass. If DocuSign or a
    // future migration introduces a new state, the safe reading is "unknown".
    expect(canAccessPortal({ ...signed, agreement_status: 'partially_signed' })).toBe(false)
    expect(canAccessPortal({ ...signed, agreement_status: 'SIGNED' })).toBe(false)
  })

  it('refuses an inactive partner even once signed', () => {
    expect(portalAccessBlockedReason({ ...signed, status: 'inactive' })).toMatch(/inactive/i)
  })

  it('refuses a partner with no email, and says so before anything else', () => {
    // Email first: it is the one fault that makes every later message
    // pointless, since the invite has nowhere to go.
    const broken = { name: 'X', email: null, status: 'inactive', agreement_status: null }
    expect(portalAccessBlockedReason(broken)).toMatch(/email/i)
  })

  it('gives a sentence a staff member can act on, not a code', () => {
    const reason = portalAccessBlockedReason({ ...signed, agreement_status: null })
    expect(reason).toBeTruthy()
    expect(reason!.length).toBeGreaterThan(20)
    expect(reason).not.toMatch(/^[A-Z_]+$/)
  })
})

describe('one decision, two vocabularies', () => {
  // portalAccessBlock decides; the two message functions only phrase it. The
  // thing being protected here is that they cannot disagree about WHETHER to
  // refuse, only about how to say it — because the dangerous drift is not a
  // clumsy sentence, it is a condition present in the staff copy and missing
  // from the login copy, which is an open door.
  const cases: Array<[string, Parameters<typeof portalAccessBlock>[0]]> = [
    ['no_email', { ...signed, email: null }],
    ['inactive', { ...signed, status: 'inactive' }],
    ['declined', { ...signed, agreement_status: 'declined' }],
    ['voided', { ...signed, agreement_status: 'voided' }],
    ['unsigned', { ...signed, agreement_status: 'not_sent' }],
  ]

  it('every block reason has both a staff and a partner sentence', () => {
    // Record<AccessBlock, string> makes a missing one a compile error, so this
    // asserts the part the type cannot: that neither map holds an empty
    // string, which would type-check and render as a blank refusal.
    for (const [expected, partner] of cases) {
      expect(portalAccessBlock(partner)).toBe(expected)
      expect(portalAccessBlockedReason(partner)!.length).toBeGreaterThan(20)
      expect(portalAccessPartnerMessage(partner)!.length).toBeGreaterThan(20)
    }
  })

  it('refuses and permits identically whichever vocabulary is asked', () => {
    for (const [, partner] of cases) {
      expect(portalAccessPartnerMessage(partner)).not.toBeNull()
      expect(portalAccessBlockedReason(partner)).not.toBeNull()
    }
    expect(portalAccessPartnerMessage(signed)).toBeNull()
    expect(portalAccessBlockedReason(signed)).toBeNull()
    expect(portalAccessBlock(signed)).toBeNull()
  })

  it('never shows a partner an instruction aimed at Shipo staff', () => {
    // This is the whole reason for the split. The staff sentences say
    // "Reactivate them first" and "Send a new one before granting access" —
    // both actions only Shipo can take. Handed to a partner holding a valid
    // login code, they read as being told to fix something they cannot reach.
    for (const [, partner] of cases) {
      const text = portalAccessPartnerMessage(partner)!
      // Third person about the person reading it.
      expect(text).not.toMatch(/\bthis partner\b/i)
      expect(text).not.toMatch(/\bthey cannot\b/i)
      // Imperatives addressed at staff.
      expect(text).not.toMatch(/\breactivate\b/i)
      expect(text).not.toMatch(/granting access/i)
      // And it must leave the partner somewhere to go, rather than dead-end.
      expect(text).toMatch(/Support@shipousa\.com|DocuSign/)
    }
  })

  it('tells an unsigned partner to finish signing, not to contact support', () => {
    // The one case the partner can resolve alone, and by far the most common
    // — it is the state every row sits in between invite and signature. A
    // "email support" answer here would generate a support ticket for
    // something the partner only has to finish.
    const text = portalAccessPartnerMessage({ ...signed, agreement_status: 'sent' })!
    expect(text).toMatch(/not signed yet/i)
    expect(text).toMatch(/DocuSign/)
  })
})

describe('agreementLabel', () => {
  it('names the states the webhook actually writes', () => {
    // These four strings are not invented here — they are the values written
    // by src/app/api/partner/agreement-webhook/route.ts. The test below holds
    // that correspondence.
    expect(agreementLabel('signed')).toEqual({ text: 'signed', tone: 'good' })
    expect(agreementLabel('declined').tone).toBe('bad')
    expect(agreementLabel('voided').tone).toBe('bad')
    expect(agreementLabel('sent').tone).toBe('wait')
  })

  it('shows an unknown state as itself rather than inventing a friendly word', () => {
    expect(agreementLabel('something_new').text).toBe('something_new')
    expect(agreementLabel('something_new').tone).toBe('wait')
  })

  it('distinguishes "not sent" from a state we were given', () => {
    expect(agreementLabel(null).text).toBe('not sent')
    expect(agreementLabel(undefined).text).toBe('not sent')
  })

  it('reads the column default as English, not as a column value', () => {
    // 'not_sent' is the default in supabase/partner_onboarding.sql, so it is
    // the state most rows hold. Falling through to the unknown-state branch
    // showed the raw value, underscore and all.
    expect(agreementLabel('not_sent')).toEqual({ text: 'not sent', tone: 'wait' })
    const sql = readFileSync('supabase/partner_onboarding.sql', 'utf8')
    expect(sql).toContain("agreement_status text default 'not_sent'")
  })
})

describe('the gate is actually wired to something', () => {
  // Everything above tests the RULE. None of it tests that any code asks.
  // A correct rule nobody consults is the same as no rule, and it would stay
  // green forever — so the two call sites are asserted against their source.
  //
  // Comments AND import lines are stripped first, for two different reasons.
  //
  // Comments: the route explains the gate in prose that names the module, and
  // a grep over source counts its own prose.
  //
  // Imports: this was measured, not predicted. The first version of this
  // check only required the source to CONTAIN 'portalAccessBlockedReason',
  // and replacing the route's entire gate with `const blocked = null` left it
  // green — because the import line still mentioned the name. The check tested
  // a mention where it needed to test a use. Stripping imports and requiring
  // the call form is what closed it.
  function body(src: string): string {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*)/.test(line))
      .filter((line) => !/^\s*import\b/.test(line))
      .join('\n')
  }

  it('the stripper keeps calls but drops prose and imports', () => {
    expect(body('  const r = portalAccessBlockedReason(p)\n')).toContain(
      'portalAccessBlockedReason(',
    )
    expect(body('  // see portalAccessBlockedReason for the rule\n')).not.toContain(
      'portalAccessBlockedReason',
    )
    expect(body("import { portalAccessBlockedReason } from '@/lib/partner-access'\n")).not.toContain(
      'portalAccessBlockedReason',
    )
  })

  it('the staff invite route refuses on it', () => {
    // This used to be titled "the only enforcement that counts", and it was
    // true: the rule was consulted nowhere else. That was the bug — the login
    // endpoints below are the front door, and they were not asking.
    const src = body(readFileSync('src/app/api/referrals/portal-access/route.ts', 'utf8'))
    expect(src).toContain('portalAccessBlockedReason(')
    // Calling it is not enough; the answer has to stop the request. Asserting
    // the refusal shape as well, because `const blocked = portalAccess...()`
    // followed by nothing would satisfy the call check alone.
    expect(src).toMatch(/if\s*\(\s*blocked\s*\)/)
    // And it must select the column, or the rule reads undefined for every
    // partner and fails closed on all of them — a gate that is always shut
    // looks like a working gate right up until the first real signature.
    expect(src).toMatch(/select\([^)]*agreement_status/)
  })

  it('request-code will not mail a code to a partner who has not signed', () => {
    const src = body(readFileSync('src/app/api/partner/request-code/route.ts', 'utf8'))
    expect(src).toContain('portalAccessBlockedReason(')
    expect(src).toMatch(/if\s*\(\s*blocked\s*\)/)
    expect(src).toMatch(/select\([^)]*agreement_status/)
    // The refusal must stay indistinguishable from "that address is not a
    // partner", or the login form becomes a lookup for who has signed.
    // Asserted as the OK constant being what the blocked branch returns.
    expect(src).toMatch(/if\s*\(\s*blocked\s*\)\s*\{[^}]*NextResponse\.json\(OK\)/)
  })

  it('verify-code will not issue a session to a partner who has not signed', () => {
    const src = body(readFileSync('src/app/api/partner/verify-code/route.ts', 'utf8'))
    // The PARTNER vocabulary here, not the staff one — see the split above.
    expect(src).toContain('portalAccessPartnerMessage(')
    expect(src).not.toContain('portalAccessBlockedReason(')
    expect(src).toMatch(/if\s*\(\s*blocked\s*\)/)
    expect(src).toMatch(/select\([^)]*agreement_status/)
    // 403, not the uniform 401: the code was right and the answer is still no.
    expect(src).toMatch(/status:\s*403/)
  })

  it('verify-code checks the gate BEFORE it burns the code', () => {
    // Ordering, and it is not cosmetic. The DocuSign webhook can flip
    // agreement_status to 'signed' while a code is in flight, so a refusal
    // that consumed the code would make a partner who signed a minute ago
    // request a second email for nothing. A code not spent is still good.
    const src = body(readFileSync('src/app/api/partner/verify-code/route.ts', 'utf8'))
    const gate = src.indexOf('portalAccessPartnerMessage(')
    const consume = src.indexOf('consumed_at: new Date()')
    expect(gate).toBeGreaterThan(-1)
    expect(consume).toBeGreaterThan(-1)
    expect(gate).toBeLessThan(consume)
    // And after the hash comparison, because the specific message is only
    // safe to show someone who has proved they received the email.
    const compare = src.indexOf('timingSafeEqual(')
    expect(compare).toBeGreaterThan(-1)
    expect(compare).toBeLessThan(gate)
  })

  it('an existing session is re-checked against the gate on every request', () => {
    // A session lasts SESSION_DAYS. Gating only at login would mean an
    // agreement voided on day 2 keeps working until day 30 — so the door
    // being locked is not enough, the room has to be checked too.
    const src = body(readFileSync('src/lib/partner-auth.ts', 'utf8'))
    expect(src).toContain('canAccessPortal(')
    expect(src).toMatch(/if\s*\(\s*!canAccessPortal\([^)]*\)\s*\)\s*return null/)
    expect(src).toMatch(/select\([^)]*agreement_status/)
  })

  it('the Referrals screen reflects it', () => {
    const src = body(readFileSync('src/components/referrals/ReferralsManager.tsx', 'utf8'))
    expect(src).toContain('portalAccessBlockedReason(')
    expect(src).toContain('agreementLabel(')
  })

  it('the page feeds the screen the column it needs', () => {
    // The component cannot show or gate on a field the server never selected.
    // It would simply be undefined, which this module reads as "not signed" —
    // so the symptom of forgetting it here is every partner locked out.
    const src = body(readFileSync('src/app/referrals/page.tsx', 'utf8'))
    expect(src).toMatch(/agreement_status/)
    expect(src).toMatch(/agreement_signed_at/)
  })
})

describe('the webhook and this module agree on the vocabulary', () => {
  // A rename on either side turns the gate into a permanent refusal: the
  // webhook would write 'complete', this module would keep looking for
  // 'signed', and every partner who signed would be told they had not. The
  // failure is silent and only a partner notices it, so it is asserted here
  // against the webhook's source rather than left to memory.
  const src = readFileSync('src/app/api/partner/agreement-webhook/route.ts', 'utf8')

  it(`writes agreement_status: '${AGREEMENT_SIGNED}' on completion`, () => {
    expect(src).toContain(`agreement_status: '${AGREEMENT_SIGNED}'`)
  })

  for (const state of ['declined', 'voided']) {
    it(`writes agreement_status: '${state}', which agreementLabel maps`, () => {
      expect(src).toContain(`agreement_status: '${state}'`)
      expect(agreementLabel(state).tone).toBe('bad')
    })
  }

  it('writes no completion state this module does not recognise', () => {
    // Every literal the webhook assigns to agreement_status must be a state
    // agreementLabel maps deliberately, i.e. not fall through to the default.
    const written = [...src.matchAll(/agreement_status:\s*'([^']+)'/g)].map((m) => m[1])
    expect(written.length).toBeGreaterThan(0)
    const known = new Set(['signed', 'declined', 'voided', 'sent'])
    expect([...new Set(written)].filter((s) => !known.has(s))).toEqual([])
  })
})
