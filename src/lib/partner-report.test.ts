import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { createFakeSupabase, type FakeDb, type FakeRow } from '@/lib/ledger/fake-supabase'

// The loader is the thing that scopes a report to one partner, so the
// scoping test at the bottom of this file drives the REAL loader against
// the real fake. Only that one block needs the mock; buildPartnerReport
// itself touches no client.
const h = vi.hoisted(() => ({ db: null as unknown as FakeDb }))

vi.mock('@/lib/supabase', () => ({
  get supabaseAdmin() {
    return h.db.client
  },
}))

import { buildPartnerReport, reportFilename, type ReportInput } from './partner-report'
import { fbaActivity } from './partner-activity'
import { rosterRows } from './partner-roster'

const { loadPartnerLedger } = await import('./partner-ledger')
import type { PartnerStatement, StatementClientLine, StatementMonth } from './referrals'
import type { RosterRow } from './partner-roster'
import type { OrderUnitsRow, FbaActivityRow } from './partner-activity'
import type { BonusState } from './partner-bonus-state'

// ============================================================
// The export is a DISCLOSURE SURFACE, and the whole reason this module is
// pure and separately tested is that a CSV is the easiest place in the
// system to leak a figure by accident. On the screen a number has to be
// written into JSX by hand. Here, anything in the input object is one
// careless `Object.values` away from a column.
//
// So the tests below are weighted toward ABSENCE. Spec §5 names two
// exclusions outright -- `cost_labour_not_deducted` and any per-order
// amount -- and both get a test that asserts the string does not occur
// anywhere in the output, header or body. A test that only checked the
// columns it expected would pass with an extra column beside them.
// ============================================================

function line(over: Partial<StatementClientLine> = {}): StatementClientLine {
  return {
    clientId: 'c1',
    clientName: 'Acme Goods',
    units: null,
    orders: null,
    billed: 1000,
    costs: { freight: 100, materials: 20, storage: 30, processing: 50 },
    totalCosts: 200,
    netProfit: 800,
    share: 40,
    status: 'computed',
    dedupeKey: 'c1:2026-09',
    ...over,
  }
}

function month(over: Partial<StatementMonth> = {}): StatementMonth {
  return {
    period: '2026-09',
    clients: [line()],
    bonuses: [],
    earned: 40,
    carriedIn: 0,
    payable: 40,
    carriedOut: 0,
    ...over,
  }
}

function statement(over: Partial<PartnerStatement> = {}): PartnerStatement {
  return {
    months: [month()],
    lifetimeEarned: 40,
    paidToDate: 0,
    awaitingPayment: 40,
    carryForward: 0,
    activeClients: 1,
    ...over,
  }
}

function roster(over: Partial<RosterRow> = {}): RosterRow {
  return {
    clientId: 'c1',
    clientName: 'Acme Goods',
    referred: '2026-06-01',
    firstPaid: '2026-07-15',
    state: 'earning',
    window: { month: 3, of: 12, closesAfter: 'June 2027' },
    ...over,
  }
}

function orderRow(over: Partial<OrderUnitsRow> = {}): OrderUnitsRow {
  return {
    period_month: '2026-09-01',
    client_id: 'c1',
    client_name: 'Acme Goods',
    referral_partner_id: 'p1',
    order_date: '2026-09-04',
    order_number: 'SO-1001',
    units: 12,
    units_estimated: false,
    ...over,
  }
}

function fbaRow(over: Partial<FbaActivityRow> = {}): FbaActivityRow {
  return { clientId: 'c1', clientName: 'Acme Goods', period: '2026-09', unitsShipped: 480, ...over }
}

function input(over: Partial<ReportInput> = {}): ReportInput {
  return {
    statement: statement(),
    roster: [roster()],
    bonuses: new Map<string, BonusState>([['c1', 'paid']]),
    orders: [orderRow()],
    ordersTruncated: false,
    fba: [fbaRow()],
    ...over,
  }
}

/** Split a CSV into cells the way a spreadsheet would, so assertions see fields. */
function cells(csv: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < csv.length; i++) {
    const ch = csv[i]
    if (quoted) {
      if (ch === '"' && csv[i + 1] === '"') {
        cell += '"'
        i++
      } else if (ch === '"') quoted = false
      else cell += ch
      continue
    }
    if (ch === '"') quoted = true
    else if (ch === ',') {
      row.push(cell)
      cell = ''
    } else if (ch === '\r') continue
    else if (ch === '\n') {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else cell += ch
  }
  row.push(cell)
  rows.push(row)
  return rows
}

