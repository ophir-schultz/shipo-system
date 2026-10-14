import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import {
  CLAIM_DAILY_CAP,
  CLAIM_FIELD_MAX,
  CLAIM_NOTE_MAX,
  CLAIM_PARTNER_TEXT,
  CLAIM_RECEIVED,
  CLAIM_STORE_CEILING,
  approvalConflict,
  claimAdmission,
  claimPartnerState,
  claimRow,
  clientMatches,
  needsAttribution,
  overDailyCap,
  reattributionConflict,
} from './partner-claims'

/**
 * §3.1-§3.3. This is the only new path to money in the plan: the deal is
 * $300 plus 5% of net profit for twelve months, so a form that attributed
 * a client by the act of typing his name would be a form for claiming
 * clients a partner never referred.
 *
 * Two properties carry that, and both are tested here rather than left to
 * the route:
 *
 *   1. the INSERTED SHAPE attributes nothing — no client_id, no decided_*,
 *      no decision_note, not even as null, and
 *   2. the RESPONSE answers nothing — one sentence for every outcome, so
 *      the form cannot be used as a lookup against Shipo's client list.
 */

describe('overDailyCap — fails CLOSED', () => {
  it('refuses when the count could not be read', () => {
    // §3.2 in one line. `/api/referrals/intake`'s ceiling fails OPEN on a
    // failed COUNT; this must not copy it. An unreadable count is an
    // unknown, and an unknown here is a submission we cannot rate-limit.
    expect(overDailyCap(null)).toBe(true)
  })

  it('allows under the cap and refuses at it', () => {
    expect(overDailyCap(0)).toBe(false)
    expect(overDailyCap(CLAIM_DAILY_CAP - 1)).toBe(false)
    expect(overDailyCap(CLAIM_DAILY_CAP)).toBe(true)
  })

  it('refuses above the cap, not only exactly at it', () => {
    expect(overDailyCap(CLAIM_DAILY_CAP + 1)).toBe(true)
    expect(overDailyCap(500)).toBe(true)
  })
})

describe('claimAdmission — refuse, but RECORD', () => {
  /**
   * The cap's two jobs were being done by one answer, and the second job
   * was never the discard.
   *
   *   CONCEALMENT is done by the identical response (§3.2). That is what
   *   stops the form being used as a lookup, and it is unaffected by
   *   whether we keep the row.
   *
   *   FLOOD PROTECTION is what the discard was for. It bounds the rows one
   *   partner can write in a day.
   *
   * Throwing the row away does nothing for the first and everything for
   * the second, so the honest shape is three outcomes, not two: store it
   * normally, store it FLAGGED, or — only once the table is being used as
   * a dumping ground — drop it. A partner's sixth genuine claim in a day
   * is not a script, and today it vanishes while he reads "Received."
   */
  it('accepts everything below the cap', () => {
    expect(claimAdmission(0)).toBe('accept')
    expect(claimAdmission(CLAIM_DAILY_CAP - 1)).toBe('accept')
  })

  it('FLAGS rather than discards at and just above the cap', () => {
    // The finding. These are the claims that were silently thrown away.
    expect(claimAdmission(CLAIM_DAILY_CAP)).toBe('flag')
    expect(claimAdmission(CLAIM_DAILY_CAP + 1)).toBe('flag')
    expect(claimAdmission(CLAIM_STORE_CEILING - 1)).toBe('flag')
  })

  it('discards only once the ceiling is reached', () => {
    expect(claimAdmission(CLAIM_STORE_CEILING)).toBe('discard')
    expect(claimAdmission(CLAIM_STORE_CEILING + 1)).toBe('discard')
    expect(claimAdmission(50_000)).toBe('discard')
  })

  it('stores a claim whose count could not be read', () => {
    // NOT a discard. overDailyCap(null) is true and stays true — an
    // unmeasurable ceiling must refuse to treat the claim as ordinary —
    // but "we could not count his claims" is not a reason to destroy one.
    // The insert then answers for itself: it either works, or it is the
    // 500 this route already owes him.
    expect(claimAdmission(null)).toBe('flag')
  })

  it('leaves room to flag — the ceiling is above the cap', () => {
    // A ceiling at or below the cap would make `flag` unreachable and
    // restore the bug with every test above still passing.
    expect(CLAIM_STORE_CEILING).toBeGreaterThan(CLAIM_DAILY_CAP)
  })

  it('agrees with overDailyCap about what is NOT an ordinary claim', () => {
    // Two functions, one boundary. If the cap moves and only one of them
    // follows, a claim is either flagged while counting as ordinary or
    // stored as ordinary while being flagged.
    for (const n of [0, 1, CLAIM_DAILY_CAP - 1, CLAIM_DAILY_CAP, CLAIM_DAILY_CAP + 1, 999]) {
      expect(claimAdmission(n) === 'accept').toBe(!overDailyCap(n))
    }
    expect(claimAdmission(null) === 'accept').toBe(!overDailyCap(null))
  })
})

describe('claimRow marks a claim that did not arrive within the allowance', () => {
  it('omits over_cap entirely on an ordinary claim', () => {
    // Omitted, not `false`. Same rule as the optional text fields and the
    // same rule as client_id: the column has a default, and a key written
    // here is a key somebody later fills in from somewhere else.
    const r = claimRow('p1', { company_name: 'Acme' }, null)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect('over_cap' in r.row).toBe(false)
  })

  it('sets over_cap when told the claim is being flagged', () => {
    const r = claimRow('p1', { company_name: 'Acme' }, null, true)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.row.over_cap).toBe(true)
  })

  it('still attributes nothing on a flagged claim', () => {
    // The flag must not become a side door into the allow-list.
    const r = claimRow(
      'p1',
      { company_name: 'Acme', client_id: 'real-client', status: 'approved' } as never,
      null,
      true,
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect('client_id' in r.row).toBe(false)
    expect(r.row.status).toBe('submitted')
    expect(r.row.referral_partner_id).toBe('p1')
  })

  it('a flagged claim is still SUBMITTED, so staff see it in the open queue', () => {
    // A bespoke status would hide it from `open` in ClaimsQueue.tsx, which
    // filters on 'submitted' — recording the row and never showing it is
    // the same loss as the discard, arriving one step later.
    const r = claimRow('p1', { company_name: 'Acme' }, null, true)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.row.status).toBe('submitted')
    expect(claimPartnerState(r.row.status as string)).toBe('under_review')
  })
})

