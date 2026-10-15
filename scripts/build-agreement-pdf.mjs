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

import { readFileSync, writeFileSync, mkdtempSync, rmSync, statSync, existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, basename, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

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
// Writes the intermediate HTML beside the PDF instead of into a temp dir
// that is deleted on exit. The typography lives in the <style> block
// below, so changing how this document LOOKS means looking at it — and a
// browser renders the HTML in a second where a PDF has to be rasterised.
// Output only; it changes nothing about the PDF.
const keepHtml = argv.includes('--keep-html')
const src = argv.find((arg) => !arg.startsWith('-'))
if (!src) {
  console.error(
    'usage: node scripts/build-agreement-pdf.mjs [--full] [--keep-html] <path-to-agreement.md>',
  )
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
  // Inside the signature block only, "Label: value" is a ruled line rather
  // than a paragraph.
  //
  // The source used to type its own rules — "Signature: ___________________"
  // — which is a typewriter artifact: a run of low dashes in a serif face,
  // its length set by how long someone held the key, and impossible to align
  // with the row above or below because the label and the rule are one run of
  // text. Drawing the rule as a border on a sized box makes the four rows line
  // up and lets Date and Title be short without the author counting
  // underscores. referral-agreement-terms.test.ts refuses the typed form.
  //
  // The anchor rides INSIDE the ruled box, so the DocuSign tab lands on the
  // line instead of after it. Every anchor coordinate therefore moves when
  // this renders — the template has to be re-uploaded and the tabs re-measured
  // against the new document, which is true of any change to this file.
  const sigRow = inSignatures && lines.length === 1
    ? first.match(/^(Signature|Name|Title|Date):\s*(.*)$/)
    : null
  if (sigRow) {
    // Date and Title take real-world-short values; a rule running the full
    // measure for a six-character date reads as an unfilled form.
    const narrow = /^(Date|Title)$/.test(sigRow[1]) ? ' sig-row-narrow' : ''
    html.push(
      `<div class="sig-row${narrow}">` +
        // The colon is part of the label and must survive into the text
        // layer: the drift guard compares "Name:OphirSchultz\\n1\\" from the
        // markdown against what the PDF actually says, and dropping it read as
        // a stale render. Which is what that guard is for.
        `<span class="sig-label">${esc(sigRow[1])}:</span>` +
        `<span class="sig-line">${inline(sigRow[2])}</span>` +
        '</div>',
    )
    continue
  }
  // The party each signature column belongs to: "**Shipo LLC**",
  // "**Partner — \pname\**". A <p><strong> is the wrong element — it inherits
  // paragraph spacing and justification and reads as prose above the rows it
  // actually labels.
  if (inSignatures && lines.length === 1 && /^\*\*.+\*\*$/.test(first)) {
    html.push(`<p class="sig-party">${inline(first)}</p>`)
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

// NOTHING HERE MAY USE text-transform OR font-variant: small-caps.
//
// Uppercase section headings are the obvious way to make this look like a
// contract, and they would break the drift guard silently. Chrome writes the
// RENDERED glyphs into the PDF text layer, so a heading uppercased in CSS
// reaches referral-agreement-terms.test.ts as "3.QUALIFICATION&COMPENSATION"
// while the markdown it is compared against says "3.Qualification&Compensation".
// That guard's flatten() folds ligatures, quotes, dashes and whitespace — it
// does NOT fold case, deliberately, because case is meaning in a contract. The
// failure would read as "the PDF is a stale render", which is the one thing it
// is not. Weight, size, letter-spacing and rules do the same job and leave the
// text layer alone.
const doc = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>${esc(basename(src, '.md'))}</title>
<style>
  @page { size: letter; margin: 1in 1in 0.95in; }

  body {
    font: 11pt/1.62 Georgia, "Times New Roman", serif;
    color: #1a1a1a;
    text-rendering: optimizeLegibility;
    hyphens: auto;
    -webkit-hyphens: auto;
  }

  /* The title. The execution copy had none: this file's own '# Shipo LLC —
     Referral Partner Agreement' sits ABOVE the CONTRACT-START marker, so it is
     internal furniture and never rendered. Eight pages of numbered clauses and
     a signature block went out under no heading at all. */
  h1 {
    font-size: 17pt;
    font-weight: 400;
    letter-spacing: .08em;
    text-align: center;
    margin: 0 0 1.7em;
    padding-bottom: .5em;
    border-bottom: 1.25pt solid #222;
  }

  h2 {
    font-size: 11pt;
    font-weight: 700;
    letter-spacing: .04em;
    margin: 1.9em 0 .6em;
    padding-bottom: .22em;
    border-bottom: .5pt solid #d4d4d4;
    page-break-after: avoid;
    break-after: avoid;
  }
  h3 {
    font-size: 10.5pt; font-weight: 700; margin: 1.35em 0 .4em;
    page-break-after: avoid; break-after: avoid;
  }

  p, .sub, ul { margin: 0 0 .8em; }
  p, li, .sub { text-align: justify; }
  .sub { margin-left: 1.8em; }
  ul { padding-left: 1.5em; }
  li { margin-bottom: .4em; }
  li::marker { color: #777; }
  /* A clause heading should never be the last line on a page, and a single
     line of a paragraph should not be stranded on its own. */
  p, li { orphans: 2; widows: 2; }

  hr { border: 0; border-top: .5pt solid #c9c9c9; margin: 1.9em 0; }
  strong { font-weight: 700; }
  code { font: 9.5pt/1.4 "SF Mono", Menlo, monospace; }

  /* Commentary, visibly not contract. --full only. */
  blockquote {
    margin: 1em 0; padding: .6em .9em;
    border-left: 2pt solid #9a9a9a; background: #f6f6f4;
    font-size: 9.5pt; line-height: 1.5; color: #333;
    page-break-inside: avoid; text-align: left;
  }

  /* In the text layer, off the page. See the header comment. */
  .anchor { color: #fff; }

  /* The whole signature section on one fresh page, never split. */
  .signatures { break-before: page; break-inside: avoid; page-break-before: always; page-break-inside: avoid; }
  .signatures h2 { margin-top: 0; }

  .sig-party {
    margin: 2em 0 1em;
    font-weight: 700;
    letter-spacing: .03em;
    text-align: left;
  }
  .signatures .sig-party:first-of-type { margin-top: 1.3em; }

  /* label | ruled box. The rule is a border, not typed underscores, so the
     four rows of a party block share one left edge and one right edge. */
  .sig-row {
    display: flex;
    align-items: baseline;
    gap: .55em;
    width: 76%;
    margin: 0 0 1.25em;
    page-break-inside: avoid;
  }
  .sig-row-narrow { width: 46%; }
  .sig-label { flex: 0 0 4.4em; font-size: 10pt; color: #444; }
  .sig-line {
    flex: 1 1 auto;
    min-height: 1.3em;
    border-bottom: .75pt solid #333;
    padding-bottom: .18em;
  }
</style>
${html.join('\n')}
`

/**
 * The page footer. Chrome substitutes .pageNumber and .totalPages itself, so
 * the count stays correct when the document grows a page — which is the whole
 * reason to let it number the pages rather than counting them here.
 *
 * The inline font-size is required, not stylistic: header and footer templates
 * are rendered as separate documents that inherit none of the page's CSS, and
 * Chrome's default for them computes to a size that reads as a smudge. The
 * horizontal padding keeps the number off the paper's edge; the template spans
 * the full sheet, not the text measure.
 */
const FOOTER = `<div style="width:100%;padding:0 0.75in;box-sizing:border-box;
  font-family:Georgia,'Times New Roman',serif;font-size:8.5pt;color:#666;text-align:center;">
  Page <span class="pageNumber"></span> of <span class="totalPages"></span>
</div>`

/** Reject if `p` has not settled within `ms`, naming what was being waited on. */
function withTimeout(p, ms, what) {
  return Promise.race([
    p,
    sleep(ms).then(() => {
      throw new Error(`timed out after ${ms}ms waiting for ${what}`)
    }),
  ])
}

/**
 * Render `htmlPath` to a PDF at `out`, driving Chrome over the DevTools
 * Protocol instead of the --print-to-pdf command line.
 *
 * The reason is page numbers, and the CLI cannot do them. Its footer has two
 * settings: Chrome's default furniture, which prints the source URL across the
 * bottom of every page — here a path inside /var/folders — or nothing at all
 * via --no-pdf-header-footer. There is no flag for a footer you control. CSS
 * cannot supply one either: headless Chrome does not implement @page margin
 * boxes, so `@bottom-center { content: counter(page) }` renders nothing.
 * Page.printToPDF takes a footerTemplate, which is the supported way to do
 * this and needs no dependency — Node has had a WebSocket client since 22.
 *
 * Page SIZE and MARGINS still come from the stylesheet's @page rule
 * (preferCSSPageSize, and no margin params below), so the measure stays defined
 * in one place next to the typography it belongs to.
 */
async function printToPdf(htmlPath, out, profileDir) {
  const chrome = spawn(
    CHROME,
    [
      '--headless',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      // Port 0 means "choose a free one and tell me". A fixed port collides
      // with a sibling build, and the collision is silent: the second Chrome
      // fails to bind and the first one's socket answers instead, so the wrong
      // process renders the document.
      '--remote-debugging-port=0',
      // A private profile per run. Without it every invocation shares the
      // default user-data-dir, and a second Chrome started while another still
      // holds that profile's lock exits 0 having done NOTHING.
      `--user-data-dir=${profileDir}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  )

  let stderr = ''
  chrome.stderr.on('data', (b) => {
    stderr += b
  })

  let ws
  try {
    // Chrome writes the port it actually bound to into the profile directory
    // once the socket is listening. Polling for that file is how you learn the
    // port when you asked for 0, and it doubles as "Chrome is up".
    const portFile = join(profileDir, 'DevToolsActivePort')
    let port
    for (let i = 0; i < 200 && port === undefined; i++) {
      if (chrome.exitCode !== null) {
        throw new Error(`Chrome exited (${chrome.exitCode}) before listening.\n${stderr.trim()}`)
      }
      if (existsSync(portFile)) {
        const first = readFileSync(portFile, 'utf8').split('\n')[0].trim()
        if (first) port = Number(first)
      }
      if (port === undefined) await sleep(50)
    }
    if (!port) throw new Error(`Chrome never reported a debugging port.\n${stderr.trim()}`)

    const targets = await withTimeout(
      fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json()),
      10_000,
      'the DevTools target list',
    )
    const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
    if (!page) throw new Error('Chrome is listening but exposes no page target to print')

    ws = new WebSocket(page.webSocketDebuggerUrl)
    await withTimeout(
      new Promise((res, rej) => {
        ws.onopen = res
        ws.onerror = () => rej(new Error('the DevTools socket refused the connection'))
      }),
      10_000,
      'the DevTools socket',
    )

    let nextId = 0
    const pending = new Map()
    const waiters = new Map()
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id !== undefined) {
        const p = pending.get(msg.id)
        pending.delete(msg.id)
        if (!p) return
        if (msg.error) p.reject(new Error(`${msg.error.message} (${msg.error.code})`))
        else p.resolve(msg.result)
        return
      }
      const list = waiters.get(msg.method)
      if (!list) return
      waiters.delete(msg.method)
      for (const resolve of list) resolve(msg.params)
    }

    const send = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = ++nextId
        pending.set(id, { resolve, reject })
        ws.send(JSON.stringify({ id, method, params }))
      })
    const once = (method) =>
      new Promise((resolve) => waiters.set(method, [...(waiters.get(method) ?? []), resolve]))

    await send('Page.enable')
    // Subscribed BEFORE navigating: a document this small can finish loading
    // between the two calls, and a listener attached afterwards waits forever
    // for an event that already fired.
    const loaded = once('Page.loadEventFired')
    const nav = await send('Page.navigate', { url: `file://${resolve(htmlPath)}` })
    if (nav.errorText) throw new Error(`could not load ${htmlPath}: ${nav.errorText}`)
    await withTimeout(loaded, 30_000, 'the page to finish loading')

    const { data } = await withTimeout(
      send('Page.printToPDF', {
        printBackground: true,
        preferCSSPageSize: true,
        displayHeaderFooter: true,
        // Non-empty, or Chrome falls back to its default header — the date on
        // one side and the document title on the other.
        headerTemplate: '<span></span>',
        footerTemplate: FOOTER,
      }),
      60_000,
      'the PDF to render',
    )
    if (!data) throw new Error('Chrome returned an empty PDF')
    writeFileSync(out, Buffer.from(data, 'base64'))
  } finally {
    ws?.close()
    chrome.kill('SIGKILL')
    // Waited for, not fired and forgotten. kill() returns as soon as the signal
    // is delivered, while the process is still being torn down and still has
    // its profile directory open — and the caller's next act is to delete that
    // directory, which then fails with ENOTEMPTY underneath a PDF that rendered
    // perfectly well.
    if (chrome.exitCode === null && chrome.signalCode === null) {
      await withTimeout(
        new Promise((res) => chrome.once('exit', res)),
        10_000,
        'Chrome to exit',
      )
    }
  }
}

