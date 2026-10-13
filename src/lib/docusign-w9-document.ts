// Page 1 of Form W-9, as base64, for the DocuSign envelope.
//
// SERVER/SCRIPT ONLY. This spawns python3 and reads the filesystem, so it
// must never be imported from a client component — importing it into the
// browser bundle fails the build, which is the loud outcome, but keep it
// out of 'use client' files all the same.
//
// The hash check and the extraction live in one function on purpose. They
// were two steps in a script before, and two steps can be performed in one
// order by one caller and the other order by the next. Every tab position
// in docusign-w9.ts was measured off one specific PDF; against a revised
// form they point at blank paper, and a tab in the wrong place is still a
// valid tab, so nothing downstream would notice. Extraction that cannot
// happen without the check having passed is the only version of this that
// stays true when someone adds a second caller.

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync, rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { W9_PAGE, W9_PDF_SHA256 } from './docusign-w9'

/**
 * Resolved from THIS FILE, not from the shell's cwd — the same reason the
 * test does: a cwd-relative read throws ENOENT when run from anywhere but
 * the repo root, and ENOENT reads as "this is broken" rather than "the W-9
 * changed". The hash guard's whole value is being unmissable, so it must
 * not have a second, louder failure mode people learn to wave away.
 */
export const W9_PDF_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../docs/irs-fw9.pdf',
)

/** Thrown when the PDF on disk is not the one the coordinates describe. */
export class W9HashMismatchError extends Error {
  constructor(expected: string, actual: string) {
    super(
      'docs/irs-fw9.pdf is NOT the file the tab coordinates were measured from.\n' +
        `  expected ${expected}\n  actual   ${actual}\n` +
        'If the IRS revised the form, re-derive the coordinates (see docusign-w9.ts)\n' +
        'and update W9_PDF_SHA256. Refusing to build an envelope against unknown geometry.',
    )
    this.name = 'W9HashMismatchError'
  }
}

/**
 * Verify the W-9 is the file we measured, then return page 1 as base64.
 *
 * Pages 2-6 are IRS instructions. Bolting five pages of them onto an
 * 8-page contract buys nothing but scrolling, so we send one page.
 *
 * Throws rather than degrading. Silently sending all six pages would look
 * like a formatting quibble while actually meaning the signer scrolls past
 * five pages of instructions to reach the tabs.
 *
 * @param pdfPath Override only in tests. Production reads W9_PDF_PATH.
 */
export function extractW9Page1Base64(pdfPath: string = W9_PDF_PATH): string {
  const bytes = readFileSync(pdfPath)
  const actual = createHash('sha256').update(bytes).digest('hex')
  if (actual !== W9_PDF_SHA256) {
    throw new W9HashMismatchError(W9_PDF_SHA256, actual)
  }

  const tmp = mkdtempSync(join(tmpdir(), 'w9-'))
  try {
    const out = join(tmp, 'w9-page1.pdf')
    try {
      execFileSync(
        'python3',
        [
          '-c',
          [
            'import pypdf, sys',
            'r = pypdf.PdfReader(sys.argv[1])',
            'w = pypdf.PdfWriter()',
            `w.add_page(r.pages[${W9_PAGE - 1}])`,
            'w.write(sys.argv[2])',
          ].join('\n'),
          pdfPath,
          out,
        ],
        { stdio: ['ignore', 'ignore', 'pipe'] },
      )
    } catch (e) {
      throw new Error(
        `Could not extract page ${W9_PAGE} of the W-9: ${(e as Error).message}\n` +
          'Needs python3 with pypdf (pip3 install pypdf).',
      )
    }

    const page1 = readFileSync(out)
    // A PdfWriter that wrote nothing useful still leaves a file behind.
    if (page1.length < 1000) {
      throw new Error(`extracted page is implausibly small (${page1.length} bytes)`)
    }
    if (page1.subarray(0, 5).toString('latin1') !== '%PDF-') {
      throw new Error('extracted page is not a PDF')
    }
    return page1.toString('base64')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}
