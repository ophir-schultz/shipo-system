import { describe, it, expect } from 'vitest'
import { filterByDate, undatedNote } from '@/lib/billing/date-range'

// Two screens filtered the same rows by the same dates and disagreed about the
// one case that matters: a row whose date column is null.
//
//   BillingView   `if (d === undefined) return !from && !to`   -> DROPPED
//   ReportsTabs   `if (from && d && d < from) return false`    -> KEPT
//
// So one undated shipment was on /reports and off /billing simultaneously, and
// nothing on either screen said so. The tie is broken by the thing that
// outlives both: src/app/api/reports/download/route.ts filters in SQL with
// `.gte('ship_date', from).lte('ship_date', to)`, and in Postgres
// `null >= '2026-10-01'` is null, which is not true -- so the .xlsx that
// /reports exports has ALWAYS excluded undated rows. ReportsTabs was therefore
// disagreeing with the spreadsheet you export from it by pressing the button
// next to the table.
//
// Dropping is correct, and dropping silently is the defect. A bounded view is a
// claim about a period; a row with no date is not known to belong to it, so
// including it makes the claim false. Excluding it makes the view incomplete,
// which is only recoverable if the view says so -- hence the count.
//
// Only ship_date and adjustment_date are nullable (schema.sql:42,70).
// log_date, week_start and week_end are `not null`, so for those three the
// undated branch is unreachable and this is a pure refactor.

type Row = { ship_date: string | null; id: string }

const row = (id: string, ship_date: string | null): Row => ({ id, ship_date })

