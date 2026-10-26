// Prepare the partner AGREEMENT envelope payload for ONE partner.
//
//   npx tsx --env-file=.env.local scripts/prep-agreement-envelope.mts <id>
//
// The .mts extension is load-bearing, not a style choice. tsx transforms a
// plain .ts here as CJS, because package.json has no "type": "module", and
// under CJS both the top-level awaits below and import.meta.url break. tsc
// does NOT catch it: tsconfig sets module esnext, so the file type-checks
// against rules the real loader does not honour. scripts/check-order-counts
// was .ts, had the same shape, and could not run at all until it was renamed
// to .mts for this reason.
//
// This script does NOT create or send anything. It reads the partner row,
// builds the payload, re-checks the things that are cheap to check and
// expensive to get wrong, and writes the JSON out for review. Creating
// the envelope is a separate, deliberate step.
//
// The W-9 is NOT here. Task 7 split it into its own envelope, which the
// partner signs embedded in their dashboard -- so it is built by the app
// at the moment they ask for it, not prepared in advance by hand.
//
// Why a script and not a route: the app holds no DocuSign credentials, so
// a route could not send even if we wanted one. What the app can own is
// the envelope's SHAPE — see src/lib/docusign-envelope.ts — and that is
// where the costly mistakes live. This is the harness that feeds it real
// data and shows the result before anyone commits to it.

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'
import {
  AGREEMENT_TEMPLATE_ID,
  buildPartnerAgreementEnvelope,
  partnerWebhookUrl,
  partyName,
} from '../src/lib/docusign-envelope'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const partnerId = process.argv[2]
if (!partnerId) {
  console.error('Usage: prep-agreement-envelope.mts <partner-id> [notice address] [legal name]')
  console.error('Partner ids: node --env-file=.env.local scripts/probe-partner-rows.mjs')
  process.exit(1)
}

// The notice address for clause 1, optional, from the command line rather
// than the database — referral_partners has no address column, and the
// address usually arrives in the application email rather than the form.
//
// Supplying it moves the tab to OUR side of the envelope, prefilled and
// locked, so both signers can read it (see agreementProseTabs). Omitting
// it leaves the partner an empty required box, which still works. This is
// the one place the two behaviours are chosen between, so it is a visible
// argument rather than a lookup that silently finds nothing.
const noticeAddress = process.argv[3]?.trim() || undefined

// The legal name of the contracting party, optional, and on the command
// line for a stronger reason than the address: it cannot be derived at
// all. partyName falls back to company-or-name, which is right for an
// incorporated agency and for a sole trader who left `company` blank, and
// WRONG for a sole trader who filled in both — clause 1 then reads a
// trading name, which is not a legal person. Nothing on the row can tell
// those apart (partner_type is null everywhere, and tax_status
// 'us_person' covers human and company alike), so this is a judgement
// made once, by a person, and printed below before anything is created.
const legalName = process.argv[4]?.trim() || undefined

// ---------------------------------------------------------------------
// 1. The partner, from the row the webhook will later match on.
// ---------------------------------------------------------------------
// Read from the database rather than taking name/email on the command
// line. The envelope carries partner_id as a custom field and the webhook
// resolves the partner by it, so the envelope and the row have to agree
// about who this is. Typing the name by hand is how they stop agreeing.
const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

const { data: partner, error } = await db
  .from('referral_partners')
  // tax_status is REQUIRED by the builder (spec 2a.7): it refuses any
  // partner who is not a recorded US person, and an unselected column
  // arrives as undefined, which reads as "not recorded" and refuses.
  // prettier-ignore
  .select('id, name, company, email, status, agreement_status, agreement_envelope_id, tax_status')
  .eq('id', partnerId)
  .maybeSingle()

if (error) {
  console.error(`Could not read referral_partners: ${error.message}`)
  process.exit(1)
}
if (!partner) {
  console.error(`No partner with id ${partnerId}.`)
  process.exit(1)
}
if (!partner.email?.trim()) {
  // DocuSign cannot address an envelope without one, and a placeholder
  // here would mail a contract to whoever owns the placeholder.
  console.error(`Partner ${partner.name} has no email address. Fix the row first.`)
  process.exit(1)
}

// Refuse to prepare a second envelope for an agreement already in flight.
// Two live envelopes for one partner means two signable contracts, and
// the webhook would stamp agreement_signed_at from whichever came back
// first — so the copy we keep might not be the copy they signed.
if (partner.agreement_status === 'signed') {
  console.error(`Partner ${partner.name} has already signed. Nothing to prepare.`)
  process.exit(1)
}
if (partner.agreement_envelope_id) {
  console.error(
    `Partner ${partner.name} already has envelope ${partner.agreement_envelope_id}.\n` +
      'Void that one in DocuSign before preparing another, or this partner ends up\n' +
      'with two signable contracts and we cannot say which one is operative.',
  )
  process.exit(1)
}

