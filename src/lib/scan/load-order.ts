// Read one customer order for the scan screen.
//
// API 2.0 is tried when a key and secret are both set. A 401 from that
// pair is a known Nayax case: the legacy SecureKey still reads
// GET /customerorders and GET /customerorders/{id}/items. The secret is
// never sent as that key. This module does not pick.

export interface OrderReadCredentials {
  apiKey: string
  apiSecret: string
  secureKey: string | null
}

export type OrderReadResult =
  | { loaded: true; source: 'v2' | 'legacy'; body: unknown }
  | { loaded: false; reason: string }

export async function loadScanOrder(input: {
  orderRef: string
  credentials: OrderReadCredentials
  secureLabel: string
  readV2: (apiKey: string, apiSecret: string) => Promise<unknown>
  readLegacy: (secureKey: string) => Promise<unknown>
}): Promise<OrderReadResult> {
  const key = input.credentials.apiKey.trim()
  const secret = input.credentials.apiSecret.trim()
  const secure = input.credentials.secureKey?.trim() ?? ''
  let v2Error = ''
  if (key && secret) {
    try {
      const body = await input.readV2(key, secret)
      return { loaded: true, source: 'v2', body }
    } catch (err) {
      v2Error = err instanceof Error ? err.message : String(err)
    }
  }
  if (!secure) {
    return {
      loaded: false,
      reason: `The order could not be read. ${v2Error || 'No API 2.0 key pair is set.'} `
        + `${input.secureLabel} is not set, so the legacy read was not tried. `
        + `The API secret is not used as that key.`,
    }
  }
  if (secret !== '' && secure === secret) {
    return {
      loaded: false,
      reason: 'The legacy read was not tried. The API secret is not a SecureKey.',
    }
  }
  try {
    const body = await input.readLegacy(secure)
    return { loaded: true, source: 'legacy', body }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const v2 = v2Error ? ` API 2.0 said: ${v2Error}` : ''
    return {
      loaded: false,
      reason: `The order could not be read from the legacy API. ${message}${v2} `
        + `The header name was ${input.secureLabel}. The value was not included.`,
    }
  }
}
