import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  REPORT_TABS,
  REPORT_TYPES,
  isReportType,
  reportTabById,
  reportTypeForTab,
  tabRequiresClient,
  type ReportTab,
  type ReportType,
} from './report-types'

/**
 * TYPE-LEVEL GUARD -- `as const` must keep ReportType a narrow union.
 *
 * This is checked by tsc, not by vitest, and it is here because the runtime
 * tests below CANNOT catch it. Measured: deleting `as const` from REPORT_TABS
 * leaves all of the tests in this file passing, because every one of them is
 * derived from REPORT_TABS and so widens along with it. Meanwhile ReportType
 * collapses to `string`, which makes isReportType's predicate `t is string`
 * and the guard accepts every string there is -- silently, with a green suite.
 *
 * tsc did object when I tried it, but only by accident: the tabRequiresClient
 * tests touch `.requiresClient`, which vanishes from the inferred type when no
 * tab sets it. That error disappears the moment a real tab opts in, taking the
 * only protection with it. Hence an explicit assertion that does not depend on
 * which optional properties happen to be in use.
 *
 * If ReportType is narrow, this assignment is an error and the directive is
 * used as intended. If ReportType widens to `string`, the assignment becomes
 * legal, the directive becomes unused, and tsc fails with TS2578 -- so the
 * guard bites in BOTH directions rather than only when it is already too late.
 */
// @ts-expect-error -- an arbitrary string must not be a ReportType
const _reportTypeMustStayNarrow: ReportType = 'not-a-report-type' as string
void _reportTypeMustStayNarrow

/**
 * WHAT THESE TESTS ARE FOR.
 *
 * report-types.ts exists to collapse three hand-maintained lists into one, so
 * the point of testing it is NOT that the functions return plausible values --
 * it is that the drift which the file was written to prevent actually fails
 * here, loudly, instead of 400ing at the end of a round trip in production.
 *
 * So the load-bearing test is `the download route implements exactly these
 * types`, which reads the route off disk. Everything else is guarding the
 * helpers the UI calls.
 */

describe('REPORT_TABS', () => {
  it('has unique ids', () => {
    const ids = REPORT_TABS.map(t => t.id)
    expect(new Set(ids).size, `duplicate tab id in ${ids.join(', ')}`).toBe(ids.length)
  })

  it('gives every tab a reportType that is either null or a real export', () => {
    // The whole point of `reportType: string | null` being REQUIRED. A tab
    // that names an export we cannot build is the old typeMap bug wearing a
    // different hat: the button renders, the request goes out, the route 400s.
    for (const tab of REPORT_TABS) {
      if (tab.reportType !== null) {
        expect(isReportType(tab.reportType), `tab '${tab.id}' names unknown export '${tab.reportType}'`)
          .toBe(true)
      }
    }
  })

  it('has a non-empty label and icon on every tab', () => {
    for (const tab of REPORT_TABS) {
      expect(tab.label, `tab '${tab.id}' has no label`).toBeTruthy()
      expect(tab.icon, `tab '${tab.id}' has no icon`).toBeTruthy()
    }
  })
})

describe('REPORT_TYPES', () => {
  it('is exactly the non-null reportTypes, in tab order, deduplicated', () => {
    expect([...REPORT_TYPES]).toEqual(
      REPORT_TABS.map(t => t.reportType).filter(t => t !== null),
    )
  })

  it('is not empty', () => {
    // Guards every `includes`-based assertion below from passing vacuously:
    // an empty REPORT_TYPES would make isReportType return false for
    // everything, and several tests here assert exactly that for bad input.
    expect(REPORT_TYPES.length).toBeGreaterThan(0)
  })
})

describe('isReportType', () => {
  it('accepts every type the registry declares', () => {
    for (const t of REPORT_TYPES) {
      expect(isReportType(t), `rejected its own declared type '${t}'`).toBe(true)
    }
  })

  it('rejects null, undefined and the empty string', () => {
    // These three are the same request as far as a person is concerned --
    // `type` missing, `type=`, and a tab that forgot its mapping. They must
    // not take different paths, which is why the guard accepts `string | null
    // | undefined` rather than being handed an already-narrowed value.
    expect(isReportType(null)).toBe(false)
    expect(isReportType(undefined)).toBe(false)
    expect(isReportType('')).toBe(false)
  })

  it("rejects the literal string 'undefined'", () => {
    // Not hypothetical. `new URLSearchParams({ type: undefined })` stringifies
    // to 'type=undefined', so this exact four-letter word is what a missing
    // mapping used to put on the wire. Measured, not assumed.
    expect(isReportType('undefined')).toBe(false)
  })

  it('rejects near-misses rather than matching loosely', () => {
    expect(isReportType('shipment')).toBe(false)
    expect(isReportType('Shipments')).toBe(false)
    expect(isReportType(' shipments')).toBe(false)
    expect(isReportType('shipments ')).toBe(false)
    expect(isReportType('profit')).toBe(false) // the TAB id, not the export
  })

  it('rejects inherited Object properties', () => {
    // The old typeMap was a plain object, so `typeMap['constructor']` was a
    // function and `'toString' in typeMap` was true. An array `includes` has
    // no such hole; this pins that we did not reintroduce an object lookup.
    expect(isReportType('constructor')).toBe(false)
    expect(isReportType('toString')).toBe(false)
    expect(isReportType('__proto__')).toBe(false)
  })
})

