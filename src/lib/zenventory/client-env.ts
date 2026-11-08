// Per-client Zenventory credentials live in the environment, not in the
// clients table. The slug is the only thing this file maps. The key and
// secret are read when a sync or a pick runs, and they are not stored.
// This file never prints an env value.

export const ZENVENTORY_NOT_CONFIGURED = 'not configured'

/** Client name, compared after trimming and lower-casing, to an env slug. */
export const ZENVENTORY_CLIENT_SLUGS: Record<string, string> = {
  nayax: 'NAYAX',
  orcam: 'ORCAM',
  'creative pea': 'CREATIVEPEA',
  sitnstand: 'SITNSTAND',
  'crisp power': 'CRISP_POWER',
  'time systems (uk) ltd': 'TIMESYSTEMS',
  suteka: 'SUTEKA',
  kivema: 'KIVEMA',
  hexaphoenix: 'HEXAPHOENIX',
  vitamedix: 'VITAMEDIX',
  hippie: 'HIPPIE',
}

export function zenventorySlug(clientName: string): string | null {
  const key = clientName.trim().toLowerCase()
  return ZENVENTORY_CLIENT_SLUGS[key] ?? null
}

export function zenventoryEnvNames(slug: string): {
  key: string
  secret: string
  secure: string
  legacyKey: string
  legacySecret: string
  legacySecure: string
} {
  return {
    key: `ZEN_${slug}_KEY`,
    secret: `ZEN_${slug}_SECRET`,
    secure: `ZEN_${slug}_SECURE`,
    legacyKey: `ZENVENTORY_KEY_${slug}`,
    legacySecret: `ZENVENTORY_SECRET_${slug}`,
    legacySecure: `ZENVENTORY_SECURE_${slug}`,
  }
}

export interface ZenventoryEnvCredentials {
  slug: string
  apiKey: string
  apiSecret: string
  /**
   * Value sent as the legacy SecureKey. Only ZEN_${slug}_SECURE or
   * ZENVENTORY_SECURE_${slug}. The API secret is not a SecureKey: Nayax's
   * legacy pick GET answers 401 when the secret is sent in that header and
   * the secure variable is unset. Null means the pick cannot be sent.
   */
  secureKey: string | null
  /** Env name that supplied the key. A name, never the value. */
  keySource: string
  /** Env name that supplied the secret. A name, never the value. */
  secretSource: string
}

function present(value: string | undefined): string | null {
  if (typeof value !== 'string') return null
  let trimmed = value.trim().replace(/^\uFEFF/, '')
  const quoted = (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  if (quoted && trimmed.length >= 2) trimmed = trimmed.slice(1, -1).trim()
  return trimmed === '' ? null : trimmed
}

function readEither(
  env: Record<string, string | undefined>,
  primary: string,
  legacy: string,
): { value: string | null; label: string } {
  const fromPrimary = present(env[primary])
  if (fromPrimary) return { value: fromPrimary, label: primary }
  const fromLegacy = present(env[legacy])
  if (fromLegacy) return { value: fromLegacy, label: legacy }
  return { value: null, label: `${primary} (or ${legacy})` }
}

/**
 * Key and secret for this client's Zenventory account.
 *
 * `ZEN_${slug}_KEY` is read first, then `ZENVENTORY_KEY_${slug}`. The same
 * order applies to SECRET. The legacy SecureKey is only
 * `ZEN_${slug}_SECURE`, then `ZENVENTORY_SECURE_${slug}`. It is not filled
 * from the secret. A missing variable is named in the notice. The value
 * is not.
 */
export function readZenventoryClientCredentials(
  clientName: string,
  env: Record<string, string | undefined> = process.env,
  options: { requireSecure?: boolean } = {},
): { ok: true; credentials: ZenventoryEnvCredentials } | { ok: false; notice: string } {
  const label = clientName.trim() || 'This client'
  const slug = zenventorySlug(clientName)
  if (!slug) {
    return {
      ok: false,
      notice: `${label} Zenventory is ${ZENVENTORY_NOT_CONFIGURED}. No slug is mapped for this client.`,
    }
  }
  const names = zenventoryEnvNames(slug)
  const apiKey = readEither(env, names.key, names.legacyKey)
  const apiSecret = readEither(env, names.secret, names.legacySecret)
  const dedicatedSecure = readEither(env, names.secure, names.legacySecure)
  const secureKey = dedicatedSecure.value
  const missing: string[] = []
  if (!apiKey.value) missing.push(apiKey.label)
  if (!apiSecret.value) missing.push(apiSecret.label)
  if (options.requireSecure && !secureKey) missing.push(dedicatedSecure.label)
  if (missing.length > 0 || !apiKey.value || !apiSecret.value) {
    return {
      ok: false,
      notice: `${label} Zenventory is ${ZENVENTORY_NOT_CONFIGURED}. Missing ${missing.join(', ')}. `
        + `The legacy pick is not sent unless ${names.secure} or ${names.legacySecure} is set. `
        + `The API secret is not used as that key.`,
    }
  }
  return {
    ok: true,
    credentials: {
      slug,
      apiKey: apiKey.value,
      apiSecret: apiSecret.value,
      secureKey,
      keySource: apiKey.label,
      secretSource: apiSecret.label,
    },
  }
}

/**
 * Credentials for a read-only order load.
 *
 * API 2.0 key and secret are used when both are set. A dedicated SecureKey
 * is enough on its own: Nayax's 2.0 pair can be refused while the legacy
 * key still reads the order. The secret is never copied into the SecureKey.
 */
export function readOrderReadCredentials(
  clientName: string,
  env: Record<string, string | undefined> = process.env,
): { ok: true; credentials: ZenventoryEnvCredentials } | { ok: false; notice: string } {
  const label = clientName.trim() || 'This client'
  const slug = zenventorySlug(clientName)
  if (!slug) {
    return {
      ok: false,
      notice: `${label} Zenventory is ${ZENVENTORY_NOT_CONFIGURED}. No slug is mapped for this client.`,
    }
  }
  const names = zenventoryEnvNames(slug)
  const apiKey = readEither(env, names.key, names.legacyKey)
  const apiSecret = readEither(env, names.secret, names.legacySecret)
  const dedicatedSecure = readEither(env, names.secure, names.legacySecure)
  const pair = Boolean(apiKey.value && apiSecret.value)
  if (!pair && !dedicatedSecure.value) {
    return {
      ok: false,
      notice: `${label} Zenventory is ${ZENVENTORY_NOT_CONFIGURED}. `
        + `Missing ${apiKey.value ? '' : apiKey.label + ', '}${apiSecret.value ? '' : apiSecret.label + ', '}${dedicatedSecure.label}. `
        + `The API secret is not used as the legacy key.`,
    }
  }
  return {
    ok: true,
    credentials: {
      slug,
      apiKey: apiKey.value ?? '',
      apiSecret: apiSecret.value ?? '',
      secureKey: dedicatedSecure.value,
      keySource: apiKey.label,
      secretSource: apiSecret.label,
    },
  }
}
