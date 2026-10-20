import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  BATCH_MAX_ROWS,
  BATCH_MAX_PER_DAY,
  batchFold,
  planBatch,
  batchReceivedMessage,
  overBatchDailyCap,
  groupOpenClaims,
} from './partner-batch'

// Batch client intake (spec 2026-10-20 §3).
//
// WHAT THIS FEATURE IS FOR. A partner onboarding an existing book pastes
// ~100 company names at once. Every one of them is a claim on $300 plus
// twelve months of 5% of net profit, so the failure that matters is not a
// crash — it is a row he believes he filed that was never stored.
//
// §3.2, the rule the whole module is shaped around: **"What must never
// happen is a partial accept. Taking the first 150 of 203 and answering
// 'Received' is Finding 1 wearing a different hat — he believes 203 are
// filed and 53 are gone."**
//
// So there are exactly two outcomes here: the whole list is planned, or
// nothing is. There is no third branch that keeps some of it.
//
// THE DEDUPE IS THE OTHER HALF, and it has already cost money once: the
// `/api/referrals/intake` dedupe was case-sensitive and was minting two
// partner rows per human. A paste of 100 hand-typed names is exactly
// where `Acme LLC` / `acme llc` / `ACME, LLC.` arrive together.
//
// Note the asymmetry that sets every threshold below. Folding too HARD
// collapses two different companies into one and destroys a claim — the
// same harm as a partial accept. Folding too SOFTLY files two claims for
// one company, which costs a human one look at the queue. So this fold is
// deliberately narrower than `foldCompany` in partner-claims.ts, which
// serves the opposite purpose (offering staff match candidates, where a
// missed candidate costs a search and a wrong one moves money).

describe('batchFold: the case that minted two partner rows per human', () => {
  it('folds the three spellings of one company together', () => {
    const a = batchFold('Acme LLC')
    expect(batchFold('acme llc')).toBe(a)
    expect(batchFold('ACME, LLC.')).toBe(a)
    expect(batchFold('  Acme   LLC  ')).toBe(a)
  })

  it('folds a name with no suffix onto the same key as one with', () => {
    expect(batchFold('Acme')).toBe(batchFold('Acme Inc'))
    expect(batchFold('Acme')).toBe(batchFold('ACME, INC.'))
  })

  it('NFKC-normalises, so a full-width paste is not a second company', () => {
    // Pasting out of a spreadsheet or a non-Latin keyboard layout brings
    // these in. Without normalisation they are a different byte string
    // and the partner files the same company twice.
    expect(batchFold('ＡＣＭＥ')).toBe(batchFold('Acme'))
  })

  it('collapses every kind of run of whitespace', () => {
    expect(batchFold('Acme \t  Widgets\n')).toBe(batchFold('Acme Widgets'))
  })

  it('strips ONLY the five suffixes the spec names', () => {
    // Conservative on purpose. partner-claims.ts strips a dozen more
    // (gmbh, bv, pty, the...) because over-folding there costs a staff
    // search. Over-folding HERE destroys a claim: "Acme GmbH" and "Acme
    // BV" are two real companies in two countries, and collapsing them
    // means one of them is never filed and nobody is told.
    expect(batchFold('Acme GmbH')).not.toBe(batchFold('Acme'))
    expect(batchFold('Acme Pty')).not.toBe(batchFold('Acme'))
    for (const suffix of ['inc', 'llc', 'ltd', 'corp', 'co']) {
      expect(batchFold(`Acme ${suffix}`), suffix).toBe(batchFold('Acme'))
    }
  })

  it('does not strip a leading word, because "The Acme" may be a real name', () => {
    expect(batchFold('The Acme')).not.toBe(batchFold('Acme'))
  })

  it('folds a name that is nothing but a legal wrapper to empty', () => {
    // Not a company anyone typed on purpose. planBatch refuses the batch
    // over one of these rather than filing "LLC" as a claim or dropping
    // the line silently.
    expect(batchFold('LLC')).toBe('')
    expect(batchFold('  ,  ')).toBe('')
    expect(batchFold('---')).toBe('')
  })
})

