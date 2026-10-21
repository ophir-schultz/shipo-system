import { describe, it, expect } from 'vitest'
import { testBanner, statusOf, missingKeyNotice } from './zenventory-test-result'

describe('missingKeyNotice', () => {
  it('returns nothing when a key is present', () => {
    expect(missingKeyNotice('abc123')).toBeNull()
  })

  it('calls an absent key not configured, without alarm', () => {
    for (const v of [null, undefined]) {
      const n = missingKeyNotice(v)
      expect(n?.tone).toBe('info')
      expect(n?.text).toContain('No API 2.0 credentials')
    }
  })

  it('warns that an EMPTY key is still in the scheduled sync', () => {
    // The distinction that costs money: '' is not null, so the sync's
    // `.not(..., 'is', null)` filter keeps selecting this client.
    const n = missingKeyNotice('')
    expect(n?.tone).toBe('warn')
    expect(n?.text).toContain('still included in the scheduled sync')
    // Must NOT reuse the null copy, which says it is not syncing.
    expect(n?.text).not.toContain('No API 2.0 credentials')
  })

  it('treats a whitespace-only key the same as empty', () => {
    // ' ' is also not null, so it behaves identically against the filter.
    expect(missingKeyNotice('   ')?.tone).toBe('warn')
    expect(missingKeyNotice('\t\n')?.tone).toBe('warn')
  })

  it('gives the two cases different text, not just different colours', () => {
    expect(missingKeyNotice('')?.text).not.toBe(missingKeyNotice(null)?.text)
  })
})

describe('statusOf', () => {
  it('reads the code out of an extractError message', () => {
    expect(statusOf('HTTP 401: {"message":"Invalid API key and/or secret"}')).toBe(401)
  })

  it('returns null for a message that is not from extractError', () => {
    expect(statusOf('No Zenventory credentials saved for this client')).toBeNull()
    expect(statusOf('timeout of 15000ms exceeded')).toBeNull()
    expect(statusOf('')).toBeNull()
  })

  it('does not read a code out of the middle of a message', () => {
    // Zenventory's own body can contain digits. Anchoring matters: without
    // `^` this would report the order number as an HTTP status.
    expect(statusOf('Request failed, HTTP 500 somewhere later')).toBeNull()
  })
})

describe('testBanner', () => {
  it('reports success without a detail line', () => {
    expect(testBanner({ success: true, status: 200 })).toEqual({
      ok: true, title: 'API 2.0 connection successful', detail: '',
    })
  })

  it('names the credentials on a real 401', () => {
    // The production failure, verbatim from the monitor.
    const b = testBanner({
      success: false,
      error: 'HTTP 401: {"message":"Invalid API key and/or secret","parameter":""}',
    })
    expect(b.ok).toBe(false)
    expect(b.title).toBe('Zenventory rejected the API Key and Secret')
    // The reason is shown, not swallowed into a toast.
    expect(b.detail).toContain('Invalid API key and/or secret')
  })

  it('does NOT blame the credentials when none were sent', () => {
    // The bug this file exists for: the route's own refusal rendered as
    // "check API Key and Secret" -- advice about a credential that is absent.
    const b = testBanner({
      success: false,
      error: 'No Zenventory credentials saved for this client',
    })
    expect(b.title).toBe('No API 2.0 credentials saved — nothing was sent')
    expect(b.title).not.toMatch(/reject|check/i)
  })

  it('keeps 403 separate from 401', () => {
    const b = testBanner({ success: false, error: 'HTTP 403: {"message":"Forbidden"}' })
    expect(b.title).toBe('Credentials are valid but not allowed to read orders')
    // The distinction is the whole point: a 403 key is a WORKING key.
    expect(b.title).not.toMatch(/rejected/)
  })

  it('does not blame the credentials for a 5xx', () => {
    for (const code of [500, 502, 503]) {
      const b = testBanner({ success: false, error: `HTTP ${code}: <html>` })
      expect(b.title).toBe('Zenventory is erroring — the credentials may be fine')
    }
  })

  it('says the credentials were never tested on a timeout', () => {
    const b = testBanner({ success: false, error: 'timeout of 15000ms exceeded' })
    expect(b.title).toBe('Could not reach Zenventory — the credentials were not tested')
  })

  it('reports an unmapped status by number rather than guessing', () => {
    const b = testBanner({ success: false, error: 'HTTP 418: teapot' })
    expect(b.title).toBe('Zenventory answered HTTP 418')
  })

  it('falls back without naming a cause when there is no status and no detail', () => {
    const b = testBanner({ success: false })
    expect(b.title).toBe('API 2.0 test failed')
    expect(b.detail).toBe('')
    // Must not invent a diagnosis. That is the old banner's failure mode.
    expect(b.title).not.toMatch(/key|secret|credential/i)
  })

  it('treats a missing success field as a failure', () => {
    // A route that 500s before answering leaves `success` undefined. Reading
    // that as a pass would show a green banner for a test that never ran.
    expect(testBanner({}).ok).toBe(false)
  })

  it('prefers the status embedded in the error over res.status', () => {
    // testZenventoryCredentials never returns both, but if a future route
    // sends `status: 200` alongside a 401 error, the error wins.
    const b = testBanner({ success: false, status: 200, error: 'HTTP 401: nope' })
    expect(b.title).toBe('Zenventory rejected the API Key and Secret')
  })

  it('trims the detail so a blank error does not render an empty line', () => {
    expect(testBanner({ success: false, error: '   ' }).detail).toBe('')
  })
})
