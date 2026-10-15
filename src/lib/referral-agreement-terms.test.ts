import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
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
//
// WHY THIS RUNS OVER EVERY COPY AND DISCOVERS THEM BY GLOB: on 2026-10-12 an
// execution copy was cut for a named partner. It was the attorney-review draft
// with the brackets resolved — which means it is a SECOND document carrying the
// same figures, and it is the one that actually binds. Guarding only the draft
// would have left the binding document unguarded, and naming the copies in a
// list here would last exactly until someone cut a third one. So the copies are
// found on disk. A new copy is in the suite the moment it exists, and cannot be
// added without being checked.

const DOCS = join(process.cwd(), 'docs')
const DRAFT = 'referral-agreement-DRAFT-for-attorney-review.md'

/**
 * Every execution copy in docs/. An execution copy is any
 * referral-agreement-*.md that is neither the attorney-review draft nor the
 * cover note that accompanies it.
 *
 * Deliberately a glob and not a list. See the header comment.
 */
function executionCopies(): string[] {
  return readdirSync(DOCS)
    .filter((f) => f.startsWith('referral-agreement-') && f.endsWith('.md'))
    .filter((f) => f !== DRAFT && !f.includes('attorney-cover-note'))
    .sort()
}

function agreement(file: string): string {
  return readFileSync(join(DOCS, file), 'utf8')
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

/** A named section, with every blockquote (ATTORNEY NOTE) line removed. */
function operativeSection(file: string, heading: string, nextHeading: string): string {
  const text = agreement(file)
  const start = text.indexOf(heading)
  expect(start, `${file}: "${heading}" not found — was the section renamed?`).toBeGreaterThan(-1)
  const end = text.indexOf(nextHeading, start)
  expect(end, `${file}: "${nextHeading}" not found — cannot bound the section`).toBeGreaterThan(start)

  return operative(text.slice(start, end))
}

function operativeSection3(file: string): string {
  return operativeSection(file, '## 3. Qualification & Compensation', '\n## 4.')
}

/**
 * The slice of an execution copy that actually gets rendered into the PDF the
 * counterparty signs, delimited by the CONTRACT-START / CONTRACT-END markers.
 *
 * This exists because the markdown file is BOTH the contract and an internal
 * record of the decisions behind it: the header note records exactly what counsel
 * did and did not review, and the Schedule at the foot lists every open question an
 * attorney might still reopen. Neither belongs in a signed document — bound into
 * the contract they read as an admission. The build script renders only this
 * slice, so the assertions about what the counterparty sees have to be made
 * against the same slice and not against the whole file.
 */
function contractSlice(file: string): string {
  const text = agreement(file)
  const start = text.indexOf('<!-- CONTRACT-START -->')
  const end = text.indexOf('<!-- CONTRACT-END -->')
  expect(start, `${file}: CONTRACT-START marker missing — the PDF build cannot bound the contract`).toBeGreaterThan(-1)
  expect(end, `${file}: CONTRACT-END marker missing — the PDF build cannot bound the contract`).toBeGreaterThan(start)
  return text.slice(start + '<!-- CONTRACT-START -->'.length, end)
}

// The copies under test: the draft plus every execution copy found on disk.
const ALL_COPIES = [DRAFT, ...executionCopies()]

it('found the draft and at least one execution copy to check', () => {
  // A guard on the guard. If the glob stops matching — a rename, a move out of
  // docs/ — every parameterised describe below silently becomes a no-op over a
  // one-element array, and the binding document goes unchecked while the suite
  // stays green. This is the assertion that fails instead.
  expect(ALL_COPIES).toContain(DRAFT)
  expect(executionCopies().length, 'no execution copies found in docs/ — did they move or get renamed?').toBeGreaterThan(0)
})

describe.each(ALL_COPIES)('%s states the standing terms the system pays on', (doc) => {
  it('still has every operative clause of Section 3, by number', () => {
    // The phrase assertions below would survive a clause being PARTIALLY
    // demoted into a blockquote: prefix only its first line with ">" and the
    // numbered heading loses legal effect while every phrase on the following
    // lines is still found. Checking the headings themselves is what makes
    // that visible. It also catches a renumbering, which silently breaks the
    // cross-references in 3.10, 3.11, 4.2 and 7.3.
    const s3 = operativeSection3(doc)
    for (const clause of ['3.1 ', '3.2 ', '3.3 ', '3.4 ', '3.5 ', '3.6 ', '3.7 ', '3.8 ', '3.9 ', '3.10 ', '3.11 ']) {
      expect(s3, `clause ${clause.trim()} is missing from the operative text`).toContain(clause)
    }
  })

  it('states the signup bonus', () => {
    expect(REFERRAL_TERMS.SIGNUP_BONUS).toBe(300)
    expect(operativeSection3(doc)).toContain('$300 USD')
  })

  it('states the commission rate as a percentage of net profit', () => {
    expect(REFERRAL_TERMS.COMMISSION_RATE).toBe(0.05)
    expect(operativeSection3(doc)).toContain('5% of the Net Profit')
  })

  it('states the length of the revenue-share window', () => {
    expect(REFERRAL_TERMS.COMMISSION_MONTHS).toBe(12)
    const s3 = operativeSection3(doc)
    expect(s3).toContain('twelve (12) consecutive months')
    // And says what it is measured from. "12 months" with no start date is the
    // ambiguity, not the number.
    expect(s3).toContain('first paid invoice')
  })

  it('says in terms that there is NO qualification threshold', () => {
    // Both gates were dropped on 2026-10-12. Until then this read
    // `QUALIFY_MIN_REVENUE === 500` and looked for "$500 USD or more in a
    // single calendar month".
    //
    // Asserted in BOTH directions, and the positive half is the important
    // half. A removed term leaves no word behind to search for, so an
    // absence check on its own would stay green on a Section 3 that had lost
    // the subject altogether — and a partner reading a contract that is
    // merely SILENT on thresholds has no answer when Shipo later asserts
    // one. The clause has to say the absence out loud.
    expect(REFERRAL_TERMS.QUALIFY_MIN_REVENUE).toBeNull()
    expect(REFERRAL_TERMS.QUALIFY_MIN_UNITS).toBeNull()
    expect(REFERRAL_TERMS.QUALIFY_MIN_ORDERS).toBeNull()

    const s3 = operativeSection3(doc)
    expect(s3).toContain('no minimum invoice amount')
    expect(s3).toContain('no minimum number of orders, units')
    expect(s3).toContain('No minimum thresholds')
    // What the bonus DOES turn on, now that it does not turn on a figure.
    expect(s3).toContain('pays its first invoice for Services')

    // And the withdrawn threshold's own wording is gone. The bare $500 scan
    // is the broad one: it catches the figure reappearing in any clause, in
    // any phrasing, including one nobody thought to write a check for.
    expect(s3).not.toContain('$500 USD or more in a single calendar month')
    expect(s3, 'a $500 figure is back in the operative Section 3').not.toMatch(/\$500/)
  })

  it('says in terms that there is NO waiting period', () => {
    // Was `QUALIFY_MIN_DAYS_ACTIVE === 60` and "at least **60 days**".
    //
    // 0 is asserted exactly, not `<= 0` or falsy: the code switches the gate
    // off by name on this constant, so a stray 1 here would re-arm a gate
    // the contract now says does not exist.
    expect(REFERRAL_TERMS.QUALIFY_MIN_DAYS_ACTIVE).toBe(0)

    const s3 = operativeSection3(doc)
    expect(s3).toContain('No waiting period')
    expect(s3).toContain('will not withhold it pending any minimum period')
    // Scoped phrases, not a bare "60 days": clauses 3.8 and 3.9 both run real
    // sixty-day windows (statement objections, and the clawback that is now
    // the ONLY churn protection left). A blanket scan here would demand the
    // deletion of the protection this change makes load-bearing.
    expect(s3).not.toContain('at least **60 days**')
    expect(s3).not.toContain('60 days active')
    expect(s3).not.toContain('Release condition')
  })

  it('points the reader from the absent waiting period to the remedy that replaces it', () => {
    // So that the absence of a waiting period and the remedy standing in for
    // it are not two unrelated facts a reader has to connect for themselves.
    // The substance of 3.9 is asserted separately, and only against execution
    // copies — see the block further down. It cannot be asserted here,
    // because in the attorney-review draft 3.9 is still an open question
    // ("[refund it / have it offset]", "[60]"), and that is the correct state
    // for that document.
    expect(operativeSection3(doc)).toContain('in place of any waiting period')
  })

  it('states the minimum payment and that a short balance carries forward', () => {
    expect(REFERRAL_TERMS.MIN_PAYOUT).toBe(50)
    const s3 = operativeSection3(doc)
    expect(s3).toContain('less than $50 USD')
    expect(s3).toContain('rolls forward')
    // A carry that can expire is a different deal from one that cannot.
    expect(s3).toContain('never forfeited')
  })

  it('states that the bonus and the share are additive, not alternatives', () => {
    // buildStatement adds them into one monthly balance. A partner reading
    // "either/or" would be reading a smaller deal than the one being paid.
    expect(operativeSection3(doc)).toContain('additive')
  })

  it('names all four deducted cost buckets', () => {
    const s3 = operativeSection3(doc)
    for (const bucket of ['freight', 'carrier', 'return shipping', 'materials', 'storage', 'payment-processing']) {
      expect(s3, `net-profit definition does not mention ${bucket}`).toContain(bucket)
    }
  })

  it('says in terms that warehouse labor is not deducted', () => {
    // This is the clause that costs Shipo money and therefore the one most
    // likely to be "corrected" by someone who assumes labor must be a cost.
    // It is also the clause a partner would most want in writing.
    const s3 = operativeSection3(doc)
    expect(s3).toContain('Warehouse labor is NOT deducted')
    expect(s3).toContain('Pick, pack, and receiving')
  })

  it('keeps the deduction list closed', () => {
    // An open list ("including without limitation...") would let any new cost
    // category reduce the partner's share without amending the agreement.
    expect(operativeSection3(doc)).toContain('less only the following')
  })

  it('says the share is on the whole account, not one service line', () => {
    expect(operativeSection3(doc)).toContain("client's **entire account**")
  })

  it('says in the agreement that no promotional tier exists', () => {
    // A positive statement, not an absence. An omission leaves no word behind
    // to search for — the same reason the attorney notes are stripped above.
    // If 3.11 is ever rewritten back into an offer, this phrase goes with it.
    const s3 = operativeSection3(doc)
    expect(s3).toContain('There is no promotional, launch, or founding tier')
    expect(s3).toContain('Every Qualified Referral earns the same bonus')
  })

  it('no longer promises a raised bonus or a shifted window anywhere in Section 3', () => {
    const s3 = operativeSection3(doc)
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

  it('says the twelve-month tail survives termination', () => {
    // Without this, a 30-day termination-for-convenience right could be read
    // as ending a twelve-month obligation in its second month.
    const s7 = operativeSection(doc, '## 7. Term & Termination', '\n## 8.')
    expect(s7).toContain('Termination does not end the twelve-month')
    expect(s7).toContain('until that client')
  })
})

// ---------------------------------------------------------------------------
// The plain-English Summary of Terms at the front of each execution copy.
// ---------------------------------------------------------------------------
//
// Added 2026-10-13 because a partner reads a summary and skims eleven sections
// of Delaware contract language. It creates a problem the rest of this suite
// does not have: every figure in the deal is now stated TWICE in the same
// document. The template's own header note exists to stop one set of figures
// living in two files and drifting apart; a summary does the same thing inside
// one file, and the second statement is the one the partner will actually read.
//
// So the summary is tied to REFERRAL_TERMS, not to the prose of Section 3. That
// catches drift in both directions with one assertion each: change 3.3 and
// forget the summary and the summary check fails; change the summary and forget
// 3.3 and the Section 3 check above fails. Comparing the summary against
// Section 3 directly would have let a matched pair of wrong numbers through.
//
// Scoped to execution copies. The attorney-review draft has no summary and
// should not grow one — it is read by a lawyer who wants the clauses.
describe.each(executionCopies())('%s — the Summary of Terms', (doc) => {
  const SUMMARY_HEADING = '## Summary of Terms'

  function summary(): string {
    const slice = contractSlice(doc)
    const start = slice.indexOf(SUMMARY_HEADING)
    expect(start, `${doc}: "${SUMMARY_HEADING}" is not inside the CONTRACT markers`).toBeGreaterThan(-1)
    const end = slice.indexOf('\n## 1.', start)
    expect(end, `${doc}: cannot bound the summary — "## 1." not found after it`).toBeGreaterThan(start)
    return operative(slice.slice(start, end))
  }

  it('sits inside the contract markers, so the partner actually receives it', () => {
    // A summary outside the markers would render into nothing: the build script
    // slices on those markers and drops everything else. It would read correctly
    // in the markdown and be absent from the signed PDF.
    expect(summary().length, `${doc}: summary is empty`).toBeGreaterThan(500)
  })

  it('says the numbered sections govern if the summary disagrees with them', () => {
    // This is the clause that makes a summary safe to include at all. Without
    // it, a summary that drifts is not a documentation bug, it is a conflicting
    // term in a signed contract, and a court resolving the conflict has no
    // instruction about which one the Parties intended to bind them.
    const s = summary()
    expect(s, `${doc}: summary does not say it is for orientation only`).toContain('for orientation only')
    expect(s, `${doc}: summary does not state that the numbered sections govern a conflict`).toMatch(
      /numbered section\s+governs|the numbered section governs/,
    )
  })

  it('states every figure the billing system pays on', () => {
    const s = summary()
    const figures: [string, string][] = [
      [`$${REFERRAL_TERMS.SIGNUP_BONUS} USD`, 'signup bonus'],
      [`${REFERRAL_TERMS.COMMISSION_RATE * 100}% of Net Profit`, 'commission rate'],
      [`$${REFERRAL_TERMS.MIN_PAYOUT} USD`, 'minimum payout'],
      // The window is the one figure NOT composed from the constant, and
      // deliberately so. The contract writes it the way contracts write
      // numbers — word then numeral, "twelve (12)" — so a composed
      // `${COMMISSION_MONTHS} (${COMMISSION_MONTHS})` asks for "12 (12)",
      // which is not English and is not what the document says. Hardcoding the
      // phrase is not a hole here because the constant is pinned by `toBe(12)`
      // in the Section 3 block above: changing COMMISSION_MONTHS fails there
      // first and sends the author to every literal. And the literal buys
      // something the composed form cannot — it checks the WORD against the
      // numeral, so "twelve (18) consecutive months", where someone edited one
      // half of the pair, fails here instead of shipping an ambiguous term.
      ['twelve (12) consecutive months', 'revenue-share window'],
    ]
    for (const [phrase, what] of figures) {
      expect(s, `${doc}: summary does not state the ${what}: "${phrase}"`).toContain(phrase)
    }
  })

  it('invents no money or percentage figure that is not a term of the deal', () => {
    // The checks above are presence checks, and a presence check cannot see an
    // ADDITION. A summary that correctly states $300 and also mentions a $1,000
    // tier that exists nowhere in the contract would pass all of them. This
    // enumerates instead: every dollar and percent figure in the summary has to
    // be one the deal actually has.
    const s = summary()
    const allowedMoney = new Set([`$${REFERRAL_TERMS.SIGNUP_BONUS}`, `$${REFERRAL_TERMS.MIN_PAYOUT}`])
    const allowedPercent = new Set([`${REFERRAL_TERMS.COMMISSION_RATE * 100}%`])

    const money = s.match(/\$[\d,]+(?:\.\d+)?/g) ?? []
    const stray = money.filter((m) => !allowedMoney.has(m))
    expect(
      stray,
      `${doc}: summary states a dollar figure that is not a term of this deal: ${JSON.stringify(stray)}. ` +
        `Allowed: ${JSON.stringify([...allowedMoney])}`,
    ).toEqual([])

    const percent = s.match(/\d+(?:\.\d+)?%/g) ?? []
    const strayPct = percent.filter((p) => !allowedPercent.has(p))
    expect(
      strayPct,
      `${doc}: summary states a percentage that is not a term of this deal: ${JSON.stringify(strayPct)}. ` +
        `Allowed: ${JSON.stringify([...allowedPercent])}`,
    ).toEqual([])
  })

  it('cites only clause numbers that exist in the agreement it summarises', () => {
    // The cover note shipped a citation to a clause that did not hold the
    // clawback (see the next describe block). A summary is read more than the
    // cover note and is bound into the signed document, so a dangling reference
    // here is worse. Every "(3.4)" style citation must correspond to a clause
    // actually drafted below.
    const slice = contractSlice(doc)
    const body = slice.slice(slice.indexOf('\n## 1.'))
    // Citations appear singly "(3.4)" and in runs "(3.1, 3.2, 3.10)", so pull
    // the whole parenthesised group and split it. Plain section references like
    // "(5)" are deliberately not collected: there is no "5 " clause line to
    // match them against, since the heading reads "## 5. Partner Conduct".
    const cited = new Set<string>()
    for (const m of summary().matchAll(/\(([\d.]+(?:,\s*[\d.]+)*)\)/g)) {
      for (const n of m[1].split(/,\s*/)) if (/^\d+\.\d+$/.test(n)) cited.add(n)
    }
    expect(cited.size, `${doc}: summary cites no clause numbers at all — the cross-references are gone`).toBeGreaterThan(10)

    // A clause counts as drafted when the body states it at the start of a
    // line, e.g. "3.4 **Revenue share". `body` is the raw slice and still has
    // its newlines; operative() collapsed them in the summary only.
    const dangling = [...cited].filter(
      (n) => !new RegExp(`(^|\\n)${n.replace('.', '\\.')} `).test(body),
    )
    expect(
      dangling,
      `${doc}: summary cites clauses that are not drafted in the agreement: ${JSON.stringify(dangling)}`,
    ).toEqual([])
  })

  it('uses no markdown table, which this renderer cannot render', () => {
    // Guarded at the source as well as in the PDF text layer. The PDF check
    // catches it after a render; this one names the problem in the file the
    // author is editing, and still fails if the PDF was never rebuilt.
    const lines = summary().split('\n')
    expect(
      lines.filter((l) => l.trim().startsWith('|')),
      `${doc}: the summary contains a markdown table. scripts/build-agreement-pdf.mjs has no ` +
        'table branch — it will print the pipes verbatim to the counterparty. Use bullets.',
    ).toEqual([])
  })

  it('states what Shipo expects of Partner, not only what Shipo pays', () => {
    // The summary was asked for as "the prices AND what is expected of him".
    // A summary that lists only the money is the version that gets written by
    // accident, and it is the one that makes a partner feel misled later.
    const s = summary()
    for (const [phrase, what] of [
      ['Form W-9', 'the W-9 precondition to payment'],
      ['CAN-SPAM', 'the outreach-compliance obligation'],
      ['confidential', 'the confidentiality obligation'],
      ['independent contractor', 'the contractor status'],
      ['no guarantee', 'the no-guarantees obligation'],
      // The two terms that cost Partner money rather than merely constraining
      // conduct, and the two the first draft of this summary left out. The
      // conduct rules were listed without the consequence of breaking them,
      // which is the same "reads better than the contract" failure as omitting
      // a figure — it just hides in a sentence that is individually true.
      // Section 9 runs ONE WAY, so the word "indemnif" appearing is not enough;
      // a summary saying "each Party indemnifies the other" would contain it
      // and be false. Hence the direction is asserted too.
      ['one way', 'that indemnification runs one way'],
      ['indemnif', 'the indemnification obligation'],
      ['capped at', "the cap on Shipo's liability to Partner"],
    ] as [string, string][]) {
      expect(s, `${doc}: summary omits ${what}: "${phrase}"`).toContain(phrase)
    }
  })
})

// ---------------------------------------------------------------------------
// The cover note that goes WITH the agreement.
// ---------------------------------------------------------------------------
//
// docs/referral-agreement-attorney-cover-note.md briefs the attorney on the
// commercial deal before they read the contract. It is not the contract, so
// none of the clause checks above touched it — and on 2026-10-12 it was found
// describing the economics as "a one-time $300" with the 5% revenue share
// missing altogether, gated by a "$500/month minimum" that had just been
// removed, and citing §3.4 for a clawback that lives at §3.9. Three errors, in
// the one document whose entire job is to tell a lawyer what they are reviewing.
//
// POSITIVE ASSERTIONS ONLY, and deliberately so. The note's whole value is that
// it explains what changed and why, so it legitimately contains the strings
// "$500" and "60 days" as HISTORY — an absence scan of the kind used on Section
// 3 above would demand the deletion of the paragraph that makes the note
// useful. What actually went wrong was an OMISSION, so the guard asserts the
// note still states each limb of the deal.
describe('the attorney cover note briefs the real deal', () => {
  const note = readFileSync(join(DOCS, 'referral-agreement-attorney-cover-note.md'), 'utf8')

  it('states both limbs of the compensation, not just the bonus', () => {
    // The omission that actually happened: a lawyer told the commission is
    // "one-time $300" has no reason to scrutinise a 5%-of-net-profit clause
    // running twelve months, which is the larger and longer liability.
    expect(note).toContain(`$${REFERRAL_TERMS.SIGNUP_BONUS}`)
    expect(note).toContain(`${REFERRAL_TERMS.COMMISSION_RATE * 100}% of the net profit`)
    expect(note).toContain(`${REFERRAL_TERMS.COMMISSION_MONTHS} months`)
    expect(note, 'the note must say a partner gets BOTH, not one or the other').toMatch(/two parts|plus/i)
  })

  it('tells the attorney the thresholds were removed and what now carries the risk', () => {
    // The gates went on 2026-10-12 and §3.9 became the only churn protection.
    // §3.9 is also still an open question in the draft, so the note has to ask
    // for it — an attorney who is not told this is the load-bearing clause may
    // reasonably leave a half-drafted one alone.
    expect(note).toContain('no minimum invoice amount and no waiting period')
    expect(note).toContain('§3.9')
    expect(note, 'the note no longer flags §3.9 as the only remaining protection').toMatch(
      /only protection/i,
    )
  })

  it('cites clause numbers that exist in the agreement it is attached to', () => {
    // Weak on its own — see the test below, which is the one that catches the
    // error that really happened. This only catches a citation to a clause
    // number that is not in the document at all.
    const cited = [...note.matchAll(/§(3\.\d+)/g)].map((m) => m[1])
    expect(cited.length, 'the note cites no Section 3 clauses at all').toBeGreaterThan(0)
    const s3 = operativeSection3(DRAFT)
    for (const clause of new Set(cited)) {
      expect(s3, `the note cites §${clause}, which is not a clause of Section 3`).toContain(
        `${clause} `,
      )
    }
  })

  it('points the clawback question at the clause that actually holds the clawback', () => {
    // The real error was §3.4 for the clawback — a clause that EXISTS and says
    // something else entirely (the revenue share). Existence checking cannot
    // see that, and nor can a `toContain('§3.9')`: the note cites §3.9 three
    // times, so corrupting one of them leaves the other two to satisfy the
    // search. Both of those weaker checks were written first and both stayed
    // green when this exact error was re-introduced.
    //
    // So the number is DERIVED from the agreement and matched against the
    // citation in the note's own clawback item. That also means renumbering
    // Section 3 fails here instead of silently repointing a lawyer — which
    // matters more than usual now, because this is the clause that replaced
    // the removed 60-day gate as the only churn protection.
    // NOT `^`-anchored: operative() collapses every run of whitespace to a
    // single space, so the string has no line starts to anchor to and an
    // /m-anchored pattern can never match. Written that way first, and it made
    // this test stuck-RED — which the E2 and E4 reversions then "caught"
    // meaninglessly, since a test that always fails detects nothing. A clause
    // number is preceded by a space once collapsed, or starts the slice.
    const s3 = operativeSection3(DRAFT)
    const clawback = s3.match(/(?:^|\s)(3\.\d+) \*\*Clawback/)
    expect(clawback, 'Section 3 has no clause headed "Clawback" any more').not.toBeNull()

    const noteLine = note.split('\n').find((l) => /clawback/i.test(l))
    expect(noteLine, 'the cover note no longer raises the clawback at all').toBeTruthy()
    expect(noteLine).toContain(`§${clawback![1]}`)
  })
})

// ---------------------------------------------------------------------------
// The PDF is the artifact. Everything above this line reads markdown.
// ---------------------------------------------------------------------------
//
// Every check above compares one text file to another text file. Nobody emails
// a .md. The thing that reaches an attorney or a partner is docs/*.pdf, and on
// 2026-10-12 the draft PDF was found to be a four-page render of the document
// as it stood BEFORE the Section 3 rewrite: no 5% share, no twelve-month
// window, no labor carve-out, no statement-objection clause. It was not
// truncated or corrupt. It was a complete, clean, confident render of the wrong
// agreement, and it had been sitting in the repo while the suite above was
// green — because the suite above never opened it.
//
// So the guard is not "does the PDF mention the figures". It is: every prose
// block of the markdown must be findable in the PDF's text layer. A phrase list
// only catches drift in the phrases someone thought to list; block containment
// catches any edit that was not re-rendered, which is the actual failure mode.
//
// THREE THINGS THAT MAKE A NAIVE VERSION OF THIS CHECK LIE:
//
// 1. LIGATURES. Georgia renders "fi" as the single glyph U+FB01, so the text
//    layer of a correct PDF says "Proﬁt", "conﬁrm", "ﬁrst". A plain search for
//    "5% of the Net Profit" fails on a PDF that displays exactly that. NFKC
//    normalization folds the ligature back apart. This one is nasty because it
//    fails in the direction of a true-looking alarm.
//
// 2. LINE BREAKS EAT CHARACTERS. Extraction joins wrapped lines without the
//    space, and drops the hyphen of a hyphenated word broken across lines:
//    "one-time" comes back "onetime" and "FBA prep" comes back "FBAprep". So
//    both sides get all whitespace AND all hyphens removed before matching —
//    stronger than the whitespace collapse operative() does for markdown.
//
// 3. AN EMPTY NEEDLE MATCHES EVERYTHING. "" is a substring of any string, so a
//    normalizer that returned nothing would turn this whole section green over
//    a blank PDF. That is why the extractor gets a positive AND a negative
//    control below, and why short blocks are dropped rather than silently
//    passing.

/** Extraction only. All normalization lives in TS, on one side of the wire. */
const EXTRACT = `import sys, pypdf
r = pypdf.PdfReader(sys.argv[1])
sys.stdout.write(''.join(p.extract_text() or '' for p in r.pages))`

const PDF_CACHE = new Map<string, string>()

function pdfText(file: string): string {
  const abs = join(DOCS, file)
  const hit = PDF_CACHE.get(abs)
  if (hit !== undefined) return hit

  let out: string
  try {
    out = execFileSync('python3', ['-c', EXTRACT, abs], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (err) {
    // Deliberately a failure and not a skip. A skipped PDF check is a green
    // suite over an unchecked artifact, which is the state that let the stale
    // draft sit in the repo in the first place.
    throw new Error(
      `cannot read the text layer of ${file}: ${(err as Error).message}\n` +
        'This guard needs pypdf on the system python3: python3 -m pip install pypdf',
    )
  }
  PDF_CACHE.set(abs, out)
  return out
}

/**
 * Fold a string to the form both sides are compared in: ligatures split, smart
 * quotes and dashes flattened, then every space and hyphen removed. See notes
 * 1 and 2 above — this is not cosmetic, each step is a real extraction
 * artifact that produced a false "missing" result on a correct PDF.
 */
function flatten(text: string): string {
  let s = text.normalize('NFKC')
  for (const [from, to] of [
    ['’', "'"],
    ['‘', "'"],
    ['“', '"'],
    ['”', '"'],
    ['—', '-'],
    ['–', '-'],
    ['­', ''],
  ] as const) {
    s = s.split(from).join(to)
  }
  return s.replace(/[\s-]+/g, '')
}

/**
 * The markdown blocks that should have produced visible text, flattened.
 *
 * Strips the syntax the renderer consumes (heading hashes, blockquote markers,
 * bullet dashes, bold stars, code backticks) and drops horizontal rules, which
 * render as a line and contribute no text. Blocks under 15 characters are
 * dropped too: they carry no evidence and a short needle invites a coincidental
 * match.
 */
function proseBlocks(markdown: string): string[] {
  return markdown
    .trim()
    .split(/\n{2,}/)
    .filter((b) => !/^\s*-{3,}\s*$/.test(b))
    .map((b) =>
      b
        .replace(/^\s*>\s?/gm, '')
        .replace(/^#+\s*/gm, '')
        .replace(/^\s*-\s+/gm, '')
        .split('**')
        .join('')
        .split('`')
        .join(''),
    )
    .map(flatten)
    .filter((b) => b.length >= 15)
}

/**
 * The markdown that the PDF for this file was rendered FROM.
 *
 * This mirrors the build script's two modes exactly, and the asymmetry is the
 * point. The draft is rendered with --full, so its whole file — banner,
 * ATTORNEY NOTEs and all — is in the PDF. An execution copy is rendered from
 * the CONTRACT-START/END slice only, so its header note and its Schedule of
 * Resolved Items are deliberately absent from the PDF and comparing the whole
 * file would report them as drift.
 */
function renderedSource(file: string): string {
  return file === DRAFT ? agreement(file) : contractSlice(file)
}

/** Copies that have a PDF sitting next to them. */
const PDF_PAIRS = [DRAFT, ...executionCopies()].filter((md) =>
  existsSync(join(DOCS, md.replace(/\.md$/, '.pdf'))),
)

const pdfFor = (md: string) => md.replace(/\.md$/, '.pdf')

describe('the PDF text extractor itself', () => {
  // Note 3 above. A broken extractor reports every phrase as absent, which on
  // screen is indistinguishable from a correctly detected stale PDF — and an
  // over-eager matcher reports every phrase as present, which is worse because
  // it is green. Neither failure is visible without controls, so: one string
  // that must be found and one that must not.
  const sample = pdfFor(DRAFT)

  it('finds text that is definitely in the document (positive control)', () => {
    const text = flatten(pdfText(sample))
    expect(text.length, `${sample}: extracted no text at all — extractor or PDF is broken`).toBeGreaterThan(1000)
    expect(text, `${sample}: extraction returned text but not the title`).toContain(
      flatten('Referral Partner Agreement'),
    )
  })

  it('does not find text that is definitely absent (negative control)', () => {
    const text = flatten(pdfText(sample))
    expect(text).not.toContain(flatten('Partner shall be compensated in Belgian waffles'))
  })

  it('does not reduce a real phrase to nothing', () => {
    // The specific way this section could go vacuously green: flatten() eating
    // its input. An empty needle is a substring of everything.
    expect(flatten('5% of the Net Profit').length).toBeGreaterThan(10)
    expect(proseBlocks(agreement(DRAFT)).length).toBeGreaterThan(20)
  })
})

it('every agreement markdown with a PDF beside it is in the PDF check', () => {
  // Guard on the guard, same reasoning as the glob check above. If the draft's
  // PDF is deleted or renamed, PDF_PAIRS quietly loses it and the parameterised
  // describe below becomes a no-op while the suite stays green. The draft PDF
  // is the artifact that gets emailed to the attorney; its absence is a failure,
  // not a reason to check less.
  expect(PDF_PAIRS, 'docs/referral-agreement-DRAFT-for-attorney-review.pdf is missing — run: node scripts/build-agreement-pdf.mjs --full docs/referral-agreement-DRAFT-for-attorney-review.md').toContain(DRAFT)
})

describe.each(PDF_PAIRS)('%s — the rendered PDF matches the markdown', (doc) => {
  const pdf = pdfFor(doc)

  it('contains every prose block of the markdown it was rendered from', () => {
    const text = flatten(pdfText(pdf))
    const blocks = proseBlocks(renderedSource(doc))
    expect(blocks.length, `${doc}: no prose blocks found — the stripper is broken`).toBeGreaterThan(20)

    const missing = blocks.filter((b) => !text.includes(b))
    expect(
      missing.length,
      `${pdf} is a stale render of ${doc}: ${missing.length} of ${blocks.length} blocks are ` +
        `not in its text layer. Rebuild it.\nFirst missing block: ${missing[0]?.slice(0, 160)}`,
    ).toBe(0)
  })

  it('states the figures the billing system pays on', () => {
    // Redundant with the block check above, and kept anyway: when this one
    // fails it names the term that is wrong instead of a block offset, and it
    // ties the PDF to REFERRAL_TERMS rather than to the markdown. A PDF that
    // passed the block check but failed this would mean the markdown itself
    // drifted from the code — a different bug with a different fix.
    const text = flatten(pdfText(pdf))
    const figures: [string, string][] = [
      [`$${REFERRAL_TERMS.SIGNUP_BONUS} USD`, 'signup bonus'],
      [`${REFERRAL_TERMS.COMMISSION_RATE * 100}% of the Net Profit`, 'commission rate'],
      [`$${REFERRAL_TERMS.MIN_PAYOUT} USD`, 'minimum payout'],
      ['twelve (12) consecutive months', 'revenue-share window'],
      ['Warehouse labor is NOT deducted', 'labor carve-out'],
      ['There is no promotional, launch, or founding tier', 'no promotional tier'],
      // The two gates dropped on 2026-10-12. In the PDF as well as the
      // markdown, because the PDF is what a partner signs and the markdown is
      // not: on 2026-10-12 the draft PDF was found to be a render of the
      // document as it stood before a whole Section 3 rewrite. A contract
      // signed off a stale render would bind Shipo to a $500 threshold its
      // own billing code no longer enforces.
      ['no minimum invoice amount', 'absence of a qualification threshold'],
      ['No waiting period', 'absence of a waiting period'],
    ]
    for (const [phrase, what] of figures) {
      expect(text, `${pdf} does not state the ${what}: "${phrase}"`).toContain(flatten(phrase))
    }
  })

  it('renders markdown syntax instead of printing it', () => {
    // A block the renderer does not recognise falls through to the <p> branch,
    // which emits the source verbatim — so an unhandled construct ships its own
    // markup to the counterparty. That is not hypothetical: the party block is a
    // bullet list with a wrapped first item, the list branch required EVERY line
    // to start with "- ", and both PDFs printed a literal "- " before "Shipo
    // LLC" on page 1.
    //
    // This needs its own check because NOTHING above can see it. Both the block
    // check and the figures check compare through flatten(), which strips
    // whitespace and hyphens precisely so that a line wrap cannot cause a false
    // miss — and that is the same edit that makes "- Shipo LLC" and "Shipo LLC"
    // identical. So this one reads the RAW text layer, not the flattened one.
    // Tables are in this list because the renderer has NO table branch — the
    // header of build-agreement-pdf.mjs says so in terms ("No tables — the one
    // table in the source file lives in the Schedule, which is outside the
    // contract markers"). So a table added inside the CONTRACT markers does not
    // render as a table; it falls through to <p> and prints its own pipes. The
    // Summary of Terms added on 2026-10-13 is exactly the kind of content
    // someone reaches for a table to express, which is why this is guarded
    // rather than left to the author remembering.
    const raw = pdfText(pdf)
    const leaked = raw
      .split('\n')
      .map((l) => l.trim())
      .filter(
        (l) =>
          /^[-*]\s+\S/.test(l) ||
          /^#{1,6}\s+\S/.test(l) ||
          /\*\*\S/.test(l) ||
          /^\|/.test(l) ||
          /\|\s*-{3,}/.test(l),
      )
    expect(
      leaked,
      `${pdf} prints raw markdown rather than rendering it: ${JSON.stringify(leaked.slice(0, 3))}. ` +
        'Some block fell through to the paragraph branch of scripts/build-agreement-pdf.mjs.',
    ).toEqual([])
  })
})

describe('the attorney-review draft', () => {
  it('still carries the NOT FOR SIGNATURE banner', () => {
    // The draft is the document an attorney has not yet cleared. Anything that
    // removes this banner from the DRAFT is removing the one thing stopping it
    // being sent to a partner as-is. Cutting an execution copy is the
    // sanctioned way to send something — not deleting the banner.
    expect(agreement(DRAFT)).toContain('NOT FOR USE OR SIGNATURE')
  })
})

describe.each(executionCopies())('%s is actually ready to send', (doc) => {
  it('does NOT carry the NOT FOR SIGNATURE banner', () => {
    // The inverse of the draft's check, and not symmetry for its own sake: a
    // copy produced by duplicating the draft starts life with the banner, and a
    // document that says "NOT FOR SIGNATURE" above a signature block is the
    // single worst thing to put in front of a counterparty.
    expect(contractSlice(doc)).not.toContain('NOT FOR USE OR SIGNATURE')
  })

  it('opens with a title, so the signed document says what it is', () => {
    // The file's own `# Shipo LLC — Referral Partner Agreement` sits ABOVE
    // CONTRACT-START, which means it is internal-record furniture and never
    // reaches the counterparty. The rendered execution PDF therefore opened
    // straight into "This Referral Partner Agreement ("Agreement") is entered
    // into as of..." with no heading of any kind — eight pages of numbered
    // clauses and a signature block, under no title.
    //
    // Asserted on the slice rather than the file for exactly that reason: the
    // title outside the markers is the one that was already there while the
    // signed document had none.
    const first = contractSlice(doc).trim().split(/\n{2,}/)[0].trim()
    expect(first, `${doc}: the contract slice does not begin with a markdown heading`).toMatch(
      /^#\s+\S/,
    )
    expect(first.replace(/^#+\s*/, '')).toContain('Referral Partner Agreement')
  })

  it('rules its signature lines in CSS instead of typing underscores', () => {
    // "Signature: _______________________" is a typewriter artifact. It renders
    // as a run of low dashes in a serif face, it cannot align with the label
    // above or below it, and its length is whatever the author happened to
    // hold the key down for. The build script draws these as a border-bottom
    // on a sized box instead, which is what makes the signature block read as
    // a contract rather than a form someone typed in 1994.
    //
    // Scoped to the signature block: a run of underscores is legitimate
    // nowhere else in this document either, but this is the place it came
    // from and the place a copy-paste would put it back.
    const slice = contractSlice(doc)
    const sigs = slice.slice(slice.indexOf('## Signatures'))
    expect(sigs, `${doc}: '## Signatures' not found — cannot bound the block`).not.toBe('')
    const typed = sigs.match(/_{3,}/g) ?? []
    expect(
      typed.length,
      `${doc}: ${typed.length} typed underscore rules in the signature block. ` +
        'The rule is drawn by .sig-line in scripts/build-agreement-pdf.mjs.',
    ).toBe(0)
  })

  it('has no unresolved bracket left in the contract text', () => {
    // The draft's open questions are written as [12], [30], [60], [2],
    // [refund it / have it offset] and [venue: ...]. Each one is a term with no
    // value. Shipped unresolved, the agreement is either ambiguous or absurd —
    // "within [30] days" is not a payment term.
    //
    // Scoped to the contract slice on purpose: the Schedule of Resolved Items
    // quotes those same brackets to record what each one became, so a scan over
    // the whole file would fail on the document that documents the fix.
    const slice = contractSlice(doc)
    const brackets = slice.match(/\[[^\]\n]{1,80}\]/g) ?? []
    // Markdown links are [text](url) and are legitimate. Nothing else is.
    const unresolved = brackets.filter((b) => {
      const at = slice.indexOf(b)
      return slice[at + b.length] !== '('
    })
    expect(unresolved, `unresolved bracketed terms in the contract text: ${unresolved.join(', ')}`)
      .toEqual([])
  })

  it('carries no ATTORNEY NOTE into the contract text', () => {
    // These are internal commentary about what might be wrong with the clause
    // they sit under. In a signed document they are an admission.
    expect(contractSlice(doc)).not.toContain('ATTORNEY NOTE')
  })

  it('still runs the sixty-day clawback that is now the only churn protection', () => {
    // Execution copies only: the draft's 3.9 is deliberately still an open
    // question, so this cannot go in the parameterised block above.
    //
    // Not a restatement of an existing check — nothing else asserts 3.9's
    // substance, and until 2026-10-12 nothing needed to. The 60-day tenure
    // gate used to stop a bonus being paid on a client that signed and left;
    // with it gone, 3.9 is the whole of Shipo's protection. If someone
    // "tidies" 3.9 while clearing out sixty-day references, this is what
    // fails instead of a partner keeping $300 on a client who never stayed.
    const s3 = operativeSection3(doc)
    expect(s3).toContain('3.9 ')
    expect(s3).toContain('by offset against amounts next becoming')
    expect(s3, '3.9 has lost the window the clawback runs on').toContain('sixty (60) days')
  })

  it('has a drafted 3.8, not a note promising one', () => {
    // 3.8 is the clause the draft never wrote: the partner's only record of
    // what it is owed is Shipo's own statement, and without an objection window
    // there is no process for disputing one. The clause-number loop above only
    // proves the heading "3.8" exists — which it also did in the draft, above
    // the words "not yet drafted".
    const s3 = operativeSection3(doc)
    expect(s3).not.toContain('not yet drafted')
    expect(s3).toContain('sixty (60) days')
    expect(s3).toContain('deemed accepted')
    // And that it is an explanation, not an audit right over the books.
    expect(s3).toContain('does not give Partner a right of access')
  })

  it('identifies the counterparty, by name or by fill anchor, never by a blank', () => {
    // The draft's party block is:
    //   - **______________________________** ("Partner"), located at ____________
    // A signable copy that still has it would go out addressed to nobody, and
    // DocuSign would send it without complaint.
    //
    // There are exactly TWO legitimate ways to fill that in, and this check has
    // to accept both or it bites a correct document:
    //
    //   a named copy     - **Acme LLC**, ... with its address at 1 Main St
    //   the template     - **\pname\**, with its address at \paddr\
    //
    // The template has no counterparty ON PURPOSE — that is what makes it one
    // document instead of one per partner. What is never acceptable is the
    // third case, an underscore blank: that is the draft's unfilled state and
    // it is indistinguishable at a glance from a finished document.
    //
    // The scope matters and the first version of this check got it wrong twice.
    // Matching /_{6,}\s*\("Partner"\)/ failed because the real line has "**"
    // between the underscores and the label, so it matched neither the draft nor
    // a reverted copy — a guard that could not fire. Widening it to "no run of
    // underscores anywhere" is the opposite error: the signature block is
    // legitimately full of them. So: the party block only, bounded by the first
    // section heading, and no blank of any kind inside it. That catches a
    // missing address as well as a missing name.
    const slice = contractSlice(doc)
    const partyBlockEnd = slice.indexOf('## 1. Purpose')
    expect(partyBlockEnd, `${doc}: cannot find "## 1. Purpose" to bound the party block`).toBeGreaterThan(-1)
    const partyBlock = slice.slice(0, partyBlockEnd)

    expect(partyBlock, 'the party block still has a blank to fill in').not.toMatch(/_{4,}/)
    expect(partyBlock).toContain('("Partner")')
    expect(partyBlock).toContain('Shipo LLC')

    // Whichever way it is filled, SOMETHING has to stand where the name goes.
    // Without this, the three assertions above all pass on a party block whose
    // Partner line lost its subject — "- **, with its address at" has no blank,
    // has the label, and has Shipo in the line above it.
    const partnerLine = partyBlock
      .split('\n')
      .find((l) => /^\s*-\s/.test(l) && !l.includes('Shipo LLC'))
    expect(partnerLine, `${doc}: no Partner bullet in the party block at all`).toBeTruthy()

    const named = /\*\*(?!\\)[^*\n]{3,}\*\*/.test(partnerLine!)
    const templated = partnerLine!.includes('\\pname\\') && partyBlock.includes('\\paddr\\')
    expect(
      named || templated,
      `${doc}: the party block neither names a partner nor carries the \\pname\\/\\paddr\\ fill anchors`,
    ).toBe(true)
  })

  it('keeps the DocuSign anchor tags for both signers', () => {
    // The envelope positions its tabs by anchor string. Lose these and the
    // signature fields land at the default position, which on a multi-page
    // contract is page 1.
    const slice = contractSlice(doc)
    for (const anchor of ['\\s1\\', '\\n1\\', '\\d1\\', '\\s2\\', '\\n2\\', '\\d2\\']) {
      expect(slice, `DocuSign anchor ${anchor} is missing`).toContain(anchor)
    }
  })

  it('whitens every anchor it uses — the build script knows them all', () => {
    // A DocuSign tab is an OVERLAY; it does not erase the anchor underneath it.
    // So an anchor the renderer does not recognise prints in black ink behind
    // the typed value. The signer anchors were handled from the start because
    // they were the only ones; \pname\ \paddr\ \pemail\ arrived later with the
    // template and the renderer's /[snd][12]/ character class silently did not
    // cover them. This check is the thing that would have said so: every
    // \...\ token in the contract text must be one the script whitens.
    const script = readFileSync(join(process.cwd(), 'scripts', 'build-agreement-pdf.mjs'), 'utf8')
    const known = script.match(/^const ANCHOR = \/(.+)\/g$/m)
    expect(known, 'cannot find the ANCHOR regex in scripts/build-agreement-pdf.mjs').not.toBeNull()
    const recognises = new RegExp(`^${known![1]}$`)

    const used = new Set(contractSlice(doc).match(/\\[A-Za-z][A-Za-z0-9]{0,9}\\/g) ?? [])
    expect(used.size, `${doc}: found no \\...\\ anchors at all`).toBeGreaterThan(0)
    for (const anchor of used) {
      expect(
        recognises.test(anchor),
        `${doc} uses the anchor ${anchor} but build-agreement-pdf.mjs does not whiten it — ` +
          'it will print in black behind the DocuSign tab. Add it to ANCHOR.',
      ).toBe(true)
    }
  })
})
