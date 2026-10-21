import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  AGREEMENT_SIGNED,
  agreementLabel,
  canAccessPortal,
  invitePreconditionReason,
  portalAccessBlock,
  portalAccessBlockedReason,
  portalAccessPartnerMessage,
} from './partner-access'
import { SIGN_IN_EMAIL_COLUMNS } from './partner-signin-email'

/**
 * Does this route actually READ `column` off referral_partners?
 *
 * WHY THIS IS NOT A PLAIN REGEX ANY MORE. The guards below used to match
 * `/select\([^)]*tax_status/` against the route source, which worked only
 * while every route spelled its column list out inline. Three routes mail
 * the sign-in email and each had written its own list, so the list became
 * one shared constant (SIGN_IN_EMAIL_COLUMNS) — and the literal the guards
 * were reading moved out of the route.
 *
 * The property being protected did not change: a route that decides on a
 * column it never selected is asking about undefined, and undefined reads
 * as "unrecorded" for every partner. So the guard follows the indirection
 * rather than losing the property — resolve the constant, then match.
 *
 * Importing partner-signin-email is safe here: src/lib/supabase.ts builds
 * its clients lazily, so nothing connects at module load.
 */
function selectsColumn(src: string, column: string): boolean {
  const resolved = src.replace(/SIGN_IN_EMAIL_COLUMNS/g, `'${SIGN_IN_EMAIL_COLUMNS}'`)
  return new RegExp(`select\\([^)]*${column}`).test(resolved)
}

describe('selectsColumn sees through the shared column list', () => {
  it('resolves the constant', () => {
    expect(selectsColumn('.select(SIGN_IN_EMAIL_COLUMNS)', 'w9_received_at')).toBe(true)
    expect(selectsColumn('.select(SIGN_IN_EMAIL_COLUMNS)', 'tax_status')).toBe(true)
  })

  it('still reads an inline list', () => {
    expect(selectsColumn(".select('id, tax_status')", 'tax_status')).toBe(true)
  })

  // THE CONTROL. Without it the helper could answer true for anything and
  // every caller below would pass vacuously — which is the failure mode of
  // a guard that reads a constant instead of the code.
  it('says no to a column nobody selects', () => {
    expect(selectsColumn('.select(SIGN_IN_EMAIL_COLUMNS)', 'cost_labour_not_deducted')).toBe(false)
    expect(selectsColumn(".select('id, name')", 'tax_status')).toBe(false)
  })
})

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

/**
 * The invite is the LAST MOMENT Shipo can prevent a dead end.
 *
 * `referral_partners.tax_status` has no default (supabase/partner_tax_status.sql),
 * so every new partner starts with it unset — and w9SignRefusal refuses
 * to assemble a W-9 for a partner whose tax status nobody recorded.
 * Deliberately vaguely, because our bookkeeping is not his business.
 *
 * So the ordinary path — invite, he signs, he logs in, he asks for his
 * money — ends with him told to email support over a dropdown nobody
 * selected. Not an edge case: the DEFAULT for every partner added from
 * today on. It was worse when the W-9 was a full-page gate, which made
 * that refusal the entire dashboard; it now costs him the payment rather
 * than the portal, and he still cannot fix it himself.
 *
 * This is a precondition for SENDING AN INVITE and deliberately not part
 * of portalAccessBlock, which is also consulted at login. A partner
 * already in the portal must not be thrown out over a column that governs
 * only a form he may already have on file.
 */
