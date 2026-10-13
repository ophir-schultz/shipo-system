#!/usr/bin/env node
// Reversion harness for the DocuSign envelope guards.
//
// A green suite is not evidence. It is evidence only once each guard has
// been shown to fail — BY NAME — when the thing it protects is broken.
//
// Two failure modes this harness is built to tell apart, both learned the
// hard way:
//
//   1. A reversion that STAYS GREEN. The guard is decoration.
//   2. A reversion that CRASHES the suite. A traceback names no check, so
//      "the guard is load-bearing" and "the fixture is brittle" print
//      identically. Reported separately, never counted as a pass.
//
// It also does not match on output format. The verdict comes from the
// exit code and the JSON reporter's failed-assertion list, because a
// harness that recognises only one failure shape is the same defect as a
// runner that selects modules by grepping for "N passed".

import { execFileSync } from 'node:child_process'
import { copyFileSync, readFileSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const FILES = [
  'src/lib/docusign-w9.ts',
  'src/lib/docusign-envelope.ts',
]
const TESTS = [
  'src/lib/docusign-w9.test.ts',
  'src/lib/docusign-envelope.test.ts',
]

/**
 * Each reversion breaks ONE invariant. `expect` is a substring of the test
 * name that SHOULD catch it — asserted, so a reversion caught by some
 * unrelated test is reported rather than quietly credited.
 */
const REVERSIONS = [
  {
    name: 'W-9 fields converted from the AcroForm (misroutes TIN to Shipo)',
    file: 'src/lib/docusign-envelope.ts',
    from: "transformPdfFields: 'false'",
    to: "transformPdfFields: 'true'",
    expect: 'transformPdfFields',
  },
  {
    name: 'envelope created already sent',
    file: 'src/lib/docusign-envelope.ts',
    from: "status: 'created'",
    to: "status: 'sent'",
    expect: 'draft',
  },
  {
    name: 'name on line 1 of the W-9 made optional',
    file: 'src/lib/docusign-w9.ts',
    from: `    label: 'Name of entity/individual',
    x: 58.6,
    y: 118.0,
    w: 517.4,
    h: 14,
    required: true,`,
    to: `    label: 'Name of entity/individual',
    x: 58.6,
    y: 118.0,
    w: 517.4,
    h: 14,
    required: false,`,
    expect: 'name and the address',
  },
  {
    name: 'anchored tabs allowed to vanish if the anchor is missing',
    file: 'src/lib/docusign-envelope.ts',
    from: "anchorIgnoreIfNotPresent: 'false'",
    to: "anchorIgnoreIfNotPresent: 'true'",
    expect: 'anchor',
  },
  {
    name: 'TIN group no longer requires one row',
    file: 'src/lib/docusign-envelope.ts',
    from: "minimumRequired: '1'",
    to: "minimumRequired: '0'",
    expect: 'one of the two TIN',
  },
  {
    name: 'both TIN rows made individually required (uncompletable)',
    file: 'src/lib/docusign-envelope.ts',
    from: `      tabLabel: 'w9_tin_ssn',
      name: 'Social security number',
      required: 'false',`,
    to: `      tabLabel: 'w9_tin_ssn',
      name: 'Social security number',
      required: 'true',`,
    expect: 'TIN',
  },
  {
    name: 'classification radios made optional',
    file: 'src/lib/docusign-envelope.ts',
    from: `          value: c.value,
          required: 'true',`,
    to: `          value: c.value,
          required: 'false',`,
    expect: 'classification',
  },
  {
    name: 'envelopeTypes custom field no longer required',
    file: 'src/lib/docusign-envelope.ts',
    from: `          value: ENVELOPE_TYPE_VALUE,
          show: 'false',
          required: 'true',`,
    to: `          value: ENVELOPE_TYPE_VALUE,
          show: 'false',
          required: 'false',`,
    expect: 'envelope type',
  },
  {
    // Distinct from the flag above: the account rejects a send whose
    // envelopeTypes value is not one it knows, so the VALUE is as
    // load-bearing as the required flag and fails the same way — on
    // envelope two, long after anyone is watching.
    name: 'envelopeTypes carries a value the account does not know',
    file: 'src/lib/docusign-envelope.ts',
    from: "export const ENVELOPE_TYPE_VALUE = 'PartnershipAgreements'",
    to: "export const ENVELOPE_TYPE_VALUE = 'SomethingElse'",
    expect: 'the way the ACCOUNT spells it',
  },
  {
    name: 'partner routed ahead of Shipo',
    file: 'src/lib/docusign-envelope.ts',
    from: "    routingOrder: '2',\n    roleName: 'Partner',",
    to: "    routingOrder: '1',\n    roleName: 'Partner',",
    expect: 'sign first',
  },
  {
    name: 'requester block offered to the partner as an empty field',
    file: 'src/lib/docusign-w9.ts',
    from: `  {
    acroform: 'f1_10',`,
    to: `  {
    acroform: 'f1_09',
    label: 'Requester name and address',
    x: 389.8,
    y: 286.0,
    w: 186.2,
    h: 38,
    required: false,
  },
  {
    acroform: 'f1_10',`,
    expect: 'requester block',
  },
  {
    name: 'W-9 geometry hash points at a different file',
    file: 'src/lib/docusign-w9.ts',
    from: "'2d420cbb4123dcf1fb82595b2359cfbb5d81f00b9df9d359fcc7af361d093f53'",
    to: "'0000000000000000000000000000000000000000000000000000000000000000'",
    expect: 'byte-for-byte',
  },
  {
    name: 'a W-9 box pushed off the bottom of the page',
    file: 'src/lib/docusign-w9.ts',
    from: "export const W9_TIN_EIN: W9Box = { x: 417.6, y: 420.0, w: 144.0, h: 24 }",
    to: "export const W9_TIN_EIN: W9Box = { x: 417.6, y: 790.0, w: 144.0, h: 24 }",
    expect: 'printable page',
  },
  {
    // The original defect this round found: no tab on \paddr\, so clause
    // 1 shipped as 'with its address at  ("Partner")' in white ink.
    name: 'address anchor left unfilled (blank notices clause)',
    file: 'src/lib/docusign-envelope.ts',
    from: `      anchored(AGREEMENT_ANCHORS.partnerAddressPrefill, {`,
    to: `      ...[], ...[], anchored(AGREEMENT_ANCHORS.partnerNamePrefill, {`,
    expect: 'fill-anchor',
  },
  {
    name: 'party block made editable by the counterparty',
    file: 'src/lib/docusign-envelope.ts',
    from: `        value: partyName(partner),
        locked: 'true',`,
    to: `        value: partyName(partner),
        locked: 'false',`,
    expect: 'clause 1 and locks it',
  },
  {
    name: 'partner address made optional',
    file: 'src/lib/docusign-envelope.ts',
    from: `        // tells US. Required, so the notices clause cannot ship blank.
        required: 'true',`,
    to: `        // tells US. Required, so the notices clause cannot ship blank.
        required: 'false',`,
    expect: 'requires it',
  },
  {
    name: 'W-9 requester block left blank (form from nobody)',
    file: 'src/lib/docusign-envelope.ts',
    from: 'textTabs: [...textTabs, ...tinTabs, requesterTab],',
    to: 'textTabs: [...textTabs, ...tinTabs],',
    expect: 'requester block',
  },
  {
    name: 'clause 1 names the signer instead of the contracting entity',
    file: 'src/lib/docusign-envelope.ts',
    from: 'return partner.company?.trim() || partner.name.trim()',
    to: 'return partner.name.trim()',
    expect: 'company when there is one',
  },
  // ---- CONTROLS ----
  // These must STAY GREEN. They are the reason a "caught it" verdict means
  // something: if a control went red, the harness is reporting noise.
  {
    name: 'CONTROL: a comment reworded',
    control: true,
    file: 'src/lib/docusign-w9.ts',
    from: '/** Page 1 is US Letter. Asserted, so a form on A4 cannot pass silently. */',
    to: '/** Page 1 is US Letter. */',
  },
  {
    name: 'CONTROL: optional account-number line left optional',
    control: true,
    file: 'src/lib/docusign-w9.ts',
    from: "    label: 'Account numbers',",
    to: "    label: 'Account number(s)',",
  },
]

const backup = mkdtempSync(join(tmpdir(), 'reversion-'))
for (const f of FILES) copyFileSync(f, join(backup, f.replace(/\//g, '_')))
const restore = () => {
  for (const f of FILES) copyFileSync(join(backup, f.replace(/\//g, '_')), f)
}

/** Run the suite. Returns a verdict that distinguishes crash from failure. */
function runSuite() {
  const out = join(backup, 'result.json')
  let code = 0
  let stdio = ''
  try {
    stdio = execFileSync(
      'npx',
      ['vitest', 'run', ...TESTS, '--reporter=json', '--outputFile', out],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    )
  } catch (e) {
    code = e.status ?? 1
    stdio = `${e.stdout ?? ''}${e.stderr ?? ''}`
  }

  let failed = []
  let total = 0
  try {
    const json = JSON.parse(readFileSync(out, 'utf8'))
    for (const file of json.testResults ?? []) {
      for (const t of file.assertionResults ?? []) {
        total++
        if (t.status === 'failed') failed.push(t.fullName ?? t.title)
      }
    }
  } catch {
    // No parsable report. Either the run never got far enough to write one
    // (a collection error — i.e. a crash) or the reporter changed shape.
    return { kind: code === 0 ? 'green' : 'crash', failed: [], total: 0, stdio }
  }

  if (code === 0 && failed.length === 0) return { kind: 'green', failed, total, stdio }
  if (failed.length === 0) return { kind: 'crash', failed, total, stdio }
  return { kind: 'caught', failed, total, stdio }
}

console.log('Baseline:')
const base = runSuite()
if (base.kind !== 'green') {
  console.log(`  REFUSING TO RUN — baseline is not green (${base.kind}).`)
  console.log(base.failed.join('\n') || base.stdio.slice(-2000))
  restore()
  rmSync(backup, { recursive: true, force: true })
  process.exit(1)
}
console.log(`  green, ${base.total} checks\n`)

const problems = []

for (const r of REVERSIONS) {
  restore()
  const src = readFileSync(r.file, 'utf8')
  const hits = src.split(r.from).length - 1
  if (hits === 0) {
    // A reversion that cannot be applied tests nothing, and silently
    // skipping it would report a clean sweep over work never done.
    problems.push(`${r.name}: PATCH DID NOT APPLY (pattern absent)`)
    console.log(`?? ${r.name}\n     pattern not found in ${r.file}`)
    continue
  }
  writeFileSync(r.file, src.split(r.from).join(r.to))

  const v = runSuite()

  if (r.control) {
    if (v.kind === 'green') {
      console.log(`ok ${r.name}  (stayed green, as a control must)`)
    } else {
      problems.push(`${r.name}: CONTROL WENT ${v.kind.toUpperCase()} — harness is reporting noise`)
      console.log(`!! ${r.name}\n     control went ${v.kind}: ${v.failed.join(' | ') || v.stdio.slice(-400)}`)
    }
    continue
  }

  if (v.kind === 'green') {
    problems.push(`${r.name}: STAYED GREEN — guard is decoration`)
    console.log(`XX ${r.name}\n     stayed green over ${v.total} checks`)
  } else if (v.kind === 'crash') {
    problems.push(`${r.name}: CRASHED — no check named it`)
    console.log(`!! ${r.name}\n     crashed; ${v.stdio.slice(-400).trim()}`)
  } else {
    const named = v.failed.some((f) => f.toLowerCase().includes(r.expect.toLowerCase()))
    console.log(`ok ${r.name}\n     ${v.failed.length} failed, e.g. "${v.failed[0]}"`)
    if (!named) {
      problems.push(
        `${r.name}: caught, but NOT by a test mentioning "${r.expect}" — caught by ${v.failed[0]}`,
      )
      console.log(`     ^ expected a test mentioning "${r.expect}"`)
    }
  }
}

restore()
rmSync(backup, { recursive: true, force: true })

console.log('')
if (problems.length) {
  console.log(`${problems.length} problem(s):`)
  for (const p of problems) console.log(`  - ${p}`)
  process.exit(1)
}
console.log(`All ${REVERSIONS.filter((r) => !r.control).length} reversions caught by name; ` +
  `${REVERSIONS.filter((r) => r.control).length} controls stayed green.`)