describe('planBatch: one line is one company', () => {
  it('takes a newline-separated paste', () => {
    const plan = planBatch('Acme\nBeta Widgets\nGamma Corp', [])
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.rows.map((r) => r.company_name)).toEqual(['Acme', 'Beta Widgets', 'Gamma Corp'])
    expect(plan.rawCount).toBe(3)
  })

  it('keeps a comma INSIDE a company name when there is no header', () => {
    // The trap. Splitting every line on commas turns "Acme, LLC" into a
    // company called "Acme" with a website called "LLC" -- and the
    // partner's roster then shows a claim he did not file. With no header
    // row to tell us the columns, the whole line is the name.
    const plan = planBatch('Acme, LLC\nBeta Widgets, Inc.', [])
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.rows.map((r) => r.company_name)).toEqual(['Acme, LLC', 'Beta Widgets, Inc.'])
  })

  it('ignores blank lines instead of counting them as rows', () => {
    // A paste out of a spreadsheet ends in a newline, and a trailing
    // blank line that counted would push a 150-row list over the limit
    // and refuse a list that is exactly the size we advertise.
    const plan = planBatch('Acme\n\n  \nBeta\n', [])
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.rawCount).toBe(2)
    expect(plan.rows).toHaveLength(2)
  })

  it('reads columns when the first line is a header', () => {
    const plan = planBatch(
      'Company,Website,Contact name,Email\nAcme,acme.com,Dana,dana@acme.com',
      [],
    )
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.rawCount).toBe(1)
    expect(plan.rows[0]).toEqual({
      company_name: 'Acme',
      website: 'acme.com',
      contact_name: 'Dana',
      contact_email: 'dana@acme.com',
    })
  })

  it('emits ONLY partner-supplied fields, never a status or a client id', () => {
    // These rows go to claimRow, whose allow-list is the real guard. This
    // test pins the layer above it: a row object that carried
    // `client_id` or `status` would be a key somebody later copies
    // through, and approval is the only write that may create money.
    const plan = planBatch('Company,Website\nAcme,acme.com', [])
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(Object.keys(plan.rows[0]).sort()).toEqual(['company_name', 'website'])
  })

  it('omits a column the partner left blank rather than storing an empty string', () => {
    // On the staff queue '' reads as "he told us there is no website";
    // absent reads as "he did not say". Same rule as claimRow.
    const plan = planBatch('Company,Website\nAcme,', [])
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.rows[0]).toEqual({ company_name: 'Acme' })
  })
})

describe('planBatch: dedupe reports both numbers and keeps nothing hidden', () => {
  it('folds duplicates within the paste, keeping the first spelling', () => {
    const plan = planBatch('Acme LLC\nBeta\nacme llc\nACME, LLC.', [])
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.rawCount).toBe(4)
    expect(plan.rows.map((r) => r.company_name)).toEqual(['Acme LLC', 'Beta'])
  })

  it('folds against the claims the partner already filed', () => {
    const plan = planBatch('Acme LLC\nBeta', ['acme'])
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.rawCount).toBe(2)
    expect(plan.rows.map((r) => r.company_name)).toEqual(['Beta'])
  })

  it('plans an empty list when every row is already filed, and refuses nothing', () => {
    // He pasted real companies and did nothing wrong, so this is not a
    // refusal -- but there is nothing to store, and a batch row with
    // zero claims under it is a header over an empty list on the staff
    // queue. The route writes nothing and still answers honestly.
    const plan = planBatch('Acme LLC\nacme inc', ['acme'])
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.rows).toEqual([])
    expect(plan.rawCount).toBe(2)
  })
})

