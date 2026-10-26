import { portalAccessBlock, type AccessCandidate } from '@/lib/partner-access'

// THE PARTNER'S GUIDE TO THE PORTAL. Carries no credential.
//
// =====================================================================
// WHY THIS IS NOT PART OF THE SIGN-IN EMAIL
//
// src/lib/partner-signin-email.ts is deliberately the single message
// that carries a way in, because a partner deciding "is this really
// from Shipo" has one shape to learn. Folding a guide into it would
// make that message longer and more variable every time we explain
// something new, which is the opposite of recognisable.
//
// So this one explains, and points at the front door. The partner asks
// for a code THERE. That ordering matters beyond tidiness: a guide is
// the kind of mail that gets forwarded to a bookkeeper or a VA, and a
// forwarded credential is a credential given away.
//
// WHY THE GATE IS IN HERE
//
// Same reason it is inside the sign-in email: a caller has to remember
// a gate exactly once to get it wrong. "Here is how to use your
// dashboard", mailed to somebody the access gate will turn away, reads
// as a broken product rather than as an unsigned agreement — and the
// partner cannot tell those apart from outside. portalAccessBlock is
// the same function the portal itself uses, not a second opinion.
// =====================================================================

export interface GuideCandidate extends AccessCandidate {
  id: string
  name?: string | null
}

export interface GuideEmail {
  subject: string
  html: string
  text: string
}

const INK = '#0b3361'
const ACCENT = '#e0ee47'
const SURFACE = '#f4f8fd'
const BODY = '#1f2937'
const MUTED = '#6b7280'

/**
 * Escape for HTML, and force the result into ASCII.
 *
 * The numeric-entity pass is not decoration. A mail client that
 * ignores the charset declaration and guesses Latin-1 renders every
 * multi-byte character as mojibake, and a partner called Hulya spelled
 * with an umlaut would be greeted by name, wrongly, in a message whose
 * whole job is to look legitimate. Entities are charset-independent,
 * so there is nothing left to guess about.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/[^\x20-\x7E]/g, (c) => `&#${c.codePointAt(0)};`)
}

/** First name only — "Hi Dana" rather than "Hi Dana Katz Consulting LLC". */
function firstName(name?: string | null): string {
  const trimmed = (name ?? '').trim()
  if (!trimmed) return 'there'
  return trimmed.split(/\s+/)[0]
}

/**
 * What a partner can actually see, in the order the portal shows it.
 *
 * Read off src/components/partner/Statement.tsx rather than imagined.
 * A guide that promises a section the portal does not have sends the
 * partner hunting for it and makes every other line less believable.
 */
const SECTIONS: Array<{ title: string; body: string }> = [
  {
    title: 'What you have earned',
    body: 'Month by month, with the one-time bonus and the monthly share listed separately so you can see where each figure came from.',
  },
  {
    title: 'How this is calculated',
    body: 'The full working: the one-time $300, the 5% of net profit for 12 months, and exactly what Shipo counts as net profit.',
  },
  {
    title: 'Clients you referred',
    body: 'Everyone confirmed as yours, and the month their clock started.',
  },
  {
    title: "Clients you've told us about",
    body: 'Claims you have filed that are still with us for review.',
  },
  {
    title: 'Order activity and FBA prep activity',
    body: 'The shipping and prep volume behind the numbers, so a month is never just a total you have to take on trust.',
  },
  {
    title: 'Your account',
    body: 'Your agreement, your tax form, and anything still outstanding.',
  },
]

/**
 * Build the guide, or refuse.
 *
 * Returns null when the access gate would turn this partner away. Null
 * rather than a throw because the caller's job is to skip them quietly
 * and keep going down the list, not to abort the run.
 *
 * `origin` is passed in rather than read from the environment so that
 * the caller decides once, visibly, which host a partner is being sent
 * to — and so this stays a pure function the tests can pin.
 */