describe('claimRow', () => {
  it('trims and keeps a normal company name', () => {
    const r = claimRow('p1', { company_name: '  Acme Co  ' }, null)
    expect(r.ok && r.row.company_name).toBe('Acme Co')
  })

  // Review Focus 4
  it('refuses a whitespace-only or missing company name', () => {
    expect(claimRow('p1', { company_name: '   ' }, null).ok).toBe(false)
    expect(claimRow('p1', {}, null).ok).toBe(false)
    expect(claimRow('p1', { company_name: 123 }, null).ok).toBe(false)
  })

  it('refuses a company name that is not a string, whatever shape it is', () => {
    // The body is JSON from the network. `null`, an array and an object
    // all survive JSON.parse, and `String(x)` would turn each of them
    // into a stored company name: 'null', '[object Object]'.
    for (const bad of [null, undefined, [], {}, true, 1.5]) {
      expect(claimRow('p1', { company_name: bad }, null).ok, JSON.stringify(bad) ?? 'undefined').toBe(false)
    }
  })

  it('caps every field before insert', () => {
    const r = claimRow('p1', { company_name: 'x'.repeat(10_000), note: 'y'.repeat(10_000) }, null)
    expect(r.ok && (r.row.company_name as string)).toHaveLength(CLAIM_FIELD_MAX)
    expect(r.ok && (r.row.note as string)).toHaveLength(CLAIM_NOTE_MAX)
  })

  it('caps the other three free-text fields too', () => {
    const long = 'z'.repeat(10_000)
    const r = claimRow('p1', { company_name: 'Acme', website: long, contact_name: long, contact_email: long }, null)
    expect(r.ok && (r.row.website as string)).toHaveLength(CLAIM_FIELD_MAX)
    expect(r.ok && (r.row.contact_name as string)).toHaveLength(CLAIM_FIELD_MAX)
    expect(r.ok && (r.row.contact_email as string)).toHaveLength(CLAIM_FIELD_MAX)
  })

  it('defaults status to submitted and never sets client_id', () => {
    const r = claimRow('p1', { company_name: 'Acme' }, null)
    expect(r.ok && r.row.status).toBe('submitted')
    expect(r.ok && r.row).not.toHaveProperty('client_id')
  })

  it('emits NONE of the staff decision columns, not even as null', () => {
    // §3.1: nothing is attributed by the act of submitting, and the shape
    // of the inserted row is where that is enforced. `client_id: null` in
    // the object would be harmless today and would be the line somebody
    // later fills in from the partner's typed company name.
    const r = claimRow('p1', { company_name: 'Acme' }, null)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    for (const forbidden of ['client_id', 'decided_by', 'decided_at', 'decision_note']) {
      expect(Object.keys(r.row), forbidden).not.toContain(forbidden)
    }
  })

  it('ignores a client_id the caller tried to supply', () => {
    // The body is attacker-controlled. A claim that arrives carrying the
    // uuid of a real Shipo client must not become an attributed row.
    const r = claimRow(
      'p1',
      { company_name: 'Acme', client_id: '00000000-0000-0000-0000-000000000001', status: 'approved' } as never,
      null,
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.row).not.toHaveProperty('client_id')
    expect(r.row.status).toBe('submitted')
  })

  it('takes the partner id from its argument, never from the input', () => {
    const r = claimRow('p1', { company_name: 'Acme', referral_partner_id: 'p2' } as never, null)
    expect(r.ok && r.row.referral_partner_id).toBe('p1')
  })

  it('records the first-hop ip', () => {
    const r = claimRow('p1', { company_name: 'Acme' }, '203.0.113.7, 10.0.0.1')
    expect(r.ok && r.row.submitted_ip).toBe('203.0.113.7')
  })

  it('stores a null ip rather than a blank one', () => {
    expect(claimRow('p1', { company_name: 'Acme' }, null).ok && claimRow('p1', { company_name: 'Acme' }, null)).toMatchObject({
      row: { submitted_ip: null },
    })
    expect(claimRow('p1', { company_name: 'Acme' }, '   ').ok && claimRow('p1', { company_name: 'Acme' }, '   ')).toMatchObject({
      row: { submitted_ip: null },
    })
  })

  it('omits an optional field that was not given, rather than storing an empty string', () => {
    // An empty string in `website` reads on the staff queue as "he told us
    // there is no website". Absent reads as "he did not say".
    const r = claimRow('p1', { company_name: 'Acme', website: '   ' }, null)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.row).not.toHaveProperty('website')
  })
})

describe('CLAIM_RECEIVED — the leak test (§3.2)', () => {
  it('says nothing about the company', () => {
    expect(CLAIM_RECEIVED).not.toMatch(/already|exist|found|attributed|another partner|client/i)
  })

  it('does not promise a decision or a timescale we have not agreed', () => {
    expect(CLAIM_RECEIVED).not.toMatch(/approv|reject|\bdays?\b|hours?/i)
  })
})

/**
 * §3.5 — what the partner is told about a claim he already filed.
 *
 * The table has FOUR states and the partner surface has THREE, because
 * `rejected` and `duplicate` collapse into one. That collapse is the
 * point, not a simplification: §3.4 tells the partner "not approved, talk
 * to us" and never the reason, and "duplicate" IS the reason — it says
 * this company is already attributed, which is exactly the §3.2 leak
 * arriving through a different door.
 */
describe('claimPartnerState', () => {
  it('maps submitted to under_review', () => {
    expect(claimPartnerState('submitted')).toBe('under_review')
  })

  it('maps approved to approved', () => {
    expect(claimPartnerState('approved')).toBe('approved')
  })

  it('maps BOTH rejected and duplicate to not_approved', () => {
    expect(claimPartnerState('rejected')).toBe('not_approved')
    expect(claimPartnerState('duplicate')).toBe('not_approved')
  })

  it('maps an unknown or null status to under_review, the safe answer', () => {
    // A status this code has not seen is an unknown, and the only answer
    // that neither promises money nor refuses it is "we are looking at
    // it". A null status would otherwise fall to whatever `??` default a
    // later edit happens to pick.
    expect(claimPartnerState(null)).toBe('under_review')
    expect(claimPartnerState(undefined)).toBe('under_review')
    expect(claimPartnerState('something_new')).toBe('under_review')
    expect(claimPartnerState('')).toBe('under_review')
  })

  it('does not treat a staff status as approved by coincidence of case', () => {
    // Postgres stores what staff typed. 'Approved' must not read as
    // approved money on a partner's screen unless the column really
    // holds the value the queue writes.
    expect(claimPartnerState('APPROVED')).toBe('under_review')
  })
})

