// Static check over the repo's own source bytes: no tracked text file may
// contain a raw NUL (0x00).
//
// WHY THIS EXISTS. src/lib/ledger/migrations.test.ts built its composite Set
// keys with a literal 0x00 byte as the separator between cost_type and variant.
// That one byte made `file` classify the whole 456-line file as "data", and the
// `grep` on the PATH in this environment is ugrep invoked with `-I`, which skips
// any file it considers binary SILENTLY -- exit 1, no "Binary file matches"
// notice. The effect was that a tracked, committed test file was invisible to
// every search in the repo: grepping for readdirSync, ledger_ or cost_rates
// returned nothing at all, which reads exactly like the file does not exist.
// Repaired in 1812c2a by writing the separator as the escape `\x00`.
//
// WHY THIS IS A BYTE CHECK AND NOT A BEHAVIOURAL ONE. `'\x00'` and a raw 0x00
// byte parse to the same one-character string, so nothing observable at runtime
// can distinguish them -- and the inverse mistake is equally quiet: joining and
// splitting on the FOUR literal characters \,x,0,0 round-trips identically too,
// which is why the 44 tests in migrations.test.ts passed both before and after
// the repair and could never have caught this. The difference exists only in the
// bytes on disk. Hence readFileSync here, and no imports of the code under test.
//
// This is a check about ENCODING, never about the choice of character. NUL is a
// legitimate and good separator for a composite key precisely because no real
// value can contain it; see the comment at the call site in migrations.test.ts
// before "simplifying" it to ^, | or ::, which would be a behavioural change to
// a collision check.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * Extensions treated as source text.
 *
 * An ALLOWLIST, not a denylist of binary types. A denylist would cover every new
 * text format for free, but it would also turn red the day someone commits a
 * .woff or a .zip, and a check that cries wolf over a legitimate binary asset is
 * a check that gets deleted. The repo's seven real binaries -- five .pdf, one
 * .jpg, one .ico -- are excluded simply by not appearing here. The cost of the
 * allowlist is that a newly introduced text extension is not covered until it is
 * added, which the instrumentation test below is sized to make noticeable.
 *
 * KNOWN GAP, stated rather than left to be discovered: a dotfile whose whole
 * name is its extension (.gitignore, .vercelignore) matches nothing here and is
 * not scanned. Both are config, neither is grepped for logic, and special-casing
 * them costs more than it buys.
 */
const TEXT_EXT = [
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.sql', '.json', '.md', '.css', '.svg', '.html',
  '.py', '.sh', '.csv', '.txt', '.yml', '.yaml',
]

/**
 * Every tracked file with a text extension, repo-root-relative.
 *
 * SCOPED TO TRACKED FILES ON PURPOSE. Another session is frequently live in this
 * same checkout with untracked work in progress under src/ and scripts/, and a
 * suite that goes red because of somebody else's scratch file is a suite that
 * gets ignored. The invariant worth enforcing is about committed source anyway.
 * Two side benefits: node_modules/ and .next/ need no skip list, and the set is
 * exactly what a reader means by "the repo".
 */
function trackedTextFiles(): string[] {
  let listing: string
  try {
    // -z, because a path containing a space or a newline would otherwise split
    // into two entries and silently shrink the scan.
    listing = execFileSync('git', ['ls-files', '-z'], { maxBuffer: 1 << 26 }).toString('utf8')
  } catch (err) {
    throw new Error(
      'Could not list tracked files with `git ls-files`, so this check cannot '
      + 'tell a clean repo from an unreadable one and refuses to pass either '
      + `way. Run vitest from the repo root. Cause: ${String(err)}`)
  }
  return listing.split('\0').filter(Boolean)
    .filter((f) => TEXT_EXT.some((e) => f.endsWith(e)))
    .sort()
}

const FILES = trackedTextFiles()

/**
 * Describes the raw NUL bytes in a buffer, or null when there are none.
 *
 * Pulled out as a pure function for one reason: a check whose only test data is
 * a clean repo can never be seen to fail. "No offenders" is indistinguishable
 * from "the detector is broken" -- the same sameness problem as a grep that
 * returns no output. Extracting this lets the controls below feed it input that
 * DOES contain NULs, so the empty result in the real scan is a measurement
 * rather than an assumption.
 *
 * `firstLine` counts 0x0a bytes directly instead of decoding the buffer: a file
 * that contains a stray NUL may well not be valid UTF-8 either, and
 * toString('utf8') on it would substitute replacement characters and could shift
 * the offset being reported.
 */
export function nulReport(buf: Buffer): { count: number; firstLine: number } | null {
  const at = buf.indexOf(0)
  if (at < 0) return null

  let firstLine = 1
  for (let i = 0; i < at; i++) if (buf[i] === 0x0a) firstLine++
  let count = 0
  for (let i = 0; i < buf.length; i++) if (buf[i] === 0) count++

  return { count, firstLine }
}

