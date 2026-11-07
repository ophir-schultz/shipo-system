import axios, { AxiosError } from 'axios'

// Zenventory has TWO APIs on two DIFFERENT paths. Neither of them is /api —
// that path does not exist on the host and returns an Apache HTML 404 page,
// which is indistinguishable from a credentials problem unless you read the body.
//
// API 2.0 — Basic Auth (API Key + API Secret). Spec: https://docs.zenventory.com/openapi.php
const BASE_URL = 'https://app.zenventory.com/rest'

// Legacy REST API — SecureKey header (endpoints not present in API 2.0)
const LEGACY_BASE_URL = 'https://app.zenventory.com/services/rest'

function makeClient(apiKey: string, apiSecret: string) {
  return axios.create({
    baseURL: BASE_URL,
    auth: { username: apiKey, password: apiSecret },
    headers: { 'Content-Type': 'application/json' },
    timeout: 15000,
  })
}

function makeLegacyClient(secureKey: string) {
  return axios.create({
    baseURL: LEGACY_BASE_URL,
    headers: { 'Content-Type': 'application/json', SecureKey: secureKey },
    timeout: 15000,
  })
}

function extractError(err: unknown): string {
  if (err instanceof AxiosError) {
    const status = err.response?.status
    const body = err.response?.data
    const detail = typeof body === 'string' ? body : JSON.stringify(body ?? {})
    return `HTTP ${status}: ${detail.slice(0, 200)}`
  }
  return err instanceof Error ? err.message : String(err)
}

export async function getCustomerOrders(
  apiKey: string,
  apiSecret: string,
  params?: { page?: number; perPage?: number; modifiedSince?: string; orderedSince?: string; orderNumber?: string }
) {
  const c = makeClient(apiKey, apiSecret)
  try {
    const res = await c.get('/customer-orders', {
      params: {
        page: params?.page ?? 1,
        // perPage is capped at 100 by the API; anything higher is rejected.
        perPage: params?.perPage ?? 100,
        // Date filtering uses the Customer Order Advanced Filter, which takes a
        // value parameter plus a matching <field>Conditional. There is no
        // "modifiedFrom" parameter — that name was silently doing nothing.
        ...(params?.modifiedSince
          ? { modifiedDate: params.modifiedSince, modifiedDateConditional: 'on_or_after' }
          : {}),
        ...(params?.orderedSince
          ? { orderedDate: params.orderedSince, orderedDateConditional: 'on_or_after' }
          : {}),
        ...(params?.orderNumber
          ? { orderNumber: params.orderNumber, orderNumberConditional: 'matches' }
          : {}),
      },
    })
    return res.data
  } catch (err) {
    throw new Error(`Zenventory API error: ${extractError(err)}`)
  }
}

/** One read of GET /inventory. The count is meta.count when Zenventory sends it. */
export async function getInventory(
  apiKey: string,
  apiSecret: string,
  params?: { page?: number; perPage?: number },
) {
  const c = makeClient(apiKey, apiSecret)
  try {
    const res = await c.get('/inventory', {
      params: { page: params?.page ?? 1, perPage: params?.perPage ?? 1 },
    })
    return res.data
  } catch (err) {
    throw new Error(`Zenventory API error: ${extractError(err)}`)
  }
}

export async function testZenventoryCredentials(apiKey: string, apiSecret: string) {
  const c = makeClient(apiKey, apiSecret)
  try {
    const res = await c.get('/customer-orders', { params: { page: 1, perPage: 1 } })
    return { ok: true, status: res.status }
  } catch (err) {
    return { ok: false, error: extractError(err) }
  }
}

// Legacy API — requires SecureKey header.
//
// NOTE: there is no GET /shipments in either Zenventory API. This previously
// called that path and could only ever 404. The legacy list endpoint is
// /shippingorders (detail at /shippingorders/{id}, lines at
// /shippingorders/{id}/items). Shipment rows in this app come from ShipStation
// (see lib/api/shipstation.ts), not from here.
export async function getShippingOrders(
  secureKey: string,
  params?: { page?: number; perPage?: number }
) {
  const c = makeLegacyClient(secureKey)
  try {
    const res = await c.get('/shippingorders', {
      params: {
        page: params?.page ?? 1,
        perPage: params?.perPage ?? 100,
      },
    })
    return res.data
  } catch (err) {
    throw new Error(`Zenventory Legacy API error: ${extractError(err)}`)
  }
}

/**
 * Read-only legacy customer order. GET /customerorders, then GET
 * /customerorders/{id}/items. SecureKey is the legacy header. The API
 * secret is not accepted here. Nothing is picked.
 */
export async function getLegacyCustomerOrder(secureKey: string, orderRef: string): Promise<unknown> {
  const c = makeLegacyClient(secureKey)
  let listed: unknown
  try {
    const res = await c.get('/customerorders')
    listed = res.data
  } catch (err) {
    throw new Error(`Zenventory Legacy API error: ${extractError(err)}`)
  }
  const orders = legacyOrders(listed)
  const want = orderRef.trim().toLowerCase()
  const matched = orders.filter((order) => legacyOrderNumber(order).toLowerCase() === want)
  if (matched.length !== 1) {
    return { customerorders: matched }
  }
  const order = matched[0]
  const id = legacyOrderId(order)
  if (!id) return { customerorders: [order] }
  try {
    const items = await c.get(`/customerorders/${id}/items`)
    const rows = Array.isArray(items.data)
      ? items.data
      : Array.isArray((items.data as { items?: unknown } | null)?.items)
        ? (items.data as { items: unknown[] }).items
        : []
    return { customerorders: [{ ...order, items: rows }] }
  } catch (err) {
    throw new Error(`Zenventory Legacy API error: ${extractError(err)}`)
  }
}

function asLegacyRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function legacyOrders(body: unknown): Record<string, unknown>[] {
  if (Array.isArray(body)) {
    return body.map(asLegacyRecord).filter((row): row is Record<string, unknown> => row !== null)
  }
  const record = asLegacyRecord(body)
  if (!record) return []
  for (const key of ['customerorders', 'customerOrders', 'orders']) {
    if (Array.isArray(record[key])) {
      return (record[key] as unknown[]).map(asLegacyRecord).filter((row): row is Record<string, unknown> => row !== null)
    }
  }
  return legacyOrderNumber(record) ? [record] : []
}

function legacyOrderNumber(order: Record<string, unknown>): string {
  for (const key of ['ordernumber', 'orderNumber', 'order_number']) {
    const value = order[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return ''
}

function legacyOrderId(order: Record<string, unknown>): string | null {
  for (const key of ['customerorderid', 'customerOrderId', 'id']) {
    const value = order[key]
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
    if (typeof value === 'string' && /^[0-9]+$/.test(value.trim())) return value.trim()
  }
  return null
}

export async function testZenventorySecureKey(secureKey: string) {
  const c = makeLegacyClient(secureKey)
  try {
    const res = await c.get('/shippingorders', { params: { page: 1, perPage: 1 } })
    return { ok: true, status: res.status }
  } catch (err) {
    return { ok: false, error: extractError(err) }
  }
}