describe('invitePreconditionReason', () => {
  it('lets a signed, active partner with a recorded tax status through', () => {
    expect(invitePreconditionReason({ ...signed, tax_status: 'us_person' })).toBeNull()
  })

  it('refuses to invite a partner whose tax status nobody recorded', () => {
    for (const tax_status of [null, undefined, '']) {
      expect(invitePreconditionReason({ ...signed, tax_status })).not.toBeNull()
    }
    expect(invitePreconditionReason({ ...signed })).not.toBeNull()
  })

  it('refuses an unrecognised value rather than reading it as recorded', () => {
    // Same fail-closed rule as taxStatusOf: a typo past the database
    // CHECK is not a tax status somebody chose.
    expect(invitePreconditionReason({ ...signed, tax_status: 'US Person' })).not.toBeNull()
  })

  it('allows a foreign partner to be invited', () => {
    // He cannot be sent a W-9 and must not be — but he has an agreement,
    // and the portal has a statement in it. Refusing the invite would
    // make "we do not build W-8 envelopes yet" into "you get no portal",
    // which is a bigger refusal than the one anybody decided on.
    for (const tax_status of ['foreign_individual', 'foreign_entity']) {
      expect(invitePreconditionReason({ ...signed, tax_status })).toBeNull()
    }
  })

  it('says what staff must do, and names the screen they do it on', () => {
    const msg = invitePreconditionReason({ ...signed, tax_status: null })!
    expect(msg).toMatch(/tax status/i)
    expect(msg).toMatch(/referrals|partner editor/i)
    expect(msg.length).toBeGreaterThan(20)
  })

  it('is about the invite only — it does not block a login', () => {
    // The regression this forbids: adding the rule to portalAccessBlock
    // would lock out a partner who already holds a W-9 (stamped by the
    // old combined envelope) but whose tax_status was never recorded —
    // taking away a statement he is entitled to read.
    expect(portalAccessBlock({ ...signed, tax_status: null })).toBeNull()
    expect(portalAccessPartnerMessage({ ...signed, tax_status: null })).toBeNull()

    // canAccessPortal is the SESSION gate — partner-auth.ts asks it on
    // every request. Folding the precondition into it signs out a
    // logged-in partner over a column staff have not filled in, which is
    // how the first draft of this fix broke the existing suite.
    expect(canAccessPortal({ ...signed, tax_status: null })).toBe(true)
  })
})

describe('the invite precondition is wired to both call sites', () => {
  function body(text: string): string {
    return text
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*)/.test(line))
      .filter((line) => !/^\s*import\b/.test(line))
      .join('\n')
  }

  const route = body(readFileSync('src/app/api/referrals/portal-access/route.ts', 'utf8'))
  const screen = body(readFileSync('src/components/referrals/ReferralsManager.tsx', 'utf8'))

  it('the stripper keeps code and drops prose and imports', () => {
    expect(body('  invitePreconditionReason(p)\n')).toContain('invitePreconditionReason')
    expect(body('  // invitePreconditionReason is called below\n')).not.toContain(
      'invitePreconditionReason',
    )
  })

  it('the route refuses the invite, since a greyed button is not a control', () => {
    expect(route).toContain('invitePreconditionReason(')
    // And it must read the column, or it is asking about a field it never
    // selected — which answers "unrecorded" for everybody.
    expect(selectsColumn(route, 'tax_status')).toBe(true)
  })

  it('the screen reads the column too, so the button reflects the same rule', () => {
    expect(screen).toContain('tax_status')
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
    expect(selectsColumn(src, 'agreement_status')).toBe(true)
  })

  it('no code is mailed to a partner who has not signed', () => {
    // THE GATE MOVED, AND THIS GUARD FOLLOWED THE CODE RATHER THAN THE
    // FILENAME. It used to read request-code/route.ts, where the gate stood
    // beside the credential it protected. Issuance now lives in
    // sendSignInEmail, which the login route, the staff invite button and
    // the DocuSign webhook all call — so the gate moved INSIDE that
    // function, where no caller can forget it.
    //
    // Left pointing at the route, every assertion below would have passed
    // vacuously forever: a route that mints no credential trivially has no
    // ungated minting in it. That is the shape of a test that has quietly
    // stopped checking anything.
    const src = body(readFileSync('src/lib/partner-signin-email.ts', 'utf8'))
    expect(src).toContain('portalAccessBlock(')
    // Calling it is not enough; the answer has to stop the send. And it has
    // to stop it BEFORE a code exists — a row written but not mailed is a
    // live credential sitting in the database with nobody expecting it.
    expect(src).toMatch(/if\s*\(\s*block\s*\)/)
    const gate = src.indexOf('portalAccessBlock(')
    const mint = src.indexOf('generateCode(')
    expect(mint).toBeGreaterThan(-1)
    expect(gate).toBeLessThan(mint)
  })

  it('the login route answers a refusal exactly as it answers a stranger', () => {
    // The route half of the rule above, and the half that cannot move into
    // the shared function: sendSignInEmail returns a reason, and the login
    // endpoint decides what a browser is told. The refusal must stay
    // indistinguishable from "that address is not a partner", or the login
    // form becomes a lookup for who has signed with Shipo.
    const src = body(readFileSync('src/app/api/partner/request-code/route.ts', 'utf8'))
    // Asserted as the OK constant being what the blocked branch returns —
    // the same constant the no-partner path above it returns.
    expect(src).toMatch(/case 'blocked':[\s\S]{0,240}?NextResponse\.json\(OK\)/)
    // And no honest sentence on that branch. The one place it is safe to
    // say "your agreement isn't signed" is verify-code, where the caller
    // has already proved they hold a mailed code.
    expect(src).not.toMatch(/case 'blocked':[\s\S]{0,240}?status:\s*4\d\d/)
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

  it('the SESSION select feeds the partner s own account panel too', () => {
    // §4.4 shows the partner when he signed. The session select is the only
    // read behind that panel, and a column missing from it arrives as
    // undefined — which the panel renders as "—", i.e. "we have no record
    // of you signing", to the one person who did sign. A silent wrong
    // answer about his own contract, so it is pinned to the select rather
    // than left to a reviewer noticing an em dash.
    const src = body(readFileSync('src/lib/partner-auth.ts', 'utf8'))
    expect(src).toMatch(/select\([^)]*agreement_signed_at/)
    // And the type, because the component reads the field off SessionPartner.
    expect(src).toMatch(/agreement_signed_at\s*:\s*string \| null/)
  })
})

