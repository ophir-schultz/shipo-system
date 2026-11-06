import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { liveCampaign, MARKETING_NOT_CONNECTED } from './marketing-connection'

describe('marketing connection', () => {
  it('names the disconnected screen and does not treat a missing source as spend', () => {
    expect(MARKETING_NOT_CONNECTED).toBe('Not connected / no live campaign data')
    expect(liveCampaign(null)).toBe(false)
    expect(liveCampaign({ connected: false })).toBe(false)
    expect(liveCampaign({ connected: true })).toBe(false)
    expect(liveCampaign({
      connected: true,
      linkedin: {},
      blog: {},
      canva: {},
      optimization: {},
      schedule: {},
    })).toBe(true)
  })

  it('the page shows that label instead of a loading shell', () => {
    const page = readFileSync('src/app/marketing/page.tsx', 'utf8')
    expect(page).toContain('MARKETING_NOT_CONNECTED')
    expect(page).not.toContain('Loading marketing dashboard')
    expect(page).not.toContain('Loading website stats')
    expect(page).toContain('liveCampaign')
  })
})