export function buildPartnerGuideEmail(partner: GuideCandidate, origin: string): GuideEmail | null {
  if (portalAccessBlock(partner) !== null) return null

  const base = origin.replace(/\/+$/, '')
  const portal = `${base}/partner`
  const who = escapeHtml(firstName(partner.name))

  const sectionsHtml = SECTIONS.map(
    (s) => `
      <tr>
        <td style="padding:0 0 14px">
          <div style="font-size:14px;font-weight:700;color:${INK}">${escapeHtml(s.title)}</div>
          <div style="font-size:14px;line-height:21px;color:${BODY};margin-top:3px">${escapeHtml(s.body)}</div>
        </td>
      </tr>`,
  ).join('')

  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
</head>
<body style="margin:0;padding:0;background:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;color:${BODY}">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff">
    <tr>
      <td align="center" style="padding:0">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:100%">

          <tr>
            <td style="background:${INK};border-bottom:5px solid ${ACCENT};padding:18px 24px">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td align="left" style="vertical-align:middle">
                    <img src="${base}/shipo-logo.png" alt="Shipo" width="111" height="42" style="display:block;border:0" />
                  </td>
                  <td align="right" style="vertical-align:middle;font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#ffffff">
                    Partner Portal
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <tr>
            <td style="padding:28px 24px 0">
              <p style="margin:0 0 14px;font-size:15px">Hi ${who},</p>
              <p style="margin:0 0 14px;font-size:15px;line-height:23px">
                Your Shipo partner dashboard is open. It shows what you have earned, the clients
                credited to you, and the working behind every figure. Here is how to reach it and
                what you will find.
              </p>
            </td>
          </tr>

          <tr>
            <td style="padding:10px 24px 0">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${SURFACE};border-radius:6px">
                <tr>
                  <td style="padding:18px 20px">
                    <div style="font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:${MUTED}">Your dashboard</div>
                    <div style="margin-top:6px;font-size:16px;font-weight:700">
                      <a href="${portal}" style="color:${INK};text-decoration:underline">${portal}</a>
                    </div>
                    <div style="margin-top:10px;font-size:14px;line-height:21px;color:${BODY}">
                      Open that link and enter this email address. Shipo sends you a short code to
                      type in &mdash; there is no password to remember or lose. The code is good for a
                      few minutes and only ever arrives by email.
                    </div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <tr>
            <td style="padding:26px 24px 0">
              <div style="font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:${MUTED};padding-bottom:12px">What you can see</div>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${sectionsHtml}</table>
            </td>
          </tr>

          <tr>
            <td style="padding:12px 24px 0">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-left:4px solid ${ACCENT};background:${SURFACE};border-radius:4px">
                <tr>
                  <td style="padding:16px 18px">
                    <div style="font-size:14px;font-weight:700;color:${INK}">Please add the clients you referred</div>
                    <div style="margin-top:6px;font-size:14px;line-height:21px;color:${BODY}">
                      This is the one thing we need from you. On your dashboard, under the list of
                      your clients, use <strong>&ldquo;+ Add a client you referred&rdquo;</strong>.
                      Only the company name is required &mdash; a website or the person you dealt with
                      makes it quicker to confirm. If you have several, there is an
                      <strong>&ldquo;Add several clients at once&rdquo;</strong> box where you can
                      paste one company name per line.
                    </div>
                    <div style="margin-top:8px;font-size:14px;line-height:21px;color:${BODY}">
                      A person at Shipo reviews every claim by hand, so a client will sit under
                      &ldquo;Clients you&rsquo;ve told us about&rdquo; until it is confirmed. That
                      wait is the process working, not a fault.
                    </div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <tr>
            <td style="padding:22px 24px 0">
              <div style="font-size:13px;line-height:20px;color:${MUTED}">
                One thing worth setting expectations on: a month only becomes payable once Shipo has
                finished billing it. Until then your dashboard marks it provisional and shows no
                amount owed. Early months can sit that way for a while, and a client appearing with
                no money against it yet is normal.
              </div>
            </td>
          </tr>

          <tr>
            <td style="padding:26px 24px 30px">
              <div style="border-top:1px solid ${SURFACE};padding-top:16px;font-size:12px;line-height:19px;color:${MUTED}">
                Questions about a figure, or something that looks wrong? Reply to this email or write
                to <a href="mailto:Support@shipousa.com" style="color:${INK}">Support@shipousa.com</a>
                within 30 days of receiving a statement.
                <br /><br />
                Shipo will never ask you for a password, and the only thing we will ever email you to
                type in is a short sign-in code you asked for yourself.
                <br /><br />
                Shipo LLC &middot; 310 Cornell Dr, Suite B4, Wilmington, DE 19801
              </div>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`

  const text = [
    `Hi ${firstName(partner.name)},`,
    '',
    'Your Shipo partner dashboard is open. It shows what you have earned, the clients',
    'credited to you, and the working behind every figure.',
    '',
    'YOUR DASHBOARD',
    portal,
    '',
    'Open that link and enter this email address. Shipo sends you a short code to type',
    'in - there is no password to remember or lose. The code is good for a few minutes',
    'and only ever arrives by email.',
    '',
    'WHAT YOU CAN SEE',
    ...SECTIONS.map((s) => `  * ${s.title} - ${s.body}`),
    '',
    'PLEASE ADD THE CLIENTS YOU REFERRED',
    'This is the one thing we need from you. On your dashboard, under the list of your',
    'clients, use "+ Add a client you referred". Only the company name is required - a',
    'website or the person you dealt with makes it quicker to confirm. If you have',
    'several, there is an "Add several clients at once" box where you can paste one',
    'company name per line.',
    '',
    'A person at Shipo reviews every claim by hand, so a client will sit under "Clients',
    "you've told us about\" until it is confirmed. That wait is the process working, not",
    'a fault.',
    '',
    'A month only becomes payable once Shipo has finished billing it. Until then your',
    'dashboard marks it provisional and shows no amount owed. Early months can sit that',
    'way for a while, and a client appearing with no money against it yet is normal.',
    '',
    'Questions about a figure, or something that looks wrong? Reply to this email or',
    'write to Support@shipousa.com within 30 days of receiving a statement.',
    '',
    'Shipo will never ask you for a password, and the only thing we will ever email you',
    'to type in is a short sign-in code you asked for yourself.',
    '',
    'Shipo LLC - 310 Cornell Dr, Suite B4, Wilmington, DE 19801',
  ].join('\n')

  return {
    subject: 'Your Shipo partner dashboard: how to get in and what to do first',
    html,
    text,
  }
}
