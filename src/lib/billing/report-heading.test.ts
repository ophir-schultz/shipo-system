// What a printed report must say about itself before it leaves the building.

import { describe, expect, it } from 'vitest'
import { reportHeading } from './report-heading'

const CLIENTS = [
  { id: 'c1', name: 'Suteka' },
  { id: 'c2', name: 'SitnStand' },
  { id: 'c3', name: null },
]

const AT = new Date('2026-10-26T10:30:45.000Z')

function heading(over: Partial<Parameters<typeof reportHeading>[0]> = {}) {
  return reportHeading({
    tabLabel: 'Shipments',
    clientId: '',
    clients: CLIENTS,
    dateFrom: '2026-10-01',
    dateTo: '2026-10-26',
    generatedAt: AT,
    ...over,
  })
}

describe('reportHeading', () => {
  it('names the client the figures were filtered by', () => {
    expect(heading({ clientId: 'c2' }).scope).toBe('SitnStand')
  })

  it('says "All clients" rather than leaving the scope blank', () => {
    // The whole point: on paper there is no dropdown to look at. A blank
    // here is a report that does not say whose it is.
    expect(heading({ clientId: '' }).scope).toBe('All clients')
  })

  it('does not read an unknown client id as every client', () => {
    // The table below is filtered to that id and will be empty. "All clients"
    // over an empty table reads as "we shipped nothing this period", which is
    // a different and much worse claim than "this filter matched no client".
    expect(heading({ clientId: 'gone' }).scope).toBe('Unknown client (gone)')
  })

  it('matches on id, not on name', () => {
    // Two clients can share a name, and the spreadsheet export filters on the
    // id. A heading that resolved by name could label a report with one
    // client's name over another client's rows.
    const dupes = [{ id: 'a', name: 'Acme' }, { id: 'b', name: 'Acme' }]
    expect(heading({ clientId: 'b', clients: dupes }).scope).toBe('Acme')
    expect(heading({ clientId: 'zzz', clients: dupes }).scope).toBe('Unknown client (zzz)')
  })

  it('falls back when a real client has no usable name', () => {
    // c3 exists and is the right client; it just has no name recorded. The id
    // is still the honest thing to print.
    expect(heading({ clientId: 'c3' }).scope).toBe('Unknown client (c3)')
  })

  it('states the period both ways round, and when it is missing', () => {
    expect(heading().period).toBe('2026-10-01 to 2026-10-26')
    expect(heading({ dateTo: '' }).period).toBe('From 2026-10-01')
    expect(heading({ dateFrom: '' }).period).toBe('Up to 2026-10-26')
    expect(heading({ dateFrom: '', dateTo: '' }).period).toBe('Period not specified')
  })

  it('refuses a date it cannot read rather than printing it raw', () => {
    // An input the browser did not fill, or a value from somewhere else,
    // must not land on a client-facing page looking like a date.
    expect(heading({ dateFrom: 'last week' }).period).toBe('Up to 2026-10-26')
  })

  it('stamps when the sheet was produced', () => {
    // Two printouts of the same period taken a week apart are different
    // documents, because the underlying rows move. Without this there is no
    // way to tell which one you are holding.
    expect(heading().generated).toBe('Generated 2026-10-26 10:30 UTC')
  })

  it('titles the report after the tab it came from', () => {
    expect(heading({ tabLabel: 'Losses' }).title).toBe('Losses report')
  })

  it('never returns an empty field', () => {
    // A hole in the header reads as a rendering glitch, and a reader who
    // decides the header is broken stops trusting the table beneath it.
    for (const over of [
      {}, { clientId: 'c1' }, { clientId: 'nope' },
      { dateFrom: '', dateTo: '' }, { clients: [] },
    ]) {
      const h = heading(over)
      for (const v of [h.title, h.scope, h.period, h.generated]) {
        expect(v.trim().length).toBeGreaterThan(0)
      }
    }
  })
})

// ── The wiring, checked in the source ───────────────────────────────────────
//
// reportHeading being right is worth nothing if the component does not render
// it, or if the filter bar prints anyway. vitest.config.ts excludes
// `.test.tsx`, so ReportsTabs cannot be rendered here and there is no runtime
// observation of "what the printer would get". The relationship exists only in
// the source: a print-only block that shows the heading, and chrome marked to
// disappear. Same approach as profit-triple-parity.test.ts, for the same
// reason.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(__dirname, '..', '..')
const TABS = readFileSync(join(SRC, 'components/reports/ReportsTabs.tsx'), 'utf8')
const CSS = readFileSync(join(SRC, 'app/globals.css'), 'utf8')

