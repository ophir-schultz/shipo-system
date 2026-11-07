import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// The scan writer is a database function. This checks that function's
// text. It does not connect to a database and it does not insert a scan.

describe('record_scan contract, unread against a database', () => {
  const sql = readFileSync('supabase/serialization_scans.sql', 'utf8')

  it('rejects a serial repeated inside one scan', () => {
    expect(sql).toContain('the same serial appears twice in one scan')
    expect(sql).toContain('scanned_serials_unique_in_event')
  })

  it('does not make a serial globally unique, and surfaces a repeat for a person', () => {
    expect(sql).toContain('NOT globally unique on purpose')
    expect(sql).toContain('create or replace view duplicate_serials')
  })

  it('joins a second carton to the same line and refuses one that is already done', () => {
    expect(sql).toContain("'line-' || p_client_id::text || '-' || v_order || '-' || v_sku")
    expect(sql).toContain('on conflict (client_id, order_ref, sku)')
    expect(sql).toContain('has already been pushed to Zenventory')
  })

  it('refuses to bill a scan when the serialization rate is missing', () => {
    expect(sql).toContain('no % rate configured for this client')
  })
})
