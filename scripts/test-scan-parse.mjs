// Exercises src/lib/scan/parse.ts as it actually ships — this imports the
// same module the /scan page loads, so a regression in the shipping file
// fails here rather than passing against a retyped copy.
//
//   node scripts/test-scan-parse.mjs
//
// Node strips the TypeScript natively; there is no build step.

import { parseScan, duplicatesWithin } from '../src/lib/scan/parse.ts'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

let failures = 0
function check(label, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected)
  if (!pass) failures++
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}`)
  if (!pass) {
    console.log(`        got      ${JSON.stringify(actual)}`)
    console.log(`        expected ${JSON.stringify(expected)}`)
  }
}

const twenty = Array.from({ length: 20 }, (_, i) => 'IMEI' + String(860000000000000 + i))

const serialsOf = (raw, perBox) => parseScan(raw, perBox).serials
const methodOf = (raw, perBox) => parseScan(raw, perBox).method

// --- separator formats, all must yield the same 20 serials ---
check('newline separated', serialsOf(twenty.join('\n'), 20), twenty)
check('CRLF separated', serialsOf(twenty.join('\r\n'), 20), twenty)
check('comma separated', serialsOf(twenty.join(','), 20), twenty)
check('pipe separated', serialsOf(twenty.join('|'), 20), twenty)
check('semicolon separated', serialsOf(twenty.join(';'), 20), twenty)
check('tab separated', serialsOf(twenty.join('\t'), 20), twenty)
check('GS1 group separator', serialsOf(twenty.join('\x1d'), 20), twenty)
check('record separator', serialsOf(twenty.join('\x1e'), 20), twenty)
check('double-space separated', serialsOf(twenty.join('  '), 20), twenty)

// --- method labels ---
check('newline method label', methodOf(twenty.join('\n'), 20), 'newline')
check('GS1 method label', methodOf(twenty.join('\x1d'), 20), 'group-separator')

// --- JSON shapes ---
check('JSON array of strings', serialsOf(JSON.stringify(twenty), 20), twenty)
check('JSON array of objects',
  serialsOf(JSON.stringify(twenty.map((s) => ({ serial: s }))), 20), twenty)
check('JSON object with serials key',
  serialsOf(JSON.stringify({ box: 'B1', serials: twenty }), 20), twenty)
check('JSON method label', methodOf(JSON.stringify(twenty), 20), 'json')

// --- hygiene ---
check('trailing separator ignored', serialsOf(twenty.join(',') + ',', 20), twenty)
check('padding trimmed', serialsOf(' A1 , B2 , C3 ', 3), ['A1', 'B2', 'C3'])
check('blank entries dropped', serialsOf('A1,,B2,,C3', 3), ['A1', 'B2', 'C3'])

// --- fixed width, no separator at all ---
const fixed = twenty.map((s) => s.slice(0, 10))          // uniform 10-char serials
check('fixed width split', serialsOf(fixed.join(''), 20), fixed)
check('fixed width is flagged as a guess', parseScan(fixed.join(''), 20).guess, true)
check('fixed width method label', methodOf(fixed.join(''), 20), 'fixed-width(10)')
// A guess must never be silent. Everything else must never claim to be one.
check('a real separator is not flagged as a guess',
  parseScan(twenty.join('\n'), 20).guess, undefined)

// --- single serial must NOT be split ---
check('single serial stays whole', serialsOf('IMEI860000000000001', 1), ['IMEI860000000000001'])
check('single serial method', methodOf('IMEI860000000000001', 1), 'single')

// A 18-char payload can't divide by 20, so it must stay a single serial
// rather than being chopped into nonsense.
check('indivisible payload not chopped', serialsOf('SHORTSERIAL1234567', 20), ['SHORTSERIAL1234567'])

// Without an expected count there is nothing to divide by, so the
// fixed-width rescue must not fire at all.
check('no perBox means no fixed-width guess', methodOf(fixed.join('')), 'single')

check('empty scan yields nothing', serialsOf('   ', 20), [])
check('empty scan method', methodOf('', 20), 'empty')

// Separator precedence: newline wins over a comma that is part of the data.
check('newline beats embedded comma',
  serialsOf('A,1\nB,2\nC,3', 3), ['A,1', 'B,2', 'C,3'])

// --- duplicate detection ---
// A serial twice in one scan is always an error — double-read or bad split.
// The database rejects it too; this exists so the operator sees WHICH one.
check('duplicates found', duplicatesWithin(['A', 'B', 'A', 'C', 'B']).sort(), ['A', 'B'])
check('no duplicates in a clean scan', duplicatesWithin(twenty), [])

// --- the scan field must be a textarea ---
// <input type=text> silently strips newlines (HTML value sanitization), which
// destroys the likeliest separator before parseScan ever sees it — and the
// fixed-width fallback then "rescues" it into plausible but wrong serials.
const page = readFileSync(join(here, '../src/app/scan/page.tsx'), 'utf8')
const scanTag = (page.match(/<(\w+)[^>]*\bid="scan"/) || [])[1]
check('scan field is a textarea, not an input', scanTag, 'textarea')

console.log(failures === 0 ? '\nall parser tests passed' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