// ---------------------------------------------------------------------
// 2. The payload.
// ---------------------------------------------------------------------
// Where DocuSign POSTs envelope events. The webhook that promotes the
// partner on completion lives there and nowhere else — if this env var
// is unset the script refuses, because sending without it ships an
// envelope that completes without ever notifying the app.
//
// Measured, not inferred: shipousa.com is the WordPress site and answers
// 404 for /api/partner/agreement-webhook. The app is served from
// shipo-system.vercel.app, which answers 405 there (exists, rejects GET).
const siteUrl = process.env.NEXT_PUBLIC_SITE_URL
if (!siteUrl) {
  console.error('NEXT_PUBLIC_SITE_URL is required (e.g. https://shipo-system.vercel.app).')
  process.exit(1)
}
// Composed rather than spelled out here. The W-9 sign route needs the same
// URL, and a path written in two places is a path that can be renamed in
// one of them — leaving the other building envelopes that report completion
// to a 404, which is indistinguishable from reporting nowhere at all.
const webhookUrl = partnerWebhookUrl(siteUrl)

// The builder throws on a non-US person rather than returning a flag, so
// catch it here: a stack trace tells whoever ran this nothing about what
// to do next, and the refusal text says exactly what to do.
let envelope: ReturnType<typeof buildPartnerAgreementEnvelope>
try {
  envelope = buildPartnerAgreementEnvelope({
    partner: {
      id: partner.id,
      name: partner.name,
      email: partner.email,
      company: partner.company,
      tax_status: partner.tax_status,
      address: noticeAddress,
      legal_name: legalName,
    },
    shipo: { name: 'Ophir Schultz', email: 'ophir@shipousa.com' },
  })
} catch (e) {
  console.error((e as Error).message)
  process.exit(1)
}

// A last assertion rather than a comment. The builder sets this, the
// tests check it, and it is still worth refusing here: everything above
// this line is reversible and everything after it is not.
if (envelope.status !== 'created') {
  console.error(`Refusing to continue: status is '${envelope.status}', expected 'created'.`)
  process.exit(1)
}

const outDir = join(ROOT, 'scripts/out')
mkdirSync(outDir, { recursive: true })
const outFile = join(outDir, `envelope-${partner.id}.json`)
writeFileSync(outFile, JSON.stringify(envelope, null, 2))

// No summary file any more. It existed to elide ~100KB of inlined W-9
// base64 so the payload could be read; the agreement comes from a server
// template, so the payload above is already the readable one. Writing
// both would mean two identical files, and two identical files is how
// somebody ends up reviewing the stale one.

/**
 * The value actually written into clause 1, pulled back out of the payload
 * by its tab label. Throws rather than printing a guess: if the label ever
 * changes, a reviewer must not be shown a confident name that came from
 * somewhere else.
 */
function clauseOneName(env: ReturnType<typeof buildPartnerAgreementEnvelope>): string {
  for (const composite of env.compositeTemplates ?? []) {
    for (const inline of composite.inlineTemplates ?? []) {
      for (const signer of inline.recipients?.signers ?? []) {
        for (const tab of signer.tabs?.textTabs ?? []) {
          // `'value' in tab` is a narrowing, not a safety blanket: a text
          // tab the PARTNER fills carries no value, and the compiler knows
          // it. Without this the union has no `value` to read at all.
          if (tab.tabLabel === 'agreement_partner_name' && 'value' in tab) return String(tab.value)
        }
      }
    }
  }
  throw new Error('No agreement_partner_name tab in the built envelope — clause 1 would be blank.')
}

console.log('Prepared — nothing has been created or sent.\n')
console.log(`  partner        ${partner.name}  <${partner.email}>`)
// READ OFF THE BUILT ENVELOPE, not computed a second time. This line used
// to call partyName() again on the row, which was a second place the same
// fact was written — and the moment `legal_name` arrived it drifted: the
// envelope carried "Jimi P Maciel dba MileMogul" while this line printed
// "MileMogul", so the one number a reviewer checks disagreed with the
// payload it was meant to describe. Same reason prefillValues() was
// deleted from docusign-envelope.ts. The tab is the single source.
console.log(`  clause 1 names ${clauseOneName(envelope)}`)
console.log(`  status         ${partner.status} / agreement ${partner.agreement_status ?? 'null'}`)
console.log(`  template       ${AGREEMENT_TEMPLATE_ID}`)
console.log(`  tax status     ${partner.tax_status ?? 'NOT RECORDED'}`)
console.log(`  notice address ${noticeAddress ?? 'NOT SUPPLIED — the partner will type it'}`)
console.log(`  subject        ${envelope.emailSubject}`)
console.log(`\n  payload   ${outFile}`)
console.log(
  '\nNext: review the payload, then create it as a DRAFT in DocuSign and open it in\n' +
    'the web console to check tab placement before anything is sent.\n' +
    '\nWhat to check: the name and email in clause 1 and the notices clause are on\n' +
    "SHIPO's side of the envelope, prefilled and locked, so both parties can read\n" +
    'the counterparty from page 1. Envelope 79dee1b4 had them on the partner and\n' +
    'Ophir saw blanks, because DocuSign renders only the current recipient\'s tabs.\n' +
    (noticeAddress
      ? 'The address is prefilled too, so no box on the agreement should look empty.'
      : 'No address was supplied, so clause 1 will show ONE empty box for the partner\n' +
        'to type — that is correct; check the box is THERE and sits on the right line.'),
)