/**
 * The declarations inside one rule of the @media print block, or null when
 * that rule is not there. Per-rule rather than a whole-file substring search,
 * because "this property appears somewhere in the stylesheet" says nothing
 * about whether it applies to the element that needs it.
 */
function ruleBody(css: string, selector: string): string | null {
  const print = css.slice(css.indexOf('@media print'))
  const at = print.indexOf(`${selector} {`)
  if (at === -1) return null
  const open = print.indexOf('{', at)
  const close = print.indexOf('}', open)
  return close === -1 ? null : print.slice(open + 1, close)
}

describe('the printed report carries its own scope', () => {
  it('renders the heading in a print-only block', () => {
    expect(TABS).toContain('reportHeading(')
    expect(TABS).toContain('print-only')
    // All four fields, or the sheet is missing one of the things it exists
    // to state.
    for (const field of ['printHeading.title', 'printHeading.scope',
      'printHeading.period', 'printHeading.generated']) {
      expect(TABS, `ReportsTabs does not render ${field}`).toContain(field)
    }
  })

  it('hides the controls that state the scope on screen', () => {
    // The filter bar and the tab strip. If these print, the sheet has a
    // dropdown picture on it; if the heading is ALSO missing, it has neither
    // and the figures are unattributed.
    const marks = TABS.split('data-print-hide').length - 1
    expect(marks, 'filter bar and tab strip must both be data-print-hide')
      .toBeGreaterThanOrEqual(2)
  })

  it('has print rules at all, and they act on those marks', () => {
    // The state this started in: window.print() with not one @media print
    // rule in the repo, so the button printed the application.
    expect(CSS).toContain('@media print')
    expect(CSS).toContain('[data-print-hide]')
    expect(CSS).toContain('.print-only')
    // The sidebar is hidden by element, so nothing in Sidebar.tsx had to
    // change; if that rule goes, every printed page regains a navigation
    // column down the left.
    expect(CSS).toMatch(/aside\s*\{\s*display:\s*none/)
  })

  it('forces a white page, because the app is dark', () => {
    // Without this the report prints as grey-on-grey or, on printers that
    // drop backgrounds, light grey text on white.
    const print = CSS.slice(CSS.indexOf('@media print'))
    expect(print).toMatch(/background:\s*#fff/)
    expect(print).toMatch(/color:\s*#000/)
  })

  it('carries the Shipo mark, in a variant that is visible on white', () => {
    // shipo-logo.svg is WHITE lettering, drawn for the sidebar's blue panel.
    // Printed on paper it renders as nothing -- a blank space at the top of a
    // client-facing document. The print variant is the same geometry in brand
    // blue, and referencing the wrong one is invisible in review and obvious
    // on the page.
    expect(TABS).toContain('/shipo-logo-print.svg')
    expect(TABS).not.toContain('"/shipo-logo.svg"')
    expect(TABS).toContain('print-brand-mark')
  })

  it('keeps the brand colour from being dropped by the printer', () => {
    // Browsers discard colour when printing unless print-color-adjust says
    // otherwise, and it is scoped to the few branded elements on purpose --
    // granting it page-wide is how a dark-theme app prints as a black
    // rectangle.
    //
    // Asserted PER RULE, not across the file. The first version of this test
    // only checked the property appeared somewhere in the stylesheet, and a
    // mutation that stripped it from the logo rule passed, because two other
    // rules still carried it. A guard that cannot tell which element is
    // protected is not guarding anything.
    for (const selector of ['.print-brand-rule', '.print-brand-mark', 'thead th']) {
      const body = ruleBody(CSS, selector)
      expect(body, `no ${selector} rule inside @media print`).not.toBeNull()
      expect(body, `${selector} may be dropped by the printer`)
        .toContain('print-color-adjust: exact')
      expect(body, `${selector} needs the -webkit- prefix too`)
        .toContain('-webkit-print-color-adjust: exact')
    }
    expect(ruleBody(CSS, '.print-brand-rule')).toContain('#00AAFF')
    // Not page-wide: the reset still forces black text everywhere else.
    expect(CSS.slice(CSS.indexOf('@media print'))).toMatch(/color:\s*#000/)
  })

  it('repeats table headers across pages', () => {
    // A money table broken by a page break puts figures on page two with no
    // column headings over them.
    const print = CSS.slice(CSS.indexOf('@media print'))
    expect(print).toContain('table-header-group')
    expect(print).toContain('page-break-inside: avoid')
  })
})
