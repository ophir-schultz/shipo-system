import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// The original scan writer is still in serialization_scans.sql.
// Cross-scan refusal is the later file. Neither file is executed here.

describe('record_scan contract, unread against a database', () => {
  const original = readFileSync('supabase/serialization_scans.sql', 'utf8')
  const claims = readFileSync('supabase/scan_serial_claims.sql', 'utf8')

  it('rejects a serial repeated inside one scan', () => {
    expect(original).toContain('the same serial appears twice in one scan')
    expect(original).toContain('scanned_serials_unique_in_event')
    expect(claims).toContain('the same serial appears twice in one scan')
  })

  it('points a cross-scan repeat at the claim file instead of a global unique', () => {
    expect(original).toContain('scan_serial_claims.sql')
    expect(original).not.toContain('NOT globally unique on purpose')
    expect(claims).toContain('unique (client_id, sku_key, serial_key)')
  })

  it('joins a second carton to the same line and refuses one that is already done', () => {
    expect(claims).toContain("'line-' || p_client_id::text || '-' || v_order || '-' || v_sku")
    expect(claims).toContain('on conflict (client_id, order_ref, sku)')
    expect(claims).toContain('has already been pushed to Zenventory')
  })

  it('refuses to bill a scan when the serialization rate is missing', () => {
    expect(claims).toContain('no % rate configured for this client')
  })

  it('keeps the duplicate list to one client and one SKU', () => {
    expect(claims).toContain('group by e.client_id, e.sku, s.serial')
    expect(claims).not.toContain('array_agg(distinct e.client_id)')
  })
})
