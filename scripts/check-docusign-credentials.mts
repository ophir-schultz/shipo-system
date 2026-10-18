// Prove the DocuSign configuration works, before trusting it with a W-9.
//
//   npx tsx --env-file=.env.local scripts/check-docusign-credentials.mts
//
// The .mts extension is load-bearing, not a style choice — see the comment
// at the top of prep-agreement-envelope.mts. package.json has no
// "type": "module", so tsx transforms a plain .ts here as CJS and
// top-level await breaks, while tsc type-checks it against esnext rules
// the real loader does not honour.
//
// WHAT THIS DOES AND DOES NOT DO. It exchanges the JWT for a token and
// reads the account back. It creates nothing, sends nothing and emails
// nobody, which is why it is safe to point at the production account —
// the alternative, a demo app with its own keypair, its own consent and a
// copied template, is a second configuration to get wrong in order to
// rehearse getting the first one right.
//
// IT PRINTS VERDICTS, NEVER VALUES. Six of the seven variables are
// credentials and one is a private key. Nothing here echoes an
// environment value, a token or an assertion: a missing variable is
// reported by NAME, and a present one is reported only as set. Paste the
// output anywhere you like.

import { docusignConfig, docusignConfigMissing, checkCredentials } from '../src/lib/docusign-client'

const OPTIONAL = ['DOCUSIGN_CONNECT_SECRET', 'ACCOUNTANT_W9_EMAIL', 'ACCOUNTANT_W9_NAME'] as const

const missing = docusignConfigMissing(process.env)

if (missing.length > 0) {
  console.log('NOT CONFIGURED — these are absent or blank:\n')
  for (const name of missing) console.log(`  ${name}`)
  console.log('\nAll six are required together. A half-configured client fails at the')
  console.log('socket, several frames from the variable that caused it, so the app')
  console.log('refuses to start a signing session until every one is present.')
  process.exit(1)
}

console.log('All six DOCUSIGN_* variables are present. Asking DocuSign…\n')

const cfg = docusignConfig(process.env)
if (!cfg) {
  console.log('docusignConfig returned null despite nothing being reported missing.')
  console.log('That is a contradiction in the config code, not in your environment.')
  process.exit(1)
}

const result = await checkCredentials(cfg)

if (!result.ok) {
  console.log(`FAILED: ${result.reason}\n`)
  console.log('The three that actually happen, and their unrelated remedies:')
  console.log('  consent_required  open the consent URL ONCE, signed in as the')
  console.log('                    DOCUSIGN_USER_ID user. Re-pasting keys will not fix it.')
  console.log('  invalid_grant     DOCUSIGN_USER_ID must be the User ID GUID, not an')
  console.log('                    email; check the integration key and the keypair.')
  console.log('  account read      DOCUSIGN_ACCOUNT_ID / DOCUSIGN_ACCOUNT_BASE_URI.')
  process.exit(1)
}

console.log('OK — authenticated and the account read back.\n')
console.log(`  account   ${result.accountName}`)

// The name alone cannot answer "which account": the demo and production
// accounts are BOTH named "Shipo LLC", so "check the name" was advice
// nobody could act on. The pod in the base URI is what separates them,
// and it is the field that decides whether an envelope is a rehearsal
// or a real document arriving in a real person's inbox.
const baseUri = process.env.DOCUSIGN_ACCOUNT_BASE_URI?.trim() ?? ''
const world = /(^|\/\/)demo\.docusign\.net(\/|$)/.test(baseUri)
  ? 'DEMO — envelopes are rehearsals; template bba422c1 does NOT exist here'
  : /\.docusign\.net(\/|$)/.test(baseUri)
    ? 'PRODUCTION — envelopes are real documents sent to real people'
    : 'UNRECOGNISED — not a docusign.net pod; check the value'
console.log(`  world     ${world}`)
console.log(`  base uri  ${baseUri || '(unset)'}`)

console.log('\nCHECK THAT WORLD. A valid token against the WRONG account is the one')
console.log('failure this script cannot call for you — and the account NAME cannot')
console.log('settle it, because demo and production carry the same name. The pod can.')

const absent = OPTIONAL.filter((n) => !process.env[n]?.trim())
if (absent.length > 0) {
  console.log('\nStill needed before a partner can actually sign:')
  for (const name of absent) {
    const why =
      name === 'DOCUSIGN_CONNECT_SECRET'
        ? 'the webhook fails CLOSED without it — no partner is ever activated'
        : 'the W-9 route refuses to send without a named accountant to copy'
    console.log(`  ${name}  — ${why}`)
  }
}
