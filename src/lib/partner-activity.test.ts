import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  fbaUnitsLabel,
  groupOrderUnits,
  fbaActivity,
  ORDER_UNITS_LIMIT,
  type OrderUnitsRow,
} from '@/lib/partner-activity'

// Activity: what shipped, in units, with no money in it anywhere.
// Spec: docs/superpowers/specs/2026-10-20-partner-dashboard-v2-design.md §4.1–4.2
//
// This module exists because of Finding 2 in that spec: the shipped statement
// showed a partner the amount billed on every single order, and `amount /
// quantity` on a line item IS the rate card. A partner who is also an agency
// reads our pricing straight off it. So the per-order AMOUNT goes away and the
// per-order UNIT COUNT replaces it — activity without economics.
//
// The two traps this file is built around, both of which this repo has been
// bitten by before:
//
//   1. `sum` SKIPS NULLS. A month total built by adding up order units reads
//      LOW when one order's unit count is unknown, and a low number presented
//      as a total is worse than no number. Every total here carries its own
//      unknown counter and the renderer must not print one without the other.
//   2. NULL IS NOT ZERO. An FBA month nobody has typed yet and an FBA month
//      that genuinely shipped nothing are different facts, and collapsing them
//      tells a partner his month was empty when the truth is that no staff
//      member has got to it. fba_invoices keeps them distinct on purpose.

const row = (over: Partial<OrderUnitsRow> = {}): OrderUnitsRow => ({
  period_month: '2026-09-01',
  client_id: 'c1',
  client_name: 'Acme',
  referral_partner_id: 'p1',
  order_date: '2026-09-15',
  order_number: 'SO-1',
  units: 3,
  units_estimated: false,
  ...over,
})

describe('fbaUnitsLabel — null is not zero', () => {
  it('says the figure was never recorded when it is null', () => {
    expect(fbaUnitsLabel(null)).toBe('not recorded yet')
  })

  it('says the same for undefined — an absent column is not a zero either', () => {
    expect(fbaUnitsLabel(undefined)).toBe('not recorded yet')
  })

  it('prints a real zero as 0', () => {
    // The whole point of the pair of tests above and this one. A month that
    // shipped nothing is a fact we are entitled to state; a month nobody
    // typed is not.
    expect(fbaUnitsLabel(0)).toBe('0')
  })

  it('groups thousands, because unit counts get large', () => {
    expect(fbaUnitsLabel(1234)).toBe('1,234')
  })

  it('reads a numeric column that arrived as a string', () => {
    // numeric(10,2) over the wire is not reliably a JS number. '0' must not
    // become 'not recorded yet' on the way through.
    expect(fbaUnitsLabel('0' as unknown as number)).toBe('0')
    expect(fbaUnitsLabel('1234' as unknown as number)).toBe('1,234')
  })

  it('treats an empty string as not recorded, not as zero', () => {
    // An empty string in a numeric column is a column written wrong. Reading
    // it as 0 would state a figure nobody entered.
    expect(fbaUnitsLabel('' as unknown as number)).toBe('not recorded yet')
  })

  it('refuses to invent a figure from garbage', () => {
    expect(fbaUnitsLabel('abc' as unknown as number)).toBe('not recorded yet')
    expect(fbaUnitsLabel(Number.NaN)).toBe('not recorded yet')
  })

  it('drops a trailing .00 but keeps a real fraction', () => {
    expect(fbaUnitsLabel(12)).toBe('12')
    expect(fbaUnitsLabel(12.5)).toBe('12.5')
  })
})