/** The rows of one labelled section, between its title and the next blank line. */
function section(csv: string, title: string): string[][] {
  const all = cells(csv)
  const start = all.findIndex((r) => r[0] === title)
  expect(start, `section "${title}" is missing`).toBeGreaterThanOrEqual(0)
  const out: string[][] = []
  for (let i = start + 1; i < all.length; i++) {
    if (all[i].length === 1 && all[i][0] === '') break
    out.push(all[i])
  }
  return out
}

describe('buildPartnerReport — the two named exclusions', () => {
  // Spec §5: "Two exclusions with tests that assert absence by name."
  //
  // Both are asserted over the WHOLE file, not over the section each
  // would naturally land in. A column added to the wrong section is
  // still a disclosure, and the point of an absence test is that it does
  // not need to know where the mistake will be made.

  it('never contains cost_labour_not_deducted, by that name or its heading', () => {
    // Reported to STAFF and never deducted from a partner's net profit:
    // partner net profit is structurally higher than Shipo's real gross
    // margin by exactly this figure. A partner who sees the column will
    // reasonably ask to have it deducted -- or conclude we are hiding
    // margin -- and in both cases we have handed him a number the signed
    // agreement never gave him.
    const csv = buildPartnerReport(input())
    expect(csv).not.toContain('cost_labour_not_deducted')
    expect(csv.toLowerCase()).not.toContain('labour')
    expect(csv.toLowerCase()).not.toContain('labor')
  })

  it('carries no money at all in the DTC orders section', () => {
    // `amount / quantity` on ONE order IS the rate card. Several referral
    // partners are agencies that also resell fulfilment, so a per-order
    // amount beside a unit count hands a competitor our per-unit price.
    //
    // Asserted as "no currency anywhere in these rows" rather than "the
    // amount column is absent", because the leak does not have to be
    // called `amount` to be the rate card.
    const csv = buildPartnerReport(input())
    const rows = section(csv, 'DTC orders')
    for (const row of rows) {
      for (const cell of row) {
        expect(cell).not.toContain('$')
      }
    }
    expect(rows[0]).toEqual(['Order date', 'Client', 'Order number', 'Units', 'Units estimated'])
  })
})

describe('buildPartnerReport — monthly section', () => {
  it('carries revenue, the four deducted costs, net profit and the share', () => {
    const rows = section(buildPartnerReport(input()), 'Monthly')
    expect(rows[0]).toEqual([
      'Period',
      'Client',
      'Revenue',
      'Freight',
      'Materials',
      'Storage',
      'Processing',
      'Net profit',
      'Your share (5%)',
      'Payable',
    ])
    expect(rows[1].slice(0, 9)).toEqual([
      '2026-09',
      'Acme Goods',
      '1000.00',
      '100.00',
      '20.00',
      '30.00',
      '50.00',
      '800.00',
      '40.00',
    ])
  })

  it('writes figures unformatted so a spreadsheet reads them as numbers', () => {
    // No `$`, no thousands separator, in the money cells. A P&L is what
    // this reconciles against (§5) and `$1,000.00` imports as text --
    // which silently sums to zero in the column the accountant totals.
    const rows = section(buildPartnerReport(input({ statement: statement({ months: [month({ clients: [line({ billed: 12345.5 })] })] }) })), 'Monthly')
    expect(rows[1][2]).toBe('12345.50')
  })

  it('says a month under the minimum is carried forward, and names the minimum', () => {
    const csv = buildPartnerReport(
      input({ statement: statement({ months: [month({ payable: 0, clients: [line({ share: 12 })] })] }) }),
    )
    expect(section(csv, 'Monthly')[1][9]).toBe('Carried forward — under the $50 minimum')
  })

  it('says a provisional month is still being priced, and not that it is payable', () => {
    // `share` is 0 on a provisional line, so the row already reads $0.00.
    // A "Payable" beside that 0 is a statement that the month is settled
    // at nothing, which is the one thing it is not.
    const csv = buildPartnerReport(
      input({
        statement: statement({ months: [month({ clients: [line({ provisional: true, share: 0 })] })] }),
      }),
    )
    const cell = section(csv, 'Monthly')[1][9]
    expect(cell).toBe('Still being priced')
    expect(cell).not.toContain('Payable')
  })

  it('reports a paid month as paid rather than as payable', () => {
    const csv = buildPartnerReport(
      input({ statement: statement({ months: [month({ clients: [line({ status: 'paid' })] })] }) }),
    )
    expect(section(csv, 'Monthly')[1][9]).toBe('Paid')
  })
})