describe('reportTabById', () => {
  it('finds every declared tab', () => {
    for (const tab of REPORT_TABS) {
      expect(reportTabById(tab.id)).toEqual(tab)
    }
  })

  it('returns null for an unknown id instead of throwing', () => {
    // activeTab is React state. A stale value after a rename should degrade to
    // "no tab selected", not crash the screen an operator is mid-export on.
    expect(reportTabById('no-such-tab')).toBeNull()
    expect(reportTabById('')).toBeNull()
  })
})

describe('reportTypeForTab', () => {
  it('returns the export type for each tab that has one', () => {
    for (const tab of REPORT_TABS) {
      if (tab.reportType !== null) {
        expect(reportTypeForTab(tab.id)).toBe(tab.reportType)
      }
    }
  })

  it('returns null for an unknown tab', () => {
    expect(reportTypeForTab('no-such-tab')).toBeNull()
  })

  it('never returns a value the download route would refuse', () => {
    // The contract the download button depends on: whatever comes back from
    // here is safe to put in the `type` parameter. If it is non-null it must
    // pass the same guard the route applies, or the button renders and fails.
    for (const tab of REPORT_TABS) {
      const t = reportTypeForTab(tab.id)
      if (t !== null) expect(isReportType(t)).toBe(true)
    }
  })
})

describe('tabRequiresClient', () => {
  /**
   * A deliberately WIDENED view of the tabs.
   *
   * `as const` narrows REPORT_TABS to literal object types, and an optional
   * property that no current tab sets is simply absent from those types -- so
   * reading `.requiresClient` off REPORT_TABS directly is a tsc error today
   * and would silently start compiling once some tab opts in. Going through
   * the ReportTab interface keeps these tests readable regardless of which
   * tabs currently use the flag, and keeps the `as const` guard at the top of
   * this file as the single thing protecting literal-ness.
   */
  const tabs: readonly ReportTab[] = REPORT_TABS

  it('is false for every tab that does not opt in', () => {
    for (const tab of tabs) {
      if (tab.requiresClient !== true) {
        expect(tabRequiresClient(tab.id), `tab '${tab.id}'`).toBe(false)
      }
    }
  })

  it('is true for every tab that does opt in', () => {
    for (const tab of tabs) {
      if (tab.requiresClient === true) {
        expect(tabRequiresClient(tab.id), `tab '${tab.id}'`).toBe(true)
      }
    }
  })

  it('is false, not undefined, for an unknown tab', () => {
    // Returns a boolean so callers can use it directly in a conditional
    // without `=== true`. An undefined here would be falsy and "work", which
    // is exactly how the old code hid its bugs.
    expect(tabRequiresClient('no-such-tab')).toBe(false)
  })
})

describe('the download route', () => {
  /**
   * Reads the route's source and extracts the types it actually branches on.
   *
   * Parsing source text is a blunt instrument, but the alternative is worse:
   * importing the route pulls in the Supabase client and the whole Next
   * request machinery to answer a question about a list of six strings. The
   * regex is pinned by the length check below, so if the route is refactored
   * into a shape this cannot read, this test fails rather than passing on an
   * empty set.
   */
  const routePath = join(
    process.cwd(),
    'src/app/api/reports/download/route.ts',
  )
  const source = readFileSync(routePath, 'utf8')
  const implemented = [...source.matchAll(/type === '([a-z-]+)'/g)].map(m => m[1])

  it('was actually read, and branches on types', () => {
    // Positive control. Without this, a regex that matches nothing turns the
    // comparison below into `[] vs []`-shaped nonsense or a confusing diff,
    // and a route rewrite would look like a passing test.
    expect(source.length).toBeGreaterThan(1000)
    expect(implemented.length).toBeGreaterThan(0)
  })

  it('implements exactly the types the registry declares', () => {
    // THE test in this file. Drift in either direction is a bug:
    //
    //   route has a type the registry lacks -> a working export with no way
    //     to reach it. Already happened once: 'profit-loss' shipped working
    //     and unreachable because TABS never listed it.
    //
    //   registry has a type the route lacks -> a tab whose download button
    //     renders and then 400s.
    expect([...implemented].sort()).toEqual([...REPORT_TYPES].sort())
  })
})