describe('filterByDate', () => {
  it('keeps a row inside both bounds', () => {
    const r = filterByDate([row('a', '2026-10-15')], 'ship_date', '2026-10-01', '2026-10-31')
    expect(r.rows.map(x => x.id)).toEqual(['a'])
    expect(r.undated).toBe(0)
  })

  it('drops a row before the lower bound', () => {
    const r = filterByDate([row('a', '2026-09-30')], 'ship_date', '2026-10-01', '2026-10-31')
    expect(r.rows).toEqual([])
  })

  it('drops a row after the upper bound', () => {
    const r = filterByDate([row('a', '2026-11-01')], 'ship_date', '2026-10-01', '2026-10-31')
    expect(r.rows).toEqual([])
  })

  it('treats both bounds as inclusive', () => {
    // Matches .gte/.lte in the download route. An off-by-one here silently
    // drops the first and last day of every month the operator asks for.
    const rows = [row('first', '2026-10-01'), row('last', '2026-10-31')]
    const r = filterByDate(rows, 'ship_date', '2026-10-01', '2026-10-31')
    expect(r.rows.map(x => x.id)).toEqual(['first', 'last'])
  })

  it('keeps a dated row when only the lower bound is set', () => {
    // A half-open range is the normal screen state: the operator types a start
    // date and leaves the end empty. Found by mutation testing -- every
    // one-bound test above uses a NULL-dated row, which returns from the undated
    // branch before reaching either comparison, so nothing covered the empty
    // upper bound against a real date. Deleting the `to &&` guard passed the
    // whole suite while dropping every row on screen: `'2026-10-15' > ''` is
    // true, because '' sorts before every string.
    const r = filterByDate([row('a', '2026-10-15')], 'ship_date', '2026-10-01', '')
    expect(r.rows.map(x => x.id)).toEqual(['a'])
  })

  it('keeps a dated row when only the upper bound is set', () => {
    const r = filterByDate([row('a', '2026-10-15')], 'ship_date', '', '2026-10-31')
    expect(r.rows.map(x => x.id)).toEqual(['a'])
  })

  it('keeps every dated row when neither bound is set', () => {
    const rows = [row('a', '2026-01-01'), row('b', '2029-12-31')]
    const r = filterByDate(rows, 'ship_date', '', '')
    expect(r.rows.map(x => x.id)).toEqual(['a', 'b'])
  })

  it('compares a timestamptz by its date part', () => {
    // ship_date is timestamptz, so the value carries a time. Comparing the
    // whole string would make '2026-10-31T23:30:00Z' > '2026-10-31' and drop
    // the last day of the range.
    const r = filterByDate([row('a', '2026-10-31T23:30:00Z')], 'ship_date', '2026-10-01', '2026-10-31')
    expect(r.rows.map(x => x.id)).toEqual(['a'])
  })

  describe('an undated row', () => {
    it('is dropped when a bound is set, and counted', () => {
      // THE FIX. ReportsTabs kept this row in every range it was ever asked
      // for, including ranges it cannot belong to.
      const r = filterByDate([row('a', null)], 'ship_date', '2026-10-01', '2026-10-31')
      expect(r.rows).toEqual([])
      expect(r.undated).toBe(1)
    })

    it('is dropped when only the lower bound is set', () => {
      const r = filterByDate([row('a', null)], 'ship_date', '2026-10-01', '')
      expect(r.rows).toEqual([])
      expect(r.undated).toBe(1)
    })

    it('is dropped when only the upper bound is set', () => {
      const r = filterByDate([row('a', null)], 'ship_date', '', '2026-10-31')
      expect(r.rows).toEqual([])
      expect(r.undated).toBe(1)
    })

    it('is KEPT and not counted when neither bound is set', () => {
      // No bounds means the view makes no claim about a period, so there is
      // nothing for an unknown date to contradict. Dropping here would hide
      // the row on the only screen state that could honestly show it.
      const r = filterByDate([row('a', null)], 'ship_date', '', '')
      expect(r.rows.map(x => x.id)).toEqual(['a'])
      expect(r.undated).toBe(0)
    })

    it('counts as undated when the column is absent entirely', () => {
      // Both pages select `manual_total` and `new_cost`, neither of which is in
      // schema.sql. A select that quietly lacks a column must not read as a
      // date of ''; '' compares less than every real date and would silently
      // drop every row while reporting nothing.
      const r = filterByDate([{ id: 'a' } as unknown as Row], 'ship_date', '2026-10-01', '2026-10-31')
      expect(r.rows).toEqual([])
      expect(r.undated).toBe(1)
    })

    it('counts as undated when the value is not a string', () => {
      // A numeric epoch would throw on .split. Treating it as unknown is the
      // honest reading: we cannot place it in the period.
      const r = filterByDate([{ id: 'a', ship_date: 1760000000 } as unknown as Row], 'ship_date', '2026-10-01', '2026-10-31')
      expect(r.rows).toEqual([])
      expect(r.undated).toBe(1)
    })
  })

  it('counts only undated drops, not out-of-range drops', () => {
    // The count renders as "N undated ... not included". If it also counted
    // rows the operator deliberately filtered out by choosing a month, the
    // note would scream on every normal screen and be ignored -- which is how
    // a warning stops working.
    const rows = [row('in', '2026-10-15'), row('early', '2026-01-01'), row('none', null)]
    const r = filterByDate(rows, 'ship_date', '2026-10-01', '2026-10-31')
    expect(r.rows.map(x => x.id)).toEqual(['in'])
    expect(r.undated).toBe(1)
  })

  it('preserves input order', () => {
    // Every caller renders these straight into a table that was already
    // ordered by the query.
    const rows = [row('c', '2026-10-03'), row('a', '2026-10-01'), row('b', '2026-10-02')]
    const r = filterByDate(rows, 'ship_date', '2026-10-01', '2026-10-31')
    expect(r.rows.map(x => x.id)).toEqual(['c', 'a', 'b'])
  })

  it('agrees with Postgres three-valued logic, which is what the export does', () => {
    // The parity that matters: whatever this returns for a bounded range must
    // match `.gte(col, from).lte(col, to)`, because the user reads the table
    // and then exports it. Modelled here rather than asserted in prose.
    const pg = (d: string | null, from: string, to: string) =>
      d === null ? false : d.split('T')[0] >= from && d.split('T')[0] <= to

    const cases: Array<string | null> = ['2026-09-30', '2026-10-01', '2026-10-15', '2026-10-31', '2026-11-01', null]
    for (const d of cases) {
      const mine = filterByDate([row('x', d)], 'ship_date', '2026-10-01', '2026-10-31').rows.length === 1
      expect(mine).toBe(pg(d, '2026-10-01', '2026-10-31'))
    }
  })
})

describe('undatedNote', () => {
  it('says nothing when every row had a date', () => {
    // A note that appears when there is nothing to report trains the operator
    // to skip it.
    expect(undatedNote(0)).toBe('')
  })

  it('names the count and says the rows are missing', () => {
    expect(undatedNote(3)).toBe('3 shipments with no date not included')
  })

  it('is singular for one', () => {
    expect(undatedNote(1)).toBe('1 shipment with no date not included')
  })

  it('takes the noun, because these tables are not all shipments', () => {
    expect(undatedNote(2, 'adjustment')).toBe('2 adjustments with no date not included')
  })

  it('pluralizes by appending s and nothing cleverer -- a caller constraint', () => {
    // Characterization, not a wish. This records a real limitation inherited
    // from unpricedNote rather than pretending it is not there: the warehouse
    // table was about to be given 'entry' and would have rendered "3 entrys
    // with no date". Every live caller passes an s-pluralizable noun
    // (shipment, adjustment, bill, day, line). If that ever stops being true
    // the fix is an explicit plural parameter, not a surprise on screen.
    expect(undatedNote(3, 'entry')).toBe('3 entrys with no date not included')
  })
})
