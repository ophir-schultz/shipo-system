// Regenerate src/lib/w9-page1-base64.ts from docs/irs-fw9.pdf.
//
//   npx tsx scripts/gen-w9-base64.mts
//
// WHY THE BYTES ARE COMMITTED RATHER THAN READ AT RUNTIME. The extractor
// (src/lib/docusign-w9-document.ts) spawns python3 and reads the PDF off
// the filesystem. That is correct for a script running on a laptop and
// impossible in a serverless function: there is no python3 in the runtime
// and docs/ is not part of the deployed bundle. The W-9 route needs these
// bytes on every partner's first visit, so they ship as a constant.
//
// The constant is therefore a cache of a derived value, which is the
// classic way to end up with a stale one. src/lib/w9-page1-base64.test.ts
// is the guard: it re-derives from the PDF and compares, so a regenerated
// form or a forgotten run of this script fails the suite rather than
// sending partners the wrong page with the tabs in the wrong places.
//
// The .mts extension is load-bearing — see prep-agreement-envelope.mts.

import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractW9Page1Base64 } from '../src/lib/docusign-w9-document'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'src/lib/w9-page1-base64.ts')

// Throws on a PDF that is not the one the tab coordinates were measured
// from, which is the whole reason extraction and the hash check are one
// call. Let it throw: a wrong page here is tabs on blank paper.
const base64 = extractW9Page1Base64()

const header = `// GENERATED FILE -- DO NOT EDIT.
//
// Page 1 of IRS Form W-9, base64, as sent to DocuSign. Regenerate with:
//
//   npx tsx scripts/gen-w9-base64.mts
//
// It is committed because the runtime cannot derive it: extraction spawns
// python3 and reads docs/irs-fw9.pdf, and a serverless function has
// neither. src/lib/w9-page1-base64.test.ts re-derives and compares, so
// this file cannot silently fall behind the PDF.
//
// ${base64.length} characters. Nothing here is secret -- it is a blank
// public IRS form. No partner data is in it and none ever should be.

`

writeFileSync(OUT, `${header}export const W9_PAGE1_BASE64 =\n  '${base64}'\n`)

console.log(`Wrote ${OUT}`)
console.log(`  ${base64.length} base64 characters`)
