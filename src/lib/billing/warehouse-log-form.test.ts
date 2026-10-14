// What the daily warehouse log form is allowed to show, and what submit is
// allowed to write.
//
// These were inside app/warehouse/page.tsx, where they could not be tested at
// all: the vitest config excludes `.test.tsx`, so a component's logic is
// untestable in this repo by construction. They decide which services an
// operator can bill a client for, which is not logic that should be sitting
// somewhere a test cannot reach.
//
// The case that matters most is the LAST one in this file: a service priced on
// a client's card but absent from the registry must end up rendered. The bug
// this whole change exists to fix is a service_type that gets logged and never
// invoiced, and a group filter that silently drops a row is that same bug with
// the rate already known.

import { describe, it, expect } from 'vitest'
import {
  CARD_GROUP, labelFor, knownService, rowsFromCard, groupOf, rowsInGroup,
  groupsToRender, filledRows, clearedEntries, money, cardStateNotice,
  type ServiceRow, type ClientEntry, type CardState,
} from './warehouse-log-form'
import { WAREHOUSE_SERVICE_GROUPS } from './warehouse-rate-card'
import type { PricedService } from './warehouse-priced-services'

/** A form row, defaulted to a shape rowsFromCard would produce. */
function row(over: Partial<ServiceRow> = {}): ServiceRow {
  return {
    service_type: 'storage', label: 'Storage', quantity: '', notes: '',
    steps: [], rate: 10, unit: 'per_pallet', ...over,
  }
}

describe('labelFor', () => {
  it('uses the registry label for a service the registry knows', () => {
    expect(labelFor('fba_prep')).toBe('Amazon FBA prep')
    expect(labelFor('devan_20ft')).toBe('Container devanning — 20ft')
  })

  it('falls back to the card\'s own spelling, underscores swapped for spaces', () => {
    expect(labelFor('inbound_pallet_handling')).toBe('inbound pallet handling')
  })

  it('preserves the card\'s punctuation rather than tidying it', () => {
    // This name is real -- it is on three production rate cards. An operator
    // matches the row against the price list they were sent, so rewriting it
    // into something prettier is how a row stops being identifiable.
    expect(labelFor('special_tasks_(kitting,_bundling,_counting)'))
      .toBe('special tasks (kitting, bundling, counting)')
  })

  it('does not invent a label for the empty string', () => {
    // pricedServices already drops blank names, so this should be
    // unreachable. It is pinned because the fallback is a string method that
    // happily returns '' -- an unlabelled row is better than a crash, but
    // either way nothing here manufactures a name.
    expect(labelFor('')).toBe('')
  })

  it('does not match a registry value by prefix or case', () => {
    expect(knownService('STORAGE')).toBeUndefined()
    expect(knownService('storage_overflow')).toBeUndefined()
    expect(labelFor('storage_overflow')).toBe('storage overflow')
  })
})

describe('rowsFromCard', () => {
  it('makes one empty-but-priced row per service on the card', () => {
    const services: PricedService[] = [
      { service_type: 'storage', rate: 25, unit: 'per_pallet' },
      { service_type: 'inbound_pallet_handling', rate: 7, unit: 'per_pallet' },
    ]
    expect(rowsFromCard(services)).toEqual([
      {
        service_type: 'storage', label: 'Storage', quantity: '', notes: '',
        steps: [], rate: 25, unit: 'per_pallet',
      },
      {
        service_type: 'inbound_pallet_handling',
        label: 'inbound pallet handling', quantity: '', notes: '',
        steps: [], rate: 7, unit: 'per_pallet',
      },
    ])
  })

  it('carries a deliberate rate of 0 through as 0, not as a missing rate', () => {
    // A card that says 0 is a card that says this service is free, which
    // someone decided on purpose. `rate: s.rate || null` would erase that
    // decision and the screen would then show an em-dash beside a box the
    // save prices at nothing.
    const [r] = rowsFromCard([{ service_type: 'returns', rate: 0, unit: 'per_unit' }])
    expect(r.rate).toBe(0)
    expect(money(r.rate)).toBe('$0.00')
  })

  it('keeps a null unit null rather than defaulting it', () => {
    // Printing an invented 'per_unit' beside a rate puts a unit on screen
    // nobody agreed to -- and a per-pallet rate read as per-carton is a
    // 20-to-1 billing error on the production card that charges 20/pallet.
    const [r] = rowsFromCard([{ service_type: 'storage', rate: 25, unit: null }])
    expect(r.unit).toBeNull()
  })

  it('yields no rows for a card with nothing priced', () => {
    // The banner is what the operator sees in that case. A form of boxes for
    // a client with no rate card is how a day's work gets typed in and saved
    // with no total.
    expect(rowsFromCard([])).toEqual([])
  })

  it('preserves the order it was given, which is the API\'s sorted order', () => {
    const names = rowsFromCard([
      { service_type: 'a_svc', rate: 1, unit: null },
      { service_type: 'b_svc', rate: 2, unit: null },
      { service_type: 'c_svc', rate: 3, unit: null },
    ]).map(r => r.service_type)
    expect(names).toEqual(['a_svc', 'b_svc', 'c_svc'])
  })
})

