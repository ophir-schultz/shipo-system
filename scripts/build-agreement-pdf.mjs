#!/usr/bin/env node
// Render a referral-agreement execution copy to a signable PDF.
//
//   node scripts/build-agreement-pdf.mjs docs/referral-agreement-<partner>.md
//   node scripts/build-agreement-pdf.mjs --full docs/referral-agreement-DRAFT-...md
//
// Deliberately has no dependencies. There is no markdown library and no
// puppeteer in this project, and adding either to produce one contract a month
// is not worth the supply chain. Chrome is already on the machine (it rendered
// the existing docs/*.pdf) and the subset of markdown these agreements use is
// small and fixed: headings, bold, paragraphs, bullets, lettered sub-items,
// blockquotes and horizontal rules. No tables — the one table in the source
// file lives in the Schedule, which is outside the contract markers.
//
// TWO THINGS THIS SCRIPT EXISTS TO GET RIGHT:
//
// 1. It renders ONLY the slice between <!-- CONTRACT-START --> and
//    <!-- CONTRACT-END -->. The markdown file is also the internal record of
//    how each open question was resolved: a header note saying the text is not
//    attorney-reviewed, and a Schedule listing every decision an attorney might
//    reopen. Bound into a signed document those read as an admission against
//    interest. Refuses to run if either marker is missing rather than guessing
//    at the boundary.
//
//    --full is the deliberate exception, and it is NOT "skip the checks". The
//    attorney-review draft is the other kind of document: it has no contract
//    markers, and its ATTORNEY NOTE blockquotes and NOT-FOR-SIGNATURE banner
//    are the point of it rather than a leak. So --full inverts the banner rule
//    instead of dropping it — in full mode the banner is REQUIRED, and a file
//    without one is refused. An execution copy therefore cannot be rendered
//    with --full at all, which is what keeps internal commentary out of a
//    signable PDF. The refusals in default mode are untouched.
//
// 2. DocuSign anchor strings (\s1\ \n1\ \d1\ for Shipo, \s2\ \n2\ \d2\ for the
//    partner) are rendered WHITE, not deleted. DocuSign positions signature
//    tabs by searching the PDF's text layer for these strings, so they have to
//    be in the text layer — but a counterparty should not see "\s2\" printed
//    next to the signature line. White text is in the layer and off the page.
//    Deleting them would move every tab to its default position, which on a
//    multi-page contract means page 1.

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const START = '<!-- CONTRACT-START -->'
const END = '<!-- CONTRACT-END -->'
const BANNER = 'NOT FOR USE OR SIGNATURE'

// Every anchor string DocuSign is allowed to position a tab on. Two kinds, and
// both have to be in the text layer and invisible for the same reason:
//
//   signer tabs  \s1\ \n1\ \d1\ (Shipo)  \s2\ \n2\ \d2\ (Partner)
//   fill tabs    \pname\ \paddr\ \pemail\ — sender-filled at send time
//
// The fill tabs are why this is a list and not the old /[snd][12]/ character
// class. The template is partner-agnostic by design: the counterparty's name
// and address are not typed into the file, they are typed into DocuSign. A
// DocuSign tab is an OVERLAY — it does not erase what is underneath it — so an
// anchor left in black ink prints "\pname\" behind the typed company name.
// Add an anchor to the document, add it here, or it ships visible.
const ANCHOR = /\\(s[12]|n[12]|d[12]|pname|paddr|pemail)\\/g

const argv = process.argv.slice(2)
const full = argv.includes('--full')
const src = argv.find((arg) => !arg.startsWith('-'))
if (!src) {
  console.error('usage: node scripts/build-agreement-pdf.mjs [--full] <path-to-agreement.md>')
  process.exit(2)
}

const raw = readFileSync(src, 'utf8')
let body

