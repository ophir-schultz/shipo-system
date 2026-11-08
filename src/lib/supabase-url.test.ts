import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { requireEnv } from './lazy-client'
import { readSupabaseServerUrl, supabaseServerUrl } from './supabase-url'

const PREVIEW_URL = 'https://preview-project.supabase.co'
const SERVER_URL = 'https://server-project.supabase.co'
const SERVICE_ROLE = 'service-role-name-only'

describe('supabaseServerUrl', () => {
  it('uses SUPABASE_URL when that server name is set', () => {
    expect(supabaseServerUrl({
      SUPABASE_URL: SERVER_URL,
      NEXT_PUBLIC_SUPABASE_URL: PREVIEW_URL,
    })).toBe(SERVER_URL)
  })

  it('uses NEXT_PUBLIC_SUPABASE_URL when preview has no SUPABASE_URL', () => {
    // Preview: service role is set, SUPABASE_URL is not, the public URL is.
    const env = {
      NEXT_PUBLIC_SUPABASE_URL: PREVIEW_URL,
      SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE,
    }
    expect(supabaseServerUrl(env)).toBe(PREVIEW_URL)
    expect(requireEnv('SUPABASE_SERVICE_ROLE_KEY', env)).toBe(SERVICE_ROLE)
  })

  it('ignores a blank SUPABASE_URL and uses the public URL', () => {
    expect(supabaseServerUrl({
      SUPABASE_URL: '   ',
      NEXT_PUBLIC_SUPABASE_URL: PREVIEW_URL,
    })).toBe(PREVIEW_URL)
  })

  it('throws naming both variables and does not invent localhost', () => {
    expect(() => supabaseServerUrl({})).toThrow(/SUPABASE_URL or NEXT_PUBLIC_SUPABASE_URL/)
    expect(() => supabaseServerUrl({})).toThrow(/No localhost default/)
    expect(readSupabaseServerUrl({})).toBeNull()
    expect(readSupabaseServerUrl({ SUPABASE_URL: '', NEXT_PUBLIC_SUPABASE_URL: '' })).toBeNull()
  })

  it('does not return the service-role key as the URL', () => {
    const url = supabaseServerUrl({
      NEXT_PUBLIC_SUPABASE_URL: PREVIEW_URL,
      SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE,
    })
    expect(url).not.toContain(SERVICE_ROLE)
    expect(url).not.toMatch(/localhost|127\.0\.0\.1/)
  })
})

describe('server clients share the URL helper and the browser does not see the secret', () => {
  const server = readFileSync('src/lib/supabase.ts', 'utf8')
  const session = readFileSync('src/lib/supabase-server.ts', 'utf8')
  const proxy = readFileSync('src/proxy.ts', 'utf8')
  const browser = readFileSync('src/lib/supabase-browser.ts', 'utf8')

  it('the admin client takes the shared URL and the service-role key', () => {
    expect(server).toContain('supabaseServerUrl()')
    expect(server).toContain("requireEnv('SUPABASE_SERVICE_ROLE_KEY')")
    expect(server).not.toMatch(/localhost|127\.0\.0\.1/)
  })

  it('the session client and the proxy use the same URL', () => {
    expect(session).toContain('supabaseServerUrl()')
    expect(proxy).toContain('readSupabaseServerUrl(process.env)')
  })

  it('the browser client does not read the service role or the server URL name', () => {
    expect(browser).toContain('NEXT_PUBLIC_SUPABASE_URL')
    expect(browser).toContain('NEXT_PUBLIC_SUPABASE_ANON_KEY')
    expect(browser).not.toContain('SUPABASE_SERVICE_ROLE_KEY')
    expect(browser).not.toMatch(/process\.env\.SUPABASE_URL\b/)
    expect(browser).not.toContain('supabaseServerUrl')
  })
})