describe('buildPartnerReport — the money gate', () => {
  // §5: "Every figure here is already on his screen, so the export adds
  // no disclosure." Read the other way round, which is the direction that
  // matters: a figure NOT on his screen must not be in the export.
  //
  // The statement screen gates every dollar on holdsW9(partner) and
  // passes `statement: null` here when it is withheld. The hazard is a
  // zero: a monthly section built from an empty statement renders a
  // perfectly plausible $0.00 and tells a partner he earned nothing,
  // when in fact we are holding his figures pending a tax form.

  it('omits every money figure when the statement is withheld', () => {
    const csv = buildPartnerReport(input({ statement: null, bonuses: null }))
    const rows = section(csv, 'Monthly')
    expect(rows).toHaveLength(2) // header, then one explanation
    expect(rows[1][0]).toContain('W-9')
    expect(csv).not.toContain('0.00')
  })

  it('still reports the dates and the unit counts when money is withheld', () => {
    // Units are not money and the dates are his own facts. Withholding
    // them too would make the W-9 gate look like a dead dashboard.
    const csv = buildPartnerReport(input({ statement: null, bonuses: null }))
    expect(section(csv, 'DTC orders')[1]).toEqual(['2026-09-04', 'Acme Goods', 'SO-1001', '12', 'No'])
    expect(section(csv, 'FBA')[1]).toEqual(['2026-09', 'Acme Goods', '480'])
    const bonus = section(csv, 'Bonus and payouts')[1]
    expect(bonus[2]).toBe('2026-06-01')
    expect(bonus[3]).toBe('2026-07-15')
  })

  it('does not state a bonus outcome when money is withheld', () => {
    const csv = buildPartnerReport(input({ statement: null, bonuses: null }))
    const bonus = section(csv, 'Bonus and payouts')[1]
    expect(bonus[1]).toContain('W-9')
    expect(bonus[1]).not.toContain('300')
  })
})

describe('buildPartnerReport — DTC orders section', () => {
  it('says a missing unit count is not recorded instead of zero', () => {
    // NULL IS NOT ZERO. `units` is a sum over order_items.quantity and
    // `sum` skips nulls, so an order whose every line is unquantified
    // comes back null. Writing 0 tells the partner the order shipped
    // nothing -- for an order that shipped.
    const csv = buildPartnerReport(input({ orders: [orderRow({ units: null })] }))
    expect(section(csv, 'DTC orders')[1][3]).toBe('not recorded yet')
  })

  it('flags an estimated unit count', () => {
    const csv = buildPartnerReport(input({ orders: [orderRow({ units_estimated: true })] }))
    expect(section(csv, 'DTC orders')[1][4]).toBe('Yes')
  })

  it('leaves an unknown order date and number blank rather than inventing one', () => {
    const csv = buildPartnerReport(input({ orders: [orderRow({ order_date: null, order_number: null })] }))
    const row = section(csv, 'DTC orders')[1]
    expect(row[0]).toBe('')
    expect(row[2]).toBe('')
  })

  it('warns when the order read hit its cap, so a short export is not read as a full one', () => {
    // An accountant reconciling against a P&L will treat this file as
    // complete unless it says otherwise. The old statement had the same
    // hazard and solved it with an on-screen note; a download leaves the
    // screen behind.
    const csv = buildPartnerReport(input({ ordersTruncated: true }))
    expect(csv).toContain('2,000')
    expect(csv.toLowerCase()).toContain('not every order')
  })

  it('does not warn about the cap when the read was complete', () => {
    expect(buildPartnerReport(input()).toLowerCase()).not.toContain('not every order')
  })
})

describe('buildPartnerReport — FBA section', () => {
  it('reports units prepped, and "not recorded yet" for a month nobody typed', () => {
    const csv = buildPartnerReport(input({ fba: [fbaRow({ unitsShipped: null })] }))
    expect(section(csv, 'FBA')[1]).toEqual(['2026-09', 'Acme Goods', 'not recorded yet'])
  })

  it('reports a recorded zero as zero', () => {
    // The mirror of the test above, and the reason fbaUnitsLabel exists:
    // 0 is a fact somebody entered, null is the absence of one.
    const csv = buildPartnerReport(input({ fba: [fbaRow({ unitsShipped: 0 })] }))
    expect(section(csv, 'FBA')[1][2]).toBe('0')
  })
})

