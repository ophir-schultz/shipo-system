import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

const snapshot = JSON.parse(readFileSync('supabase/proposals/snapshot_1038.json', 'utf8')) as Array<{
  id: string
  stored_charge_date: string
  carrier_day: string
  amount: string | null
}>
const oct6 = JSON.parse(readFileSync('supabase/proposals/oct6_23.json', 'utf8')) as Array<{
  order_id: string
  order_number: string
  shipment_id: string
  shipstation_shipment_id: number
  client_rate: string
  carrier_day: string
  n_charges: number
  n_ship: number
  cancelled: boolean
}>
const dateSql = readFileSync('supabase/propose_charge_date_repair_2026_11_08.sql', 'utf8')
const dateApplySql = readFileSync('supabase/apply_charge_date_repair_2026_11_08.sql', 'utf8')
const listSql = readFileSync('supabase/propose_nayax_oct6_zone_shipping_2026_11_08.sql', 'utf8')
const insertSql = readFileSync('supabase/propose_nayax_oct6_zone_shipping_insert_2026_11_08.sql', 'utf8')
const insertApplySql = readFileSync('supabase/apply_nayax_oct6_zone_shipping_2026_11_08.sql', 'utf8')

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

describe('frozen charge-date snapshot', () => {
  it('is 1038 unique ids, one day later, with the known amount and 723 unknowns', () => {
    expect(new Set(snapshot.map((row) => row.id)).size).toBe(1038)
    let cents = 0
    let unknowns = 0
    for (const row of snapshot) {
      const oldDay = Date.parse(`${row.stored_charge_date}T00:00:00Z`)
      const newDay = Date.parse(`${row.carrier_day}T00:00:00Z`)
      expect(newDay - oldDay).toBe(86_400_000)
      if (row.amount == null) unknowns += 1
      else cents += Math.round(Number(row.amount) * 100)
    }
    expect(unknowns).toBe(723)
    expect(cents / 100).toBeCloseTo(6241.29, 2)
    expect(sha256(readFileSync('supabase/proposals/snapshot_1038.json'))).toBe(
      'eff3346858d733e83e6ceafb2d79fa48fd53e2d867fc0e4199c6724ec2f46500',
    )
  })

  it('reproduces the line fingerprint with Python None and no trailing newline', () => {
    const lines = [...snapshot]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((row) => `${row.id}|${row.stored_charge_date}|${row.carrier_day}|${row.amount == null ? 'None' : row.amount}`)
    const hash = sha256(lines.join('\n'))
    expect(hash).toBe('bfb18f5b9109c7c56cc3eec6726cdb3485323f3a3d74df683a56f614f1c6b569')
    expect(dateSql).toContain('bfb18f5b9109c7c56cc3eec6726cdb3485323f3a3d74df683a56f614f1c6b569')
    expect(dateSql).not.toContain('does not claim that hash')
    expect(dateSql).toContain('eff3346858d733e83e6ceafb2d79fa48fd53e2d867fc0e4199c6724ec2f46500')
  })

  it('pins every frozen id and does not create a public backup', () => {
    for (const row of snapshot) expect(dateSql).toContain(row.id)
    expect(dateSql.toLowerCase()).not.toContain('create table if not exists public')
    expect(dateSql.toLowerCase()).not.toContain('create table public')
    expect(dateSql.trimEnd().endsWith('rollback;')).toBe(true)
    expect(dateSql).toContain("shipo.approve_charge_date_repair")
    expect(dateSql).not.toMatch(/^\s*commit\s*;/im)
  })

  it('keeps the apply file on the same ids and a different approval setting', () => {
    for (const row of snapshot) expect(dateApplySql).toContain(row.id)
    expect(dateApplySql).toContain('apply_charge_date_repair_2026_11_08')
    expect(dateApplySql).not.toContain("is distinct from 'propose_charge_date_repair_2026_11_08'")
    expect(dateApplySql.trimEnd().endsWith('commit;')).toBe(true)
    expect(dateApplySql.toLowerCase()).not.toContain('create table public')
    expect(dateApplySql.toLowerCase()).not.toContain('create schema')
    expect(dateApplySql).toContain('Do not run')
  })
})

describe('frozen Nayax October 6 list', () => {
  it('is 23 orders, one shipment, ship day October 7, rates 539.58, and no charges', () => {
    expect(oct6).toHaveLength(23)
    expect(new Set(oct6.map((row) => row.order_id)).size).toBe(23)
    let cents = 0
    for (const row of oct6) {
      expect(row.cancelled).toBe(false)
      expect(row.n_charges).toBe(0)
      expect(row.n_ship).toBe(1)
      expect(row.carrier_day).toBe('2026-10-07')
      cents += Math.round(Number(row.client_rate) * 100)
      expect(listSql).toContain(row.order_id)
      expect(insertSql).toContain(row.order_id)
      expect(insertSql).toContain(String(row.shipstation_shipment_id))
    }
    expect(cents / 100).toBeCloseTo(539.58, 2)
    expect(sha256(readFileSync('supabase/proposals/oct6_23.json'))).toBe(
      'f2bc2370bcdae926ccc3cbd9969271074e08666f45ba42f772b0ccbe10c9ba0e',
    )
  })

  it('keeps the insert to shipping at the stored zone price and rolls it back', () => {
    expect(listSql.toLowerCase()).not.toContain('insert into public.order_charges')
    expect(insertSql).toContain("name = 'Nayax'")
    expect(insertSql).toContain('order_charges oc where oc.order_id')
    expect(insertSql).toContain('snap.client_rate')
    expect(insertSql).not.toContain('actual_cost')
    expect(insertSql).not.toMatch(/'pick'|'pack'|carrier_freight/)
    expect(insertSql).toContain("'shipping'")
    expect(insertSql).toContain('cost is null')
    expect(insertSql.trimEnd().endsWith('rollback;')).toBe(true)
    expect(insertSql).not.toMatch(/^\s*commit\s*;/im)
    expect(insertSql.toLowerCase()).not.toContain('create table public')
  })

  it('keeps the shipping apply on the same 23 rows and a different approval setting', () => {
    for (const row of oct6) {
      expect(insertApplySql).toContain(row.order_id)
      expect(insertApplySql).toContain(String(row.shipstation_shipment_id))
    }
    expect(insertApplySql).toContain('apply_nayax_oct6_zone_shipping_2026_11_08')
    expect(insertApplySql).not.toContain("is distinct from 'propose_nayax_oct6_zone_shipping_insert_2026_11_08'")
    expect(insertApplySql).toContain("'zone_client_rate'")
    expect(insertApplySql).toContain('cost is null')
    expect(insertApplySql.trimEnd().endsWith('commit;')).toBe(true)
    expect(insertApplySql).not.toMatch(/^\s*rollback\s*;/im)
    expect(insertApplySql.toLowerCase()).not.toContain('create table public')
    expect(insertApplySql).toContain('Do not run')
  })
})