describe('the webhook and this module agree on the vocabulary', () => {
  // A rename on either side turns the gate into a permanent refusal: the
  // writer would write 'complete', this module would keep looking for
  // 'signed', and every partner who signed would be told they had not. The
  // failure is silent and only a partner notices it, so it is asserted here
  // against the source rather than left to memory.
  //
  // BOTH FILES, because Task 7 moved the completion stamp out of the route
  // and into partner-envelope-stamp.ts. Reading only the route would have
  // left this describe green over a route that writes no agreement_status
  // at all — which is exactly the state it is in now. The contract is
  // between this module and whatever writes the column, so the guard reads
  // everything that writes it; add a third writer and it belongs here too.
  const WRITERS = [
    'src/app/api/partner/agreement-webhook/route.ts',
    'src/lib/partner-envelope-stamp.ts',
  ]
  const src = WRITERS.map((f) => readFileSync(f, 'utf8')).join('\n')

  it('every file this describe claims to read exists and is non-empty', () => {
    // A typo'd path would throw, but a file that is renamed away and
    // re-created empty would not — and an empty string satisfies no
    // `toContain`, so the describe would go red for the right reason. What
    // this catches is the opposite: a `WRITERS` entry quietly reduced to a
    // file that no longer writes anything, leaving the greps below reading
    // a shrinking surface.
    for (const f of WRITERS) expect(readFileSync(f, 'utf8').length).toBeGreaterThan(200)
  })

  // Two ways to write the column, both real in this codebase: the route
  // builds object literals (`agreement_status: 'voided'`) and the stamp
  // module assigns onto a fields record (`fields.agreement_status =
  // 'signed'`). Matching only the first is how this describe went green
  // over a route that had stopped writing the column at all.
  const ASSIGNS = /agreement_status(?::|\s*=)\s*'([^']+)'/g

  it('the pattern recognises both assignment forms', () => {
    // A control. Without it, a pattern that silently matched neither form
    // would make every assertion below vacuous rather than red: they all
    // read from the same matchAll, and an empty match set passes a filter.
    const found = (s: string) => [...s.matchAll(new RegExp(ASSIGNS.source, 'g'))].map((m) => m[1])
    expect(found("  agreement_status: 'voided',")).toEqual(['voided'])
    expect(found("  fields.agreement_status = 'signed'")).toEqual(['signed'])
    expect(found('  agreement_status,')).toEqual([])
  })

  const written = [...src.matchAll(ASSIGNS)].map((m) => m[1])

  it(`writes agreement_status '${AGREEMENT_SIGNED}' on completion`, () => {
    expect(written).toContain(AGREEMENT_SIGNED)
  })

  for (const state of ['declined', 'voided']) {
    it(`writes agreement_status '${state}', which agreementLabel maps`, () => {
      expect(written).toContain(state)
      expect(agreementLabel(state).tone).toBe('bad')
    })
  }

  it('writes no completion state this module does not recognise', () => {
    // Every literal assigned to agreement_status must be a state
    // agreementLabel maps deliberately, i.e. not fall through to the default.
    expect(written.length).toBeGreaterThan(0)
    const known = new Set(['signed', 'declined', 'voided', 'sent'])
    expect([...new Set(written)].filter((s) => !known.has(s))).toEqual([])
  })
})
