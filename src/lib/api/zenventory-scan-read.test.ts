import http from 'node:http'
import { describe, expect, it } from 'vitest'
import { getScanCustomerOrder, v2Authorization } from './zenventory'

function listen(): Promise<{ port: number; hits: { url: string; authorization: string; contentType: string | undefined }[]; close: () => void; setBody: (body: unknown, status?: number) => void }> {
  const hits: { url: string; authorization: string; contentType: string | undefined }[] = []
  let body: unknown = { customerOrders: [{ orderNumber: 'SO601065056', items: [] }] }
  let status = 200
  const server = http.createServer((req, res) => {
    hits.push({
      url: req.url ?? '',
      authorization: req.headers.authorization ?? '',
      contentType: req.headers['content-type'],
    })
    const payload = JSON.stringify(body)
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(payload)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('no port')
      resolve({
        port: address.port,
        hits,
        close: () => server.close(),
        setBody: (next, nextStatus = 200) => {
          body = next
          status = nextStatus
        },
      })
    })
  })
}

describe('scan API 2.0 read', () => {
  it('sends the bare GET with Basic auth and no JSON content type', async () => {
    const server = await listen()
    try {
      const body = await getScanCustomerOrder('fixture-key', 'fixture-secret', 'SO601065056', `http://127.0.0.1:${server.port}`)
      expect(body).toMatchObject({ customerOrders: [{ orderNumber: 'SO601065056' }] })
      expect(server.hits).toHaveLength(1)
      expect(server.hits[0].url).toBe('/customer-orders')
      expect(server.hits[0].contentType).toBeUndefined()
      expect(server.hits[0].authorization).toBe(v2Authorization('fixture-key', 'fixture-secret'))
      expect(Buffer.from(server.hits[0].authorization.replace(/^Basic /, ''), 'base64').toString('utf8'))
        .toBe('fixture-key:fixture-secret')
    } finally {
      server.close()
    }
  })

  it('does not send a second request when the bare GET is unauthorized', async () => {
    const server = await listen()
    server.setBody({ code: 'unauthorized', message: 'Invalid API key and/or secret.', parameter: '' }, 401)
    try {
      await expect(getScanCustomerOrder('fixture-key', 'fixture-secret', 'SO601065056', `http://127.0.0.1:${server.port}`))
        .rejects.toThrow(/HTTP 401/)
      expect(server.hits).toHaveLength(1)
      expect(server.hits[0].url).toBe('/customer-orders')
    } finally {
      server.close()
    }
  })

  it('filters only after the bare page omits the order', async () => {
    const hits: { url: string }[] = []
    const server = http.createServer((req, res) => {
      hits.push({ url: req.url ?? '' })
      const body = hits.length === 1
        ? { customerOrders: [{ orderNumber: 'OTHER' }] }
        : { customerOrders: [{ orderNumber: 'SO601065056', items: [] }] }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('no port')
    try {
      const body = await getScanCustomerOrder('fixture-key', 'fixture-secret', 'SO601065056', `http://127.0.0.1:${address.port}`)
      expect(body).toMatchObject({ customerOrders: [{ orderNumber: 'SO601065056' }] })
      expect(hits.map((hit) => hit.url)).toEqual([
        '/customer-orders',
        '/customer-orders?page=1&perPage=100&orderNumber=SO601065056&orderNumberConditional=matches',
      ])
    } finally {
      server.close()
    }
  })
})
