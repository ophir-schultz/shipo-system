import { execFileSync } from 'node:child_process'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  W9_PDF_PATH,
  W9HashMismatchError,
  extractW9Page1Base64,
} from './docusign-w9-document'

// These tests run the real python3 + pypdf path on the real PDF. That is
// the point: the extraction is the one mechanism here that no amount of
// reading the source can verify, because it depends on a tool outside the
// repo being present and behaving. If pypdf is missing, these fail — which
// is correct. A test that skipped itself when the dependency was absent
// would report green on a machine that cannot prepare an envelope at all.

const scratch = mkdtempSync(join(tmpdir(), 'w9-test-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

/** Page count, read back with the same tool that wrote the file. */
function pageCount(pdf: Buffer): number {
  const p = join(scratch, `count-${Math.random().toString(36).slice(2)}.pdf`)
  writeFileSync(p, pdf)
  const out = execFileSync(
    'python3',
    ['-c', 'import pypdf, sys; print(len(pypdf.PdfReader(sys.argv[1]).pages))', p],
    { encoding: 'utf8' },
  )
  return Number(out.trim())
}

describe('extracting page 1 of the W-9', () => {
  const base64 = extractW9Page1Base64()
  const decoded = Buffer.from(base64, 'base64')

  it('returns base64, not bytes', () => {
    // DocuSign wants documentBase64. Handing it a Buffer would serialise
    // as a JSON object of byte values and be rejected far from here.
    expect(typeof base64).toBe('string')
    expect(base64).toMatch(/^[A-Za-z0-9+/]+=*$/)
  })

  it('decodes to a PDF', () => {
    expect(decoded.subarray(0, 5).toString('latin1')).toBe('%PDF-')
  })

  it('is exactly one page', () => {
    // The assertion the whole function exists for. Six pages is a valid
    // PDF and a valid envelope, so only counting catches it.
    expect(pageCount(decoded)).toBe(1)
  })

  it('is smaller than the six-page original', () => {
    // A guard against the extraction quietly returning the input. Same
    // class as the hash control in docusign-w9.test.ts: without it, a
    // function that just read the file through would pass every check
    // above, since the full form is also a PDF whose first bytes are %PDF.
    const original = execFileSync('python3', [
      '-c',
      'import sys, os; print(os.path.getsize(sys.argv[1]))',
      W9_PDF_PATH,
    ])
    expect(decoded.length).toBeLessThan(Number(original.toString().trim()))
  })

  it('the original really is six pages, so "one page" means something', () => {
    // Measures the premise. If the source PDF were already one page, the
    // page-count test above would pass while proving nothing.
    const bytes = execFileSync('python3', [
      '-c',
      'import pypdf, sys; print(len(pypdf.PdfReader(sys.argv[1]).pages))',
      W9_PDF_PATH,
    ])
    expect(Number(bytes.toString().trim())).toBeGreaterThan(1)
  })
})

describe('the hash guard refuses unknown geometry', () => {
  it('throws on a PDF that is not the measured form', () => {
    // The guard that makes every coordinate in docusign-w9.ts trustworthy.
    // Fed a different PDF, it must refuse rather than extract a page the
    // tabs do not describe.
    const other = join(scratch, 'not-the-w9.pdf')
    execFileSync('python3', [
      '-c',
      [
        'import pypdf, sys',
        'w = pypdf.PdfWriter()',
        'w.add_blank_page(width=612, height=792)',
        'w.write(sys.argv[1])',
      ].join('\n'),
      other,
    ])
    expect(() => extractW9Page1Base64(other)).toThrow(W9HashMismatchError)
  })

  it('names both hashes when it refuses', () => {
    // The message has to say what to do next. "Hash mismatch" alone sends
    // the reader to the source to find out which file and which constant.
    const other = join(scratch, 'not-the-w9-2.pdf')
    execFileSync('python3', [
      '-c',
      [
        'import pypdf, sys',
        'w = pypdf.PdfWriter()',
        'w.add_blank_page(width=200, height=200)',
        'w.write(sys.argv[1])',
      ].join('\n'),
      other,
    ])
    let message = ''
    try {
      extractW9Page1Base64(other)
    } catch (e) {
      message = (e as Error).message
    }
    expect(message).toContain('expected')
    expect(message).toContain('actual')
    expect(message).toContain('W9_PDF_SHA256')
  })

  it('accepts the real form, so the guard is not refusing everything', () => {
    // A control. A function that threw unconditionally would pass both
    // tests above.
    expect(() => extractW9Page1Base64()).not.toThrow()
  })
})