describe('ReportsTabs', () => {
  /**
   * Every tab in the registry must have something to render.
   *
   * This is checked by reading the .tsx as text because it CANNOT be checked
   * any other way here: vitest.config.ts includes only .test.ts under src and
   * deliberately excludes .test.tsx, so a component test is not an option, and
   * importing a 'use client' module with six table components to ask which
   * strings it compares against would be a worse instrument than grep.
   *
   * It is here because this exact drift happened while wiring the registry up:
   * adding the 'profit' tab to REPORT_TABS made its button appear immediately,
   * with no `activeTab === 'profit'` branch behind it, so the tab rendered a
   * blank panel. tsc was perfectly happy -- the tab list and the render
   * branches have no type relationship, which is the same shape of hole the
   * registry was built to close for the download route.
   */
  const tabsPath = join(process.cwd(), 'src/components/reports/ReportsTabs.tsx')
  const source = readFileSync(tabsPath, 'utf8')
  const rendered = new Set(
    [...source.matchAll(/activeTab === '([a-z-]+)'/g)].map(m => m[1]),
  )

  it('was actually read, and compares against tab ids', () => {
    // Positive control, same role as the route's. Without it a regex that
    // stops matching turns the next test into `every id is missing` -- which
    // would at least fail, or `nothing is checked` if it were written the
    // other way round. Pinning the count makes the instrument self-reporting.
    expect(source.length).toBeGreaterThan(1000)
    expect(rendered.size).toBeGreaterThan(0)
  })

  it('renders a panel for every tab in the registry', () => {
    const missing = REPORT_TABS.map(t => t.id).filter(id => !rendered.has(id))
    expect(missing, `tab(s) with a button but no content: ${missing.join(', ')}`)
      .toEqual([])
  })

  it('gates every requiresClient tab through the registry, in exactly one place', () => {
    /**
     * The companion to the test above, for the OTHER thing the registry
     * declares. `requiresClient: true` is a claim that a tab refuses to render
     * for "All Clients"; it is worth nothing unless some code reads it, and it
     * is worth less than nothing if two pieces of code read it differently.
     *
     * Not hypothetical in either direction. The flag shipped in the registry
     * with no reader at all for one edit, and before that the refusal lived
     * inside StatementPanel as its own `clientId === ''` branch -- a second
     * copy of a rule the registry already held, which is the exact pattern
     * report-types.ts was written to delete.
     *
     * Source text again, for the reason given above: vitest excludes .test.tsx
     * here, so there is no way to render the component and ask.
     */
    const gated = (REPORT_TABS as readonly ReportTab[])
      .filter(t => t.requiresClient === true)

    // Positive control. With no tab opting in, every assertion below is a
    // statement about a rule nothing uses, and this test would sit here
    // "passing" while proving nothing.
    expect(gated.length, 'no tab sets requiresClient, so this test checks nothing')
      .toBeGreaterThan(0)

    // ONE call site. A count rather than a mere `toContain`, because the
    // failure this guards against is a SECOND reader, not a missing one: two
    // gates disagree about a boundary exactly once, quietly, and the losing one
    // renders a client-facing document for nobody.
    const calls = [...source.matchAll(/tabRequiresClient\(/g)]
    expect(
      calls.length,
      `tabRequiresClient is called ${calls.length} times in ReportsTabs.tsx; `
        + `the rule belongs in one gate`,
    ).toBe(1)

    // And that one call is the gate -- it tests the dropdown's empty value.
    // Without this, a call that merely READ the flag (to label a tab, say)
    // would satisfy the count above while nothing refused to render.
    expect(source, 'tabRequiresClient is called but not against an unset client')
      .toMatch(/tabRequiresClient\(activeTab\) && clientId === ''/)

    // No per-tab copy of the same decision beside the registry-driven one.
    for (const tab of gated) {
      expect(
        source,
        `tab '${tab.id}' decides the client rule for itself as well as via the registry`,
      ).not.toMatch(new RegExp(`activeTab === '${tab.id}' && clientId`))
    }
  })

  it('renders no panel for a tab that does not exist', () => {
    // The other direction. A leftover branch for a removed tab is dead code
    // that looks alive, and the next person to read this file would reasonably
    // conclude the tab still exists somewhere.
    // `Set<string>` explicitly. Inferred, it would be a set of the six id
    // literals, whose `has` then refuses an arbitrary string -- the same
    // narrowing that bit isReportType. Widening the SET is right; widening the
    // id being tested would defeat the check.
    const ids: Set<string> = new Set(REPORT_TABS.map(t => t.id))
    const orphans = [...rendered].filter(id => !ids.has(id))
    expect(orphans, `render branch(es) for unknown tab(s): ${orphans.join(', ')}`)
      .toEqual([])
  })
})
