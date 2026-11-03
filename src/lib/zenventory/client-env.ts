// Per-client Zenventory credentials live in the environment, not in the
// clients table. The slug is the only thing this file maps. The key and
// secret are read when a sync or a pick runs, and they are not stored.

export const ZENVENTORY_NOT_CONFIGURED = 'not configured'

/** Client name, compared after trimming and lower-casing, to an env slug. */
export const ZENVENTORY_CLIENT_SLUGS: Record<string, string> = {
  nayax: 'NAYAX',
  orcam: 'ORCAM',
  'creative pea': 'CREATIVE_PEA',
  sitnstand: 'SITNSTAND',
  'crisp power': 'CRISP_POWER',
  'time systems (uk) ltd': 'TIME_SYSTEMS',
}

export function zenventorySlug(clientName: string): string | null {
  const key = clientName.trim().toLowerCase()
  return ZENVENTORY_CLIENT_SLUGS[key] ?? null
}

export function zenventoryEnvNames(slug: string): { key: string; secret: string; secure: string } {
  return {
    key: `ZENVENTORY_KEY_${slug}`,
    secret: `ZENVENTORY_SECRET_${slug}`,
    secure: `ZENVENTORY_SECURE_${slug}`,
  }
}

export interface ZenventoryEnvCredentials {
  slug: string
  apiKey: string
  apiSecret: string
  /** Legacy pick key. Null when the caller did not require it. */
  secureKey: string | null
}

function present(value: string | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * Key and secret for this client's Zenventory account.
 * `requireSecure` is the legacy pick. A missing variable is not configured,
 * and the notice names the variable. Nothing here reads the clients table.
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
  const missing: string[] = []
  const apiKey = present(env[names.key])
  const apiSecret = present(env[names.secret])
  const secureKey = present(env[names.secure])
  if (!apiKey) missing.push(names.key)
  if (!apiSecret) missing.push(names.secret)
  if (options.requireSecure && !secureKey) missing.push(names.secure)
  if (missing.length > 0 || !apiKey || !apiSecret) {
    return {
      ok: false,
      notice: `${label} Zenventory is ${ZENVENTORY_NOT_CONFIGURED}. Missing ${missing.join(', ')}.`,
    }
  }
  return {
    ok: true,
    credentials: { slug, apiKey, apiSecret, secureKey },
  }
}