describe('groupOf', () => {
  it('puts a registry service in its registry group', () => {
    expect(groupOf(row({ service_type: 'storage' }))).toBe('Storage')
    expect(groupOf(row({ service_type: 'devan_40ft' }))).toBe('Inbound')
    expect(groupOf(row({ service_type: 'labor_hours' }))).toBe('Labour & other')
  })

  it('puts a card-only service in the card bucket', () => {
    expect(groupOf(row({ service_type: 'loose_case' }))).toBe(CARD_GROUP)
  })

  it('groups on service_type, not on the label', () => {
    // A row whose label was overwritten must still land in its real group --
    // otherwise the section a service appears in depends on display text.
    expect(groupOf(row({ service_type: 'storage', label: 'loose_case' })))
      .toBe('Storage')
  })
})

describe('rowsInGroup', () => {
  const rows = [
    row({ service_type: 'storage' }),
    row({ service_type: 'receiving_pallet' }),
    row({ service_type: 'devan_20ft' }),
    row({ service_type: 'loose_case' }),
  ]

  it('returns only that section\'s rows', () => {
    expect(rowsInGroup(rows, 'Inbound').map(r => r.service_type))
      .toEqual(['receiving_pallet', 'devan_20ft'])
    expect(rowsInGroup(rows, 'Storage').map(r => r.service_type))
      .toEqual(['storage'])
  })

  it('returns the card-only rows for the card bucket', () => {
    expect(rowsInGroup(rows, CARD_GROUP).map(r => r.service_type))
      .toEqual(['loose_case'])
  })

  it('returns nothing for a group no row is in', () => {
    expect(rowsInGroup(rows, 'Prep & outbound')).toEqual([])
  })
})

describe('groupsToRender', () => {
  it('lists the registry groups in their declared order', () => {
    const rows = [row({ service_type: 'storage' })]
    expect(groupsToRender(rows)).toEqual([...WAREHOUSE_SERVICE_GROUPS])
  })

  it('appends the card bucket when a card-only service is present', () => {
    const rows = [row({ service_type: 'storage' }), row({ service_type: 'loose_case' })]
    expect(groupsToRender(rows)).toEqual([...WAREHOUSE_SERVICE_GROUPS, CARD_GROUP])
  })

  it('omits the card bucket when every service is a registry one', () => {
    // A client whose card happens to use registry names sees the layout
    // unchanged rather than gaining an empty heading.
    const rows = [row({ service_type: 'storage' }), row({ service_type: 'fba_prep' })]
    expect(groupsToRender(rows)).not.toContain(CARD_GROUP)
  })

  it('appends the card bucket exactly once for several card-only services', () => {
    const rows = [
      row({ service_type: 'loose_case' }),
      row({ service_type: 'package_received' }),
      row({ service_type: 'inbound_pallet_handling' }),
    ]
    const groups = groupsToRender(rows)
    expect(groups.filter(g => g === CARD_GROUP)).toHaveLength(1)
  })

  it('does not mutate WAREHOUSE_SERVICE_GROUPS', () => {
    // `const groups = WAREHOUSE_SERVICE_GROUPS; groups.push(CARD_GROUP)`
    // would append to the shared registry array, so the card bucket would
    // leak into every other client's form -- and into
    // WarehouseRatesUpload.tsx, which imports the same constant.
    const before = [...WAREHOUSE_SERVICE_GROUPS]
    groupsToRender([row({ service_type: 'loose_case' })])
    groupsToRender([row({ service_type: 'loose_case' })])
    expect([...WAREHOUSE_SERVICE_GROUPS]).toEqual(before)
  })
})

describe('filledRows', () => {
  it('keeps rows with a positive quantity', () => {
    const rows = [row({ service_type: 'a', quantity: '3' }), row({ service_type: 'b', quantity: '0.5' })]
    expect(filledRows(rows).map(r => r.service_type)).toEqual(['a', 'b'])
  })

  it('drops blank, zero, negative and non-numeric quantities', () => {
    const rows = [
      row({ service_type: 'blank', quantity: '' }),
      row({ service_type: 'zero', quantity: '0' }),
      row({ service_type: 'negative', quantity: '-2' }),
      row({ service_type: 'spaces', quantity: '  ' }),
      row({ service_type: 'words', quantity: 'abc' }),
      row({ service_type: 'real', quantity: '1' }),
    ]
    expect(filledRows(rows).map(r => r.service_type)).toEqual(['real'])
  })

  it('ignores the rate entirely -- a free service with real work still submits', () => {
    // Quantity is "was work done"; rate is "what it costs". A card that
    // prices a service at 0 means free, and free work still has to appear on
    // the log so the client can see it was performed.
    const rows = [row({ service_type: 'returns', quantity: '12', rate: 0 })]
    expect(filledRows(rows)).toHaveLength(1)
  })
})

