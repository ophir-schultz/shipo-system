import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  W9_CLASSIFICATIONS,
  W9_PAGE,
  W9_PAGE_HEIGHT,
  W9_PAGE_WIDTH,
  W9_PDF_SHA256,
  W9_REQUESTER_BOX,
  W9_TEXT_FIELDS,
  W9_TIN_EIN,
  W9_TIN_SSN,
  type W9Box,
} from './docusign-w9'

describe('the coordinates still describe the form they were measured from', () => {
  // This is the guard the whole file depends on. Every number in
  // docusign-w9.ts was read off one specific PDF. If the IRS revises
  // Form W-9 and someone drops the new file in, those numbers go on
  // looking perfectly reasonable while pointing at blank paper — and
  // nothing else in the system would notice, because a tab in the wrong
  // place is still a valid tab.
  //
  // Hashing the file is what makes a revision loud. It is a cruder check
  // than re-deriving the rectangles, and deliberately so: re-deriving
  // needs a PDF parser in the test runtime, and a guard that quietly
  // skips itself when the parser is missing is worse than no guard,
  // because it reports green.
  it('docs/irs-fw9.pdf is byte-for-byte the file the tabs were placed on', () => {
    const actual = createHash('sha256').update(readFileSync('docs/irs-fw9.pdf')).digest('hex')
    expect(actual).toBe(W9_PDF_SHA256)
  })

  it('the hash would actually change if the file did', () => {
    // A control. Without it, a bug that hashed a constant rather than the
    // file would pass the test above forever.
    const a = createHash('sha256').update(readFileSync('docs/irs-fw9.pdf')).digest('hex')
    const b = createHash('sha256').update('not the W-9').digest('hex')
    expect(a).not.toBe(b)
  })
})

describe('every box lands on the page', () => {
  const boxes: [string, W9Box][] = [
    ...W9_TEXT_FIELDS.map((f) => [f.acroform, f] as [string, W9Box]),
    ...W9_CLASSIFICATIONS.map((c) => [`classification:${c.value}`, c] as [string, W9Box]),
    ['tin:ssn', W9_TIN_SSN],
    ['tin:ein', W9_TIN_EIN],
    ['requester', W9_REQUESTER_BOX],
  ]

  it('has boxes to check', () => {
    // Measures the list itself. A loop over an empty array passes by
    // examining nothing, which is the failure mode of every table-driven
    // test that has ever gone green for the wrong reason.
    expect(boxes.length).toBeGreaterThan(15)
  })

  for (const [name, box] of boxes) {
    it(`${name} is inside the printable page`, () => {
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.y).toBeGreaterThanOrEqual(0)
      expect(box.x + box.w).toBeLessThanOrEqual(W9_PAGE_WIDTH)
      expect(box.y + box.h).toBeLessThanOrEqual(W9_PAGE_HEIGHT)
      expect(box.w).toBeGreaterThan(0)
      expect(box.h).toBeGreaterThan(0)
    })
  }
})

describe('the TIN rows', () => {
  it('do not overlap each other', () => {
    // They are an either/or presented as two rows. If the rectangles
    // collided, a partner typing an EIN would be typing into the SSN
    // box, and we would file a 1099 against a number of the wrong kind.
    const ssnBottom = W9_TIN_SSN.y + W9_TIN_SSN.h
    expect(ssnBottom).toBeLessThanOrEqual(W9_TIN_EIN.y)
  })

  it('are one tab per row, not one per printed cell', () => {
    // The SSN is printed as three cells and the EIN as two. Spanning
    // them means "filled" is a whole number rather than a fragment —
    // see the note in docusign-w9.ts. If someone re-splits these into
    // five boxes, the group rule silently weakens to "type three
    // digits", so the spans are asserted rather than assumed.
    expect(W9_TIN_SSN.w).toBeGreaterThan(100)
    expect(W9_TIN_EIN.w).toBeGreaterThan(100)
  })

  it('sit in the right-hand column where Part I is printed', () => {
    expect(W9_TIN_SSN.x).toBeGreaterThan(W9_PAGE_WIDTH / 2)
    expect(W9_TIN_EIN.x).toBeGreaterThan(W9_PAGE_WIDTH / 2)
  })
})

describe('what the partner must fill', () => {
  it('requires the name and the address, and nothing optional', () => {
    // Named explicitly. A test that merely counted required fields would
    // stay green if the required one changed identity.
    const required = W9_TEXT_FIELDS.filter((f) => f.required).map((f) => f.acroform).sort()
    expect(required).toEqual(['f1_01', 'f1_07', 'f1_08'])
  })

  it('leaves the genuinely optional lines optional', () => {
    // Exempt payee and FATCA codes apply to almost nobody. Marking them
    // required would make the envelope uncompletable for every ordinary
    // partner — the same class of error as requiring both TIN rows.
    const optional = W9_TEXT_FIELDS.filter((f) => !f.required).map((f) => f.acroform)
    expect(optional).toContain('f1_05')
    expect(optional).toContain('f1_06')
    expect(optional).toContain('f1_02')
  })

  it('offers all seven tax classifications', () => {
    expect(W9_CLASSIFICATIONS).toHaveLength(7)
    const values = W9_CLASSIFICATIONS.map((c) => c.value)
    expect(values).toContain('individual')
    expect(values).toContain('llc')
    expect(values).toContain('other')
    expect(new Set(values).size).toBe(7)
  })

  it('does not ask the partner for the requester block', () => {
    // f1_09 is the REQUESTER's name and address — ours. It must not
    // appear among the fields the partner is handed.
    expect(W9_TEXT_FIELDS.map((f) => f.acroform)).not.toContain('f1_09')
  })

  it('does not ask for the TIN as a plain text field', () => {
    // The TIN is handled by the group, not by W9_TEXT_FIELDS. A stray
    // f1_11..f1_15 here would be an unrequired, ungrouped tax number box.
    const names = W9_TEXT_FIELDS.map((f) => f.acroform)
    for (const n of ['f1_11', 'f1_12', 'f1_13', 'f1_14', 'f1_15']) {
      expect(names).not.toContain(n)
    }
  })
})

describe('page selection', () => {
  it('sends page 1 only', () => {
    // The form is 6 pages; 2-6 are IRS instructions. Changing this to
    // send all six is harmless legally and awful in practice, so it is
    // recorded as a decision rather than left as a magic 1.
    expect(W9_PAGE).toBe(1)
  })

  it('assumes US Letter', () => {
    expect(W9_PAGE_WIDTH).toBe(612)
    expect(W9_PAGE_HEIGHT).toBe(792)
  })
})
