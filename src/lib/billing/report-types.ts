/**
 * The tabs on /reports, and which export each one produces.
 *
 * WHY THIS FILE EXISTS.
 *
 * This list was three lists. `TABS` in ReportsTabs.tsx carried the five tab
 * buttons, a separate `typeMap` inside handleDownload mapped tab id -> export
 * type, and `REPORT_TYPES` in api/reports/download/route.ts declared what the
 * route would accept. Nothing tied them together, and `noUncheckedIndexedAccess`
 * is off in this project, so `typeMap[activeTab]` is typed `string` and is
 * `undefined` at runtime for any tab the map forgot.
 *
 * Measured, not assumed, because the failure is not the obvious one:
 *
 *   new URLSearchParams({ type: undefined })  ->  'type=undefined'
 *
 * URLSearchParams stringifies it, so the request goes out with the literal
 * four-letter word and the download lands as `undefined-2026-10-01.xlsx` unless
 * something refuses it. The route's isReportType does refuse it, with a 400, so
 * today this drift fails loudly rather than exporting the wrong sheet -- but it
 * fails at the far end of a round trip, with a message about query parameters,
 * for what is really a missing line in a different file.
 *
 * The three lists had ALREADY drifted before anyone added a tab: REPORT_TYPES
 * has six entries and TABS had five, so 'profit-loss' was a working export with
 * no way to reach it except by hand-editing the URL. That is the drift this file
 * makes impossible rather than merely unlikely.
 *
 * So: one array, each tab naming its own export, and the route deriving what it
 * accepts from the same array. A tab with no export says so in the type system
 * (`reportType: null`) instead of by being absent from a map.
 */

/**
 * Every export `api/reports/download` knows how to build.
 *
 * Derived from REPORT_TABS below rather than written twice. `as const` on the
 * tab array is what makes these literal types instead of `string`; dropping it
 * widens ReportType to `string` and disarms isReportType completely, which is
 * why the assertion is load-bearing and not decoration.
 *
 * Measured, because "load-bearing" was wishful when first written: with
 * `as const` removed, every runtime test in report-types.test.ts still passes
 * -- they all derive from REPORT_TABS, so they widen along with it and keep
 * agreeing with themselves. What actually catches it is a type-level assertion
 * at the top of that file. Do not delete that assertion on the grounds that it
 * states the obvious; it is the only thing standing here.
 */
export type ReportType =
  Exclude<(typeof REPORT_TABS)[number]['reportType'], null>

export interface ReportTab {
  /** The value held in ReportsTabs' `activeTab` state. */
  id: string
  label: string
  icon: string
  /**
   * The `type` query parameter this tab's download button sends, or null when
   * this tab has no spreadsheet.
   *
   * Explicitly null rather than omitted. An optional field would let a new tab
   * forget the decision and fall back to the old `undefined` behaviour; a
   * required `| null` forces whoever adds a tab to answer the question, and the
   * download button reads it to decide whether to render at all.
   */
  reportType: string | null
  /**
   * Does this tab refuse to render until a single client is chosen?
   *
   * True only for the client-facing statement. Every other tab is a management
   * view across all clients and "All Clients" is a meaningful selection there.
   * A statement with no client is not an empty statement, it is no statement --
   * the same rule /statements already enforces, carried here so both screens
   * agree rather than one of them quietly showing a blank document.
   */
  requiresClient?: true
}

/**
 * The tabs, in the order they appear.
 *
 * `satisfies` and not `:` -- the annotation would widen the literals away and
 * take ReportType down with it, while `satisfies` checks the shape and keeps
 * them. Probed both ways; with `: readonly ReportTab[]` the ReportType above
 * collapses to `string`.
 */
export const REPORT_TABS = [
  { id: 'shipments', label: 'Shipments', icon: '🚚', reportType: 'shipments' },
  { id: 'profit', label: 'Profit', icon: '📈', reportType: 'profit-loss' },
  { id: 'loss', label: 'Losses', icon: '⚠️', reportType: 'loss-shipments' },
  { id: 'adjustments', label: 'Adjustments', icon: '🔔', reportType: 'adjustments' },
  { id: 'billing', label: 'Billing', icon: '💰', reportType: 'billing' },
  { id: 'warehouse', label: 'Warehouse', icon: '📦', reportType: 'warehouse' },
] as const satisfies readonly ReportTab[]

export const REPORT_TYPES: readonly ReportType[] =
  REPORT_TABS.map(t => t.reportType).filter((t): t is ReportType => t !== null)

/**
 * Is this the name of an export we can build?
 *
 * Takes `string | null` because it is fed straight from
 * `searchParams.get('type')`, which is null for an absent parameter. Narrowing
 * that here rather than at the call site is what stops `type=` (present but
 * empty) and an absent `type` from taking different paths.
 */
export function isReportType(t: string | null | undefined): t is ReportType {
  // The widening cast is on the ARRAY, not on `t`. `readonly ReportType[]`
  // declares `includes(x: ReportType)`, so passing an arbitrary string is a
  // type error -- which is backwards for a guard whose only job is testing
  // untrusted input. Casting `t` to ReportType instead would assert the very
  // thing being checked and make the guard return true for anything; casting
  // the array only relaxes the lookup, and the runtime answer is unchanged.
  return typeof t === 'string' && (REPORT_TYPES as readonly string[]).includes(t)
}

/**
 * The tab with this id, or null.
 *
 * Returns null rather than throwing: `activeTab` is React state and a stale
 * value after a rename should degrade to "no tab selected", not crash the
 * screen an operator is mid-export on.
 */
export function reportTabById(id: string): ReportTab | null {
  return REPORT_TABS.find(t => t.id === id) ?? null
}

/**
 * The export type for a tab id, or null if that tab has no spreadsheet.
 *
 * Null for BOTH "unknown tab" and "tab with no export" on purpose: the only
 * caller is the download button, and the correct behaviour is identical in
 * either case -- do not offer a download. Distinguishing them would invite a
 * branch that renders a button which cannot work.
 */
export function reportTypeForTab(id: string): ReportType | null {
  const t = reportTabById(id)
  return t !== null && isReportType(t.reportType) ? t.reportType : null
}

/** Does this tab need a single client chosen before it will render? */
export function tabRequiresClient(id: string): boolean {
  return reportTabById(id)?.requiresClient === true
}