describe('planBatch: it refuses whole, never in part', () => {
  it('refuses a paste over the limit and plans NO rows', () => {
    const raw = Array.from({ length: BATCH_MAX_ROWS + 53 }, (_, i) => `Company ${i}`).join('\n')
    const plan = planBatch(raw, [])
    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.reason).toBe('too_many')
    // The honest count, verbatim from §3.2.
    expect(plan.message).toContain('150 companies at a time')
    expect(plan.message).toContain('203')
    // And no rows anywhere on the refusal. A refusal that still carried
    // the first 150 is one `if` away from storing them.
    expect(plan).not.toHaveProperty('rows')
  })

  it('refuses on the PASTED count, not the deduped one', () => {
    // 151 lines of which 11 repeat. Gating after the fold would accept
    // this, and the refusal message quotes what he pasted -- so the rule
    // a partner can infer from the message is the rule enforced. It also
    // means a 10,000-line paste is refused before we read anything.
    const lines = Array.from({ length: BATCH_MAX_ROWS - 10 }, (_, i) => `Company ${i}`)
    const raw = [...lines, ...lines.slice(0, 11)].join('\n')
    expect(raw.split('\n')).toHaveLength(BATCH_MAX_ROWS + 1)
    const plan = planBatch(raw, [])
    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.reason).toBe('too_many')
  })

  it('accepts a paste of exactly the limit', () => {
    const raw = Array.from({ length: BATCH_MAX_ROWS }, (_, i) => `Company ${i}`).join('\n')
    const plan = planBatch(raw, [])
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.rows).toHaveLength(BATCH_MAX_ROWS)
  })

  it('refuses an empty paste, which is a fact about the form and not about any company', () => {
    for (const raw of ['', '   ', '\n\n']) {
      const plan = planBatch(raw, [])
      expect(plan.ok, JSON.stringify(raw)).toBe(false)
      if (plan.ok) return
      expect(plan.reason).toBe('empty')
    }
  })

  it('refuses the whole batch over one unusable line, naming the line', () => {
    // "LLC" on line 2 is not a company. The two alternatives are both
    // worse: filing it makes a claim nobody can act on, and dropping it
    // is the partial accept the spec forbids outright. Refusing names
    // the line so he can fix it -- a fact about his own paste.
    const plan = planBatch('Acme\nLLC\nBeta', [])
    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.reason).toBe('unusable_row')
    expect(plan.message).toContain('2')
    expect(plan.message).toContain('LLC')
  })

  it('counts the line number as the partner sees it, blanks included', () => {
    // He is going to look at his paste to find line 4. If we number the
    // lines we kept rather than the lines he sent, we point him at the
    // wrong one.
    const plan = planBatch('Acme\n\nBeta\n---\nGamma', [])
    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.message).toContain('4')
  })
})

describe('batchReceivedMessage: both numbers, and no fiction when there is nothing to report', () => {
  it('reports pasted and kept when duplicates were folded', () => {
    const msg = batchReceivedMessage(203, 187)
    expect(msg).toContain('203')
    expect(msg).toContain('187')
    expect(msg.toLowerCase()).toContain('duplicate')
  })

  it('says nothing about duplicates when none were removed', () => {
    const msg = batchReceivedMessage(12, 12)
    expect(msg).toContain('12')
    expect(msg.toLowerCase()).not.toContain('duplicate')
  })

  it('tells him plainly when everything was already filed', () => {
    const msg = batchReceivedMessage(4, 0)
    expect(msg).toContain('4')
    expect(msg.toLowerCase()).toContain('already')
  })

  it('never promises a decision or a date', () => {
    // Same discipline as CLAIM_RECEIVED: the next sentence a partner
    // reads about these claims is a human's.
    for (const msg of [batchReceivedMessage(203, 187), batchReceivedMessage(12, 12)]) {
      expect(msg).not.toMatch(/\bapprov/i)
      expect(msg).not.toMatch(/\b\d+\s*(hours|days|weeks|business)\b/i)
    }
  })
})