describe('buildPartnerReport — bonus and payouts section', () => {
  it('carries the client, the bonus state, and both dates', () => {
    const rows = section(buildPartnerReport(input()), 'Bonus and payouts')
    expect(rows[0]).toEqual(['Client', 'Sign-up bonus', 'Referred', 'First payment'])
    expect(rows[1][0]).toBe('Acme Goods')
    expect(rows[1][1]).toContain('300')
    expect(rows[1][2]).toBe('2026-06-01')
    expect(rows[1][3]).toBe('2026-07-15')
  })

  it('leaves a date blank when it was never recorded', () => {
    // Never substituted, never guessed -- the same rule RosterRow states
    // for the screen. A partner planning around a window start needs to
    // know the date is missing, not be handed today's.
    const csv = buildPartnerReport(input({ roster: [roster({ referred: null, firstPaid: null })] }))
    const row = section(csv, 'Bonus and payouts')[1]
    expect(row[2]).toBe('')
    expect(row[3]).toBe('')
  })

  it('says nothing about a bonus with no state rather than implying one', () => {
    // computeOwed produced no signup_bonus line for this client at all.
    // The screen prints a dash; the file must not print "not qualified",
    // which is a verdict we did not reach.
    const csv = buildPartnerReport(input({ bonuses: new Map() }))
    expect(section(csv, 'Bonus and payouts')[1][1]).toBe('')
  })
})

describe('buildPartnerReport — no staff voice reaches the partner', () => {
  it('contains none of the staff instructions computeOwed writes', () => {
    // These three phrases are actions only Shipo can take, about fields
    // the partner cannot see. They live in computeOwed's notes, which is
    // one map lookup away from every state label this file prints.
    const csv = buildPartnerReport(
      input({ bonuses: new Map<string, BonusState>([['c1', 'in_review']]) }),
    ).toLowerCase()
    expect(csv).not.toContain('set the first-payment date')
    expect(csv).not.toContain('re-send')
    expect(csv).not.toContain('reactivate')
  })
})

describe('buildPartnerReport — the empty partner', () => {
  it('produces all four labelled sections for a partner with no clients', () => {
    // Review Focus 6: a partner with zero clients opening Reports. The
    // failure to avoid is a zero-byte download, which reads as a broken
    // button rather than as an empty account.
    const csv = buildPartnerReport({
      statement: statement({ months: [] }),
      roster: [],
      bonuses: new Map(),
      orders: [],
      ordersTruncated: false,
      fba: [],
    })
    for (const title of ['Monthly', 'DTC orders', 'FBA', 'Bonus and payouts']) {
      expect(section(csv, title).length).toBeGreaterThanOrEqual(2)
    }
    expect(csv.toLowerCase()).toContain('nothing to report yet')
  })
})

describe('buildPartnerReport — CSV quoting', () => {
  it('quotes a client name containing a comma so it stays one cell', () => {
    // Real client names do this: "Acme Goods, Inc." An unquoted comma
    // shifts every figure on the row one column left, which in the
    // Monthly section files freight under revenue.
    const csv = buildPartnerReport(input({ roster: [roster({ clientName: 'Acme Goods, Inc.' })] }))
    const row = section(csv, 'Bonus and payouts')[1]
    expect(row[0]).toBe('Acme Goods, Inc.')
    expect(row).toHaveLength(4)
  })

  it('doubles an embedded quote', () => {
    const csv = buildPartnerReport(input({ roster: [roster({ clientName: 'The "Big" Co' })] }))
    expect(csv).toContain('"The ""Big"" Co"')
    expect(section(csv, 'Bonus and payouts')[1][0]).toBe('The "Big" Co')
  })

  it('keeps a newline inside a name in one cell', () => {
    const csv = buildPartnerReport(input({ roster: [roster({ clientName: 'Two\nLines' })] }))
    expect(section(csv, 'Bonus and payouts')[1][0]).toBe('Two\nLines')
  })

  it('neutralises a leading = so a pasted name cannot run as a formula', () => {
    // CSV injection. A client name is partner-supplied text (§2 lets him
    // paste a roster), and Excel executes a cell beginning = + - or @.
    // The accountant opening this file is the target.
    const csv = buildPartnerReport(input({ roster: [roster({ clientName: '=HYPERLINK("http://x","go")' })] }))
    const cell = section(csv, 'Bonus and payouts')[1][0]
    expect(cell.startsWith('=')).toBe(false)
    expect(cell).toContain('HYPERLINK')
  })
})

