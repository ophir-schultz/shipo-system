import axios, { AxiosError } from 'axios'
import { legacyMissReason, legacyOrderId, matchLegacyOrders } from '@/lib/scan/legacy-orders'
import { readCustomerOrder } from '@/lib/scan/order-lines'

// Zenventory has TWO APIs on two DIFFERENT paths. Neither of them is /api —
// that path does not exist on the host and returns an Apache HTML 404 page,
// which is indistinguishable from a credentials problem unless you read the body.
//
// API 2.0 — Basic Auth (API Key + API Secret). Spec: https://docs.zenventory.com/openapi.php
const BASE_URL = 'https://app.zenventory.com/rest'

// Legacy REST API — SecureKey header (endpoints not present in API 2.0)
const LEGACY_BASE_URL = 'https://app.zenventory.com/services/rest'

/** Basic header for API 2.0. The value is the key, then the secret, UTF-8. */
export function v2Authorization(apiKey: string, apiSecret: string): string {
  return 'Basic ' + Buffer.from(`${apiKey}:${apiSecret}`, 'utf8').toString('base64')
}

function makeClient(apiKey: string, apiSecret: string, baseURL = BASE_URL) {
  // No Content-Type on these GETs. A JSON content type is for a body, and the
  // read that returns the Nayax order does not send one.
  return axios.create({
    baseURL,
    headers: {
      Accept: 'application/json',
      Authorization: v2Authorization(apiKey, apiSecret),
    },
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

/**
 * One page of GET /items. perPage is 20–100. active true is the default
 * and leaves inactive SKUs out of this page. The caller must read every
 * page or use none of them.
 */
export async function getItems(
  apiKey: string,
  apiSecret: string,
  params: { page: number; perPage: number; active: boolean },
) {
  const c = makeClient(apiKey, apiSecret)
  try {
    const res = await c.get('/items', {
      params: {
        page: params.page,
        perPage: params.perPage,
        active: params.active,
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

/**
 * The scan read. The first request is the bare GET that returns this
 * account's order. A filtered GET is a second read only when that page
 * does not contain the number. A 401 on the bare GET stops there.
 */
export async function getScanCustomerOrder(
  apiKey: string,
  apiSecret: string,
  orderRef: string,
  baseURL = BASE_URL,
): Promise<unknown> {
  const c = makeClient(apiKey, apiSecret, baseURL)
  let listed: unknown
  try {
    listed = (await c.get('/customer-orders')).data
  } catch (err) {
    throw new Error(`Zenventory API error: ${extractError(err)}`)
  }
  const read = readCustomerOrder(listed, orderRef)
  if (read.ok || !read.reason.startsWith('No order matches')) return listed
  try {
    const filtered = await c.get('/customer-orders', {
      params: {
        page: 1,
        perPage: 100,
        orderNumber: orderRef,
        orderNumberConditional: 'matches',
      },
    })
    return filtered.data
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
 * Read-only legacy customer order.
 *
 * GET /customerorders is the open-order window. A completed order is
 * not in it. When the typed number is absent there, GET /shippingorders
 * is the second read. Items are GET /{collection}/{id}/items. SecureKey
 * is the header. Nothing is picked.
 */
export async function getLegacyCustomerOrder(secureKey: string, orderRef: string): Promise<unknown> {
  const c = makeLegacyClient(secureKey)
  let customerBody: unknown
  try {
    customerBody = (await c.get('/customerorders')).data
  } catch (err) {
    throw new Error(`Zenventory Legacy API error: ${extractError(err)}`)
  }
  const customer = matchLegacyOrders(customerBody, orderRef)
  if (customer.kind === 'one') return withLegacyItems(c, 'customerorders', customer.order)
  if (customer.kind === 'many') throw new Error(legacyMissReason(orderRef, customer, null))

  let shipping: ReturnType<typeof matchLegacyOrders> | null = null
  try {
    const shippingBody = (await c.get('/shippingorders')).data
    shipping = matchLegacyOrders(shippingBody, orderRef)
    if (shipping.kind === 'one') return withLegacyItems(c, 'shippingorders', shipping.order)
  } catch (err) {
    if (customer.kind === 'unreadable') {
      throw new Error(`Zenventory Legacy API error: ${extractError(err)}`)
    }
  }
  throw new Error(legacyMissReason(orderRef, customer, shipping))
}

async function withLegacyItems(
  client: ReturnType<typeof makeLegacyClient>,
  collection: 'customerorders' | 'shippingorders',
  order: Record<string, unknown>,
): Promise<unknown> {
  const id = legacyOrderId(order)
  if (!id) return { customerorders: [order] }
  try {
    const items = await client.get(`/${collection}/${id}/items`)
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

export async function testZenventorySecureKey(secureKey: string) {
  const c = makeLegacyClient(secureKey)
  try {
    const res = await c.get('/shippingorders', { params: { page: 1, perPage: 1 } })
    return { ok: true, status: res.status }
  } catch (err) {
    return { ok: false, error: extractError(err) }
  }
}