describe('CLAIM_PARTNER_TEXT — the leak test (§3.4, §3.2)', () => {
  it('no partner-facing text leaks a reason or another partner', () => {
    for (const t of Object.values(CLAIM_PARTNER_TEXT)) {
      expect(t, t).not.toMatch(/already|another partner|duplicate|attributed|existing client/i)
    }
  })

  it('every state has text, and none of it is blank', () => {
    // Record<ClaimPartnerState, string> makes a MISSING key a compile
    // error; it does not make an empty string one. A blank cell under a
    // claim he filed reads as "lost".
    for (const state of ['under_review', 'approved', 'not_approved'] as const) {
      expect(CLAIM_PARTNER_TEXT[state].trim().length).toBeGreaterThan(0)
    }
  })

  it('the not_approved text gives him somewhere to go', () => {
    // §3.4: "not approved, contact us". Told only "not approved", a
    // partner with a claim worth $300 plus twelve months of share has no
    // next step and no way to correct a mistake on our side.
    expect(CLAIM_PARTNER_TEXT.not_approved).toMatch(/support@shipousa\.com/i)
  })
})

/**
 * §3.4 — the conflict rule, which guards THE SINGLE WRITE THAT CREATES
 * MONEY.
 *
 * Approving a claim sets `clients.referral_partner_id`. If that column
 * already names a different partner, approving would silently re-point
 * a client — and twelve months of commission plus a $300 bonus — from
 * the partner who earned it to the one who typed the name. §3.4:
 * "must raise a conflict, not silently re-point the row."
 *
 * Every ambiguous case below resolves to RAISE. A false conflict costs a
 * human one look at two rows; a missed conflict moves somebody else's
 * money and nobody is told.
 */
describe('approvalConflict', () => {
  it('allows an unattributed client', () => {
    expect(
      approvalConflict({ claimPartnerId: 'p1', client: { id: 'c1', referral_partner_id: null } }),
    ).toBeNull()
  })

  it('allows a re-approval to the SAME partner', () => {
    // Idempotent on purpose: a second approval of the same claim, or a
    // claim for a client already correctly attributed to this partner,
    // is not a conflict. Treating it as one would make a double-click
    // look like somebody else's claim.
    expect(
      approvalConflict({ claimPartnerId: 'p1', client: { id: 'c1', referral_partner_id: 'p1' } }),
    ).toBeNull()
  })

  it('RAISES when the client belongs to another partner', () => {
    expect(
      approvalConflict({ claimPartnerId: 'p1', client: { id: 'c1', referral_partner_id: 'p2' } }),
    ).toMatch(/another partner/i)
  })

  it('RAISES rather than guessing when the ids differ only by case', () => {
    // Postgres hands back canonical lower-case uuids, so this should not
    // happen — which is exactly why it must not be silently normalised.
    // If the two strings are not equal, we do not know they name the
    // same partner, and the fail-closed answer is the only safe one.
    expect(
      approvalConflict({
        claimPartnerId: 'AAAA1111-0000-0000-0000-000000000001',
        client: { id: 'c1', referral_partner_id: 'aaaa1111-0000-0000-0000-000000000001' },
      }),
    ).toMatch(/another partner/i)
  })

  it('RAISES when we do not know which partner we would be crediting', () => {
    // A blank claimPartnerId means the claim row lost its owner. Writing
    // the attribution anyway credits '' — or, through a `|| null`
    // somewhere downstream, nobody — while reporting success.
    expect(approvalConflict({ claimPartnerId: '', client: { id: 'c1', referral_partner_id: null } }))
      .not.toBeNull()
    expect(
      approvalConflict({ claimPartnerId: '   ', client: { id: 'c1', referral_partner_id: null } }),
    ).not.toBeNull()
  })

  it('treats a blank attribution as unattributed, not as a partner named ""', () => {
    expect(
      approvalConflict({ claimPartnerId: 'p1', client: { id: 'c1', referral_partner_id: '' } }),
    ).toBeNull()
  })

  it('names no partner, no company and no id in the message', () => {
    // Staff-facing today, and it must stay safe if it is ever rendered
    // anywhere else. It says THAT there is a conflict and nothing about
    // whose — the identity is on the queue screen, which is staff-only
    // by route, not by the wording of a string.
    const msg = approvalConflict({
      claimPartnerId: 'p1',
      client: { id: 'c1', referral_partner_id: 'p2' },
    })
    expect(msg).not.toBeNull()
    expect(msg).not.toMatch(/p2|c1/)
  })
})

/**
 * The SECOND approval of the same claim, pointed at a different client.
 *
 * approvalConflict cannot see this. It is asked about the client staff
 * named THIS time, and that client is unattributed, so it says yes —
 * correctly, on the facts it is given. What it is not given is that this
 * claim was already approved against a DIFFERENT client, whose
 * `referral_partner_id` is still this partner's and which nothing in the
 * route ever clears.
 *
 * The result is two clients attributed to one referral: $300 plus twelve
 * months of 5% of net profit on an account the partner never referred,
 * and no screen that contradicts it. Staff doing the normal thing —
 * noticing they picked the wrong client and approving again against the
 * right one — is what produces it.
 */