describe('the batch rate limit is per batch and fails closed', () => {
  it('bounds batches per day, not rows', () => {
    expect(BATCH_MAX_PER_DAY).toBe(3)
    expect(BATCH_MAX_ROWS).toBe(150)
  })

  it('refuses when the count cannot be read', () => {
    // Copied from overDailyCap, for the reason that route documents: an
    // unreadable count is an unknown, and the thing being counted is a
    // claim on twelve months of commission. /api/referrals/intake fails
    // OPEN here; the spec says in as many words not to copy that.
    expect(overBatchDailyCap(null)).toBe(true)
  })

  it('allows the batches inside the allowance and refuses the one past it', () => {
    expect(overBatchDailyCap(0)).toBe(false)
    expect(overBatchDailyCap(BATCH_MAX_PER_DAY - 1)).toBe(false)
    expect(overBatchDailyCap(BATCH_MAX_PER_DAY)).toBe(true)
    expect(overBatchDailyCap(BATCH_MAX_PER_DAY + 10)).toBe(true)
  })
})

// ============================================================
// The route's own invariants, read off its source.
//
// `vitest.config.ts` has `include: ['src/**/*.test.ts']`, so a route
// handler cannot be covered as a module -- the same constraint
// partner-terms-record.ts and partner-brand.test.ts work around, and the
// same two traps apply:
//
//   1. COMMENTS ARE STRIPPED FIRST, because the route's own header
//      explains at length why it must not consult CLAIM_DAILY_CAP. A
//      grep over raw source counts that explanation and the rule passes
//      or fails on its own prose. (This has bitten before: a /\b429\b/
//      guard tripped on the comment saying why the response is NOT a
//      429.)
//
//   2. EVERY ABSENCE TEST NEEDS A CONTROL. `not.toContain` passes over
//      an empty string, so a renamed route file would read as a clean
//      bill of health. The first test below is that control.
// ============================================================

const ROUTE = 'src/app/api/partner/claims/batch/route.ts'

const codeOf = (file: string) =>
  readFileSync(file, 'utf8')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

