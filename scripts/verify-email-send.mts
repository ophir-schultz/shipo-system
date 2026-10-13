// Is email actually configured, and does the credential actually work?
//
//   npx tsx --env-file=.env.local scripts/verify-email-send.mts
//   npx tsx --env-file=.env.local scripts/verify-email-send.mts ophir@shipousa.com
//
// Named verify-, not probe-, on purpose: .gitignore ignores scripts/probe-*
// as one-off questions nobody maintains, and the rule's comment rests on
// "no tracked file begins with probe-". This one is meant to be kept and
// re-run, so it belongs beside verify-partner-ledger.mjs instead.
//
// With no argument it only REPORTS which provider would be selected and
// what From address would be used. Given an address, it actually sends a
// test message there and prints the provider's verdict verbatim.
//
// Why this script has to exist
// ----------------------------
// /api/partner/request-code cannot tell you whether email works, and that
// is deliberate. It answers with the same uniform OK -- "If that email is
// on file, a code is on its way." -- for an address that is not a partner,
// for a partner blocked by the access gate, AND for a partner who was
// genuinely mailed a code. That uniformity is correct: anything else turns
// the endpoint into a directory of who Shipo's partners are. But it costs
// us the only externally visible signal about the mail path, and with
// referral_partners empty, EVERY request returns that OK. So the endpoint
// returns "a code is on its way" with no provider configured at all, and
// there is no way to tell from outside. The honest 502 that would prove
// the mail path is unreachable until an active, signed partner exists.
//
// This script reaches the mail path directly instead, so the question
// "does email work" stops depending on the state of the partner table.
//
// It imports the REAL sendEmail rather than re-deriving the provider
// precedence. A second copy of that if-chain would be a copy that drifts,
// and it would then be confidently wrong about the thing being probed.
//
// No secret is ever printed. Presence is reported as a boolean; values are
// never read into the output. Provider error bodies ARE printed, because
// that is the diagnostic ("API key is invalid", "domain is not verified")
// and it carries no credential.
//
// NOTE the .mts extension is load-bearing: package.json has no "type":
// "module", so tsx transforms a plain .ts as CJS and the top-level await
// below will not compile. See prep-agreement-envelope.mts.

import { sendEmail } from '../src/lib/email'

// Each provider, in the exact order src/lib/email.ts tries them, with the
// vars it needs ALL of. Keep this list in step with that file -- it decides
// only what we PRINT, never what gets used, so a drift here is a cosmetic
// bug rather than a behavioural one.
const PROVIDERS: Array<{ name: string; vars: string[] }> = [
  { name: 'resend', vars: ['RESEND_API_KEY'] },
  { name: 'sendgrid', vars: ['SENDGRID_API_KEY'] },
  { name: 'smtp', vars: ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS'] },
  { name: 'supabase-smtp', vars: ['SUPABASE_SMTP_HOST', 'SUPABASE_SMTP_USER', 'SUPABASE_SMTP_PASS'] },
]

const isSet = (k: string) => Boolean(process.env[k]?.trim())

console.log('Email provider configuration (presence only -- no values are read)\n')

let selected: string | null = null
for (const p of PROVIDERS) {
  const have = p.vars.filter(isSet)
  const complete = have.length === p.vars.length
  if (complete && !selected) selected = p.name

  const mark = complete ? 'set' : have.length ? 'PARTIAL' : '-'
  console.log(`  ${p.name.padEnd(14)} ${mark.padEnd(8)} ${p.vars.map((v) => `${v}=${isSet(v) ? 'set' : 'unset'}`).join('  ')}`)
}

// A PARTIAL row is the dangerous state and the reason this prints every var
// rather than one line per provider. SMTP_HOST + SMTP_USER with no
// SMTP_PASS does not fail loudly -- the if-chain simply falls through to
// the next provider, and you get "No email provider configured" while
// looking at a dashboard that plainly shows SMTP variables present.
const partial = PROVIDERS.filter((p) => {
  const n = p.vars.filter(isSet).length
  return n > 0 && n < p.vars.length
})

console.log()
console.log(`  EMAIL_FROM     ${isSet('EMAIL_FROM') ? 'set' : 'unset (default)'}`)
// The From address is not a secret and is a common cause of a valid key
// still refusing to send, so print the value that will actually be used.
console.log(`  resolved from  ${process.env.EMAIL_FROM || 'Shipo Security <security@shipousa.com>'}`)
console.log()

if (partial.length) {
  for (const p of partial) {
    const missing = p.vars.filter((v) => !isSet(v))
    console.log(`  !! ${p.name} is PARTIAL -- missing ${missing.join(', ')}. It will be SKIPPED silently.`)
  }
  console.log()
}

if (!selected) {
  console.log('VERDICT: no provider configured. sendEmail() returns')
  console.log('         { sent: false, provider: "none", error: "No email provider configured" }')
  console.log('         and every partner login code is silently dropped.')
  process.exit(1)
}

console.log(`VERDICT: "${selected}" would be selected.`)

// ---------------------------------------------------------------------
// The live send.
// ---------------------------------------------------------------------
// Configured is not the same as working. An expired key, a From address on
// an unverified domain, and a revoked SMTP app password all look identical
// to a correct setup from the outside -- they are only distinguishable by
// a provider's reply to a real request.
const to = process.argv[2]
if (!to) {
  console.log('\nNot sending. Pass an address to send a real test message:')
  console.log('  npx tsx --env-file=.env.local scripts/verify-email-send.mts you@example.com')
  process.exit(0)
}

console.log(`\nSending a test message to ${to} ...`)
const result = await sendEmail({
  to,
  subject: 'Shipo email path test',
  text:
    'This is a test from scripts/verify-email-send.mts.\n\n' +
    'If you are reading it, the Shipo partner portal can send login codes.\n',
  html:
    '<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:480px;padding:24px;color:#111">' +
    '<p>This is a test from <code>scripts/verify-email-send.mts</code>.</p>' +
    '<p>If you are reading it, the Shipo partner portal can send login codes.</p>' +
    '</div>',
})

console.log()
console.log(`  sent      ${result.sent}`)
console.log(`  provider  ${result.provider}`)
if (result.error) console.log(`  error     ${result.error}`)

// Exit non-zero on failure so this can gate a deploy or sit in a runbook
// without anyone having to read the words.
if (!result.sent) {
  console.log('\nVERDICT: configured but NOT working. The error above is the provider\'s own.')
  process.exit(1)
}
console.log('\nVERDICT: email works. Check the inbox to confirm delivery, not just acceptance.')