describe('clearedEntries', () => {
  const entries: ClientEntry[] = [{
    client_id: 'c1', name: 'Kivema', state: 'priced',
    rows: [
      row({ service_type: 'loose_case', label: 'loose case', quantity: '40', notes: 'am shift', rate: 0.3, unit: 'per_unit' }),
      row({ service_type: 'fba_prep', label: 'Amazon FBA prep', quantity: '5', notes: '', steps: ['Bagging'], rate: 1.25, unit: 'per_unit' }),
    ],
  }]

  it('empties quantity, notes and steps', () => {
    const [e] = clearedEntries(entries)
    expect(e.rows.map(r => [r.quantity, r.notes, r.steps]))
      .toEqual([['', '', []], ['', '', []]])
  })

  it('KEEPS the card-derived rows, rates and units', () => {
    // This is the whole reason the function exists. The reset this replaced
    // rebuilt rows from the fixed registry list, which for Kivema means
    // `loose_case` -- their actual priced service -- disappears on reset and
    // is replaced by registry names their card does not price. A priced form
    // became a guessed one every time the operator logged a second entry.
    const [e] = clearedEntries(entries)
    expect(e.rows.map(r => ({ service_type: r.service_type, rate: r.rate, unit: r.unit })))
      .toEqual([
        { service_type: 'loose_case', rate: 0.3, unit: 'per_unit' },
        { service_type: 'fba_prep', rate: 1.25, unit: 'per_unit' },
      ])
    expect(e.rows.map(r => r.label)).toEqual(['loose case', 'Amazon FBA prep'])
  })

  it('keeps the client identity and card state', () => {
    const [e] = clearedEntries(entries)
    expect(e.client_id).toBe('c1')
    expect(e.name).toBe('Kivema')
    expect(e.state).toBe('priced')
  })

  it('leaves the input untouched', () => {
    // React state is compared by reference; mutating in place gives a reset
    // that does not re-render, so the boxes keep their old text on screen
    // while state says they are empty.
    clearedEntries(entries)
    expect(entries[0].rows[0].quantity).toBe('40')
    expect(entries[0].rows[1].steps).toEqual(['Bagging'])
  })

  it('returns new row objects, not the same ones', () => {
    const [e] = clearedEntries(entries)
    expect(e.rows[0]).not.toBe(entries[0].rows[0])
    expect(e.rows[0].steps).not.toBe(entries[0].rows[0].steps)
  })

  it('clears a client with an empty card without inventing rows for it', () => {
    const noCard: ClientEntry[] = [
      { client_id: 'c2', name: 'Orcam', state: 'no-card', rows: [] },
    ]
    expect(clearedEntries(noCard)).toEqual(noCard)
  })
})

describe('cardStateNotice', () => {
  const ALL: CardState[] = ['priced', 'no-card', 'structured-only', 'none-priced']

  it('says nothing when the card is usable', () => {
    // A banner over a working form is noise, and noise is how the real
    // warnings stop being read.
    expect(cardStateNotice('priced', 'Kivema', '2026-10-14')).toBeNull()
  })

  it('gives a distinct title to each unusable state', () => {
    // The screen this replaced showed all four states the same twenty boxes.
    // Collapsing three of them into one "no rates" message would be the same
    // mistake with better manners: they send the operator to three different
    // places.
    const titles = ALL
      .map(s => cardStateNotice(s, 'Kivema', '2026-10-14')?.title)
      .filter((t): t is string => typeof t === 'string')
    expect(titles).toHaveLength(3)
    expect(new Set(titles).size).toBe(3)
  })

  it('names the client in every notice', () => {
    // "No rate card for this client" with no client named is unactionable on
    // a screen whose whole job is logging for one of nine.
    for (const s of ALL) {
      const n = cardStateNotice(s, 'Orcam', '2026-10-14')
      if (n === null) continue
      expect(n.body).toContain('Orcam')
    }
  })

  it('does not call a structured-only card a missing one', () => {
    // A price WAS agreed for this client. Telling the operator there is no
    // rate card would be false, and the false version sends them to add
    // rates that already exist in another shape.
    const n = cardStateNotice('structured-only', 'Nayax', '2026-10-14')!
    expect(n.title).not.toMatch(/no rate card/i)
    expect(n.body).toMatch(/was agreed/i)
    expect(n.body).toMatch(/charge calculator/i)
  })

  it('does not call a none-priced card a missing one either, and dates it', () => {
    // Lines exist; none is usable TODAY. The date is in the message because
    // "expired" is only meaningful against a day, and that day has to be the
    // one the menu and the save were both asked about.
    const n = cardStateNotice('none-priced', 'Suteka', '2026-10-14')!
    expect(n.body).toMatch(/not a missing rate card/i)
    expect(n.body).toContain('2026-10-14')
  })

  it('warns that work typed against no card would not reach an invoice', () => {
    // This is the actual cost of the old behaviour, stated where the person
    // about to incur it is standing.
    const n = cardStateNotice('no-card', 'Crisp Power', '2026-10-14')!
    expect(n.body).toMatch(/would not reach an invoice/i)
  })

  it('returns a non-empty title and body for every state that has one', () => {
    for (const s of ALL) {
      const n = cardStateNotice(s, 'Kivema', '2026-10-14')
      if (n === null) continue
      expect(n.title.trim()).not.toBe('')
      expect(n.body.trim()).not.toBe('')
    }
  })

  it('handles every CardState pricedServices can return', () => {
    // Pinned against the producer's own union rather than a list retyped
    // here. The switch in cardStateNotice is exhaustive, so a fifth state
    // added to pricedServices is a compile error -- this is the runtime half:
    // nothing throws, and exactly one state is silent.
    const silent = ALL.filter(s => cardStateNotice(s, 'X', '2026-10-14') === null)
    expect(silent).toEqual(['priced'])
  })
})