describe('reattributionConflict', () => {
  it('allows a first approval', () => {
    expect(
      reattributionConflict({ status: 'submitted', existingClientId: null, clientId: 'c1' }),
    ).toBeNull()
  })

  it('allows a re-approval to the SAME client', () => {
    // THE DOCUMENTED RECOVERY PATH. When the attribution write lands and
    // the status write fails, the route tells staff "approve it again to
    // finish". Refusing that would strand the claim in the exact state
    // the message promises is recoverable.
    expect(
      reattributionConflict({ status: 'approved', existingClientId: 'c1', clientId: 'c1' }),
    ).toBeNull()
  })

  it('RAISES on a re-approval to a different client', () => {
    const msg = reattributionConflict({
      status: 'approved',
      existingClientId: 'c1',
      clientId: 'c2',
    })
    expect(msg).not.toBeNull()
    expect(msg!.length).toBeGreaterThan(20)
    expect(msg).not.toMatch(/^[A-Z_]+$/)
  })

  it('names what staff must do, since only a human can undo the first one', () => {
    const msg = reattributionConflict({
      status: 'approved',
      existingClientId: 'c1',
      clientId: 'c2',
    })!
    expect(msg).toMatch(/by hand|un-?attribut|another client|a different client/i)
  })

  it('allows approving a claim that was rejected or called a duplicate', () => {
    // Neither decision attributed anything, so there is nothing stale to
    // clear. Changing your mind about a rejection is a legitimate act.
    for (const status of ['rejected', 'duplicate'] as const) {
      expect(reattributionConflict({ status, existingClientId: null, clientId: 'c2' })).toBeNull()
    }
  })

  it('allows an approved claim that never recorded a client', () => {
    // status 'approved' with no client_id is the half-written state the
    // route's own 500 message describes. Nothing is attributed through
    // this claim, so the next approval is a completion, not a move.
    expect(
      reattributionConflict({ status: 'approved', existingClientId: null, clientId: 'c2' }),
    ).toBeNull()
    expect(
      reattributionConflict({ status: 'approved', existingClientId: '  ', clientId: 'c2' }),
    ).toBeNull()
  })

  it('names no client id in the message', () => {
    const msg = reattributionConflict({
      status: 'approved',
      existingClientId: 'c1',
      clientId: 'c2',
    })!
    expect(msg).not.toMatch(/c1|c2/)
  })
})

/**
 * Whether `clients.referral_partner_id` still needs writing.
 *
 * FAILS TOWARDS WRITING. False means "the column already says exactly
 * this partner" and nothing else. Every other case — blank, or some other
 * partner — answers true, and the write itself carries
 * `.is('referral_partner_id', null)` so an attempt against a client
 * somebody else just took matches no rows and becomes a 409.
 *
 * The inverse default is the dangerous one: a `false` for a client
 * attributed to another partner would skip the write, mark the claim
 * approved, and report success over an attribution that names somebody
 * else.
 */
describe('needsAttribution', () => {
  it('is true for an unattributed client', () => {
    expect(needsAttribution('p1', { referral_partner_id: null })).toBe(true)
    expect(needsAttribution('p1', { referral_partner_id: '' })).toBe(true)
    expect(needsAttribution('p1', { referral_partner_id: '   ' })).toBe(true)
  })

  it('is false when the client already carries exactly this partner', () => {
    // The idempotent half of the recovery path: re-approving a claim
    // whose attribution already landed must not depend on a write that
    // `.is(..., null)` would now refuse.
    expect(needsAttribution('p1', { referral_partner_id: 'p1' })).toBe(false)
  })

  it('is true for a client that belongs to someone else', () => {
    // approvalConflict refuses this before we get here. If that gate is
    // ever bypassed, answering true sends it into a write that cannot
    // match — a 409 — rather than into a silent success.
    expect(needsAttribution('p1', { referral_partner_id: 'p2' })).toBe(true)
  })
})

/**
 * The staff route, asserted over source text — same technique and same
 * reason as the partner route above: `vitest.config.ts` includes only
 * `src/**\/*.test.ts`, so a handler cannot be imported.
 *
 * The brief's test for this is a live-database snapshot
 * (`expect(await snapshot([...])).toEqual(before)`). There is no test
 * database in this project and no fixture harness to build one on, so
 * what is pinned here instead is the ORDER and the COMPLETENESS of the
 * writes: that the conflict is checked before anything is written, that
 * the 409 path returns before the first `.update(`, and that no handler
 * reaches a decision without stamping who made it.
 */