describe('the batch route: shape rules a module test cannot reach', () => {
  it('reads the route and finds real code (control for every absence below)', () => {
    const src = codeOf(ROUTE)
    expect(src.length, 'route read as empty -- is the path right?').toBeGreaterThan(500)
    expect(src).toContain('export async function POST')
  })

  it('authenticates BEFORE it reads the body', () => {
    // Not cosmetic. Every step after this needs a partner id: the count
    // would count nobody's batches, the dedupe would fold against
    // nobody's claims, and the insert would have no owner. The existing
    // single-claim route documents the same ordering.
    const src = codeOf(ROUTE)
    const auth = src.indexOf('getPartnerFromSession()')
    const json = src.indexOf('req.json()')
    const text = src.indexOf('req.text()')
    expect(auth).toBeGreaterThan(-1)
    expect(json).toBeGreaterThan(-1)
    expect(text).toBeGreaterThan(-1)
    expect(auth).toBeLessThan(json)
    expect(auth).toBeLessThan(text)
  })

  it('does not consult the single-form caps', () => {
    // §3.2, in as many words: "The batch path must not consult
    // CLAIM_DAILY_CAP or CLAIM_STORE_CEILING per row." Those bound how
    // many times a partner fills in the one-at-a-time form. Applying
    // either to a 100-row first upload flags or discards 95 legitimate
    // rows -- and the discard path answers "Received" while doing it.
    const src = codeOf(ROUTE)
    expect(src).not.toContain('CLAIM_DAILY_CAP')
    expect(src).not.toContain('CLAIM_STORE_CEILING')
    expect(src).not.toContain('claimAdmission')
  })

  it('never truncates the list to the limit', () => {
    // The partial accept, as it would actually get written: a slice to
    // BATCH_MAX_ROWS followed by the ordinary success answer. planBatch
    // refuses instead, and this pins that nobody re-adds the kind path
    // in the route.
    const src = codeOf(ROUTE)
    expect(src).not.toMatch(/slice\s*\(\s*0\s*,\s*BATCH_MAX_ROWS/)
    expect(src).not.toContain('BATCH_MAX_ROWS')
  })

  it('files every claim under the batch it arrived in', () => {
    // Without this the staff queue cannot group (§3.5) and the two
    // counts on the batch row describe rows nothing points at.
    expect(codeOf(ROUTE)).toContain('batch_id: batch.id')
  })

  it('never selects * from the claims table', () => {
    // A star carries decision_note and client_id into a partner-path
    // handler. partner_client_claims.sql's header: staff-facing columns
    // "must never reach the partner surface", and the way they get there
    // is a convenience query somebody adds later.
    const src = codeOf(ROUTE)
    expect(src).not.toMatch(/select\(\s*['"`]\*/)
  })

  it('answers a failed write with a 500, on every write path', () => {
    // A partner told "Received" over a failed write has lost claims
    // worth $300 each plus twelve months of share, and will not re-send
    // a list he watched succeed. FIVE steps can fail without proving
    // anything was stored -- the batch count, the existing-claims read,
    // the per-row build, the batch insert, the claim insert -- and each
    // one owns a 500.
    //
    // EXACT, NOT A FLOOR. This started as `>= 4` and I reverted the
    // existing-read branch from 500 to 200 to check the guard: the suite
    // stayed green, because four of the five were still there. A floor
    // is only a tripwire if it is tight. Adding a sixth failure path
    // means adding its 500 and this number together, which is the point.
    const src = codeOf(ROUTE)
    const fives = src.match(/status:\s*500/g) ?? []
    expect(fives.length).toBe(5)
    // And no success code written out longhand anywhere. A 200 in this
    // file would be a deliberate "answer OK on a path that failed".
    expect(src).not.toMatch(/status:\s*200/)
  })
})

// ============================================================
// §3.5: the staff queue groups the open list BY BATCH.
//
// WHY GROUPING IS NOT COSMETIC. A hundred claims filed in the same
// second, each with its own dropdown and its own Approve button, is a
// screen nobody triages — the only way back to "what did this partner
// actually send us" is to eyeball timestamps. The grouping is the
// difference between one list to work through and a hundred unrelated
// rows.
//
// WHAT IT MUST NOT DO is turn one list into one decision. Approving a
// claim is the single write that creates money, so the group is a
// heading over N independent decisions, never a decision of its own.
// §3.5 keeps bulk approve out of scope deliberately, and these tests
// pin the shape that makes it possible to render a group WITHOUT
// offering one.
// ============================================================

interface TestClaim {
  id: string
  batch_id?: string | null
  referral_partner_id: string | null
  status: string | null
  created_at: string | null
}

const claim = (over: Partial<TestClaim> & { id: string }): TestClaim => ({
  batch_id: null,
  referral_partner_id: 'p1',
  status: 'submitted',
  created_at: '2026-10-20T10:00:00Z',
  ...over,
})

describe('groupOpenClaims', () => {
  it('leaves a claim filed one at a time on its own', () => {
    const groups = groupOpenClaims([claim({ id: 'a' }), claim({ id: 'b' })])
    expect(groups).toEqual([
      { kind: 'single', claim: expect.objectContaining({ id: 'a' }) },
      { kind: 'single', claim: expect.objectContaining({ id: 'b' }) },
    ])
  })

  it('collapses the claims of one paste into one group', () => {
    const groups = groupOpenClaims([
      claim({ id: 'a', batch_id: 'B' }),
      claim({ id: 'b', batch_id: 'B' }),
      claim({ id: 'c', batch_id: 'B' }),
    ])
    expect(groups).toHaveLength(1)
    const g = groups[0]
    if (g.kind !== 'batch') throw new Error('expected a batch group')
    expect(g.batchId).toBe('B')
    expect(g.claims.map((c) => c.id)).toEqual(['a', 'b', 'c'])
    expect(g.partnerId).toBe('p1')
  })

  it('keeps the queue in the order it arrived, with the batch where it started', () => {
    // The page reads newest first. A grouping that re-sorted would move
    // yesterday's list above this morning's single claim and quietly
    // change which one a human looks at first.
    const groups = groupOpenClaims([
      claim({ id: 'x' }),
      claim({ id: 'a', batch_id: 'B' }),
      claim({ id: 'y' }),
      claim({ id: 'b', batch_id: 'B' }),
    ])
    expect(groups.map((g) => (g.kind === 'single' ? g.claim.id : g.batchId))).toEqual([
      'x',
      'B',
      'y',
    ])
    const g = groups[1]
    if (g.kind !== 'batch') throw new Error('expected a batch group')
    expect(g.claims.map((c) => c.id)).toEqual(['a', 'b'])
  })

  it('never puts a decided claim back in front of a human', () => {
    // It has been decided. Re-rendering it inside the open group is an
    // invitation to approve it twice -- and the second approval of a
    // rejected claim is a commission nobody meant to grant.
    const groups = groupOpenClaims([
      claim({ id: 'a', batch_id: 'B' }),
      claim({ id: 'done', batch_id: 'B', status: 'approved' }),
      claim({ id: 'no', batch_id: 'B', status: 'rejected' }),
      claim({ id: 'dup', status: 'duplicate' }),
    ])
    expect(groups).toHaveLength(1)
    const g = groups[0]
    if (g.kind !== 'batch') throw new Error('expected a batch group')
    expect(g.claims.map((c) => c.id)).toEqual(['a'])
    expect(g.decidedCount).toBe(2)
  })

  it('reads a missing status as waiting, like the rest of the queue', () => {
    const groups = groupOpenClaims([claim({ id: 'a', status: null, batch_id: 'B' })])
    const g = groups[0]
    if (g.kind !== 'batch') throw new Error('expected a batch group')
    expect(g.claims.map((c) => c.id)).toEqual(['a'])
  })

  it('drops a batch whose every claim has been decided', () => {
    // Those rows are in the "already decided" section. An empty
    // collapsible headed "0 waiting" is a thing to click for nothing.
    const groups = groupOpenClaims([
      claim({ id: 'a', batch_id: 'B', status: 'approved' }),
      claim({ id: 'b', batch_id: 'B', status: 'rejected' }),
    ])
    expect(groups).toEqual([])
  })

  it('dates the group from the earliest claim in it', () => {
    const groups = groupOpenClaims([
      claim({ id: 'a', batch_id: 'B', created_at: '2026-10-20T10:00:05Z' }),
      claim({ id: 'b', batch_id: 'B', created_at: '2026-10-20T10:00:01Z' }),
    ])
    const g = groups[0]
    if (g.kind !== 'batch') throw new Error('expected a batch group')
    expect(g.submittedAt).toBe('2026-10-20T10:00:01Z')
  })

  it('refuses to name a partner when the group disagrees about whose it is', () => {
    // One insert, one partner id -- so this cannot happen from the
    // route. If it ever does, the failure mode is a heading that names
    // partner A over partner B's claim, and a human approving under it
    // moves money to the wrong person. Null, so the screen has to say
    // it does not know.
    const groups = groupOpenClaims([
      claim({ id: 'a', batch_id: 'B', referral_partner_id: 'p1' }),
      claim({ id: 'b', batch_id: 'B', referral_partner_id: 'p2' }),
    ])
    const g = groups[0]
    if (g.kind !== 'batch') throw new Error('expected a batch group')
    expect(g.partnerId).toBeNull()
    expect(g.partnerMismatch).toBe(true)
  })

  it('says so plainly when the partners agree', () => {
    const groups = groupOpenClaims([
      claim({ id: 'a', batch_id: 'B' }),
      claim({ id: 'b', batch_id: 'B' }),
    ])
    const g = groups[0]
    if (g.kind !== 'batch') throw new Error('expected a batch group')
    expect(g.partnerMismatch).toBe(false)
  })

  it('treats an empty-string batch_id as no batch at all', () => {
    // Not a list -- a column written wrong. Grouping on '' would file
    // every such claim from every partner under one heading.
    const groups = groupOpenClaims([
      claim({ id: 'a', batch_id: '' }),
      claim({ id: 'b', batch_id: '', referral_partner_id: 'p2' }),
    ])
    expect(groups.map((g) => g.kind)).toEqual(['single', 'single'])
  })

  it('returns nothing for an empty queue', () => {
    expect(groupOpenClaims([])).toEqual([])
  })
})