describe('groupOrderUnits — one group per client-month', () => {
  it('has nothing to say about no orders', () => {
    expect(groupOrderUnits([])).toEqual([])
  })

  it('totals the units of one client-month', () => {
    const out = groupOrderUnits([row({ units: 3 }), row({ order_number: 'SO-2', units: 4 })])
    expect(out).toHaveLength(1)
    expect(out[0].totalUnits).toBe(7)
    expect(out[0].orders).toHaveLength(2)
    expect(out[0].clientName).toBe('Acme')
    expect(out[0].periodMonth).toBe('2026-09-01')
  })

  it('keeps months apart and puts the newest first', () => {
    const out = groupOrderUnits([
      row({ period_month: '2026-08-01', order_date: '2026-08-02', order_number: 'A' }),
      row({ period_month: '2026-10-01', order_date: '2026-10-02', order_number: 'C' }),
      row({ period_month: '2026-09-01', order_date: '2026-09-02', order_number: 'B' }),
    ])
    expect(out.map((g) => g.periodMonth)).toEqual(['2026-10-01', '2026-09-01', '2026-08-01'])
  })

  it('keeps two clients in the same month apart, ordered by name', () => {
    const out = groupOrderUnits([
      row({ client_id: 'c2', client_name: 'Zenith' }),
      row({ client_id: 'c1', client_name: 'Acme' }),
    ])
    expect(out).toHaveLength(2)
    expect(out.map((g) => g.clientName)).toEqual(['Acme', 'Zenith'])
  })

  it('splits two clients that share a name but not an id', () => {
    // Grouping by name would merge two real companies into one row and
    // attribute one's volume to the other.
    const out = groupOrderUnits([
      row({ client_id: 'c1', client_name: 'Acme' }),
      row({ client_id: 'c2', client_name: 'Acme' }),
    ])
    expect(out).toHaveLength(2)
  })

  it('puts the newest order first inside a group', () => {
    const out = groupOrderUnits([
      row({ order_number: 'OLD', order_date: '2026-09-02' }),
      row({ order_number: 'NEW', order_date: '2026-09-28' }),
    ])
    expect(out[0].orders.map((o) => o.order_number)).toEqual(['NEW', 'OLD'])
  })

  it('sorts an undated order last instead of crashing', () => {
    const out = groupOrderUnits([
      row({ order_number: 'UNDATED', order_date: null }),
      row({ order_number: 'DATED', order_date: '2026-09-02' }),
    ])
    expect(out[0].orders.map((o) => o.order_number)).toEqual(['DATED', 'UNDATED'])
  })
})

describe('groupOrderUnits — an unknown unit count is never a zero', () => {
  it('counts an order with null units instead of adding nothing', () => {
    // THE TRAP. Adding `?? 0` here makes the total read LOW and look
    // complete. The counter is the only thing that distinguishes a finished
    // total from a partial one.
    const out = groupOrderUnits([row({ units: 5 }), row({ order_number: 'SO-2', units: null })])
    expect(out[0].totalUnits).toBe(5)
    expect(out[0].unitsUnknownOrders).toBe(1)
  })

  it('reports no unknowns when every order has a count', () => {
    // The control. Without it, a `unitsUnknownOrders` hardcoded to 1 would
    // pass the test above.
    const out = groupOrderUnits([row({ units: 5 })])
    expect(out[0].unitsUnknownOrders).toBe(0)
  })

  it('keeps a genuine zero-unit order out of the unknown count', () => {
    const out = groupOrderUnits([row({ units: 0 })])
    expect(out[0].totalUnits).toBe(0)
    expect(out[0].unitsUnknownOrders).toBe(0)
  })

  it('reads unit counts that arrived as strings', () => {
    const out = groupOrderUnits([
      row({ units: '3' as unknown as number }),
      row({ order_number: 'SO-2', units: '4.5' as unknown as number }),
    ])
    expect(out[0].totalUnits).toBe(7.5)
    expect(out[0].unitsUnknownOrders).toBe(0)
  })

  it('treats an unparseable unit count as unknown, not as zero', () => {
    const out = groupOrderUnits([row({ units: 'abc' as unknown as number })])
    expect(out[0].totalUnits).toBe(0)
    expect(out[0].unitsUnknownOrders).toBe(1)
  })

  it('does not accumulate floating-point dust across many orders', () => {
    // 0.1 * 3 is 0.30000000000000004 in IEEE754, and a unit count printed as
    // that is a screen nobody trusts again.
    const out = groupOrderUnits([
      row({ order_number: 'a', units: 0.1 }),
      row({ order_number: 'b', units: 0.1 }),
      row({ order_number: 'c', units: 0.1 }),
    ])
    expect(out[0].totalUnits).toBe(0.3)
  })
})

describe('groupOrderUnits — the estimated flag is sticky', () => {
  it('marks the month estimated when any one order fell back to ordered quantity', () => {
    const out = groupOrderUnits([
      row({ order_number: 'picked', units_estimated: false }),
      row({ order_number: 'ordered', units_estimated: true }),
    ])
    expect(out[0].unitsEstimated).toBe(true)
  })

  it('leaves a fully picked month unflagged', () => {
    // The control for the sticky flag.
    const out = groupOrderUnits([row({ units_estimated: false })])
    expect(out[0].unitsEstimated).toBe(false)
  })

  it('does not let a null flag read as estimated', () => {
    // units_estimated is boolean and nullable over the wire. Null means the
    // view said nothing, and claiming "estimated" on a figure that is not
    // would make the word meaningless where it does appear.
    expect(groupOrderUnits([row({ units_estimated: null })])[0].unitsEstimated).toBe(false)
  })

  it('flags an order whose every line was unpicked as estimated, not as zero units', () => {
    // §8: "An order whose every line has null quantity_picked reports
    // estimated units, not zero units." The view supplies the fallback; this
    // pins that the fallback survives the grouping with its flag intact.
    const out = groupOrderUnits([row({ units: 6, units_estimated: true })])
    expect(out[0].totalUnits).toBe(6)
    expect(out[0].unitsEstimated).toBe(true)
    expect(out[0].unitsUnknownOrders).toBe(0)
  })
})

