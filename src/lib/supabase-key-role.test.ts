import { describe, expect, it } from 'vitest'
import { supabaseKeyRole } from '../../scripts/supabase-key-role.mjs'

function legacyJwt(role: string): string {
  const payload = Buffer.from(JSON.stringify({ role }), 'utf8').toString('base64url')
  return `eyJhbGciOiJIUzI1NiJ9.${payload}.sig`
}

describe('supabase key role', () => {
  it('treats a new secret key as service_role without decoding it', () => {
    expect(supabaseKeyRole('sb_secret_example')).toBe('service_role')
  })

  it('treats a new publishable key as anon', () => {
    expect(supabaseKeyRole('sb_publishable_example')).toBe('anon')
  })

  it('still reads the role claim from a legacy JWT', () => {
    expect(supabaseKeyRole(legacyJwt('service_role'))).toBe('service_role')
    expect(supabaseKeyRole(legacyJwt('anon'))).toBe('anon')
  })

  it('does not call a non-key service_role', () => {
    expect(supabaseKeyRole('')).toBe('absent')
    expect(supabaseKeyRole('not-a-key')).toBe('unparseable')
  })
})
