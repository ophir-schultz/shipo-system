import { describe, expect, it } from 'vitest'
import { liveReportHref } from './run-report'

describe('live report link', () => {
  it('keeps the selected client and dates and does not write', () => {
    const link = liveReportHref('nayax-id', '2026-11-01', '2026-11-28')
    expect(link.ok).toBe(true)
    if (!link.ok) return
    expect(link.href).toBe('/client-report/activity?client=nayax-id&from=2026-11-01&to=2026-11-28')
    expect(link.href.startsWith('/client-report/activity?')).toBe(true)
    expect(link.href).not.toContain('import')
    expect(link.href).not.toContain('approve')
    expect(link.href).not.toContain('download')
  })

  it('refuses all clients and a reversed range', () => {
    expect(liveReportHref('', '2026-11-01', '2026-11-28').ok).toBe(false)
    expect(liveReportHref('nayax-id', '2026-11-28', '2026-11-01').ok).toBe(false)
  })
})
