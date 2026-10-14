// The only code in this application that talks to the DocuSign API.
//
// Everything else builds payloads (docusign-envelope.ts) or reads what
// DocuSign sends us (the Connect webhook). Until now the app held no
// DocuSign credentials at all and every envelope was created by hand; the
// dashboard W-9 cannot work that way, because the partner clicks a button
// and expects a form, with nobody watching.
//
// ====================================================================
// WHAT HAS TO BE IN THE ENVIRONMENT, AND WHERE EACH VALUE IS FOUND
// ====================================================================
// DocuSign admin -> Settings -> Apps and Keys:
//
//   DOCUSIGN_INTEGRATION_KEY   "Integration Key" of the app
//   DOCUSIGN_USER_ID           "User ID" (a GUID) of the account the
//                              envelopes are sent AS -- not an email
//   DOCUSIGN_ACCOUNT_ID        "API Account ID" (a GUID)
//   DOCUSIGN_ACCOUNT_BASE_URI  "Account Base URI", e.g.
//                              https://na3.docusign.net
//   DOCUSIGN_OAUTH_HOST        account.docusign.com for production,
//                              account-d.docusign.com for demo
//   DOCUSIGN_PRIVATE_KEY       the RSA private key generated for the app,
//                              PEM, the whole thing including headers
//
// The app also needs one-time consent for the impersonation scope, granted
// by opening DocuSign's consent URL once as the DOCUSIGN_USER_ID user.
// Until that is done every token request returns `consent_required`.
//
// NOT ONE OF THESE HAS A DEFAULT, deliberately. A guessed oauth host
// sends a real partner's tax form into a demo account, or demo traffic
// into production; a guessed account id signs against somebody else's
// account. There is no safe guess, so missing configuration is a refusal
// that names the variables -- the same fail-closed posture the Connect
// webhook takes on DOCUSIGN_CONNECT_SECRET.
//
// NOTHING HERE MAY BE LOGGED. The access token is a bearer credential for
// the whole account, the assertion is a bearer credential for sixty
// minutes, and a recipient view URL is a bearer credential for one
// signing session. The functions below return them and never print them.

import { createSign } from 'node:crypto'

export const DOCUSIGN_ENV_VARS = [
  'DOCUSIGN_INTEGRATION_KEY',
  'DOCUSIGN_USER_ID',
  'DOCUSIGN_ACCOUNT_ID',
  'DOCUSIGN_PRIVATE_KEY',
  'DOCUSIGN_ACCOUNT_BASE_URI',
  'DOCUSIGN_OAUTH_HOST',
] as const

export interface DocusignConfig {
  integrationKey: string
  userId: string
  accountId: string
  privateKey: string
  /** Bare host, no scheme — this is the JWT `aud`. */
  oauthHost: string
  /** `https://host/restapi`, no trailing slash. */
  restBase: string
}

type Env = Record<string, string | undefined>

const present = (v: string | undefined): boolean => typeof v === 'string' && v.trim() !== ''

/** Which required variables are absent or blank. Empty means configured. */
export function docusignConfigMissing(env: Env): string[] {
  return DOCUSIGN_ENV_VARS.filter((name) => !present(env[name]))
}

/**
 * The configuration, or null if ANY part of it is absent.
 *
 * All-or-nothing on purpose: a half-configured client produces a failure
 * at the socket, several frames away from the variable that caused it.
 */
export function docusignConfig(env: Env = process.env): DocusignConfig | null {
  if (docusignConfigMissing(env).length > 0) return null

  const privateKeyRaw = env.DOCUSIGN_PRIVATE_KEY!.trim()

  return {
    integrationKey: env.DOCUSIGN_INTEGRATION_KEY!.trim(),
    userId: env.DOCUSIGN_USER_ID!.trim(),
    accountId: env.DOCUSIGN_ACCOUNT_ID!.trim(),
    // A dashboard env editor stores a pasted PEM with literal
    // backslash-n sequences. createSign then fails with a DECODER error
    // that reads as a bad key rather than a flattened one, and the
    // obvious response is to regenerate a key that was fine.
    privateKey: privateKeyRaw.replace(/\\n/g, '\n'),
    oauthHost: env
      .DOCUSIGN_OAUTH_HOST!.trim()
      .replace(/^https?:\/\//, '')
      .replace(/\/+$/, ''),
    restBase: `${env.DOCUSIGN_ACCOUNT_BASE_URI!.trim().replace(/\/+$/, '').replace(/\/restapi$/, '')}/restapi`,
  }
}

export interface JwtClaims {
  iss: string
  sub: string
  aud: string
  iat: number
  exp: number
  scope: string
}

/** One hour is DocuSign's maximum for a JWT assertion. */
const ASSERTION_SECONDS = 3600

/**
 * The claims of the JWT assertion exchanged for an access token.
 *
 * `impersonation` is what makes a service account possible: without it
 * the token belongs to nobody and every envelope call returns 401.
 * Signed, not encrypted — nothing secret goes in here.
 */
export function jwtClaims(cfg: DocusignConfig, nowSeconds: number): JwtClaims {
  return {
    iss: cfg.integrationKey,
    sub: cfg.userId,
    aud: cfg.oauthHost,
    iat: nowSeconds,
    exp: nowSeconds + ASSERTION_SECONDS,
    scope: 'signature impersonation',
  }
}

const b64url = (buf: Buffer): string =>
  buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/** Thrown for every DocuSign failure, with no credential in the message. */
export class DocusignError extends Error {
  readonly httpStatus: number | null

  constructor(message: string, httpStatus: number | null = null) {
    super(message)
    this.name = 'DocusignError'
    this.httpStatus = httpStatus
  }
}

function signedAssertion(cfg: DocusignConfig, nowSeconds: number): string {
  const header = b64url(Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })))
  const payload = b64url(Buffer.from(JSON.stringify(jwtClaims(cfg, nowSeconds))))
  const signer = createSign('RSA-SHA256')
  signer.update(`${header}.${payload}`)
  return `${header}.${payload}.${b64url(signer.sign(cfg.privateKey))}`
}