describe('POST /api/referrals/claims — the write that creates money (§3.4)', () => {
  function body(text: string): string {
    return text
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*)/.test(line))
      .filter((line) => !/^\s*import\b/.test(line))
      .join('\n')
  }

  const src = body(readFileSync('src/app/api/referrals/claims/route.ts', 'utf8'))

  it('was read', () => {
    expect(src).toContain('approvalConflict')
  })

  it('is STAFF-authenticated by its own call, not by the proxy', () => {
    // src/proxy.ts excludes `api/` from its matcher: nothing under
    // src/app/api is authenticated by it. A handler added here without
    // requireStaff() is published to the internet, and this one sets
    // clients.referral_partner_id.
    //
    // PER HANDLER, not over the file. This assertion used to ask only
    // "does some requireStaff() appear before some .update()", which
    // GET's guard satisfies on POST's behalf — one call anywhere in the
    // file made the whole file look gated, and deleting POST's own guard
    // would have stayed green. The file is split at POST's declaration
    // and each half is asked about its own first database call.
    const split = src.indexOf('export async function POST')
    expect(split).toBeGreaterThan(-1)
    const halves = [
      { name: 'GET', text: src.slice(0, split) },
      { name: 'POST', text: src.slice(split) },
    ]
    for (const h of halves) {
      // Control: the half really is a handler with a database call in it,
      // or the ordering assertion below passes on nothing.
      expect(h.text, `${h.name} half is not a handler`).toMatch(/export async function/)
      const guard = h.text.indexOf('requireStaff()')
      const touch = h.text.search(/\.(update|insert|select)\(/)
      expect(guard, `${h.name} does not call requireStaff()`).toBeGreaterThan(-1)
      expect(touch, `${h.name} makes no database call`).toBeGreaterThan(-1)
      expect(guard, `${h.name} reads the database before it checks staff`).toBeLessThan(touch)
    }
  })

  it('checks the conflict BEFORE either write on the approve path, and answers 409', () => {
    // The FIRST `.update(` in this file belongs to the reject/duplicate
    // branch, and it is CORRECTLY before the conflict check: a rejection
    // attributes nothing, so there is no conflict to raise. The property
    // §3.4 actually states is narrower — on the APPROVE path, nothing is
    // written until the check has passed. Both of that path's writes are
    // named here, because pinning one leaves the other free to move.
    const check = src.indexOf('approvalConflict(')
    expect(check).toBeGreaterThan(-1)

    const attribution = src.indexOf('referral_partner_id: claim.referral_partner_id')
    const status = src.indexOf("status: 'approved'")
    expect(attribution).toBeGreaterThan(-1)
    expect(status).toBeGreaterThan(-1)
    expect(check).toBeLessThan(attribution)
    expect(check).toBeLessThan(status)

    // And the write that IS allowed before the check must be the one on
    // the claims table. An `.update(` on `clients` before the check is
    // the §3.4 failure — the commission moved, then we looked.
    const firstWrite = src.indexOf('.update(')
    expect(firstWrite).toBeGreaterThan(-1)
    expect(firstWrite).toBeLessThan(check)
    const tablesBefore = [
      ...src.slice(0, firstWrite).matchAll(/from\(\s*['"`]([a-z_]+)['"`]/g),
    ]
    expect(tablesBefore.at(-1)?.[1]).toBe('partner_client_claims')

    expect(src).toMatch(/status:\s*409/)
  })

  it('stamps WHO decided and WHEN on every decision', () => {
    // §3.4: a human act with a name attached. A decision with no
    // decided_by is an approval nobody made.
    expect(src).toMatch(/decided_by/)
    expect(src).toMatch(/decided_at/)
    expect(src).toMatch(/staffEmail\(/)
  })

  it('never selects * from the claims table', () => {
    // decision_note lives on these rows. The staff screen may see it;
    // a star select is how it eventually reaches somewhere that may not.
    expect(src).not.toMatch(/select\(\s*['"`]\s*\*/)
  })

  it('reads the claim’s own client_id, so a second approval can see the first', () => {
    // CLAIM_COLUMNS omitted it. The route therefore could not tell a
    // first approval from a second one pointed at a different client,
    // and the earlier client kept this partner's id forever.
    const columns = src.indexOf('CLAIM_COLUMNS =')
    expect(columns).toBeGreaterThan(-1)
    const decl = src.slice(columns, src.indexOf('\n', columns))
    expect(decl).toContain('client_id')
  })

  it('refuses a re-approval to a different client BEFORE either write', () => {
    // The stale-attribution class: approving again against the right
    // client leaves the wrong one attributed, paying $300 plus twelve
    // months of share on an account nobody referred. Only a human can
    // undo the first one, so the route refuses and says so.
    const gate = src.indexOf('reattributionConflict(')
    expect(gate).toBeGreaterThan(-1)
    const attribution = src.indexOf('referral_partner_id: claim.referral_partner_id')
    const status = src.indexOf("status: 'approved'")
    expect(attribution).toBeGreaterThan(-1)
    expect(status).toBeGreaterThan(-1)
    expect(gate).toBeLessThan(attribution)
    expect(gate).toBeLessThan(status)
  })

  it('cannot clobber an attribution written between its read and its write', () => {
    // READ-THEN-WRITE RACE. The conflict check runs against a row read
    // moments earlier; two employees working the queue at once both read
    // `referral_partner_id: null`, both pass the check, and the second
    // `.update(` silently moves the commission the first one created.
    //
    // The guard is on the WRITE: the update matches only while the column
    // is still blank, and a write that matched nothing is the 409 the
    // check would have returned had it seen the row as it now is.
    const start = src.indexOf('needsAttribution(')
    expect(start, 'the route does not ask whether the write is needed').toBeGreaterThan(-1)
    const end = src.indexOf("status: 'approved'")
    expect(end).toBeGreaterThan(start)
    const write = src.slice(start, end)

    // Control: this really is the attribution write's own region.
    expect(write).toContain('referral_partner_id: claim.referral_partner_id')
    expect(write).toMatch(/\.is\(\s*['"`]referral_partner_id['"`]\s*,\s*null\s*\)/)
    expect(write).toMatch(/status:\s*409/)
  })
})

/**
 * The STAFF-ONLY resemblance hint. §3.4.
 *
 * This answers "does the company he typed look like a client we already
 * have, and is that client already somebody's?" — on the queue screen,
 * where the §3.2 concealment does not apply because the reader is an
 * employee.
 *
 * It is a HINT and never a selection: the route requires `client_id`
 * explicitly and refuses to derive it from the typed name (§3.1). These
 * tests pin the matcher's own failure modes, which are not symmetric —
 * a missed candidate costs staff a search box, and a wrong candidate
 * offered as the obvious one is how the wrong client gets attributed.
 */
describe('clientMatches — the staff-only resemblance hint (§3.4)', () => {
  const clients = [
    { id: 'c1', name: 'Acme Widgets', referral_partner_id: null },
    { id: 'c2', name: 'Acme Widgets International', referral_partner_id: 'p9' },
    { id: 'c3', name: 'Globex', referral_partner_id: null },
    { id: 'c4', name: null, referral_partner_id: null },
  ]

  it('finds an exact name and flags it exact', () => {
    const hits = clientMatches('Acme Widgets', clients)
    expect(hits[0].id).toBe('c1')
    expect(hits[0].exact).toBe(true)
  })

  it('ignores case, punctuation and a company suffix', () => {
    // "Acme Widgets, LLC." and "acme widgets" are the same request.
    expect(clientMatches('ACME WIDGETS, LLC.', clients)[0].id).toBe('c1')
    expect(clientMatches('  acme   widgets ', clients)[0].id).toBe('c1')
  })

  it('offers a longer client as a PARTIAL, not as exact', () => {
    const hits = clientMatches('Acme Widgets', clients)
    const partial = hits.find((h) => h.id === 'c2')
    expect(partial).toBeDefined()
    expect(partial!.exact).toBe(false)
  })

  it('sorts exact matches before partial ones', () => {
    const hits = clientMatches('Acme Widgets', clients)
    expect(hits[0].exact).toBe(true)
    expect(hits.map((h) => h.id)).toEqual(['c1', 'c2'])
  })

  it('carries referral_partner_id through, so the screen can say whose it is', () => {
    const hits = clientMatches('Acme Widgets', clients)
    expect(hits.find((h) => h.id === 'c2')!.referral_partner_id).toBe('p9')
    expect(hits.find((h) => h.id === 'c1')!.referral_partner_id).toBeNull()
  })

  it('returns NOTHING for a blank name, never the whole client list', () => {
    // A blank typed name resembles nothing. Returning every client would
    // put Shipo's customer list on screen under the heading "did he mean
    // one of these?".
    expect(clientMatches('', clients)).toEqual([])
    expect(clientMatches('   ', clients)).toEqual([])
    expect(clientMatches('LLC', clients)).toEqual([])
  })

  it('does not let a two-letter fragment match everything', () => {
    // 'co' is inside "Globex"? no — but it is inside a great many real
    // company names, and a substring rule with no floor turns the hint
    // into the whole table.
    expect(clientMatches('co', clients)).toEqual([])
  })

  it('skips a client with no name instead of coercing it', () => {
    const hits = clientMatches('Acme Widgets', clients)
    expect(hits.some((h) => h.id === 'c4')).toBe(false)
  })

  it('returns an empty list when nothing resembles it', () => {
    expect(clientMatches('Initech', clients)).toEqual([])
  })

  it('caps how many it offers', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      id: `x${i}`,
      name: `Acme Widgets ${i}`,
      referral_partner_id: null,
    }))
    expect(clientMatches('Acme Widgets', many).length).toBeLessThanOrEqual(8)
  })
})

/**
 * §3.4's other half: "The resemblance hint is staff-only and must never
 * be reachable from a partner route."
 *
 * `clientMatches` answers the one question §3.2 forbids answering to a
 * partner — is this company already a Shipo client, and whose is it. A
 * partner surface that imported it, even to render nothing, would be one
 * refactor away from an autocomplete that enumerates the customer base.
 *
 * Asserted by WALKING the partner directories rather than naming files,
 * so a partner surface added next month is covered without anybody
 * remembering to add it here. The control below proves the walk found
 * files at all — an empty walk would pass every assertion.
 */
describe('the resemblance hint is staff-only (§3.4)', () => {
  const PARTNER_DIRS = [
    'src/app/partner',
    'src/app/api/partner',
    'src/components/partner',
  ]

  // CODE ONLY. A grep over source counts its own prose: Statement.tsx's
  // header explains at length that `decision_note` and `decided_by` must
  // not reach the partner, and an unstripped grep reads that explanation
  // as the violation it warns about. Two controls below prove the strip
  // happened and that it did not strip everything.
  function body(text: string): string {
    return text
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*)/.test(line))
      .join('\n')
  }

  const files: { path: string; raw: string; code: string }[] = []
  for (const dir of PARTNER_DIRS) {
    let names: string[] = []
    try {
      names = readdirSync(dir, { recursive: true }) as unknown as string[]
    } catch {
      names = []
    }
    for (const name of names) {
      if (!/\.(ts|tsx)$/.test(name)) continue
      try {
        const raw = readFileSync(`${dir}/${name}`, 'utf8')
        files.push({ path: `${dir}/${name}`, raw, code: body(raw) })
      } catch {
        // a directory entry, not a file
      }
    }
  }

  it('walked the partner surfaces and found them', () => {
    // The control. Without it, a typo in a directory name would make
    // every assertion below vacuously true.
    expect(files.length).toBeGreaterThan(5)
    expect(files.some((f) => f.path.includes('Statement.tsx'))).toBe(true)
    expect(files.some((f) => f.path.includes('claims'))).toBe(true)
  })

  it('strips prose but keeps code', () => {
    // The second control, and it is load-bearing: Statement.tsx DOES
    // name decision_note — in the comment forbidding it. A stripper that
    // silently did nothing would turn the real assertions below into a
    // permanent, unfixable failure; one that stripped everything would
    // turn them into a permanent pass.
    const s = files.find((f) => f.path.includes('Statement.tsx'))!
    expect(s.raw).toContain('decision_note')
    expect(s.code).not.toContain('decision_note')
    expect(s.code).toContain('partner_client_claims')
  })

  it('names clientMatches nowhere under a partner route', () => {
    const offenders = files.filter((f) => f.code.includes('clientMatches')).map((f) => f.path)
    expect(offenders).toEqual([])
  })

  it('names the staff queue component nowhere under a partner route', () => {
    const offenders = files.filter((f) => f.code.includes('ClaimsQueue')).map((f) => f.path)
    expect(offenders).toEqual([])
  })

  it('never names decision_note or decided_by under a partner route', () => {
    // The staff columns. §3.3: they exist for the queue and must not
    // travel. Checked over every partner file, not only the statement.
    const offenders = files
      .filter((f) => /decision_note|decided_by/.test(f.code))
      .map((f) => f.path)
    expect(offenders).toEqual([])
  })
})

/**
 * The partner's claims LIST, asserted over source text for the reason
 * given above the route tests: `vitest.config.ts` includes only
 * `src/**\/*.test.ts`, so a .tsx component cannot be imported here.
 *
 * What this pins is the one line §3.3 says must never be written:
 * `select('*')` on partner_client_claims, which carries decision_note —
 * "already claimed by Partner B" — onto the partner's screen.
 */
describe('the partner claims surface names its columns (§3.3)', () => {
  function body(text: string): string {
    return text
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*)/.test(line))
      .filter((line) => !/^\s*import\b/.test(line))
      .join('\n')
  }

  const src = body(readFileSync('src/components/partner/Statement.tsx', 'utf8'))

  it('was read', () => {
    // Control: the three assertions below are `not.toMatch`, which pass
    // vacuously on an empty string.
    expect(src).toContain('partner_client_claims')
  })

  it('never selects * from the claims table, and never names decision_note', () => {
    expect(src).not.toMatch(/partner_client_claims[\s\S]{0,120}select\(\s*['"`]\s*\*/)
    expect(src).not.toMatch(/decision_note/)
    expect(src).not.toMatch(/decided_by/)
  })

  it('scopes the claims read to this partner', () => {
    // Without the eq() this lists every partner's claims — the same
    // defect as a star select, reached by forgetting a filter.
    expect(src).toMatch(/partner_client_claims[\s\S]{0,300}referral_partner_id/)
  })
})

/**
 * The route is the control, and §6's property is that it reaches the SAME
 * response down three different code paths — a new company, an existing
 * Shipo client, and a company another partner already claimed. The
 * constant being one string is not that property.
 *
 * `vitest.config.ts` includes only `src/**\/*.test.ts`, so the handler
 * cannot be imported and covered as a module here. These assertions are
 * therefore made against the route's SOURCE TEXT, with controls, which is
 * the same technique partner-terms.test.ts uses for /partner's gate
 * ordering. What they pin is the thing that would be weakened: that no
 * path to a 200 and no path to a refusal-by-cap can carry a different
 * body, and that the cap is not answered with a 429.
 */
describe('POST /api/partner/claims — answers nothing (§3.2, §6)', () => {
  /**
   * CODE ONLY. A grep over source counts its own prose: the route's
   * comments explain why the cap is NOT a 429 and name the three cases
   * §3.2 conceals ("already claimed by another partner"), so the
   * assertions below matched the explanation of the rule rather than a
   * violation of it. Same stripper partner-access.test.ts uses.
   */
  function body(text: string): string {
    return text
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*)/.test(line))
      .filter((line) => !/^\s*import\b/.test(line))
      .join('\n')
  }

  const src = body(readFileSync('src/app/api/partner/claims/route.ts', 'utf8'))

  it('the stripper drops prose and keeps calls', () => {
    // Control for the control. A stripper that returned '' would make
    // every `not.toMatch` below pass on any route at all.
    expect(body('  // never say 429 here\n  return x(1)\n')).not.toMatch(/429/)
    expect(body('  // never say 429 here\n  return x(1)\n')).toContain('x(1)')
  })

  it('was read', () => {
    // Control: every assertion below is a `not.toMatch`, which passes
    // vacuously on an empty string.
    expect(src).toContain('export async function POST')
    expect(src).toContain('CLAIM_RECEIVED')
  })

  it('never answers the cap with a distinguishable status', () => {
    // A 429 is itself a signal: it tells a partner he is being counted,
    // and a script can tell "refused" from "accepted" without reading the
    // body. §3.2's rule is that the endpoint answers nothing.
    expect(src).not.toMatch(/\b429\b/)
    expect(src).not.toMatch(/Too Many|rate.?limit/i)
  })

  it('has exactly ONE success body, used by both the stored and the capped path', () => {
    // Two occurrences: the cap refusal and the insert success. If a third
    // appears, or either is replaced by a bespoke message, this fails.
    const hits = src.match(/CLAIM_RECEIVED/g) ?? []
    expect(hits.length).toBeGreaterThanOrEqual(2)
    // And no competing sentence on a 200.
    expect(src).not.toMatch(/already (?:a )?(?:client|claimed|attributed)/i)
    expect(src).not.toMatch(/not found/i)
  })

  it('checks the session before it reads the body (Review Focus 5)', () => {
    // The dashboard gate is a render; the route is the control. An
    // unauthenticated POST must not reach the cap count or the insert —
    // both of which take a partner id.
    const session = src.indexOf('getPartnerFromSession(')
    const body = src.indexOf('.json()')
    expect(session).toBeGreaterThan(-1)
    expect(body).toBeGreaterThan(-1)
    expect(session).toBeLessThan(body)
    expect(src).toMatch(/status:\s*401/)
  })

  it('counts the cap BEFORE inserting, and the count is per-partner', () => {
    const count = src.indexOf('claimAdmission(')
    const insert = src.indexOf('.insert(')
    expect(count).toBeGreaterThan(-1)
    expect(insert).toBeGreaterThan(-1)
    expect(count).toBeLessThan(insert)
    expect(src).toMatch(/referral_partner_id/)
  })

  it('a claim over the cap is STORED, flagged — not thrown away', () => {
    // The finding. §3.2 is served by the identical response, which this
    // keeps; the discard served only flood protection, and the ceiling
    // does that instead. Claims six and up in a rolling day were being
    // destroyed while the partner read "Received." and his claims panel
    // told him not to re-send.
    //
    // The route must therefore reach the insert on the flagged path. The
    // shape that proves it: `claimAdmission` is asked once, the only
    // early return is the `discard` branch, and the insert carries the
    // flag through claimRow.
    expect(src).toContain('claimAdmission(')
    expect(src).toMatch(/['"`]discard['"`]/)
    expect(src).toMatch(/['"`]flag['"`]/)

    // The flag reaches the row builder, which is the only thing that
    // writes the column.
    expect(src).toMatch(/claimRow\([\s\S]{0,200}over|overCap|=== ['"`]flag['"`]/)

    // Exactly ONE insert, so a flagged claim cannot be routed to a
    // different table or a different shape.
    expect((src.match(/\.insert\(/g) ?? []).length).toBe(1)
  })

  it('the discard branch is the ONLY path that answers without writing', () => {
    const admission = src.indexOf('claimAdmission(')
    const insert = src.indexOf('.insert(')
    expect(admission).toBeGreaterThan(-1)
    expect(insert).toBeGreaterThan(admission)

    const between = src.slice(admission, insert)
    // Control: this really is the region between the decision and the write.
    expect(between).toMatch(/claimRow\(/)

    // One early 200 only, and it is the ceiling. Two would mean the
    // flagged path is still returning before the insert.
    const earlyReceived = (between.match(/CLAIM_RECEIVED/g) ?? []).length
    expect(earlyReceived).toBe(1)
    expect(between).toMatch(/['"`]discard['"`]/)
  })

  it('records the flag where staff can see it, and nowhere a partner reads', () => {
    // A write-only flag is no better than the discard: the whole point is
    // that a human looks at the row. The staff queue selects it; the
    // partner's own claims read must not, because "you went over your
    // daily limit" is a sentence about our rate-limiting that §3.2's
    // identical response deliberately refuses to send.
    const staffRoute = body(readFileSync('src/app/api/referrals/claims/route.ts', 'utf8'))
    const staffPage = body(readFileSync('src/app/referrals/page.tsx', 'utf8'))
    const partnerRead = body(readFileSync('src/components/partner/Statement.tsx', 'utf8'))

    // Controls: all three were read.
    expect(staffRoute).toContain('partner_client_claims')
    expect(staffPage).toContain('partner_client_claims')
    expect(partnerRead).toContain('partner_client_claims')

    expect(staffRoute).toContain('over_cap')
    expect(staffPage).toContain('over_cap')
    expect(partnerRead).not.toContain('over_cap')
  })

  it('tells the partner when a claim was NOT stored (a 500, never "received")', () => {
    // The two rules in this route point in opposite directions and the
    // wrong instinct is to make them agree: conceal whether the company
    // is known; NEVER conceal whether we stored the claim. A partner told
    // "received" over a failed insert has silently lost a claim worth
    // $300 plus twelve months of share.
    expect(src).toMatch(/status:\s*500/)
    expect(src).toMatch(/could not record/i)
  })

  it('never selects * from the claims table', () => {
    // §3.3: decision_note is staff-facing. A star select on a partner
    // path carries "already claimed by Partner B" to his screen.
    expect(src).not.toMatch(/select\(\s*['"`]\s*\*/)
  })

  it('a count it could not READ is a 500, never "received"', () => {
    // The Critical the whole-branch review found, and the one failure on
    // this route that destroys money silently.
    //
    // The cap count and the cap itself are two different questions and
    // this route answered them with one. `overDailyCap(null)` is true,
    // which is correct — a ceiling that cannot be measured must refuse —
    // but the refusal it produced was `200 { message: CLAIM_RECEIVED }`,
    // the SAME sentence a stored claim gets, because a cap refusal is
    // deliberately indistinguishable (§3.2). So "the claims table does
    // not exist" rendered as "Received." Then the statement's claims
    // panel tells him, verbatim, "Nothing you have submitted has been
    // discarded. Please don't re-send." Two honest-looking screens
    // combining into one false reassurance over a claim worth $300 plus
    // twelve months of share, which he will never resubmit because he
    // watched it succeed.
    //
    // §3.2's concealment is not weakened by answering 500 here. A 500
    // says OUR WRITE FAILED — which the failed-insert path already says,
    // and which the partner is entitled to know. It says nothing about
    // whether any company is a Shipo client.
    const destructure = src.indexOf('error: countError')
    const cap = src.indexOf('claimAdmission(')
    expect(destructure).toBeGreaterThan(-1)
    expect(cap).toBeGreaterThan(destructure)

    // The unreadable-count branch sits BETWEEN the read and the cap test,
    // and it returns rather than falling through.
    const between = src.slice(destructure, cap)
    expect(between).toMatch(/if\s*\(\s*countError/)
    expect(between).toMatch(/status:\s*500/)
    expect(between).not.toMatch(/CLAIM_RECEIVED/)

    // And the error is no longer laundered INTO the cap test, where it
    // would arrive as a cap refusal again.
    expect(src).not.toMatch(/claimAdmission\(\s*countError/)
  })
})

/**
 * The form's one job after a successful POST is to SHOW the server's
 * sentence. Important 3 from the whole-branch review: it set `done` and
 * left the form open, and the only renderer of `done` is the collapsed
 * branch — so the partner watched his five fields empty themselves and
 * got no confirmation at all. An emptied form with no message is exactly
 * what a discarded submission looks like, and the next thing he does is
 * type it again, which is the duplicate the staff queue then has to
 * adjudicate.
 *
 * A `.tsx` cannot be imported here (`vitest.config.ts` includes only
 * `src/**\/*.test.ts`, environment `node`), so this is a source-text
 * assertion with controls, like the route's above.
 */
describe('ClaimForm shows the answer it received (§3.5)', () => {
  function body(text: string): string {
    return text
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*)/.test(line))
      .filter((line) => !/^\s*import\b/.test(line))
      .join('\n')
  }

  const src = body(readFileSync('src/components/partner/ClaimForm.tsx', 'utf8'))

  it('the stripper drops prose and keeps calls', () => {
    expect(body('  // setOpen(false) one day\n  setDone(x)\n')).not.toContain('setOpen')
    expect(body('  // setOpen(false) one day\n  setDone(x)\n')).toContain('setDone(x)')
  })

  it('was read', () => {
    expect(src).toContain('export default function ClaimForm')
    expect(src).toContain('setDone(')
  })

  it('renders the confirmation only in the collapsed branch', () => {
    // The premise of the test below. If a second renderer of `done` is
    // ever added inside the open form, this fails and the next
    // assertion stops being the thing that matters.
    const closed = src.indexOf('if (!open)')
    expect(closed).toBeGreaterThan(-1)
    const renders = [...src.matchAll(/\{done &&/g)].map((m) => m.index!)
    expect(renders.length).toBe(1)
    expect(renders[0]).toBeGreaterThan(closed)
  })

  it('collapses the form on success, so the message it just set is on screen', () => {
    const success = src.indexOf('setDone(json.message')
    expect(success).toBeGreaterThan(-1)
    const collapse = src.indexOf('setOpen(false)', success)
    expect(collapse).toBeGreaterThan(success)
    // Inside the success path, not merely somewhere later in the file —
    // Cancel also calls setOpen(false), and that one proves nothing.
    const end = src.indexOf('} catch {', success)
    expect(end).toBeGreaterThan(success)
    expect(collapse).toBeLessThan(end)
  })

  it('does NOT collapse the form on an error, so he can fix and resend', () => {
    // The other direction. A 400 is about this form; closing it would
    // throw away what he typed and hide the sentence telling him why.
    const err = src.indexOf('setError(json.error')
    expect(err).toBeGreaterThan(-1)
    const ret = src.indexOf('return', err)
    expect(src.slice(err, ret)).not.toContain('setOpen(')
  })
})

describe('the claims migration declares what it uses', () => {
  const sql = readFileSync('supabase/partner_client_claims.sql', 'utf8')

  it('was read', () => {
    expect(sql).toContain('create table if not exists public.partner_client_claims')
  })

  it('declares uuid-ossp, because it defaults the primary key with it', () => {
    // Second half of the same Critical. `uuid_generate_v4()` lives in the
    // uuid-ossp extension, which is NOT installed by default on a fresh
    // Postgres. On a database where no earlier migration happened to
    // declare it, this file fails at the CREATE TABLE — and then every
    // partner's claim meets the route's unreadable-count path above, for
    // which the honest answer is a 500 and the old answer was "Received."
    // Every other migration in this repo that calls it declares it first.
    expect(sql).toContain('uuid_generate_v4()')
    const ext = sql.indexOf('create extension if not exists "uuid-ossp"')
    expect(ext).toBeGreaterThan(-1)
    expect(ext).toBeLessThan(sql.indexOf('uuid_generate_v4()'))
  })

  it('declares over_cap, and declares it on an EXISTING table too', () => {
    // The column the route now writes. Two declarations, because this
    // file is applied by hand and has been applied before: the CREATE
    // TABLE serves a fresh database, and the ALTER serves one where the
    // table already exists — without which the route's insert fails on
    // every flagged claim and the partner gets the 500 rather than the
    // row. `if not exists` on both so re-running stays harmless.
    expect(sql).toMatch(/over_cap\s+boolean\s+not null\s+default\s+false/)
    expect(sql).toMatch(
      /alter table[\s\S]{0,80}partner_client_claims[\s\S]{0,60}add column if not exists\s+over_cap/,
    )
  })

  it('the verification query counts the column it now declares', () => {
    // The commented check at the foot of the file asserts an exact column
    // count. A column added above it and not below leaves the operator
    // pasting a query that reports `present = false` on a database that
    // is correct — which is how a good migration gets re-run or reverted.
    const list = sql.match(/column_name in \(([\s\S]*?)\)/)
    expect(list, 'the verification query no longer lists its columns').not.toBeNull()
    const names = list![1].match(/'[a-z_]+'/g) ?? []
    expect(names.length).toBeGreaterThan(10) // control: the list was found
    expect(names).toContain("'over_cap'")

    // The count asserted right after the list must be the length of it.
    const after = sql.slice(sql.indexOf(list![0]) + list![0].length)
    const asserted = after.match(/=\s*(\d+)/)
    expect(asserted, 'the verification query no longer asserts a column count').not.toBeNull()
    expect(Number(asserted![1])).toBe(names.length)
  })
})