describe('money', () => {
  it('formats a number', () => {
    expect(money(7)).toBe('$7.00')
    expect(money(0.3)).toBe('$0.30')
  })

  it('formats a numeric STRING, which is how the column arrives over JSON', () => {
    // `v?.toFixed(2)` throws "toFixed is not a function" here and takes the
    // whole panel down. Optional chaining guards null, not a wrong type.
    expect(money('12.34')).toBe('$12.34')
  })

  it('shows an em-dash, never $0.00, for an unknown amount', () => {
    // Unpriced is not free. Rendering null as $0.00 asserts a price was
    // agreed at zero, which is the one thing this column is nullable to
    // avoid claiming.
    expect(money(null)).toBe('—')
    expect(money(undefined)).toBe('—')
    expect(money('')).toBe('—')
    expect(money('not a number')).toBe('—')
    expect(money(NaN)).toBe('—')
  })

  it('shows $0.00 for a real zero', () => {
    expect(money(0)).toBe('$0.00')
    expect(money('0')).toBe('$0.00')
    expect(money('0.00')).toBe('$0.00')
  })
})

describe('every priced service reaches the screen', () => {
  // The property the original bug violated. A service_type priced on a
  // client's card but missing from the registry used to be filtered out by a
  // group loop that only iterated registry groups -- so the row existed, the
  // rate was known, and it rendered nowhere. Work logged against it, had the
  // operator been able to log it, would never be invoiced.
  //
  // This asserts the round trip: rows from a card, grouped by the sections
  // the page actually renders, give back exactly the services it started
  // with -- no drops and no duplicates.
  const cases: Array<[string, string[]]> = [
    ['registry names only', ['storage', 'fba_prep', 'labor_hours']],
    ['card names only', ['loose_case', 'inbound_pallet_handling', 'package_received']],
    ['both mixed', ['storage', 'loose_case', 'devan_20ft', 'special_tasks_(kitting)']],
    ['one card name', ['loose_case']],
  ]

  for (const [label, names] of cases) {
    it(`loses nothing and duplicates nothing: ${label}`, () => {
      const rows = rowsFromCard(names.map(service_type => ({
        service_type, rate: 1, unit: null,
      })))
      const rendered = groupsToRender(rows)
        .flatMap(g => rowsInGroup(rows, g))
        .map(r => r.service_type)
      expect(rendered.slice().sort()).toEqual(names.slice().sort())
      expect(rendered).toHaveLength(names.length)
    })
  }

  it('fails loudly if a registry group is ever renamed out from under a service', () => {
    // groupOf reads `group` off the registry entry. If a service's group
    // string stopped appearing in WAREHOUSE_SERVICE_GROUPS, its rows would
    // render nowhere and the round-trip above is the only thing that would
    // notice -- so the registry's own consistency is pinned here directly.
    const groups = new Set<string>(WAREHOUSE_SERVICE_GROUPS)
    const orphans = rowsFromCard(
      [...new Set(['storage', 'receiving', 'receiving_pallet', 'receiving_carton',
        'devan_20ft', 'devan_40ft', 'pallet_in', 'fba_prep', 'returns',
        'labeling', 'kitting', 'pallet_out', 'labor_hours', 'special_task'])]
        .map(service_type => ({ service_type, rate: 1, unit: null })),
    ).filter(r => !groups.has(groupOf(r)))
    expect(orphans.map(r => r.service_type)).toEqual([])
  })
})