describe('fbaActivity — hand-typed months only', () => {
  const clients = [
    { id: 'c1', name: 'Acme' },
    { id: 'c2', name: 'Zenith' },
  ]

  it('has nothing to say with no invoices', () => {
    expect(fbaActivity([], clients)).toEqual([])
  })

  it('names the client and carries the figure through', () => {
    const out = fbaActivity([{ client_id: 'c1', period: '2026-09-01', units_shipped: 400 }], clients)
    expect(out).toEqual([{ clientId: 'c1', clientName: 'Acme', period: '2026-09-01', unitsShipped: 400 }])
  })

  it('keeps a null figure as null rather than dropping the month', () => {
    // The month EXISTS — someone typed the row. Omitting it would read as no
    // FBA activity; keeping it lets the renderer say "not recorded yet".
    const out = fbaActivity([{ client_id: 'c1', period: '2026-09-01', units_shipped: null }], clients)
    expect(out).toHaveLength(1)
    expect(out[0].unitsShipped).toBeNull()
  })

  it('keeps a real zero distinct from a null', () => {
    const out = fbaActivity([{ client_id: 'c1', period: '2026-09-01', units_shipped: 0 }], clients)
    expect(out[0].unitsShipped).toBe(0)
  })

  it('puts the newest month first, then the client name', () => {
    const out = fbaActivity(
      [
        { client_id: 'c2', period: '2026-08-01', units_shipped: 1 },
        { client_id: 'c2', period: '2026-09-01', units_shipped: 2 },
        { client_id: 'c1', period: '2026-09-01', units_shipped: 3 },
      ],
      clients,
    )
    expect(out.map((r) => `${r.period}/${r.clientName}`)).toEqual([
      '2026-09-01/Acme',
      '2026-09-01/Zenith',
      '2026-08-01/Zenith',
    ])
  })

  it('DROPS a month for a client who is not this partner s', () => {
    // The disclosure rule, restated in the app because a helper that takes
    // both lists can be called with mismatched ones. A client id with no
    // entry in `clients` is not this partner's to see named, and printing it
    // with a blank name would still disclose a period and a volume.
    const out = fbaActivity(
      [
        { client_id: 'c1', period: '2026-09-01', units_shipped: 1 },
        { client_id: 'SOMEONE-ELSE', period: '2026-09-01', units_shipped: 999 },
      ],
      clients,
    )
    expect(out).toHaveLength(1)
    expect(out[0].clientId).toBe('c1')
  })

  it('falls back to a placeholder when the client row has no name', () => {
    const out = fbaActivity(
      [{ client_id: 'c3', period: '2026-09-01', units_shipped: 1 }],
      [{ id: 'c3', name: null }],
    )
    expect(out).toHaveLength(1)
    expect(out[0].clientName).toBe('Unnamed client')
  })
})