const tmp = mkdtempSync(join(tmpdir(), 'agreement-pdf-'))
const out = src.replace(/\.md$/, '.pdf')
const htmlPath = keepHtml ? src.replace(/\.md$/, '.html') : join(tmp, 'contract.html')

// The moment the run started, to compare the output's mtime against. See the
// post-condition below.
const startedAt = Date.now()

try {
  writeFileSync(htmlPath, doc, 'utf8')
  await printToPdf(htmlPath, out, join(tmp, 'chrome'))

  // A render that reported success is NOT evidence that a file reached disk.
  //
  // Measured, not theorised: on 2026-10-15 this script printed
  // "wrote docs/referral-agreement-TEMPLATE.pdf" while leaving yesterday's
  // file untouched, because the path handed to Chrome was relative and
  // "file://docs/x.html" parses "docs" as a HOSTNAME — it loaded nothing and
  // exited 0. The failure is silent, and what it leaves behind is a CONTRACT
  // that does not match the markdown it claims to render — the exact artifact
  // the drift guard in referral-agreement-terms.test.ts exists to catch,
  // except that guard only asserts markdown ⊆ PDF and the title block it would
  // have tripped on happened to appear in a body paragraph too.
  //
  // Driving the protocol directly closes that particular hole, since a failed
  // navigation now throws instead of being swallowed by an exit code. The
  // post-condition stays regardless: it is cheap, and it is the check that does
  // not care which of the many ways to produce no PDF was taken this time.
  const stamp = statSync(out, { throwIfNoEntry: false })
  if (!stamp) {
    console.error(`${out}: the render reported success but wrote no file.`)
    process.exit(1)
  }
  if (stamp.mtimeMs < startedAt) {
    console.error(
      `${out}: the render did not touch the output — the file on disk is from ` +
        `${stamp.mtime.toISOString()}, before this run started.\n` +
        'It is a STALE RENDER of an older version of the markdown. Do not send it.',
    )
    process.exit(1)
  }
  if (stamp.size < 10_000) {
    console.error(`${out}: rendered only ${stamp.size} bytes — that is not this agreement.`)
    process.exit(1)
  }
} finally {
  // Retries because this deletes a directory a browser has just let go of.
  rmSync(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
}

console.log(`wrote ${out}`)
if (keepHtml) console.log(`wrote ${htmlPath}`)
