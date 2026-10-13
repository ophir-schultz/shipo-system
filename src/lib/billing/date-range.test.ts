import { describe, it, expect } from 'vitest'
import {
  filterByDate, undatedNote, filterByClient, unattributedNote, scopeRows,
} from '@/lib/billing/date-range'

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
      // Both pages used to select `manual_total` and `new_cost`, neither of
      // which is in schema.sql and neither of which anything writes; both
      // selects now name the written column. The case stands on its own
      // regardless: a select that quietly lacks a column must not read as a
      // date of '', because '' compares less than every real date and would
      // silently drop every row while reporting nothing.
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

// ---------------------------------------------------------------------------
// The client filter.
//
// /reports' client dropdown filtered NOTHING on screen while the Excel button
// beside it passed `clientId` to /api/reports/download, which filters in SQL
// with `.eq('client_id', clientId)`. So the table showed every client and the
// spreadsheet you exported from it showed one -- and the screenshot that found
// this had 'Nayax' selected above a table of SitnStand, Orcam, Crisp Power and
// Time Systems. A file built from the wrong rows gets emailed to a client.
//
// ReportsTabs.tsx had the parameter and could not use it: reports/page.tsx
// selected `clients(name)` and no `client_id`, so the column to filter on was
// not in the payload. Fixed at the source -- the select now carries client_id
// and this is the filter it feeds.
//
// NULL client_id is the case worth the code. It is not hypothetical: the
// production monitor reports 241 shipments from 9 unmapped stores, so these
// rows exist right now and carry real money. `row.client_id === clientId` is
// false for them, which drops them correctly and says nothing -- so a client's
// report would silently omit shipments that might be theirs. Counted, exactly
// as filterByDate counts undated rows, and for the same reason.

type CRow = { client_id: string | null; id: string }

const crow = (id: string, client_id: string | null): CRow => ({ id, client_id })

const NAYAX = '11111111-1111-1111-1111-111111111111'
const ORCAM = '22222222-2222-2222-2222-222222222222'

describe('filterByClient', () => {
  it('keeps only the rows belonging to the selected client', () => {
    const rows = [crow('a', NAYAX), crow('b', ORCAM), crow('c', NAYAX)]
    const r = filterByClient(rows, 'client_id', NAYAX)
    expect(r.rows.map(x => x.id)).toEqual(['a', 'c'])
    expect(r.unattributed).toBe(0)
  })

  it('keeps every row when no client is selected', () => {
    // The ordinary state of the screen. '' is how a cleared <select> arrives,
    // matching how filterByDate reads an empty bound.
    const rows = [crow('a', NAYAX), crow('b', ORCAM), crow('c', null)]
    const r = filterByClient(rows, 'client_id', '')
    expect(r.rows.map(x => x.id)).toEqual(['a', 'b', 'c'])
    expect(r.unattributed).toBe(0)
  })

  it('drops an unattributed row when a client IS selected, and counts it', () => {
    // The 241-shipments case. Dropping is right -- a row with no client is not
    // known to be this client's -- but dropping silently turns an incomplete
    // report into one that looks complete.
    const rows = [crow('a', NAYAX), crow('none', null)]
    const r = filterByClient(rows, 'client_id', NAYAX)
    expect(r.rows.map(x => x.id)).toEqual(['a'])
    expect(r.unattributed).toBe(1)
  })

  it('counts only unattributed drops, not other-client drops', () => {
    // The distinguishing case, and the same rule filterByDate follows. If the
    // count included rows the operator deliberately filtered away by picking a
    // client, it would fire on every normal screen and stop being read.
    const rows = [crow('mine', NAYAX), crow('theirs', ORCAM), crow('none', null)]
    const r = filterByClient(rows, 'client_id', NAYAX)
    expect(r.rows.map(x => x.id)).toEqual(['mine'])
    expect(r.unattributed).toBe(1)
  })

  it('counts an unattributed row as unattributed and not as a non-match', () => {
    // A `rows.filter(r => r.client_id === id)` implementation passes every test
    // above except the counts. This is the one that fails it outright.
    const r = filterByClient([crow('none', null)], 'client_id', NAYAX)
    expect(r.rows).toEqual([])
    expect(r.unattributed).toBe(1)
  })

  it('treats a non-string client_id as unattributed rather than coercing it', () => {
    // Same hazard filterByDate guards: the column may arrive in a shape the
    // select did not promise. `undefined === clientId` is false, which would
    // drop the row with no count -- the silent case this function exists to
    // remove.
    const r = filterByClient(
      [{ id: 'a' } as unknown as CRow, { id: 'b', client_id: 7 } as unknown as CRow],
      'client_id', NAYAX,
    )
    expect(r.rows).toEqual([])
    expect(r.unattributed).toBe(2)
  })

  it('matches exactly, never by prefix', () => {
    // UUIDs share long prefixes. A `startsWith` or `includes` implementation
    // would attribute one client's money to another.
    const r = filterByClient([crow('a', NAYAX + 'X')], 'client_id', NAYAX)
    expect(r.rows).toEqual([])
    expect(r.unattributed).toBe(0)
  })

  it('preserves input order', () => {
    const rows = [crow('c', NAYAX), crow('a', NAYAX), crow('b', NAYAX)]
    expect(filterByClient(rows, 'client_id', NAYAX).rows.map(x => x.id))
      .toEqual(['c', 'a', 'b'])
  })

  it('agrees with .eq(client_id, id), which is what the export does', () => {
    // The parity that matters, for the same reason filterByDate pins its own:
    // the operator reads the table and then presses the button beside it. In
    // Postgres `null = <uuid>` is null, which is not true, so an unattributed
    // row is absent from the spreadsheet -- and must therefore be absent here.
    const pg = (c: string | null, id: string) => c === null ? false : c === id

    for (const c of [NAYAX, ORCAM, null]) {
      const mine = filterByClient([crow('x', c)], 'client_id', NAYAX).rows.length === 1
      expect(mine, String(c)).toBe(pg(c, NAYAX))
    }
  })
})

