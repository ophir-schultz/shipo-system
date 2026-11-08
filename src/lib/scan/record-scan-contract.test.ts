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

  it('keeps the production view and points the new check at a separate function', () => {
    expect(original).toContain('create or replace function record_scan(')
    expect(original).toContain('array_agg(distinct e.client_id) as client_ids')
    expect(original).toContain('scan_serial_claims.sql')
    expect(claims).toContain('unique (client_id, sku_key, serial_key)')
    expect(claims).not.toContain('array_agg(distinct e.client_id)')
  })

  it('joins a second carton to the same line and refuses one that is already done', () => {
    expect(claims).toContain("'line-' || p_client_id::text || '-' || v_order || '-' || v_sku")
    expect(claims).toContain('on conflict (client_id, order_ref, sku)')
    expect(claims).toContain('has already been pushed to Zenventory')
  })

  it('refuses to bill a scan when the serialization rate is missing', () => {
    expect(claims).toContain('no % rate configured for this client')
  })

  it('adds a separate writer and leaves the production function and view alone', () => {
    expect(claims).toContain('create or replace function record_scan_claimed(')
    expect(claims).not.toContain('drop function if exists public.record_scan')
    expect(claims).not.toContain('drop view if exists duplicate_serials')
    expect(claims).not.toContain('create or replace function record_scan(')
    expect(claims).not.toContain('create or replace view duplicate_serials')
    expect(claims).toContain('security invoker')
    expect(claims).not.toContain('security definer')
    expect(claims).toContain('pg_get_functiondef')
    expect(claims).toContain('client-sku-v1')
    expect(claims).toContain('ONE-TIME OUTBOUND')
    expect(claims).not.toMatch(/delete\s+from\s+scan_serial_claims/i)
    const route = readFileSync('src/app/api/scan/route.ts', 'utf8')
    expect(route.match(/rpc\('record_scan[^']*'/g)).toEqual(["rpc('record_scan'"])
    expect(route).not.toContain('record_scan_claimed')
    expect(route).not.toContain('claimProbeOk')
  })
})
