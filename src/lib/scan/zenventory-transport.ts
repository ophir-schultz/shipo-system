import axios from 'axios'
import type { HttpResult, ZenventoryTransport } from './zenventory-pick'

// Same two hosts as src/lib/api/zenventory.ts. validateStatus keeps a
// 4xx body available to the audit log instead of throwing it away.

const V2 = 'https://app.zenventory.com/rest'
const LEGACY = 'https://app.zenventory.com/services/rest'

function result(status: number, body: unknown): HttpResult {
  return { status, body }
}

export function createZenventoryTransport(): ZenventoryTransport {
  return {
    async getV2(path, params, creds) {
      const res = await axios.get(`${V2}${path}`, {
        auth: { username: creds.apiKey, password: creds.apiSecret },
        params,
        timeout: 15000,
        validateStatus: () => true,
      })
      return result(res.status, res.data)
    },
    async getLegacy(path, params, secureKey) {
      const res = await axios.get(`${LEGACY}${path}`, {
        headers: { 'Content-Type': 'application/json', SecureKey: secureKey },
        params,
        timeout: 15000,
        validateStatus: () => true,
      })
      return result(res.status, res.data)
    },
    async putLegacy(path, body, secureKey) {
      const res = await axios.put(`${LEGACY}${path}`, body, {
        headers: { 'Content-Type': 'application/json', SecureKey: secureKey },
        timeout: 15000,
        validateStatus: () => true,
      })
      return result(res.status, res.data)
    },
  }
}
