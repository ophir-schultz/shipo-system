import axios, { AxiosError } from 'axios'

const BASE_URL = 'https://app.zenventory.com/api'

function makeClient(apiKey: string, apiSecret: string) {
  return axios.create({
    baseURL: BASE_URL,
    auth: { username: apiKey, password: apiSecret },
    headers: { 'Content-Type': 'application/json' },
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
  params?: { page?: number; perPage?: number; modifiedFrom?: string }
) {
  const c = makeClient(apiKey, apiSecret)
  try {
    const res = await c.get('/customer-orders', {
      params: {
        page: params?.page ?? 1,
        perPage: params?.perPage ?? 100,
        modifiedFrom: params?.modifiedFrom,
      },
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