// ============================================================
// The route. Spec §5 fixes three things a module test cannot see: GET,
// authenticated by getPartnerFromSession(), and the partner id applied
// in the SQL predicate rather than by filtering in the app.
// ============================================================

const ROUTE = 'src/app/api/partner/report/route.ts'
const STATEMENT = 'src/components/partner/Statement.tsx'

const codeOf = (file: string) =>
  readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

describe('the report route', () => {
  it('reads the route and finds real code (control for every absence below)', () => {
    // Without this control every `not.toContain` below passes on a
    // renamed or deleted file, which is the failure mode that makes an
    // absence suite worthless.
    const src = codeOf(ROUTE)
    expect(src.length, 'route read as empty -- is the path right?').toBeGreaterThan(500)
    expect(src).toContain('export async function GET')
  })

  it('exposes no write verb', () => {
    // A download is a read. An exported POST here would be a second,
    // unreviewed entry point into the same partner data.
    const src = codeOf(ROUTE)
    for (const verb of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(src).not.toContain(`export async function ${verb}`)
    }
  })

  it('authenticates before it reads anything', () => {
    // Every read below needs a partner id. Reading first and checking
    // after is how an unauthenticated request ends up having already
    // queried somebody's ledger.
    const src = codeOf(ROUTE)
    const auth = src.indexOf('getPartnerFromSession()')
    const load = src.indexOf('loadPartnerLedger(')
    expect(auth).toBeGreaterThan(-1)
    expect(load).toBeGreaterThan(auth)
  })

  it('applies the partner id in the query, never by filtering the result', () => {
    // §5 in as many words. The loader puts the id inside each of its
    // four queries; the payouts read here carries its own eq. What must
    // not appear is a filter over rows we already fetched.
    const src = codeOf(ROUTE)
    expect(src).toContain('loadPartnerLedger(partner.id)')
    expect(src).toContain(".eq('referral_partner_id', partner.id)")
    expect(src).not.toMatch(/\.filter\(\s*\(?\s*\w+\s*\)?\s*=>[^)]*referral_partner_id/)
  })

  it('refuses to serve a file when a read failed', () => {
    // THE WORST OUTPUT THIS ROUTE CAN PRODUCE. Every read in the loader
    // ends in `.data ?? []`, so a failed query is indistinguishable from
    // a partner who is owed nothing -- and this serialises that to
    // "Nothing to report yet." in a file he keeps and forwards to his
    // accountant. The screen already refuses; the download must too.
    const src = codeOf(ROUTE)
    const guard = src.indexOf('ledger.readFailed')
    const build = src.indexOf('buildPartnerReport(')
    expect(guard).toBeGreaterThan(-1)
    expect(build).toBeGreaterThan(guard)
    expect(src).toContain('status: 503')
  })

  it('asks the W-9 gate before it reads payouts, not before it renders', () => {
    // The ordering partner-w9.test.ts pins for the screen. A payout read
    // performed unconditionally is one serialiser away from the file.
    const src = codeOf(ROUTE)
    const gate = src.indexOf('holdsW9(partner)')
    const payouts = src.indexOf('referral_payouts')
    expect(gate).toBeGreaterThan(-1)
    expect(payouts).toBeGreaterThan(gate)
    expect(src).toContain('showMoney ?')
  })

  it('names no staff-only cost column', () => {
    const src = codeOf(ROUTE)
    expect(src).not.toContain('cost_labour_not_deducted')
    expect(src).not.toContain('order_charges')
    expect(src).not.toContain('partner_order_transactions')
  })

  it('never selects *', () => {
    expect(codeOf(ROUTE)).not.toMatch(/select\(\s*['"`]\*/)
  })

  it('sends the file as an attachment and forbids caching it', () => {
    const src = codeOf(ROUTE)
    expect(src).toContain('attachment; filename=')
    expect(src).toContain('text/csv')
    expect(src).toMatch(/no-store/)
  })

  it('is reachable from the statement screen', () => {
    // A route nothing links to is not a shipped feature. §5 asks for a
    // download the partner can hand to a bookkeeper, and a partner does
    // not type API paths.
    const src = codeOf(STATEMENT)
    expect(src.length).toBeGreaterThan(500)
    expect(src).toContain('/api/partner/report')
  })

  it('offers no download on the screen that could not read his figures', () => {
    // The failure branch returns before the link is rendered. A download
    // button beside "we can't show your statement" produces either a 503
    // or — if the read recovers for one query and not another — a file
    // that disagrees with the screen he is looking at.
    const src = codeOf(STATEMENT)
    const failure = src.indexOf('ledger.readFailed || payoutsRes.error')
    const link = src.indexOf('/api/partner/report')
    expect(failure).toBeGreaterThan(-1)
    expect(link).toBeGreaterThan(failure)
  })
})

// ============================================================
// Scoping, end to end through the real loader. §7's check list: "A
// report request returns only the requesting partner's rows when two
// partners exist."
//
// Driven through loadPartnerLedger rather than asserted on the route's
// source, because the question is not whether an `eq` is written down —
// it is whether the rows that reach the serialiser belong to one
// partner. The fake applies eq filters, so a missing predicate shows up
// here as another company's name in the file.
// ============================================================

const ME = 'partner-1'
const THEM = 'partner-2'

function seed(tables: Record<string, FakeRow[]> = {}) {
  h.db = createFakeSupabase({
    clients: [],
    partner_client_monthly: [],
    partner_order_units: [],
    fba_invoices: [],
    ...tables,
  })
}

beforeEach(() => seed())

describe('buildPartnerReport over the real loader', () => {
  it('carries no trace of the other partner when two partners have clients', async () => {
    seed({
      clients: [
        {
          id: 'mine',
          name: 'My Client',
          referral_partner_id: ME,
          referral_signup_date: '2026-01-15',
          referral_first_payment_date: '2026-02-01',
          founding_bonus_seq: null,
        },
        {
          id: 'theirs',
          name: 'Their Secret Client',
          referral_partner_id: THEM,
          referral_signup_date: '2026-01-15',
          referral_first_payment_date: '2026-02-01',
          founding_bonus_seq: null,
        },
      ],
      partner_order_units: [
        {
          period_month: '2026-03-01',
          client_id: 'mine',
          client_name: 'My Client',
          referral_partner_id: ME,
          order_date: '2026-03-04',
          order_number: 'SO-1',
          units: 5,
          units_estimated: false,
        },
        {
          period_month: '2026-03-01',
          client_id: 'theirs',
          client_name: 'Their Secret Client',
          referral_partner_id: THEM,
          order_date: '2026-03-05',
          order_number: 'SO-2',
          units: 9,
          units_estimated: false,
        },
      ],
      fba_invoices: [
        { id: 'i1', client_id: 'mine', period: '2026-03', amount: 100, units_shipped: 10 },
        { id: 'i2', client_id: 'theirs', period: '2026-03', amount: 100, units_shipped: 99 },
      ],
    })

    const ledger = await loadPartnerLedger(ME)
    expect(ledger.readFailed).toBeNull()

    const csv = buildPartnerReport({
      // Money withheld, because what this test is about is the row set.
      statement: null,
      bonuses: null,
      roster: rosterRows(ledger.clients, new Date('2026-03-20')),
      orders: ledger.orderUnits,
      ordersTruncated: ledger.orderUnitsTruncated,
      fba: fbaActivity(
        ledger.manualInvoices.map((i) => ({
          client_id: i.client_id,
          period: i.period,
          units_shipped: i.units_shipped ?? null,
        })),
        ledger.clients,
      ),
    })

    expect(csv).toContain('My Client')
    expect(csv).not.toContain('Their Secret Client')
    expect(csv).not.toContain('theirs')
    expect(csv).not.toContain('SO-2')
    // The other partner's FBA volume, which is the figure a missing
    // predicate would hand over most quietly — it arrives as a bare
    // number with no company beside it.
    expect(csv).not.toContain('99')
  })
})

describe('reportFilename', () => {
  it('names the partner and the date', () => {
    expect(reportFilename({ id: 'p1', company: 'Acme Partners', name: null }, '2026-10-20')).toBe(
      'shipo-partner-report-acme-partners-2026-10-20.csv',
    )
  })

  it('falls back to the contact name, then to the id, rather than to a bare date', () => {
    expect(reportFilename({ id: 'p1', company: null, name: 'Jane Doe' }, '2026-10-20')).toContain('jane-doe')
    expect(reportFilename({ id: 'p1', company: null, name: null }, '2026-10-20')).toContain('p1')
  })

  it('strips path separators and quotes out of the filename', () => {
    // The value lands in a Content-Disposition header. A `"` ends the
    // quoted filename early and a `/` is a path.
    const name = reportFilename({ id: 'p1', company: 'a/b"c\\d', name: null }, '2026-10-20')
    expect(name).not.toMatch(/["/\\]/)
  })
})
