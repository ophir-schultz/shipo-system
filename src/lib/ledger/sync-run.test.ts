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
    expect(e.list()[0]).toEqual({ context: 'shipment 123', message: 'duplicate key' })
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
})
