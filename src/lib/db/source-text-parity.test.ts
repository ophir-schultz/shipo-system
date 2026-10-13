import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// No source file in this repo may contain a NUL byte.
//
// A NUL in a .ts or .tsx compiles and runs perfectly. What it does instead is
// change the file's CLASS: git, `file`, `grep`, and most editors decide a file
// is binary by looking for a NUL, and once they have found one
//
//   - `grep -rn 'unit_rate' src/` reports "Binary file src/... matches" and
//     prints no line, so the file silently stops answering searches;
//   - `git diff` refuses to show the change and prints "Binary files differ",
//     so a review of that file shows nothing to review.
//
// On the money path that is severe out of proportion to the cause. The two
// strongest tools for "where else does this figure come from" both go quiet on
// exactly one file, and nothing announces it -- every gate still passes, because
// every gate is a compiler or a test runner and neither cares.
//
// WHY A TEST AND NOT A NOTE TO BE CAREFUL.
//
// This has now happened three times in one sitting, on one feature, to one
// author: twice in the group-separator expression itself, and once in the
// comment explaining why it must not happen -- that third one was caught by
// this test, on its first run, before it had ever been committed. Every time,
// the separator was MEANT to be the six-character escape sequence and arrived
// as the single byte it denotes. Every time, the cause was invisible at the
// point of writing, because a NUL is zero pixels wide in every editor and in
// every diff.
//
// A convention that depends on noticing an invisible character is not a
// convention. The third occurrence is the evidence, and it is also the reason
// this file asserts on its own tree rather than on a list: the author who most
// needed the check was the one who could not see the problem.
//
// VALID UTF-8 is checked for the same reason rather than as tidiness. This repo
// uses '—' and '…' in operator-facing strings, and a truncated multi-byte
// sequence makes BSD grep call the file binary under LC_CTYPE=C just as a NUL
// does -- the same outage from a different cause, so it belongs in the same
// guard.
//
// Deliberately a whole-tree walk and not a list of known files. The defect is
// "a file nobody is looking at", so a guard that only looks where someone
// already thought to look cannot catch the next one.

const ROOTS = ['src', 'supabase']
const EXTENSIONS = ['.ts', '.tsx', '.sql', '.json', '.css', '.md']

function sourceFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.next') continue
        walk(p)
      } else if (EXTENSIONS.some(e => entry.name.endsWith(e))) {
        out.push(p)
      }
    }
  }
  for (const root of ROOTS) walk(root)
  return out
}

describe('source files stay searchable', () => {
  const files = sourceFiles()

  it('found the tree it is about to judge', () => {
    // A guard on the guard. If the roots move or the extension list goes stale,
    // `files` empties, both assertions below iterate nothing and pass by
    // examining nothing -- the standard failure of a source-scraping test.
    expect(files.length).toBeGreaterThan(100)
    expect(files).toContain(join('src', 'lib', 'billing', 'statement.ts'))
    expect(files).toContain(join('src', 'app', 'statements', 'page.tsx'))
  })

  it('contains no NUL byte', () => {
    // Reported as the list of offending paths rather than as a count, so a
    // regression fails by NAMING the file -- the whole problem with this defect
    // is that the file is hard to find.
    const withNul = files.filter(f => readFileSync(f).includes(0))
    expect(withNul).toEqual([])
  })

  it('is valid UTF-8 throughout', () => {
    // Decoding with fatal:true rather than comparing a re-encode: Node's
    // non-fatal decode substitutes U+FFFD for a bad sequence and would make
    // every file look fine.
    const bad = files.filter(f => {
      try {
        new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(f))
        return false
      } catch {
        return true
      }
    })
    expect(bad).toEqual([])
  })
})
