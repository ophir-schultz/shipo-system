// Does Shipo agree with DocuSign about who has signed?
//
//   npx tsx --env-file=.env.local scripts/audit-partner-agreements.mts
//
// Exits 1 when anything CRITICAL is found, so it can gate a cron or a
// check run. Warnings alone exit 0.
//
// WHY IT EXISTS. Jimi Maciel signed at 2026-10-23T23:38:42Z, DocuSign
// recorded `completed`, and his row stayed `sent` because the completion
// webhook never landed. The portal he had just signed a contract to use
// refused him for three days, and nothing anywhere said so: the webhook
// is the only writer of that column, and one that never arrives raises
// no error and writes no log. See src/lib/partner-agreement-audit.ts.
//
// IT CHANGES NOTHING. No row is stamped. A cron that quietly repairs
// state hides how often the webhook fails, and the repair is one UPDATE
// a human runs with DocuSign's own timestamp in front of them.

import { createClient } from '@supabase/supabase-js'
import {
  auditAgreements,
  docusignVerdict,
  type AgreementRow,
  type EnvelopeVerdict,
} from '../src/lib/partner-agreement-audit'
import { docusignConfig, envelopeStatus } from '../src/lib/docusign-client'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.')
  process.exit(2)
}

const db = createClient(url, key, { auth: { persistSession: false } })

const { data, error } = await db
  .from('referral_partners')
  .select('id, name, email, agreement_status, agreement_sent_at, agreement_signed_at, agreement_envelope_id')

if (error) {
  console.error('Could not read referral_partners:', error.message)
  process.exit(2)
}

const rows = (data ?? []) as AgreementRow[]

const cfg = docusignConfig(process.env)
const verdicts = new Map<string, EnvelopeVerdict>()

if (!cfg) {
  console.log('DocuSign is not configured — every envelope will report as unanswerable.\n')
} else {
  const ids = [...new Set(rows.map((r) => r.agreement_envelope_id).filter((v): v is string => !!v))]
  for (const id of ids) {
    const verdict = docusignVerdict(await envelopeStatus(id, cfg))
    if (verdict) verdicts.set(id, verdict)
  }
  console.log(`Asked DocuSign about ${ids.length} envelope(s); ${verdicts.size} answered.\n`)
}

const findings = auditAgreements(rows, verdicts, new Date())

console.log(`${rows.length} partner row(s) checked.`)

if (findings.length === 0) {
  console.log('No disagreement between Shipo and DocuSign.')
  process.exit(0)
}

for (const f of findings) {
  const tag = f.severity === 'critical' ? 'CRITICAL' : 'warn    '
  console.log(`\n${tag}  ${f.kind}`)
  console.log(`          ${f.name} <${f.email ?? 'no email'}>`)
  console.log(`          envelope ${f.envelopeId ?? '(none)'}`)
  console.log(`          ${f.detail}`)
}

const critical = findings.filter((f) => f.severity === 'critical').length
console.log(`\n${critical} critical, ${findings.length - critical} warning(s).`)
process.exit(critical > 0 ? 1 : 0)
