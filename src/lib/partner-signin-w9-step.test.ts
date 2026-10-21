import { describe, expect, it } from 'vitest'
import { w9NextStep } from './partner-signin-w9-step'

// ===========================================================================
// WHAT THE SIGN-IN EMAIL SAYS ABOUT THE W-9, AND WHEN IT SAYS NOTHING
//
// Spec §2.3 asks for the W-9 to follow automatically once the agreement is
// signed. It cannot be an ENVELOPE: the W-9 envelope is embedded — it sets a
// clientUserId and is reachable only through a recipient-view URL minted for
// somebody with a browser open — so an envelope fired by a webhook would be
// addressed to nobody. Worse, there is no w9_envelope_id column and no
// in-flight state, so a webhook-fired envelope plus the dashboard's own CTA
// would be two live W-9s for one person, which is two taxpayer numbers
// collected from a man who already gave us his.
//
// So the automatic part is the PROMPT. The email that carries him into the
// portal the moment he signs also tells him what is waiting there, because
// the alternative is a partner who arrives expecting money and meets a tax
// form nobody warned him about.
//
// AND IT IS SILENT MORE OFTEN THAN IT SPEAKS. Three of the four cases say
// nothing, and the one that matters most is the partner whose tax status
// staff have not recorded: the dashboard form refuses him (partner-w9-sign
// answers "we need to confirm one detail about your account"), so promising
// him a form he cannot open would be sending him to a dead end — Shipo's
// unfinished record-keeping dressed up as his next step. The silence is
// paired with a log, because a condition only staff can fix has to reach
// staff.
// ===========================================================================

const US = { id: 'p1', tax_status: 'us_person', w9_received_at: null }

/** The patterns that would be an invitation to mail us a taxpayer number. */
const SENDS_US_A_TIN = [
  /email (us )?(your|the) (completed |signed )?(w-9|form|ssn|ein|tin)/i,
  /send us (your|the) (w-9|form|ssn|ein|tin)/i,
  /(reply|respond) with (your|the) (w-9|form|ssn|ein|tin)/i,
]

describe('w9NextStep speaks only to a partner who can act on it', () => {
  it('names the W-9, and names the dashboard as where he signs it', () => {
    const { lines, log } = w9NextStep(US)

    for (const body of [lines.text, lines.html]) {
      expect(body).toMatch(/W-9/)
      // Where, not just what. "We need a W-9 from you" with no location is
      // an instruction he cannot carry out, and the obvious guess — reply
      // to this email with the form — is the one thing that must not happen.
      expect(body).toMatch(/dashboard/i)
    }
    // Nobody's bug. He has just signed; the form is simply next.
    expect(log).toBeNull()
  })

  it('says nothing to a partner whose W-9 is already on file', () => {
    // THE WORST SENTENCE THIS FUNCTION COULD PRINT. A partner who has
    // already handed over a taxpayer number, told on his next login that we
    // need one, reasonably concludes the first one was lost — and does it
    // again. That is the "ask him twice" failure the whole webhook exists to
    // prevent.
    const { lines, log } = w9NextStep({ ...US, w9_received_at: '2026-10-20T12:00:00Z' })

    expect(lines.text).toBe('')
    expect(lines.html).toBe('')
    expect(log).toBeNull()
  })

  it('stays silent when no tax status is recorded, and tells staff instead', () => {
    // The dashboard form refuses this partner, so a promise here points him
    // at a locked door. Silence plus a log: he sees the ordinary email, and
    // the column that needs filling reaches somebody who can fill it.
    for (const tax_status of [null, undefined, '', '   ', 'US person']) {
      const { lines, log } = w9NextStep({ ...US, tax_status })

      expect(lines.text).toBe('')
      expect(lines.html).toBe('')
      expect(log).toMatch(/tax_status/)
      // The row, or staff cannot act on it.
      expect(log).toContain('p1')
    }
  })

  it('stays silent for a foreign partner, and names the form that is actually owed', () => {
    // Not a W-9 case at all. Shipo builds no W-8 envelope, so this is work
    // only a human can do, and the log has to say which form — "not a W-9
    // case" sends somebody looking it up.
    const individual = w9NextStep({ ...US, tax_status: 'foreign_individual' })
    expect(individual.lines.text).toBe('')
    expect(individual.log).toMatch(/W-8BEN\b/)

    const entity = w9NextStep({ ...US, tax_status: 'foreign_entity' })
    expect(entity.lines.text).toBe('')
    expect(entity.log).toMatch(/W-8BEN-E/)
  })

  it('never invites the partner to send a taxpayer number to us', () => {
    // The entire point of signing inside DocuSign is that the number never
    // touches our mail, our logs or our database. This email is the first
    // thing he reads about the W-9, so it is the place a wrong instruction
    // would be most readily obeyed.
    const { lines } = w9NextStep(US)

    for (const body of [lines.text, lines.html]) {
      for (const pattern of SENDS_US_A_TIN) expect(body).not.toMatch(pattern)
    }
    // A control, so the patterns above are known to be able to fire at all.
    expect(SENDS_US_A_TIN.some((p) => p.test('Email us your completed W-9.'))).toBe(true)
  })

  it('mentions no money, no client and no figure', () => {
    // Same rule as the rest of this email, and for the same reason: it is
    // delivered before the partner has ever opened the portal, and it
    // travels through infrastructure Shipo does not own. The W-9 is the one
    // subject here that invites a figure, which is why the guard is repeated
    // on this half rather than left to the email's own test.
    const { lines } = w9NextStep(US)

    // Tags stripped before the figure check. Unstripped, `margin:0 0 24px`
    // and `#555` satisfy it, so the guard would be reading the stylesheet
    // and reporting on the sentence.
    for (const body of [lines.text, lines.html.replace(/<[^>]*>/g, '')]) {
      expect(body).not.toMatch(/commission|\$|per order|per unit/i)
      expect(body).not.toMatch(/\d{2,}/)
    }
  })

  it('offers the W-9 step without claiming the code or the link is redundant', () => {
    // The email's existing contract: the 6-digit code is the fallback for
    // every way a link can fail. A W-9 paragraph that read "all you need to
    // do is..." would quietly contradict it.
    const { lines } = w9NextStep(US)
    for (const body of [lines.text, lines.html]) {
      expect(body).not.toMatch(/instead of|no code|all you need/i)
    }
  })
})
