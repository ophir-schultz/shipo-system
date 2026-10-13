#!/usr/bin/env node
// Reversion harness for the partner portal access gate.
//
// Same contract as scripts/reversion-docusign.mjs, and for the same
// reason: a green suite is not evidence. It is evidence only once each
// guard has been shown to fail — BY NAME — when the thing it protects is
// broken. Each reversion declares the test it EXPECTS to catch it, so a
// break caught by some unrelated assertion is reported rather than
// quietly credited.
//
// Three verdicts, and the middle one is the trap: a reversion that
// CRASHES the suite names no check, so "this guard is load-bearing" and
// "this fixture is brittle" print identically. Counted separately, never
// as a pass.
//
// What is being protected here is an ordering rule with a security
// consequence: the agreement is signed BEFORE portal access. For a while
// that rule was consulted only on the staff invite button, which made
// email delivery the de facto control — and the gate's guards all sat
// green over a login endpoint that never asked.

import { execFileSync } from 'node:child_process'
import { copyFileSync, readFileSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const FILES = [
  'src/lib/partner-access.ts',
  'src/lib/partner-auth.ts',
  'src/app/api/partner/request-code/route.ts',
  'src/app/api/partner/verify-code/route.ts',
]
const TESTS = ['src/lib/partner-access.test.ts']

const REVERSIONS = [
  // ---- the rule itself ----
  {
    name: 'an unsigned agreement let through',
    file: 'src/lib/partner-access.ts',
    from: "  if (partner.agreement_status !== AGREEMENT_SIGNED) return 'unsigned'",
    to: "  if (false) return 'unsigned'",
    expect: 'not signed',
  },
  {
    // The fail-closed direction. Treating an unrecognised state as fine
    // is how a future DocuSign status would silently open the portal.
    name: 'an unknown agreement state treated as signed',
    file: 'src/lib/partner-access.ts',
    from: "  if (partner.agreement_status !== AGREEMENT_SIGNED) return 'unsigned'",
    to: "  if (partner.agreement_status === 'not_sent') return 'unsigned'",
    expect: 'never as fine',
  },

  // ---- the front door: request-code ----
  {
    name: 'request-code: gate deleted',
    file: 'src/app/api/partner/request-code/route.ts',
    from: 'const blocked = portalAccessBlockedReason(partner)',
    to: 'const blocked = null',
    expect: 'request-code will not mail a code',
  },
  {
    name: 'request-code: gate asked, answer ignored',
    file: 'src/app/api/partner/request-code/route.ts',
    from: `  if (blocked) {
    console.error('[partner-login] code not sent:', blocked)
    return NextResponse.json(OK)
  }`,
    to: '  void blocked',
    expect: 'request-code will not mail a code',
  },
  {
    // The LEAK, not the lockout. A distinguishable response on the public
    // login form turns it into a lookup for who has signed.
    name: 'request-code: refuses with a specific message instead of the uniform OK',
    file: 'src/app/api/partner/request-code/route.ts',
    from: 'return NextResponse.json(OK)\n  }\n\n  const code = generateCode()',
    to: 'return NextResponse.json({ error: blocked }, { status: 403 })\n  }\n\n  const code = generateCode()',
    expect: 'request-code will not mail a code',
  },
  {
    // Drops the column from the query. The gate then reads undefined for
    // every partner and refuses everyone — which LOOKS like a working
    // gate right up until the first real signature is also refused.
    name: 'request-code: stops selecting agreement_status',
    file: 'src/app/api/partner/request-code/route.ts',
    from: "'id, name, email, status, agreement_status'",
    to: "'id, name, email, status'",
    expect: 'request-code will not mail a code',
  },

  // ---- the session mint: verify-code ----
  {
    name: 'verify-code: gate deleted',
    file: 'src/app/api/partner/verify-code/route.ts',
    from: 'const blocked = portalAccessPartnerMessage(partner)',
    to: 'const blocked = null',
    expect: 'verify-code will not issue a session',
  },
  {
    name: 'verify-code: gate asked, answer ignored',
    file: 'src/app/api/partner/verify-code/route.ts',
    from: `  if (blocked) {
    return NextResponse.json({ error: blocked }, { status: 403 })
  }`,
    to: '  void blocked',
    expect: 'verify-code will not issue a session',
  },
  {
    name: 'verify-code: stops selecting agreement_status',
    file: 'src/app/api/partner/verify-code/route.ts',
    from: "'id, email, status, agreement_status'",
    to: "'id, email, status'",
    expect: 'verify-code will not issue a session',
  },
  {
    // Ordering, and it is not cosmetic. The DocuSign webhook can flip
    // agreement_status to 'signed' while a code is in flight, so a
    // refusal that already consumed the code forces a partner who signed
    // thirty seconds ago to request a second email for nothing.
    // A genuine MOVE, not a deletion. The first draft of this reversion
    // only removed the gate block, which made it a duplicate of
    // "gate deleted" — it went red for the right-looking reason (the
    // ordering test saw index -1) while never once testing an ordering.
    // The guard was credited for catching an absence. So the whole
    // consume sequence is carried in the pattern and the gate is
    // re-inserted BELOW it, leaving every other assertion satisfiable.
    name: 'verify-code: burns the code before checking the gate',
    file: 'src/app/api/partner/verify-code/route.ts',
    from: `  const blocked = portalAccessPartnerMessage(partner)
  if (blocked) {
    return NextResponse.json({ error: blocked }, { status: 403 })
  }

  // Correct code — consume it before minting anything, so a race
  // cannot spend the same code twice.
  const { data: consumed } = await supabaseAdmin
    .from('partner_login_codes')
    .update({ consumed_at: new Date().toISOString() })
    .eq('id', row.id)
    .is('consumed_at', null)
    .select('id')
    .maybeSingle()

  if (!consumed) return NextResponse.json(BAD, { status: 401 })`,
    to: `  // Correct code — consume it before minting anything, so a race
  // cannot spend the same code twice.
  const { data: consumed } = await supabaseAdmin
    .from('partner_login_codes')
    .update({ consumed_at: new Date().toISOString() })
    .eq('id', row.id)
    .is('consumed_at', null)
    .select('id')
    .maybeSingle()

  if (!consumed) return NextResponse.json(BAD, { status: 401 })

  const blocked = portalAccessPartnerMessage(partner)
  if (blocked) {
    return NextResponse.json({ error: blocked }, { status: 403 })
  }`,
    expect: 'BEFORE it burns the code',
  },

  // ---- the room, not just the door ----
  {
    // What the code did before this change. A session lasts SESSION_DAYS,
    // so gating only at login lets an agreement voided on day 2 keep
    // working until day 30.
    name: 'session: re-checks status only, as it did before',
    file: 'src/lib/partner-auth.ts',
    from: 'if (!canAccessPortal(partner)) return null',
    to: "if (partner.status === 'inactive') return null",
    expect: 'every request',
  },
  {
    name: 'session: stops selecting agreement_status',
    file: 'src/lib/partner-auth.ts',
    from: "'id, name, company, email, status, agreement_status'",
    to: "'id, name, company, email, status'",
    expect: 'every request',
  },

  // ---- the two vocabularies ----
  {
    // The drift this split exists to prevent, in its harmless direction:
    // a partner told to do something only Shipo staff can do.
    name: 'module: partner shown the staff instruction',
    file: 'src/lib/partner-access.ts',
    from: "  inactive:\n    'Your partner account is paused, so the portal is closed for now. Email Support@shipousa.com and we will look into it.',",
    to: "  inactive: 'This partner is inactive, so they cannot sign in. Reactivate them first.',",
    expect: 'instruction aimed at Shipo staff',
  },
  {
    name: 'verify-code: hands the partner the staff wording',
    file: 'src/app/api/partner/verify-code/route.ts',
    from: 'portalAccessPartnerMessage(partner)',
    to: 'portalAccessBlockedReason(partner)',
    expect: 'verify-code will not issue a session',
  },
  {
    // The common case. Every row sits in 'not_sent' or 'sent' between
    // invite and signature, so sending this one to support generates a
    // ticket for something the partner only has to finish.
    name: 'module: unsigned partner sent to support instead of DocuSign',
    file: 'src/lib/partner-access.ts',
    from: "  unsigned:\n    'Your partner agreement is not signed yet. Finish signing the DocuSign email we sent and the portal opens by itself — no second code needed.',",
    to: "  unsigned: 'Your partner agreement is not signed yet. Email Support@shipousa.com.',",
    expect: 'finish signing',
  },
  {
    // Type-checks, satisfies Record<AccessBlock, string>, and renders as
    // a refusal with no words in it.
    name: 'module: a partner sentence blanked',
    file: 'src/lib/partner-access.ts',
    from: "  voided:\n    'The partner agreement on file was cancelled before it was signed. Email Support@shipousa.com and we will send a new one.',",
    to: "  voided: '',",
    expect: 'both a staff and a partner sentence',
  },

  // ---- CONTROLS ----
  // These must STAY GREEN. They are the reason a "caught it" verdict
  // means anything: if a control goes red, the harness is reporting
  // noise and every verdict above it is suspect.
  {
    name: 'CONTROL: a comment reworded',
    control: true,
    file: 'src/lib/partner-access.ts',
    from: '/** The value the DocuSign webhook writes on envelope-completed. */',
    to: '/** What the webhook writes when the envelope completes. */',
  },
  {
    name: 'CONTROL: staff wording rephrased without changing who it addresses',
    control: true,
    file: 'src/lib/partner-access.ts',
    from: "  inactive: 'This partner is inactive, so they cannot sign in. Reactivate them first.',",
    to: "  inactive: 'This partner is inactive and cannot sign in. Reactivate them first.',",
  },
  {
    // The check order is deliberate but not load-bearing for ACCESS —
    // swapping two refusals changes which sentence appears first, not
    // whether the door opens. It must not be reported as a caught guard.
    control: true,
    name: 'CONTROL: declined and voided checked in the other order',
    file: 'src/lib/partner-access.ts',
    from: `  if (partner.agreement_status === 'declined') return 'declined'
  if (partner.agreement_status === 'voided') return 'voided'`,
    to: `  if (partner.agreement_status === 'voided') return 'voided'
  if (partner.agreement_status === 'declined') return 'declined'`,
  },
]

const backup = mkdtempSync(join(tmpdir(), 'reversion-login-'))
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
      console.log(
        `!! ${r.name}\n     control went ${v.kind}: ${v.failed.join(' | ') || v.stdio.slice(-400)}`,
      )
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
console.log(
  `All ${REVERSIONS.filter((r) => !r.control).length} reversions caught by name; ` +
    `${REVERSIONS.filter((r) => r.control).length} controls stayed green.`,
)
