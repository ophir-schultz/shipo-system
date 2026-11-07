import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('staff shell on a phone', () => {
  const shell = readFileSync('src/components/layout/StaffShell.tsx', 'utf8')
  const dashboard = readFileSync('src/app/dashboard/layout.tsx', 'utf8')
  const partner = readFileSync('src/app/partner/layout.tsx', 'utf8')

  it('hides the sidebar behind a menu and keeps the page from overflowing', () => {
    expect(shell).toContain('aria-label="Open menu"')
    expect(shell).toContain('min-w-0')
    expect(shell).toContain('md:hidden')
    expect(dashboard).toContain('<StaffShell>')
    expect(partner).not.toContain('StaffShell')
  })

  it('keeps the partner label readable on the navy bar', () => {
    expect(partner).toContain('text-[#C7D8F0]')
    expect(partner).not.toContain('text-[#0B1220]')
  })
})