describe('the NUL detector itself', () => {
  // Buffer.from([...]) with a numeric 0, never a literal NUL in this source --
  // this file is scanned by the very check it defines.
  const withNul = (...bytes: number[]) => Buffer.from(bytes)
  const LF = 0x0a
  const A = 0x61

  it('reports a NUL and the line it is on', () => {
    // 'a\n' 'a\n' 'a<NUL>' -- the NUL sits on the third line.
    const r = nulReport(withNul(A, LF, A, LF, A, 0))
    expect(r).toEqual({ count: 1, firstLine: 3 })
  })

  it('counts every NUL but reports only the first line', () => {
    const r = nulReport(withNul(0, LF, 0, LF, 0))
    expect(r).toEqual({ count: 3, firstLine: 1 })
  })

  it('returns null for clean ASCII', () => {
    // The negative control. Without it, a detector hard-coded to report a hit
    // would pass both tests above and fail the whole repo scan loudly -- but a
    // detector that reported a hit only sometimes would not be caught at all.
    expect(nulReport(Buffer.from('const x = 1\n// ordinary source\n', 'utf8'))).toBeNull()
  })

  it('fires on a real NUL-bearing file in this repo', () => {
    // Positive control on REAL data, not a hand-made buffer. src/app/favicon.ico
    // is tracked and genuinely full of NULs, which is exactly why the allowlist
    // above excludes .ico from the scan. This proves the detector works on a
    // file read off disk -- the thing the scan below actually does -- and not
    // merely on bytes assembled in memory.
    //
    // If the favicon is ever deleted or replaced with an SVG, this fails and
    // asks to be repointed at another binary rather than silently losing the
    // only real-data control in the file.
    const r = nulReport(readFileSync('src/app/favicon.ico'))
    expect(r, 'src/app/favicon.ico no longer contains NUL bytes -- repoint this '
      + 'control at another tracked binary (public/shipo-logo.jpg, or any of '
      + 'the docs/*.pdf) so the detector keeps being exercised on real data')
      .not.toBeNull()
    expect(r!.count).toBeGreaterThan(0)
  })
})

describe('tracked source files contain no raw NUL bytes', () => {
  it('finds the source files it is meant to check', () => {
    // Not `> 0`, and not an exact number either. The repo tracks roughly 310
    // text files; a listing that returned a handful -- a wrong cwd, a typo in
    // TEXT_EXT, a git that printed nothing -- would make the scan below pass by
    // iterating almost nothing, which is the vacuous pass this repo's tests keep
    // warning about. 200 is low enough not to need editing on ordinary growth
    // and high enough that a broken listing cannot clear it.
    expect(FILES.length).toBeGreaterThanOrEqual(200)

    // The file that actually regressed, named explicitly: if it is moved or
    // renamed, this line failing is the correct outcome, rather than the file
    // quietly dropping out of the scan that exists because of it.
    expect(FILES).toContain('src/lib/ledger/migrations.test.ts')

    // This file too -- the check covers itself, so a NUL pasted into the very
    // test that forbids NULs is still caught.
    expect(FILES).toContain('src/lib/source-encoding.test.ts')

    // Two different extensions, so an allowlist that had decayed to .ts only
    // would not look healthy on the count alone.
    expect(FILES.some((f) => f.endsWith('.sql')), 'no .sql file in the scan').toBe(true)
    expect(FILES.some((f) => f.endsWith('.tsx')), 'no .tsx file in the scan').toBe(true)
  })

  // ONE test over all ~310 files rather than one test per file, unlike the
  // per-file pattern in migrations.test.ts. That pattern is right for the 8
  // migrations and 5 verify scripts; at 310 it would triple the suite's test
  // count and slow collection for no extra information, since the failure
  // message below already names every offender and where to look.
  it('no tracked text file contains a raw 0x00 byte', () => {
    const offenders: string[] = []

    for (const f of FILES) {
      let buf: Buffer
      try {
        buf = readFileSync(f)
      } catch {
        // Tracked but absent from the working tree -- mid-rebase, or deleted and
        // not yet committed. Not this check's business.
        continue
      }

      // The same function the four controls above exercise, so an empty
      // offender list here is backed by evidence that this code path is able to
      // report one.
      const found = nulReport(buf)
      if (found === null) continue

      offenders.push(
        `${f} (${found.count} NUL byte(s), first on line ${found.firstLine})`)
    }

    // The message carries the remedy, because the person who hits this is
    // probably pasting a delimiter and has no reason to know about ugrep's -I.
    expect(offenders, `${offenders.length} tracked source file(s) contain a raw `
      + `NUL byte: ${offenders.join('; ')}. A single 0x00 makes \`file\` report `
      + 'the file as "data", and the grep on the PATH here is ugrep with `-I`, '
      + 'which then skips the whole file SILENTLY -- exit 1, no "Binary file '
      + 'matches" notice -- so every line of it becomes invisible to search and '
      + 'reads as though the file does not exist. Write the byte as the escape '
      + '\\x00 instead: it parses to the identical character, so no behaviour '
      + 'changes and the file stays greppable. Do NOT swap the character itself '
      + 'for ^, | or :: -- where it separates the parts of a composite key, that '
      + 'is a behavioural change to a collision check, not a cleanup.')
      .toEqual([])
  })
})
