import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const psql = '/usr/lib/postgresql/16/bin/psql'

describe('repair guards on a disposable local database', () => {
  it('fails a 23 insert before the date repair and undoes only an exact approved image', () => {
    const out = execFileSync(psql, [
      '-h', '/tmp',
      '-p', '5433',
      '-d', 'postgres',
      '-v', 'ON_ERROR_STOP=1',
      '-c', 'select current_database()',
      '-f', 'src/lib/ledger/proposal-behavior.fixture.sql',
      '-c', 'select step, ok, detail from proof order by step',
    ], { encoding: 'utf8' })
    expect(out).toContain('postgres')
    expect(out).not.toContain('fdqyzekseetvzkmuihbg')
    const rows = Object.fromEntries(
      out.split('\n')
        .map((line) => line.trim())
        .filter((line) => line.includes('|'))
        .map((line) => {
          const [step, ok, detail] = line.split('|').map((part) => part.trim())
          return [step, { ok, detail }]
        }),
    )
    expect(rows['wrong-order'].ok).toBe('t')
    expect(rows['insert-after-repair'].ok).toBe('t')
    expect(rows['restore-unapproved'].ok).toBe('t')
    expect(rows['restore-drift'].ok).toBe('t')
    expect(rows['restore-exact'].ok).toBe('t')
    expect(rows['date-back'].ok).toBe('t')
    expect(rows['shipping-gone'].ok).toBe('t')
  })
})

describe('proposal files keep the modes the fixture proved', () => {
  const insertSql = readFileSync('supabase/propose_nayax_oct6_zone_shipping_insert_2026_11_08.sql', 'utf8')
  const insertApply = readFileSync('supabase/apply_nayax_oct6_zone_shipping_2026_11_08.sql', 'utf8')
  const dateRestore = readFileSync('supabase/propose_restore_charge_date_repair_2026_11_08.sql', 'utf8')
  const dateUndo = readFileSync('supabase/apply_restore_charge_date_repair_2026_11_08.sql', 'utf8')
  const nayaxUndo = readFileSync('supabase/apply_restore_nayax_oct6_zone_shipping_2026_11_08.sql', 'utf8')

  it('refuses the 23 inserts unless the 1038 repair is already live', () => {
    for (const sql of [insertSql, insertApply]) {
      expect(sql).toContain('1038 date repair is not the live after-state')
      expect(sql).toContain('charge_date_repair_required')
      expect(sql.indexOf('END ORDERING')).toBeLessThan(sql.indexOf('insert into public.order_charges'))
    }
  })

  it('keeps dry-run rollback and gives the undo its own commit setting', () => {
    expect(dateRestore.trimEnd().endsWith('rollback;')).toBe(true)
    expect(dateRestore).toContain("'restore_charge_date_repair_2026_11_08'")
    expect(dateUndo.trimEnd().endsWith('commit;')).toBe(true)
    expect(dateUndo).toContain("'apply_restore_charge_date_repair_2026_11_08'")
    expect(dateUndo).not.toContain("is distinct from 'restore_charge_date_repair_2026_11_08'")
    expect(nayaxUndo.trimEnd().endsWith('commit;')).toBe(true)
    expect(nayaxUndo).toContain("'apply_restore_nayax_oct6_zone_shipping_2026_11_08'")
    expect(nayaxUndo).not.toContain("is distinct from 'restore_nayax_oct6_zone_shipping_2026_11_08'")
    expect(dateUndo).toContain('not the repaired image')
    expect(nayaxUndo).toContain('not the inserted image')
  })
})
