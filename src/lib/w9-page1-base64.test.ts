import { describe, expect, it } from 'vitest'
import { W9_PAGE1_BASE64 } from './w9-page1-base64'
import { extractW9Page1Base64 } from './docusign-w9-document'

/**
 * The guard on a committed copy of a derived value.
 *
 * w9-page1-base64.ts exists because the runtime cannot derive the bytes —
 * extraction spawns python3 and reads docs/irs-fw9.pdf, and a serverless
 * function has neither. A committed cache of a derived value is the
 * classic way to end up serving a stale one, and stale here means the tab
 * coordinates in docusign-w9.ts point at a different page's blank space.
 * A tab in the wrong place is still a valid tab, so nothing downstream
 * would notice: DocuSign would happily collect a signature in the margin.
 *
 * This test is what makes "regenerate it" a build failure rather than
 * something somebody has to remember.
 */
describe('the committed W-9 page 1', () => {
  it('is byte-identical to what the extractor produces from the PDF', () => {
    expect(W9_PAGE1_BASE64).toBe(extractW9Page1Base64())
  })

  it('is a non-trivial, well-formed base64 PDF', () => {
    // A positive control on the comparison above: if both sides became
    // empty strings — a plausible outcome of a broken generator — the
    // first assertion would pass.
    expect(W9_PAGE1_BASE64.length).toBeGreaterThan(10_000)
    expect(W9_PAGE1_BASE64).toMatch(/^[A-Za-z0-9+/]+=*$/)
    expect(Buffer.from(W9_PAGE1_BASE64, 'base64').subarray(0, 5).toString('latin1')).toBe('%PDF-')
  })
})
