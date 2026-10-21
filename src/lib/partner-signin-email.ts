import { supabaseAdmin } from '@/lib/supabase'
import { sendEmail } from '@/lib/email'
import { sha256Hex, generateCode, normalizeEmail, CODE_TTL_MINUTES } from '@/lib/partner-auth'
import {
  portalAccessBlock,
  portalAccessBlockedReason,
  type AccessCandidate,
} from '@/lib/partner-access'
import { generateLinkToken, signInLinkUrl, linkExpiresAt } from '@/lib/partner-login-link'
import { isMissingLinkColumn, loginLinkLines, signInLinkOrigin } from '@/lib/partner-login-issue'

// THE ONE EMAIL THAT CARRIES A PARTNER INTO THE PORTAL. Spec §2.1, §2.2.
//
// =====================================================================
// WHY THIS IS ONE FUNCTION AND NOT THREE COPIES
//
// Three paths mail a partner his way in: the DocuSign webhook the moment
// he finishes signing, the staff invite button on /referrals, and the
// login screen's own request-code. All three must produce the SAME
// message, because a partner who receives a different-looking email
// depending on which path fired cannot tell the automated one from a
// phishing attempt — and this email carries a credential, so that is the
// exact judgement we are asking him to make. The invite used to hold a
// second copy of the body, and it had already drifted.
//
// WHY THE GATE IS IN HERE RATHER THAN AT EACH CALL SITE
//
// Spec §2.2 says creating the entitlement sends the email. Shipo's
// standing rule is that the agreement is signed BEFORE access. Where the
// two disagree, access wins: a working credential mailed to someone who
// has not signed is the one failure nobody reports, because the email
// looks right and the partner is pleased to have it.
//
// A gate a caller has to remember is a gate that gets forgotten exactly
// once, and there are already three callers. So portalAccessBlock runs
// HERE, before any credential is minted — not after, and not upstream.
// =====================================================================

/**
 * What a caller has to know about the partner. A row from
 * referral_partners, or the fields of one.
 *
 * `request_ip` is the one thing here that is not partner identity, and it
 * is recorded rather than used: nothing reads the column, it exists so a
 * flood can be traced after the fact. It may ride on the input while a
 * request ORIGIN may not, and the difference is not stylistic — an
 * attacker-supplied origin would point the mailed link at his own host,
 * while an attacker-supplied IP string can only make a forensic record
 * wrong. One redirects a credential; the other mislabels a log line.
 */
export interface SignInEmailPartner extends AccessCandidate {
  id: string
  name?: string | null
  request_ip?: string | null
}

/**
 * Discriminated, and never a bare boolean.
 *
 * Every caller logs this and one of them (the login screen) turns it into
 * an HTTP status. "No email arrived" is otherwise an unanswerable support
 * question: blocked, no address on file, the database refused the write,
 * and the mail provider refused the send are four different problems with
 * four different fixes, and they are indistinguishable from the outside.
 *
 * NO CREDENTIAL IS IN HERE. The code and the token are deliberately
 * absent from every variant, because the caller is a route that answers a
 * browser and a result in hand is one careless `NextResponse.json(result)`
 * away from the wire.
 */
export type SignInEmailResult =
  | { sent: true; provider: string; linkIssued: boolean }
  | { sent: false; reason: 'blocked'; blocked: string }
  | { sent: false; reason: 'no-email' }
  | { sent: false; reason: 'insert-failed'; error: string }
  | { sent: false; reason: 'send-failed'; provider: string; error?: string }

/**
 * Mint a single-use code and a single-use link, store their hashes, and
 * mail both to the partner.
 *
 * TAKES ONE ARGUMENT, AND THE ARITY IS A SECURITY PROPERTY. There is no
 * origin parameter: see signInLinkOrigin, which reads server config only.
 * A request arriving with `Origin: https://evil.example` must not be able
 * to make Shipo mail the real partner a real token pointed somewhere else,
 * and the attacker needs no reply — the partner's own click delivers it.
 * Do not add a second parameter to this function.
 */
