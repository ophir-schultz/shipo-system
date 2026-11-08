import { describe, expect, it } from 'vitest'
import { WEBSITE_PROJECT_FALLBACK, websiteProjectName } from './website-project'

describe('website project name', () => {
  it('falls back to the project the repo names for shipousa.com', () => {
    expect(websiteProjectName({})).toBe('shipo-website1')
    expect(websiteProjectName({ WEBSITE_VERCEL_PROJECT: '  ' })).toBe(WEBSITE_PROJECT_FALLBACK)
  })

  it('uses WEBSITE_VERCEL_PROJECT when it is set', () => {
    expect(websiteProjectName({ WEBSITE_VERCEL_PROJECT: 'shipousa' })).toBe('shipousa')
    expect(websiteProjectName({ WEBSITE_VERCEL_PROJECT: '  other-site  ' })).toBe('other-site')
  })
})