describe('unattributedNote', () => {
  it('says nothing when every row had a client', () => {
    expect(unattributedNote(0)).toBe('')
    expect(unattributedNote(-1)).toBe('')
  })

  it('names the count and says the rows are missing', () => {
    expect(unattributedNote(4)).toBe('4 shipments with no client not included')
  })

  it('is singular for one', () => {
    expect(unattributedNote(1)).toBe('1 shipment with no client not included')
  })

  it('takes the noun, because these tables are not all shipments', () => {
    expect(unattributedNote(2, 'adjustment')).toBe('2 adjustments with no client not included')
  })

  it('never reads the same as the undated note', () => {
    // The two sit in the same line of the same table and mean different
    // things: one row could not be placed in the PERIOD, the other could not
    // be placed with a CLIENT. Rendering them alike would make the distinction
    // invisible at exactly the moment it decides whose invoice is short.
    expect(unattributedNote(3)).not.toBe(undatedNote(3))
  })
})

describe('scopeRows', () => {
  // The composition, in the library rather than in ReportsTabs.tsx, because
  // vitest.config.ts includes only `src/**/*.test.ts` -- logic inside a .tsx
  // cannot be given a test, and this is the logic that decides which rows a
  // client's report covers. The .tsx is left with no logic of its own to get
  // wrong.

  type SRow = { id: string; client_id: string | null; ship_date: string | null }
  const s = (id: string, client_id: string | null, ship_date: string | null): SRow =>
    ({ id, client_id, ship_date })

  const OCT = { from: '2026-10-01', to: '2026-10-31' }

  it('applies both filters', () => {
    const rows = [
      s('keep', NAYAX, '2026-10-15'),
      s('wrong-client', ORCAM, '2026-10-15'),
      s('wrong-month', NAYAX, '2026-09-15'),
    ]
    const r = scopeRows(rows, { clientKey: 'client_id', clientId: NAYAX, dateKey: 'ship_date', ...OCT })
    expect(r.rows.map(x => x.id)).toEqual(['keep'])
    expect(r.undated).toBe(0)
    expect(r.unattributed).toBe(0)
  })

  it('counts the undated rows of the SELECTED client only', () => {
    // Order is load-bearing and this is the test that pins it: client first,
    // then date. Filtering by date first would report "2 shipments with no
    // date not included" on Nayax's report when one of them is Orcam's --
    // a warning about someone else's data, on a page about this client.
    const rows = [s('a', NAYAX, null), s('b', ORCAM, null), s('c', NAYAX, '2026-10-15')]
    const r = scopeRows(rows, { clientKey: 'client_id', clientId: NAYAX, dateKey: 'ship_date', ...OCT })
    expect(r.rows.map(x => x.id)).toEqual(['c'])
    expect(r.undated).toBe(1)
  })

  it('reports the two omissions separately', () => {
    // They are different facts and they want different fixes: an unattributed
    // row needs a store mapping, an undated one needs a ship_date. One merged
    // count would tell the operator neither.
    const rows = [s('a', NAYAX, '2026-10-15'), s('b', NAYAX, null), s('c', null, '2026-10-15')]
    const r = scopeRows(rows, { clientKey: 'client_id', clientId: NAYAX, dateKey: 'ship_date', ...OCT })
    expect(r.rows.map(x => x.id)).toEqual(['a'])
    expect(r.undated).toBe(1)
    expect(r.unattributed).toBe(1)
  })

  it('is the identity when nothing is selected and no bounds are set', () => {
    const rows = [s('a', NAYAX, '2026-10-15'), s('b', null, null)]
    const r = scopeRows(rows, { clientKey: 'client_id', clientId: '', dateKey: 'ship_date', from: '', to: '' })
    expect(r.rows.map(x => x.id)).toEqual(['a', 'b'])
    expect(r.undated).toBe(0)
    expect(r.unattributed).toBe(0)
  })

  it('preserves input order', () => {
    const rows = [s('c', NAYAX, '2026-10-03'), s('a', NAYAX, '2026-10-01'), s('b', NAYAX, '2026-10-02')]
    const r = scopeRows(rows, { clientKey: 'client_id', clientId: NAYAX, dateKey: 'ship_date', ...OCT })
    expect(r.rows.map(x => x.id)).toEqual(['c', 'a', 'b'])
  })
})