export async function sendSignInEmail(partner: SignInEmailPartner): Promise<SignInEmailResult> {
  // THE GATE, BEFORE ANYTHING IS MINTED. Not after: a row written but not
  // mailed is a live credential sitting in the database for days with
  // nobody expecting it, which is strictly worse than no row at all.
  //
  // no_email is split out from the rest because it is not a refusal of
  // this partner — it is a missing field, and the caller's remedy is to
  // add an address rather than to explain a policy.
  const block = portalAccessBlock(partner)
  if (block === 'no_email') return { sent: false, reason: 'no-email' }
  if (block) {
    // portalAccessBlockedReason, not the key: the caller logs this for
    // support, and 'unsigned' is not a sentence anyone can act on.
    return { sent: false, reason: 'blocked', blocked: portalAccessBlockedReason(partner)! }
  }

  const email = normalizeEmail(partner.email) || (partner.email as string)

  const code = generateCode()
  const codeHash = await sha256Hex(code)
  const expiresAt = new Date(Date.now() + CODE_TTL_MINUTES * 60_000).toISOString()

  // The one-click link, issued on the SAME ROW as the code. Spec §2.1.
  //
  // One row with two ways to redeem it, sharing one consumed_at, is the
  // design and not an economy: signing in by link must retire the code
  // that travelled in the same email, and vice versa. Two rows, or two
  // consumed flags, would leave a live credential in a mailbox after its
  // owner was already inside.
  const linkToken = generateLinkToken()
  const linkTokenHash = await sha256Hex(linkToken)
  const linkUrl = signInLinkUrl(signInLinkOrigin(), linkToken)

  // Anything still outstanding for this partner is retired first, so a
  // fresh email always invalidates the one before it. Scoped by
  // referral_partner_id — an `eq` missing here would sign every other
  // partner out on one person's signature.
  await supabaseAdmin
    .from('partner_login_codes')
    .update({ consumed_at: new Date().toISOString() })
    .eq('referral_partner_id', partner.id)
    .is('consumed_at', null)

  const row = {
    referral_partner_id: partner.id,
    email,
    code_hash: codeHash,
    expires_at: expiresAt,
    attempts: 0,
    request_ip: partner.request_ip ?? null,
  }

  let { error: insertError } = await supabaseAdmin.from('partner_login_codes').insert({
    ...row,
    link_token_hash: linkTokenHash,
    link_expires_at: linkExpiresAt().toISOString(),
  })

  // DEGRADE, DO NOT FAIL. supabase/partner_login_link.sql is applied by
  // hand in the Supabase SQL editor and nothing sequences it against a
  // deploy, so this code can reach production before its two columns do.
  // PostgREST answers that with 42703. Treating it as fatal would turn
  // "the migration is a day late" into "nobody can log in", which is far
  // worse than "no link in today's email" — the 6-digit code in the same
  // message is a working way in either way.
  //
  // Narrow by isMissingLinkColumn, never a blanket retry: a unique
  // violation or a dead connection must still surface.
  let linkIssued = linkUrl !== null
  if (insertError && isMissingLinkColumn(insertError)) {
    console.error(
      '[partner-signin] link columns missing — apply supabase/partner_login_link.sql. ' +
        'Sending a code-only email:',
      insertError.message,
    )
    linkIssued = false
    ;({ error: insertError } = await supabaseAdmin.from('partner_login_codes').insert(row))
  }

  if (insertError) {
    // The email is the thing that must not happen now. A mailed code with
    // no stored hash is a credential guaranteed to be refused, and the
    // partner has no way to tell that from "Shipo locked me out".
    console.error('[partner-signin] could not store the credential:', insertError.message)
    return { sent: false, reason: 'insert-failed', error: insertError.message }
  }

  // Only after the row is written. An email offering a link whose hash
  // never landed is an email whose link is certain to be refused, and an
  // offered-but-dead link is worse than no link.
  const linkLines = loginLinkLines(linkIssued ? linkUrl : null)
  const firstName = (partner.name ?? '').split(' ')[0] || 'there'

  // WHAT THIS EMAIL DELIBERATELY DOES NOT SAY. No commission figure, no
  // client name, no money of any kind. It is delivered the moment the
  // agreement is signed — before the partner has ever opened the portal —
  // and it travels through infrastructure Shipo does not own and the
  // partner did not choose. It is a way in and nothing else.
  const result = await sendEmail({
    to: email,
    subject: `${code} is your Shipo partner login code`,
    // Support@ is the only address this email names. A reply here is
    // either "this code doesn't work" or "I didn't ask for this", and both
    // want a staffed mailbox. security@ is the shared From identity for
    // all system mail and is nobody's inbox.
    replyTo: 'Support@shipousa.com',
    text:
      `Hi ${firstName},\n\n` +
      `Your Shipo partner portal code is ${code}\n\n` +
      `It expires in ${CODE_TTL_MINUTES} minutes and can be used once.\n\n` +
      linkLines.text +
      `If you didn't ask for this, you can ignore this email — nobody can get in without the code.\n\n` +
      `Shipo LLC · 310 Cornell Dr, Suite B4, Wilmington, DE 19801 · Support@shipousa.com`,
    html:
      `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#111">` +
      `<p style="margin:0 0 16px">Hi ${firstName},</p>` +
      `<p style="margin:0 0 8px">Your Shipo partner portal code is:</p>` +
      `<p style="font-size:34px;font-weight:700;letter-spacing:8px;margin:16px 0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace">${code}</p>` +
      `<p style="margin:0 0 16px;color:#555">It expires in ${CODE_TTL_MINUTES} minutes and can be used once.</p>` +
      linkLines.html +
      `<p style="margin:0 0 24px;color:#555">If you didn&rsquo;t ask for this, you can ignore this email &mdash; nobody can get in without the code.</p>` +
      `<hr style="border:none;border-top:1px solid #e5e5e5;margin:24px 0">` +
      `<p style="margin:0;font-size:12px;color:#888">Shipo LLC &middot; 310 Cornell Dr, Suite B4, Wilmington, DE 19801 &middot; Support@shipousa.com</p>` +
      `</div>`,
  })

  if (!result.sent) {
    // The PROVIDER NAME matters to whoever reads this. sendEmail fails for
    // three reasons wanting three different fixes: 'none' means no mail
    // env var is set in THIS environment (fix it in Vercel, not at the
    // provider), the provider's own name means the key is set and the
    // provider refused, and 'error' means sendEmail threw.
    console.error('[partner-signin] email send failed:', result.provider, result.error)
    return {
      sent: false,
      reason: 'send-failed',
      provider: result.provider,
      error: result.error,
    }
  }

  return { sent: true, provider: result.provider, linkIssued }
}
