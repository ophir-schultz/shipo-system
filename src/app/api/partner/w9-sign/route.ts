import { NextResponse } from 'next/server'
import { getPartnerFromSession } from '@/lib/partner-auth'
import { buildW9Envelope } from '@/lib/docusign-envelope'
import { W9_PAGE1_BASE64 } from '@/lib/w9-page1-base64'
import { W9_SIGN_FALLBACK, w9SignRefusal } from '@/lib/partner-w9-sign'
import {
  DocusignError,
  createEnvelope,
  createRecipientView,
  docusignConfig,
} from '@/lib/docusign-client'

export const dynamic = 'force-dynamic'

// ============================================================
// The partner signs his W-9 inside his own dashboard. Spec §2a.
//
// THIS IS THE ONLY SEND THIS APPLICATION PERFORMS. The agreement goes out
// by hand from a script, reviewed as a draft by a human first. This one
// fires when a partner clicks a button, with nobody watching, so every
// condition that would make the send wrong is checked before it — and
// checked in w9SignRefusal, a pure function with its own tests, because
// none of those conditions can be reached by a test that has to stand up
// a session and a DocuSign account first.
//
// WHAT NEVER HAPPENS HERE:
//   - The taxpayer identification number never reaches this process. The
//     partner types it into DocuSign. We record a timestamp, later, from
//     the Connect webhook. There is no field on this route for one.
//   - The signing URL is never logged. It is a bearer credential: anyone
//     holding it can sign as this partner until it expires.
//   - The accountant's address is never defaulted. A W-9 copied to nobody
//     is the failure §2a.5 names, and it looks exactly like success.
//
// A GATE WITH NO EXIT IS A LOCKOUT. This screen stands between a partner
// and money he is owed, so every refusal below carries a sentence he can
// act on. §2a.9.1.
// ============================================================

export async function POST(req: Request) {
  // Re-asks the portal gate, so this covers "is there a session" and
  // "may this person still use the portal" in one read. A partner whose
  // agreement was voided this morning does not get a tax form.
  const partner = await getPartnerFromSession()

  const accountantEmail = process.env.ACCOUNTANT_W9_EMAIL
  const accountantName = process.env.ACCOUNTANT_W9_NAME
  // THE ONLY PLACE THESE ARE READ. Passed down as arguments from here so
  // that no builder, and no test, can quietly pick up an environment.
  const cfg = docusignConfig()

  const refusal = w9SignRefusal({
    partner,
    accountantEmail,
    accountantName,
    docusignConfigured: cfg !== null,
  })

  if (refusal) {
    if (refusal.log) console.error(`[w9-sign] ${refusal.log}`)
    return NextResponse.json({ error: refusal.message }, { status: refusal.status })
  }

  // All three are established past the ladder; TypeScript cannot see that
  // through a function boundary, and the alternative — inlining the checks
  // so it can — is what the ladder exists to avoid. So this is a narrowing
  // guard, not a second opinion: if it ever fires, the ladder is wrong.
  if (!partner || !partner.email || !cfg) {
    console.error('[w9-sign] reached the send with no partner or no config — ladder bug')
    return NextResponse.json({ error: W9_SIGN_FALLBACK }, { status: 503 })
  }

  let envelope: ReturnType<typeof buildW9Envelope>
  try {
    envelope = buildW9Envelope({
      partner: {
        id: partner.id,
        name: partner.name,
        email: partner.email,
        company: partner.company,
        tax_status: partner.tax_status,
      },
      w9DocumentBase64: W9_PAGE1_BASE64,
      accountantEmail: accountantEmail!,
      accountantName: accountantName!,
      // What makes the recipient EMBEDDED. With it DocuSign stops
      // emailing him and expects us to produce a signing URL; without it
      // he gets an email and this route's URL request fails. The partner
      // id, so the same value identifies him in the envelope's custom
      // fields, in the recipient, and in the view request below.
      clientUserId: partner.id,
    })
  } catch (e) {
    // The builder throws for a partner the IRS wants a different form
    // from (§2a.7). w9SignRefusal already answered that case in partner
    // voice, so reaching here means a condition it does not know about —
    // a missing name or email on the row. Staff bug, partner-safe reply.
    console.error('[w9-sign] builder refused:', (e as Error).message)
    return NextResponse.json({ error: W9_SIGN_FALLBACK }, { status: 409 })
  }

  // THE ONE PLACE A BUILDER'S DRAFT IS PROMOTED TO A SEND, and it is
  // written out here rather than changed in the builder so that "every
  // builder returns a draft" stays true and the single exception sits at
  // the line a human authorised.
  //
  // An embedded recipient view requires a sent envelope: DocuSign will
  // not produce a signing URL for a draft. So this is a send, and it is
  // the partner asking for it — he clicked the button on the screen that
  // tells him what it does.
  const sendable = { ...envelope, status: 'sent' }

  let url: string
  try {
    const created = await createEnvelope(sendable, cfg)
    // The envelope id is safe to log and worth logging: §2a.8 wants the
    // W-9 envelope traceable alongside the agreement's, and if the
    // Connect webhook never arrives this line is the only record that we
    // sent anything. The id is not a credential.
    console.log(`[w9-sign] envelope ${created.envelopeId} (${created.status}) for partner ${partner.id}`)

    url = await createRecipientView(
      created.envelopeId,
      {
        // Exactly what the envelope carries. DocuSign matches on all
        // three together and answers "unknown recipient" when one
        // differs — which the partner experiences as a dead button.
        email: partner.email,
        userName: partner.name,
        clientUserId: partner.id,
        returnUrl: `${req.headers.get('origin') ?? new URL(req.url).origin}/partner`,
      },
      cfg,
    )
  } catch (e) {
    // §2a.9.1. The envelope may well exist at this point — it is sitting
    // in DocuSign, emailless because the recipient is embedded. That is
    // recoverable by hand and the partner must not be left on a dead
    // screen while it is, so he gets the fallback sentence.
    const err = e as DocusignError
    console.error('[w9-sign] DocuSign call failed:', err.message)
    return NextResponse.json({ error: W9_SIGN_FALLBACK }, { status: 502 })
  }

  // NOT LOGGED, NOT STORED, NOT RETURNED ANYWHERE ELSE. One response, to
  // the browser of the partner who asked for it.
  return NextResponse.json({ url })
}