/**
 * Exchange the assertion for an access token.
 *
 * Not cached. A token lasts an hour and this runs once per partner per
 * W-9 — at most a handful of times ever — so a cache would be a shared
 * mutable holding a bearer credential, bought for nothing.
 */
async function accessToken(cfg: DocusignConfig): Promise<string> {
  const res = await fetch(`https://${cfg.oauthHost}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: signedAssertion(cfg, Math.floor(Date.now() / 1000)),
    }),
  })

  const text = await res.text()
  if (!res.ok) {
    // DocuSign's own error codes, passed through because they are the
    // only way to tell these three apart, and they are the three that
    // actually happen. No token and no assertion is echoed.
    const hint = text.includes('consent_required')
      ? ' — the impersonation consent has not been granted for DOCUSIGN_USER_ID'
      : text.includes('invalid_grant')
        ? ' — check DOCUSIGN_USER_ID, DOCUSIGN_INTEGRATION_KEY and the key pair'
        : ''
    throw new DocusignError(`DocuSign token request failed (${res.status})${hint}`, res.status)
  }

  const token = (JSON.parse(text) as { access_token?: string }).access_token
  if (!token) throw new DocusignError('DocuSign returned no access token', res.status)
  return token
}

async function api(
  cfg: DocusignConfig,
  token: string,
  path: string,
  body: unknown,
): Promise<unknown> {
  const res = await fetch(`${cfg.restBase}/v2.1/accounts/${cfg.accountId}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  const text = await res.text()
  if (!res.ok) {
    // The response body is DocuSign's own validation message — which tab
    // is off the page, which recipient did not match. It describes OUR
    // payload, never the partner's data, and it is the difference between
    // a fixable report and "it did not work".
    throw new DocusignError(`DocuSign ${path} failed (${res.status}): ${text.slice(0, 600)}`, res.status)
  }
  return text ? JSON.parse(text) : {}
}

/**
 * Create an envelope and return its id.
 *
 * `envelope` is whatever docusign-envelope.ts built. This function does
 * not inspect it and in particular does not decide `status` — a builder
 * returning 'created' makes a draft and one returning 'sent' sends, and
 * that choice stays visible at the call site that authorised it.
 */
export async function createEnvelope(
  envelope: unknown,
  cfg: DocusignConfig,
): Promise<{ envelopeId: string; status: string }> {
  const token = await accessToken(cfg)
  const out = (await api(cfg, token, '/envelopes', envelope)) as {
    envelopeId?: string
    status?: string
  }
  if (!out.envelopeId) throw new DocusignError('DocuSign created no envelope id')
  return { envelopeId: out.envelopeId, status: out.status ?? 'unknown' }
}

export interface RecipientViewInput {
  email: string
  userName: string
  clientUserId: string
  returnUrl: string
}

/**
 * The body of a recipient-view request.
 *
 * DocuSign matches the recipient on email, name and clientUserId
 * TOGETHER. One mismatch — a trimmed name, a lowercased address, a
 * partner id read off a different column — is a 400 saying "Unknown
 * recipient", which the partner experiences as a dead button. Pulled out
 * as a pure function so that contract is pinned by a test instead of
 * being re-derived by whoever edits the builder next.
 */
export function recipientViewRequest(input: RecipientViewInput) {
  return {
    // We authenticated him ourselves, with an emailed code. `none` is
    // DocuSign's value for that: it must not claim DocuSign verified an
    // identity, because DocuSign did not.
    authenticationMethod: 'none',
    email: input.email,
    userName: input.userName,
    clientUserId: input.clientUserId,
    returnUrl: input.returnUrl,
  }
}

/**
 * The signing URL for an embedded recipient.
 *
 * THE RETURN VALUE IS A BEARER CREDENTIAL. Anybody holding it can sign as
 * this partner until it expires. It is handed to his browser and never
 * logged, stored or included in an error.
 */
export async function createRecipientView(
  envelopeId: string,
  input: RecipientViewInput,
  cfg: DocusignConfig,
): Promise<string> {
  const token = await accessToken(cfg)
  const out = (await api(
    cfg,
    token,
    `/envelopes/${encodeURIComponent(envelopeId)}/views/recipient`,
    recipientViewRequest(input),
  )) as { url?: string }
  if (!out.url) throw new DocusignError('DocuSign returned no signing URL')
  return out.url
}
