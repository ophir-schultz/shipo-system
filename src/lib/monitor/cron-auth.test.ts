import { describe, expect, it } from 'vitest'
import { cronBearerAuthorized } from './cron-auth'

const SECRET = 'cron-test-secret'

describe('cron bearer', () => {
  it('accepts a bearer that matches CRON_SECRET or MONITOR_SECRET', () => {
    expect(cronBearerAuthorized(`Bearer ${SECRET}`, { CRON_SECRET: SECRET })).toBe(true)
    expect(cronBearerAuthorized(`Bearer ${SECRET}`, { MONITOR_SECRET: SECRET })).toBe(true)
  })

  it('rejects a missing, empty, or wrong secret', () => {
    expect(cronBearerAuthorized(`Bearer ${SECRET}`, {})).toBe(false)
    expect(cronBearerAuthorized(`Bearer ${SECRET}`, { CRON_SECRET: '' })).toBe(false)
    expect(cronBearerAuthorized('Bearer ', { CRON_SECRET: '' })).toBe(false)
    expect(cronBearerAuthorized(`Bearer ${SECRET}`, { CRON_SECRET: 'other-secret' })).toBe(false)
    expect(cronBearerAuthorized(null, { CRON_SECRET: SECRET })).toBe(false)
    expect(cronBearerAuthorized('Bearer', { CRON_SECRET: SECRET })).toBe(false)
  })

  it('does not treat a cron hint as the secret', () => {
    expect(cronBearerAuthorized('x-vercel-cron', { CRON_SECRET: SECRET })).toBe(false)
    expect(cronBearerAuthorized('Bearer 1', { CRON_SECRET: SECRET })).toBe(false)
  })
})
