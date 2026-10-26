// Mail every listed partner the portal guide. Once each.
//
//   npx tsx --env-file=.env.local scripts/send-partner-guide.mts          # dry run
//   npx tsx --env-file=.env.local scripts/send-partner-guide.mts --send   # really send
//
// DRY RUN IS THE DEFAULT and that is not politeness. This walks a list
// of real people and mails them; a flag you have to add is the
// difference between reading the plan and performing it.
//
// WHAT STOPS A SECOND COPY
//
// referral_partners.guide_sent_at. Without it there is no way to ask
// "has this person already had the guide", and a script that cannot
// ask will cheerfully mail the same partner on every run. So the
// column is REQUIRED: if it is missing this refuses and prints the one
// line of SQL that adds it, rather than sending and hoping somebody
// remembers not to run it twice.
//
// WHO IS SKIPPED
//
// Anyone the portal's own access gate would turn away — unsigned
// agreement, inactive, declined, voided, no email. buildPartnerGuideEmail
// returns null for them and the reason is printed. Mailing "here is how
// to use your dashboard" to somebody who cannot get in reads as a broken
// product, and they have no way to tell that from an unsigned agreement.

import { createClient } from '@supabase/supabase-js'
import { buildPartnerGuideEmail, type GuideCandidate } from '../src/lib/partner-guide-email'
import { portalAccessBlockedReason } from '../src/lib/partner-access'
import { signInLinkOrigin } from '../src/lib/partner-login-issue'
import { sendEmail } from '../src/lib/email'

const SEND = process.argv.includes('--send')

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.')
  process.exit(2)
}

// Which host the partner is told to visit. Refuse rather than guess:
// a guide that points at the wrong origin sends every partner to a
// page that will not know them, and the mail cannot be recalled.
const origin = signInLinkOrigin()
if (!origin) {
  console.error(
    'No portal origin. Set NEXT_PUBLIC_PARTNER_URL (e.g. https://partners.shipousa.com)\n' +
      'or NEXT_PUBLIC_SITE_URL before running this — the guide prints a link and a\n' +
      'wrong one cannot be taken back.',
  )
  process.exit(2)
}

const db = createClient(url, key, { auth: { persistSession: false } })

const { data, error } = await db
  .from('referral_partners')
  .select('id, name, email, status, agreement_status, guide_sent_at')
  .order('created_at', { nullsFirst: false })

if (error) {
  // The one error worth translating: the column this script depends on.
  if (/guide_sent_at/.test(error.message)) {
    console.error(
      'referral_partners.guide_sent_at does not exist, so nothing can record who has\n' +
        'already had the guide. Refusing to send. Add it first:\n\n' +
        '  alter table referral_partners add column if not exists guide_sent_at timestamptz;\n',
    )
    process.exit(2)
  }
  console.error('Could not read referral_partners:', error.message)
  process.exit(2)
}

type Row = GuideCandidate & { guide_sent_at?: string | null }
const rows = (data ?? []) as Row[]

console.log(`${rows.length} partner row(s). Portal origin: ${origin}`)
console.log(SEND ? 'MODE: sending for real.\n' : 'MODE: dry run — nothing will be sent.\n')

let sent = 0
let failed = 0
const skipped: string[] = []

for (const row of rows) {
  const label = `${row.name ?? '(no name)'} <${row.email ?? 'no email'}>`

  if (row.guide_sent_at) {
    skipped.push(`${label} — already sent ${row.guide_sent_at}`)
    continue
  }

  const mail = buildPartnerGuideEmail(row, origin)
  if (!mail) {
    skipped.push(`${label} — ${portalAccessBlockedReason(row) ?? 'cannot access the portal'}`)
    continue
  }

  if (!SEND) {
    console.log(`WOULD SEND  ${label}`)
    console.log(`            subject: ${mail.subject}`)
    sent++
    continue
  }

  const result = await sendEmail({
    to: row.email!,
    subject: mail.subject,
    html: mail.html,
    text: mail.text,
    // The footer tells them to reply; From is a shared env var that
    // defaults to security@. Without this the two disagree.
    replyTo: 'Support@shipousa.com',
  })

  if (!result.sent) {
    console.log(`FAILED      ${label} — ${result.error ?? 'no reason given'} (${result.provider})`)
    failed++
    continue
  }

  // Stamp only AFTER the provider accepted it. Stamping first would
  // mark a partner as told on a send that never left.
  const { error: stampError } = await db
    .from('referral_partners')
    .update({ guide_sent_at: new Date().toISOString() })
    .eq('id', row.id)

  if (stampError) {
    // Loud, because the mail DID go and the record did not. The next
    // run would send it again.
    console.log(`SENT, NOT RECORDED  ${label} — ${stampError.message}`)
    console.log('            Set guide_sent_at by hand or this partner gets a second copy.')
    failed++
    continue
  }

  console.log(`SENT        ${label} (${result.provider})`)
  sent++
}

if (skipped.length) {
  console.log('\nSkipped:')
  for (const line of skipped) console.log(`  ${line}`)
}

console.log(
  `\n${SEND ? 'Sent' : 'Would send'}: ${sent}   Skipped: ${skipped.length}   Failed: ${failed}`,
)
if (!SEND && sent > 0) console.log('Re-run with --send to actually mail them.')

process.exit(failed > 0 ? 1 : 0)
