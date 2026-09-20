import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { sendPortalInvite } from '@/lib/partner-invite'

// ============================================================
// DocuSign Connect listener — the step that makes onboarding
// automatic.
//
// When a partner finishes signing, DocuSign POSTs here. This route
// is the ONLY thing in the system allowed to promote a partner from
// `pending` to `active`. An application does not do it, a staff
// member clicking around does not do it, and the partner cannot do
// it for themselves. No signature, no portal.
//
// Configure in DocuSign: Settings -> Connect -> Add Configuration
//   URL:      https://<app-domain>/api/partner/agreement-webhook
//   Format:   JSON
//   Events:   Envelope Completed, Declined, Voided
//   Include:  Envelope Custom Fields  (REQUIRED — see resolvePartner)
//   Sign using HMAC, and put the same secret in DOCUSIGN_CONNECT_SECRET.
//
// This endpoint is public — /api/ is excluded from the proxy's auth
// redirect — so the HMAC is the whole of its security. It fails
// CLOSED: no secret configured means nothing is processed, because
// an unauthenticated caller here could grant themselves a partner
// portal session and read another partner's earnings.
// ============================================================

export const dynamic = 'force-dynamic'

const SIGNATURE_HEADERS = [
  'x-docusign-signature-1',
  'x-docusign-signature-2',
  'x-docusign-signature-3',
]

/** base64(HMAC-SHA256(secret, rawBody)) — DocuSign's Connect scheme. */
async function hmacBase64(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body))
  let bin = ''
  for (const b of new Uint8Array(sig)) bin += String.fromCharCode(b)
  return btoa(bin)
}

/** Length-independent, early-exit-free comparison. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

interface ConnectPayload {
  event?: string
  data?: {
    envelopeId?: string
    envelopeSummary?: {
      status?: string
      customFields?: {
        textCustomFields?: { name?: string; value?: string }[]
      }
      recipients?: {
        signers?: { email?: string; declinedReason?: string }[]
      }
    }
  }
}

function customField(payload: ConnectPayload, name: string): string | null {
  const fields = payload.data?.envelopeSummary?.customFields?.textCustomFields ?? []
  for (const f of fields) {
    if (f?.name?.toLowerCase() === name.toLowerCase() && f.value) return f.value.trim()
  }
  return null
}

/**
 * Find the partner this envelope belongs to.
 *
 * Order matters. `partner_id` is an envelope custom field we set when
 * sending, so it is exact and cannot be spoofed by anything the signer
 * types. Envelope id is next — also ours. Signer email is LAST and is
 * only a fallback, because a signer can change the email an envelope
 * is forwarded to, and matching on it first would let a forwarded
 * envelope attach itself to the wrong partner row.
 */
async function resolvePartner(payload: ConnectPayload, envelopeId: string) {
  const partnerId = customField(payload, 'partner_id')
  if (partnerId) {
    const { data } = await supabaseAdmin
      .from('referral_partners')
      .select('id, name, email, status, agreement_status')
      .eq('id', partnerId)
      .maybeSingle()
    if (data) return data
  }

  const { data: byEnvelope } = await supabaseAdmin
    .from('referral_partners')
    .select('id, name, email, status, agreement_status')
    .eq('agreement_envelope_id', envelopeId)
    .maybeSingle()
  if (byEnvelope) return byEnvelope

  const signerEmail = payload.data?.envelopeSummary?.recipients?.signers?.[0]?.email
  if (signerEmail) {
    const { data: byEmail } = await supabaseAdmin
      .from('referral_partners')
      .select('id, name, email, status, agreement_status')
      .ilike('email', signerEmail.trim())
      .maybeSingle()
    if (byEmail) return byEmail
  }

  return null
}

