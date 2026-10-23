import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Two facts about W9Prompt's window.open call that are invisible to every
 * other test in the suite, because partner-signing-window.test.ts is handed
 * a fake window and can therefore never find out how the real one is made.
 *
 * 1. NO `noopener`. Per the HTML spec window.open returns null whenever the
 *    window is opened with noopener. Add the flag a reviewer would
 *    reflexively ask for and the handle is null on every browser, every
 *    open reads as "popup blocked", and the feature silently degrades to
 *    the same-tab navigation it replaced — with all 13 unit tests still
 *    green, because they never touch this file.
 *
 * 2. OPENED BEFORE THE AWAIT. A popup opened after an await is not
 *    attributable to the click and really is blocked. Order is the whole
 *    mechanism, and it is one line away from being wrong.
 *
 * Both are read off the SOURCE because both are properties of how the call
 * is written, not of what it returns. Comments are stripped first: the
 * explanation above the call names `noopener` twice, so an unstripped grep
 * would be satisfied by the prose warning against it.
 */

const SRC = join(__dirname, 'W9Prompt.tsx')

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

/** The window.open(...) call's own text, or null if there is none. */
function openCall(code: string): string | null {
  return code.match(/window\.open\([^)]*\)/)?.[0] ?? null
}

function namesNoopener(code: string): boolean {
  return /noopener|noreferrer/.test(code)
}

describe('W9Prompt popup wiring', () => {
  const code = stripComments(readFileSync(SRC, 'utf8'))

  it('opens a window', () => {
    expect(openCall(code)).not.toBeNull()
  })

  it('does not pass noopener, which would make window.open return null', () => {
    expect(namesNoopener(openCall(code)!)).toBe(false)
  })

  it('opens the window before the first await, not after', () => {
    const open = code.indexOf('window.open(')
    const firstAwait = code.indexOf('await ')

    expect(open).toBeGreaterThan(-1)
    expect(firstAwait).toBeGreaterThan(-1)
    expect(open).toBeLessThan(firstAwait)
  })

  it('closes the blank window on both failure paths', () => {
    // Two: the bad-response return, and the catch. One of them alone
    // leaves an orphan blank popup next to an error message.
    expect(code.match(/abandonSigningWindow\(/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
  })

  // ---- controls: the detectors above must be able to report a problem ----

  it('detects noopener when it IS present (control)', () => {
    expect(namesNoopener(openCall(`const w = window.open('', '_blank', 'noopener')`)!)).toBe(true)
  })

  it('reports no call when there is none (control)', () => {
    expect(openCall('const w = null')).toBeNull()
  })

  // Without stripping, the real file's own explanatory comment satisfies
  // the noopener grep. This asserts the stripping is what makes the check
  // above mean anything.
  it('strips block comments, which the noopener check depends on (control)', () => {
    expect(namesNoopener(stripComments('/* explains noopener */ ok'))).toBe(false)
  })

  it('strips line comments too (control)', () => {
    expect(namesNoopener(stripComments('  // never pass noopener here\nok'))).toBe(false)
  })
})