if (full) {
  // The whole file, commentary included — but only for a document that says on
  // its face that it is not signable. See point 1 in the header.
  if (!raw.includes(BANNER)) {
    console.error(
      `${src}: --full requires the "${BANNER}" banner and this file has none.\n` +
        'Refusing: --full renders internal commentary, so it is only for the attorney-review ' +
        'draft. To render an execution copy, drop --full and use the CONTRACT markers.',
    )
    process.exit(1)
  }
  body = raw.trim()
} else {
  const a = raw.indexOf(START)
  const b = raw.indexOf(END)
  if (a === -1 || b === -1 || b < a) {
    console.error(
      `${src}: missing or inverted CONTRACT-START / CONTRACT-END markers.\n` +
        'Refusing to guess where the contract begins — the text outside those markers is ' +
        'internal and must not reach the counterparty.',
    )
    process.exit(1)
  }
  body = raw.slice(a + START.length, b).trim()

  // Anything in the slice that looks like internal commentary is a bug in the
  // source file, not something to silently render. The test suite checks this too;
  // this is the check that stops a hand-built PDF bypassing the test suite.
  for (const forbidden of ['ATTORNEY NOTE', BANNER, 'Schedule of Resolved Items']) {
    if (body.includes(forbidden)) {
      console.error(`${src}: "${forbidden}" appears inside the contract markers. Refusing to render.`)
      process.exit(1)
    }
  }
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Inline: bold, code spans, then DocuSign anchors. */
function inline(s) {
  const out = esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
  // In the draft the anchors stay VISIBLE. Nothing positions DocuSign tabs off
  // the draft, and its closing note is a sentence ABOUT the anchor strings —
  // "DocuSign anchor tags (\s1\ \n1\ \d1\ signer 1 = Shipo; ...)" — which
  // white-on-white renders as a sentence with holes in it.
  if (full) return out
  return out.replace(ANCHOR, '<span class="anchor">\\$1\\</span>')
}

const blocks = body.split(/\n{2,}/)
const html = []

// The signature section is wrapped in one container that starts a fresh page
// and is forbidden from splitting.
//
// WHY: the first render put page 6 of a 6-page contract at 26 characters —
// "Date: _______________ \d2\" alone, the partner's date line, orphaned past a
// page break. Cosmetically bad, functionally worse: DocuSign anchors its tabs
// to those strings, so the partner's date field would have landed on an
// otherwise blank page after the one they signed. Per-paragraph
// `page-break-inside: avoid` does not help, because the break falls BETWEEN
// paragraphs, not inside one. The fix has to bind to the whole block.
let inSignatures = false

for (const block of blocks) {
  const lines = block.split('\n')
  const first = lines[0].trim()

  if (/^#{1,3}\s/.test(first)) {
    const level = first.match(/^#+/)[0].length
    const title = first.replace(/^#+\s*/, '')
    if (/^Signatures$/i.test(title.trim()) && !inSignatures) {
      html.push('<div class="signatures">')
      inSignatures = true
    }
    html.push(`<h${level}>${inline(title)}</h${level}>`)
    continue
  }
  if (/^-{3,}$/.test(first)) {
    html.push('<hr>')
    continue
  }
  // A blockquote: the NOT-FOR-SIGNATURE banner and the ATTORNEY NOTEs. Only
  // reachable under --full, since in default mode a blockquote is either absent
  // or has already been refused by name. Rendered set off from the clause it
  // sits under, so a reader can tell commentary from contract at a glance —
  // which is the whole job of the draft PDF.
  if (lines.every((l) => l.trimStart().startsWith('>') || l.trim() === '')) {
    const text = lines
      .filter((l) => l.trim())
      .map((l) => l.trimStart().replace(/^>\s?/, ''))
      .join(' ')
    html.push(`<blockquote>${inline(text)}</blockquote>`)
    continue
  }
  // A bullet list. The test is "first line is a bullet", NOT "every line is a
  // bullet": a wrapped item puts its tail on an indented continuation line, so
  // requiring every line to match dropped the whole block through to the <p>
  // branch below, which emits the source verbatim — shipping a literal "- " to
  // the counterparty on page 1 of the signable template. Continuations fold
  // into the preceding <li>.
  if (
    /^\s*-\s/.test(lines[0]) &&
    lines.every((l) => /^\s*-\s/.test(l) || /^\s+\S/.test(l) || l.trim() === '')
  ) {
    const items = []
    for (const l of lines) {
      if (!l.trim()) continue
      if (/^\s*-\s/.test(l)) items.push(l.replace(/^\s*-\s*/, ''))
      else items[items.length - 1] += ' ' + l.trim()
    }
    html.push(`<ul>${items.map((t) => `<li>${inline(t)}</li>`).join('')}</ul>`)
    continue
  }
  // A lettered sub-item block, e.g. "  (a) **freight** — ...". Indented in the
  // source and indented in the output; these are the four Net Profit buckets
  // and the indent is what makes the closed list read as a closed list.
  if (/^\s{2,}\(/.test(lines[0])) {
    html.push(`<div class="sub">${inline(block.replace(/\n\s+/g, ' '))}</div>`)
    continue
  }
  html.push(`<p>${inline(block.replace(/\n/g, ' '))}</p>`)
}

if (inSignatures) html.push('</div>')

const doc = `<!doctype html>
<meta charset="utf-8">
<title>${esc(basename(src, '.md'))}</title>
<style>
  @page { size: letter; margin: 0.9in 0.85in; }
  body { font: 10.5pt/1.5 Georgia, "Times New Roman", serif; color: #111; }
  h1 { font-size: 16pt; margin: 0 0 1.2em; text-align: center; letter-spacing: .01em; }
  h2 { font-size: 11.5pt; margin: 1.6em 0 .5em; page-break-after: avoid; }
  p, .sub, ul { margin: 0 0 .7em; text-align: left; }
  .sub { margin-left: 1.6em; }
  ul { padding-left: 1.3em; }
  li { margin-bottom: .35em; }
  hr { border: 0; border-top: .5pt solid #bbb; margin: 1.4em 0; }
  strong { font-weight: 700; }
  code { font: 9.5pt/1.4 "SF Mono", Menlo, monospace; }
  /* Commentary, visibly not contract. --full only. */
  blockquote {
    margin: .8em 0; padding: .5em .8em;
    border-left: 2.5pt solid #999; background: #f4f4f4;
    font-size: 9.5pt; color: #333; page-break-inside: avoid;
  }
  /* In the text layer, off the page. See the header comment. */
  .anchor { color: #fff; }
  /* The whole signature section on one fresh page, never split. */
  .signatures { break-before: page; break-inside: avoid; page-break-before: always; page-break-inside: avoid; }
  .signatures h2 { margin-top: 0; }
  .signatures p { margin-bottom: 1.1em; }
</style>
${html.join('\n')}
`

const tmp = mkdtempSync(join(tmpdir(), 'agreement-pdf-'))
const htmlPath = join(tmp, 'contract.html')
const out = src.replace(/\.md$/, '.pdf')

try {
  writeFileSync(htmlPath, doc, 'utf8')
  execFileSync(
    CHROME,
    [
      '--headless',
      '--disable-gpu',
      '--no-pdf-header-footer',
      '--run-all-compositor-stages-before-draw',
      '--virtual-time-budget=2000',
      `--print-to-pdf=${out}`,
      `file://${htmlPath}`,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  )
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

console.log(`wrote ${out}`)
