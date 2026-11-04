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
   * Value sent as the legacy SecureKey. A ZEN_SECURE or ZENVENTORY_SECURE
   * variable wins. Otherwise this is the secret: Zenventory uses the same
   * value for both. Null only when the secret itself is missing.
   */
  secureKey: string | null
}

function present(value: string | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
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
 * order applies to SECRET. SECURE is `ZEN_${slug}_SECURE`, then
 * `ZENVENTORY_SECURE_${slug}`, then the secret (`ZEN_${slug}_SECRET`, then
 * `ZENVENTORY_SECRET_${slug}`). The pick push is configured once the key and
 * secret are present. A missing variable is named in the notice. The value
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
  // Zenventory's secure value is the secret unless a secure variable is set.
  const secureKey = dedicatedSecure.value ?? apiSecret.value
  const missing: string[] = []
  if (!apiKey.value) missing.push(apiKey.label)
  if (!apiSecret.value) missing.push(apiSecret.label)
  if (missing.length > 0 || !apiKey.value || !apiSecret.value || (options.requireSecure && !secureKey)) {
    return {
      ok: false,
      notice: `${label} Zenventory is ${ZENVENTORY_NOT_CONFIGURED}. Missing ${missing.join(', ')}. `
        + `The pick push uses the secret when no ${names.secure} or ${names.legacySecure} is set.`,
    }
  }
  return {
    ok: true,
    credentials: {
      slug,
      apiKey: apiKey.value,
      apiSecret: apiSecret.value,
      secureKey,
    },
  }
}