// ---------------------------------------------------------------------------
// The view itself. These assert on the SQL TEXT, which is weaker than asserting
// on a database — but the thing being protected is a column list, and a column
// list is exactly what the text does say. §8 names the first of these.
// ---------------------------------------------------------------------------
describe('supabase/partner_order_units.sql — no money in the view', () => {
  const sql = readFileSync('supabase/partner_order_units.sql', 'utf8')

  /**
   * The view's select list, with comments stripped.
   *
   * Comments are stripped FIRST and that is the whole reason this helper
   * exists: every assertion below is an ABSENCE, and the comments in that file
   * explain at length why there is no amount column. A grep over the raw text
   * would find the word `amount` in the prose defending its absence and report
   * the exact opposite of the truth. This repo has made that mistake before —
   * a /\b429\b/ guard once tripped on the comment explaining why the response
   * is NOT a 429.
   */
  const selectList = (() => {
    const m = /create\s+view\s+public\.partner_order_units\s+as([\s\S]*?);/i.exec(sql)
    if (!m) throw new Error('could not find the create view statement')
    return m[1]
      .replace(/--[^\n]*/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
  })()

  it('found a select list to judge, and stripped the comments out of it', () => {
    // The control. Every test below is an absence, so a selectList that came
    // back empty — a renamed view, a regex that stopped matching — would pass
    // all of them by examining nothing.
    expect(selectList.length).toBeGreaterThan(100)
    expect(selectList).toContain('units')
    expect(selectList).toContain('order_number')
    // And proof the stripping worked: the file's prose says `amount` and the
    // stripped select list must not.
    expect(sql).toContain('amount')
  })

  for (const word of ['amount', 'rate', 'cost', 'price']) {
    it(`selects no column whose name contains "${word}"`, () => {
      // §8. Absent from the VIEW, not hidden in the render, so a later caller
      // cannot select what does not exist.
      expect(selectList.toLowerCase()).not.toContain(word)
    })
  }

  it('names every column the loader reads, and no others', () => {
    // §4.1: "That is the complete column list." Pinned as an exact set so
    // adding a column to the view is a decision someone has to come here and
    // make, rather than something that happens.
    const declared = [...selectList.matchAll(/\bas\s+([a-z_0-9]+)\b/gi)].map((m) => m[1])
    const bare = ['client_id', 'order_number', 'order_date', 'units', 'client_name']
    const all = new Set([...declared, ...bare.filter((c) => selectList.includes(c))])
    expect([...all].sort()).toEqual([
      'client_id',
      'client_name',
      'order_date',
      'order_number',
      'period_month',
      'referral_partner_id',
      'units',
      'units_estimated',
    ])
  })

  it('excludes cancelled orders with `is not true`, never `not cancelled`', () => {
    // orders.cancelled is nullable, and `not null` is null, which a WHERE
    // drops — so `not o.cancelled` silently hides every order written before
    // the column was populated. ledger_04_views.sql documents this at length
    // and pick_days gets it right; this view must agree with both.
    expect(sql).toMatch(/cancelled\s+is\s+not\s+true/i)
    expect(sql).not.toMatch(/where\s+not\s+[a-z_.]*cancelled/i)
  })

  it('applies the partner filter in SQL', () => {
    // §4.1. Putting the aggregation in SQL also puts the disclosure rule in
    // SQL, where an app-side refactor cannot drop it.
    expect(sql).toMatch(/referral_partner_id\s+is\s+not\s+null/i)
  })

  it('revokes the view from anon and authenticated', () => {
    // The partner portal signs in people who are emphatically not staff. A
    // partner who could read this view directly would see every OTHER
    // partner's clients and order volumes.
    expect(sql).toMatch(/revoke\s+all\s+on\s+public\.partner_order_units/i)
    expect(sql).toMatch(/from\s+anon,\s*authenticated,\s*public/i)
  })

  it('does not drop partner_order_transactions', () => {
    // §4.1: the transactions view stops being READ by the partner statement.
    // It is not dropped — /pnl and staff screens may use it, and dropping a
    // view to change a partner screen is blast radius for nothing.
    expect(sql).not.toMatch(/drop\s+view\s+if\s+exists\s+public\.partner_order_transactions/i)
  })
})

describe('the partner statement no longer reads per-order amounts', () => {
  it('does not read partner_order_transactions anywhere on the partner path', () => {
    // Finding 2's resolution, pinned at the app layer as well as the view
    // layer. The loader is shared with /pnl, so this is the assertion that
    // keeps the amount out of reach of the statement: if the loader does not
    // fetch it, no component can render it.
    for (const file of [
      'src/lib/partner-ledger.ts',
      'src/components/partner/Statement.tsx',
    ]) {
      const src = readFileSync(file, 'utf8')
        .replace(/\/\/[^\n]*/g, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
      expect(src, `${file} reads partner_order_transactions`).not.toContain(
        'partner_order_transactions',
      )
      expect(src, `${file} renders amount_billed`).not.toContain('amount_billed')
    }
  })

  it('still reads something — the control for the two absences above', () => {
    const src = readFileSync('src/lib/partner-ledger.ts', 'utf8')
    expect(src).toContain('partner_client_monthly')
    expect(src).toContain('partner_order_units')
  })
})

describe('ORDER_UNITS_LIMIT', () => {
  it('caps the read so a truncation can be admitted rather than hidden', () => {
    expect(ORDER_UNITS_LIMIT).toBeGreaterThan(0)
    expect(Number.isInteger(ORDER_UNITS_LIMIT)).toBe(true)
  })
})