export async function POST(req: Request) {
  const secret = process.env.DOCUSIGN_CONNECT_SECRET
  if (!secret) {
    console.error('[agreement-webhook] DOCUSIGN_CONNECT_SECRET is not set — refusing to process.')
    return NextResponse.json({ error: 'Webhook not configured.' }, { status: 503 })
  }

  // Raw text first: the HMAC is over the exact bytes DocuSign sent, so
  // re-serialising a parsed object would change the digest.
  const raw = await req.text()

  const expected = await hmacBase64(secret, raw)
  const presented = SIGNATURE_HEADERS.map((h) => req.headers.get(h)).filter(
    (v): v is string => typeof v === 'string' && v.length > 0,
  )
  // DocuSign rotates through up to three signature headers when more
  // than one HMAC key is configured; any one matching is valid.
  if (!presented.some((sig) => timingSafeEqual(sig, expected))) {
    console.error('[agreement-webhook] HMAC mismatch — rejected.')
    return NextResponse.json({ error: 'Invalid signature.' }, { status: 401 })
  }

  let payload: ConnectPayload
  try {
    payload = JSON.parse(raw)
  } catch {
    return NextResponse.json({ error: 'Malformed payload.' }, { status: 400 })
  }

  const envelopeId = payload.data?.envelopeId
  const event = payload.event ?? payload.data?.envelopeSummary?.status ?? 'unknown'
  if (!envelopeId) {
    return NextResponse.json({ error: 'No envelopeId in payload.' }, { status: 400 })
  }

  const partner = await resolvePartner(payload, envelopeId)

  // Idempotency gate. The unique index on (envelope_id, event) is what
  // actually enforces this — checking first and inserting later would
  // race two concurrent retries. A duplicate insert failing is the
  // SUCCESS path here: it means this exact event already ran.
  const { error: ledgerError } = await supabaseAdmin.from('partner_agreement_events').insert({
    envelope_id: envelopeId,
    event,
    referral_partner_id: partner?.id ?? null,
    payload: payload as unknown as Record<string, unknown>,
  })

  if (ledgerError) {
    // 23505 = unique_violation. Already processed; acknowledge so
    // DocuSign stops retrying.
    if ((ledgerError as { code?: string }).code === '23505') {
      return NextResponse.json({ success: true, duplicate: true })
    }
    console.error('[agreement-webhook] ledger insert failed:', ledgerError.message)
    return NextResponse.json({ error: 'Could not record event.' }, { status: 500 })
  }

  if (!partner) {
    // Recorded above, so this is visible and replayable by hand. A 200
    // is deliberate: retrying will not conjure a partner row, and a
    // non-2xx would make DocuSign hammer this endpoint for days.
    console.error(`[agreement-webhook] no partner matched envelope ${envelopeId}`)
    return NextResponse.json({ success: true, matched: false })
  }

  const now = new Date().toISOString()

  if (event === 'envelope-completed' || event === 'completed') {
    // Promote. `active` here is what /api/partner/request-code checks
    // before it will issue a login code at all.
    const { error } = await supabaseAdmin
      .from('referral_partners')
      .update({
        agreement_status: 'signed',
        agreement_signed_at: now,
        agreement_envelope_id: envelopeId,
        status: 'active',
        updated_at: now,
      })
      .eq('id', partner.id)

    if (error) {
      console.error('[agreement-webhook] activation failed:', error.message)
      return NextResponse.json({ error: 'Could not activate partner.' }, { status: 500 })
    }

    // The invite is best-effort. If mail is down the partner is still
    // active and can reach /partner/login unaided, so a send failure
    // must not turn into a retry that re-activates them.
    const invite = await sendPortalInvite(partner, req.headers.get('origin'))
    if (invite.sent) {
      await supabaseAdmin
        .from('referral_partners')
        .update({ portal_invited_at: now })
        .eq('id', partner.id)
    } else {
      console.error('[agreement-webhook] portal invite failed:', invite.provider, invite.error)
    }

    return NextResponse.json({ success: true, activated: true, invited: invite.sent })
  }

  if (event === 'envelope-declined' || event === 'declined') {
    const reason =
      payload.data?.envelopeSummary?.recipients?.signers?.[0]?.declinedReason ?? null
    await supabaseAdmin
      .from('referral_partners')
      .update({
        agreement_status: 'declined',
        agreement_declined_reason: reason,
        updated_at: now,
      })
      .eq('id', partner.id)
    return NextResponse.json({ success: true, declined: true })
  }

  if (event === 'envelope-voided' || event === 'voided') {
    await supabaseAdmin
      .from('referral_partners')
      .update({ agreement_status: 'voided', updated_at: now })
      .eq('id', partner.id)
    return NextResponse.json({ success: true, voided: true })
  }

  // Anything else is recorded and acknowledged, never acted on.
  return NextResponse.json({ success: true, ignored: event })
}
