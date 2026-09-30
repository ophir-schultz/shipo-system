import { describe, it, expect } from 'vitest'
import { collectErrors } from '@/lib/ledger/sync-run'

describe('collectErrors', () => {
  it('starts empty', () => {
    const e = collectErrors()
    expect(e.count()).toBe(0)
    expect(e.list()).toEqual([])
  })

  it('keeps the message of an Error, not just a count', () => {
    const e = collectErrors()
    e.push('shipment 123', new Error('duplicate key'))
    expect(e.count()).toBe(1)
    // kind:'error' is present so piece 4 can discriminate error vs warning
    // entries in sync_runs.errors without parsing the message string.
    expect(e.list()[0]).toEqual({ kind: 'error', context: 'shipment 123', message: 'duplicate key' })
  })

  // Supabase returns error objects, not Error instances. `String(err)` on one
  // yields '[object Object]', which is exactly as useless as the bare catch
  // this replaces.
  it('extracts .message from a Supabase-style error object', () => {
    const e = collectErrors()
    e.push('row 9', { message: 'PGRST116: multiple rows returned', code: 'PGRST116' })
    expect(e.list()[0].message).toContain('PGRST116')
  })

  it('does not produce [object Object] for an unrecognised value', () => {
    const e = collectErrors()
    e.push('row 9', { weird: true })
    expect(e.list()[0].message).not.toContain('[object Object]')
    expect(e.list()[0].message).toContain('weird')
  })

  it('survives a thrown string and a thrown null', () => {
    const e = collectErrors()
    e.push('a', 'plain string failure')
    e.push('b', null)
    expect(e.count()).toBe(2)
    expect(e.list()[0].message).toBe('plain string failure')
    expect(e.list()[1].message).toBe('null')
  })

  // A run that fails on every one of 1,095 rows must not write a 1,095-entry
  // JSON blob into sync_runs.errors. The cap keeps the column readable; the
  // count stays exact.
  it('caps the stored list at 50 but keeps counting', () => {
    const e = collectErrors()
    for (let i = 0; i < 200; i++) e.push(`row ${i}`, new Error('boom'))
    expect(e.count()).toBe(200)
    expect(e.list()).toHaveLength(50)
    expect(e.list()[0].context).toBe('row 0')
  })

  // warn() must not count toward errors, and push() must not count toward
  // warnings. If they shared a counter, status resolution in close() would
  // mark a warning-only run as 'partial' or 'failed'.
  it('a warning does not increment count(), and an error does not increment warnCount()', () => {
    const e = collectErrors()
    e.warn('carrier lookup', { carrierCode: 'fedex' })
    expect(e.count()).toBe(0)
    expect(e.warnCount()).toBe(1)

    e.push('insert row 5', new Error('conflict'))
    expect(e.count()).toBe(1)
    expect(e.warnCount()).toBe(1)
  })

  // With a shared 50-slot budget, 200 warnings fill it completely and the
  // subsequent error is dropped. Independent caps prevent this: warnings can
  // never displace a stored error regardless of volume.
  it('independent caps: 200 warnings then 1 error — the error is findable in list()', () => {
    const e = collectErrors()
    for (let i = 0; i < 200; i++) {
      e.warn(`unknown carrier fedex`, { shipmentId: i })
    }
    e.push('insert row 201', new Error('unique violation'))

    const allEntries = e.list()
    const errorEntry = allEntries.find(
      entry => entry.kind === 'error' && entry.context === 'insert row 201'
    )
    expect(errorEntry).toBeDefined()
    expect(errorEntry?.message).toContain('unique violation')
  })

  // Both errors and warnings end up in list(), each tagged with kind, so
  // piece 4 can query the jsonb column for entries by kind without parsing
  // message strings.
  it('errors and warnings both appear in list() carrying the right kind', () => {
    const e = collectErrors()
    e.push('insert row 1', new Error('conflict'))
    e.warn('unknown carrier fedex', { shipmentId: 42 })

    const entries = e.list()
    const err = entries.find(x => x.kind === 'error')
    const warn = entries.find(x => x.kind === 'warning')

    expect(err).toMatchObject({ kind: 'error', context: 'insert row 1', message: 'conflict' })
    expect(warn).toMatchObject({ kind: 'warning', context: 'unknown carrier fedex' })
  })

  // A run with 200 unknown-carrier warnings must cap stored warnings at 50
  // while keeping an exact count — mirroring the existing error-cap test.
  it('warnings cap stored list at 50 but warnCount() stays exact', () => {
    const e = collectErrors()
    for (let i = 0; i < 200; i++) e.warn(`carrier`, { carrierCode: `code_${i}` })
    expect(e.warnCount()).toBe(200)
    const warnEntries = e.list().filter(x => x.kind === 'warning')
    expect(warnEntries).toHaveLength(50)
    expect(warnEntries[0].context).toBe('carrier')
  })
})
