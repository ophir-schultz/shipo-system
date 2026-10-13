import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  AGREEMENT_SIGNED,
  agreementLabel,
  canAccessPortal,
  portalAccessBlockedReason,
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

  it('the API route refuses on it — this is the only enforcement that counts', () => {
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
