// What a recalculation run is allowed to look like when it is reported as
// "fine". The cases here are chosen to fail against the behaviour that was
// live before this file existed, where the dashboard called showSuccess()
// unconditionally and rendered four of the six counts.

import { describe, expect, it } from 'vitest'
import {
  hasRecalcGaps,
  recalcGaps,
  recalcSeverity,
  recalcSummary,
  type RecalcStatsLike,
} from './recalc-report'

/** A run where everything priced and nothing was withheld. */
const CLEAN: RecalcStatsLike = {
  updated: 1200,
  zone_matched: 900,
  legacy_matched: 300,
  unmatched: 0,
  skipped: 0,
  failed: 0,
  reasons: [],
}

describe('recalcSeverity', () => {
  it('is success only when every count is present and zero', () => {
    expect(recalcSeverity(CLEAN)).toBe('success')
  })

  it('is error when a write did not land', () => {
    // `failed` outranks everything: the run's own numbers describe writes that
    // the database did not accept, so the screen may be stale. This was
    // previously reported as a green "Recalculation complete".
    expect(recalcSeverity({ ...CLEAN, failed: 1 })).toBe('error')
  })

  it('is a warning, not success, for unpriced shipments', () => {
    // The case that matters operationally: 218 shipments with no rate is the
    // rate card being incomplete. Green for 4 seconds is the wrong report.
    expect(recalcSeverity({ ...CLEAN, unmatched: 218 })).toBe('warning')
  })

  it('is a warning for rows skipped because an input was unreadable', () => {
    // Distinct from unmatched and separately actionable: re-run, do not edit
    // prices. Pinned so the two cannot be collapsed into one count.
    expect(recalcSeverity({ ...CLEAN, skipped: 3 })).toBe('warning')
  })

  it('treats a missing count as unknown rather than as zero', () => {
    // The null-vs-zero rule. A body that does not say whether writes landed
    // has not said that they did, so it cannot be success. `failed: undefined`
    // must not read as `failed: 0`.
    expect(recalcSeverity({ ...CLEAN, failed: undefined })).toBe('warning')
    expect(recalcSeverity({ ...CLEAN, unmatched: null })).toBe('warning')
    expect(recalcSeverity({ ...CLEAN, skipped: null })).toBe('warning')
    // NaN is not a count either.
    expect(recalcSeverity({ ...CLEAN, unmatched: Number.NaN })).toBe('warning')
  })

  it('believes the detail over the totals when they disagree', () => {
    // An inconsistent body -- zero unmatched but a named reason -- reports the
    // reason, because the reason carries a real order number and the total
    // does not.
    expect(recalcSeverity({
      ...CLEAN,
      reasons: [{ reason: 'no rate band covers 42 LB', count: 1, example: '103996' }],
    })).toBe('warning')
  })
})

describe('recalcSummary', () => {
  it('names every count the response carries', () => {
    expect(recalcSummary({ ...CLEAN, unmatched: 218, skipped: 2, failed: 1 }))
      .toBe('1200 repriced · 900 by zone · 300 by rate card · 218 unpriced · 2 skipped (unreadable) · 1 WRITE FAILED')
  })

  it('omits the three problem counts only when they are exactly zero', () => {
    expect(recalcSummary(CLEAN)).toBe('1200 repriced · 900 by zone · 300 by rate card')
  })

  it('shows a missing count as ? rather than as 0', () => {
    // A "0 unpriced" that was really "we were not told" is the defect this
    // project calls writing a decision where there was none.
    const s = recalcSummary({ ...CLEAN, unmatched: undefined })
    expect(s).toContain('? unpriced')
    expect(s).not.toContain('0 unpriced')
  })
})

describe('recalcGaps', () => {
  const UNSORTED: RecalcStatsLike = {
    ...CLEAN,
    reasons: [
      { reason: 'b-reason', count: 5, example: '1001' },
      { reason: 'big', count: 90, example: '1002' },
      { reason: 'a-reason', count: 5, example: '1003' },
      { reason: 'never matched', count: 0, example: '1004' },
    ],
  }

  it('puts the biggest gap first', () => {
    expect(recalcGaps(UNSORTED).map(r => r.reason)).toEqual(['big', 'a-reason', 'b-reason'])
  })

  it('breaks ties by reason so two runs can be compared', () => {
    // Without the tiebreaker, equal counts come back in map-insertion order,
    // which follows whichever shipment happened to be read first -- so the
    // list reshuffles between runs and a diff of two screenshots is noise.
    const once = recalcGaps(UNSORTED).map(r => r.reason)
    const again = recalcGaps({ ...UNSORTED, reasons: [...UNSORTED.reasons!].reverse() })
      .map(r => r.reason)
    expect(again).toEqual(once)
  })

  it('drops a reason that matched nothing', () => {
    expect(recalcGaps(UNSORTED).some(r => r.count === 0)).toBe(false)
  })

  it('keeps the example order number, which is the point of the list', () => {
    // A count tells you a card is incomplete; the example tells you which
    // shipment to open to find out how. Losing it makes the list unactionable.
    expect(recalcGaps(UNSORTED)[0]).toEqual({ reason: 'big', count: 90, example: '1002' })
  })

  it('survives a response with no reasons field at all', () => {
    expect(recalcGaps({ updated: 1 })).toEqual([])
  })

  it('does not mutate the response it was given', () => {
    const reasons = [...UNSORTED.reasons!]
    recalcGaps({ ...UNSORTED, reasons })
    expect(reasons.map(r => r.reason)).toEqual(['b-reason', 'big', 'a-reason', 'never matched'])
  })
})

describe('hasRecalcGaps', () => {
  it('is false for a clean run', () => {
    expect(hasRecalcGaps(CLEAN)).toBe(false)
  })

  it('is true when there is a named gap to list', () => {
    expect(hasRecalcGaps({
      ...CLEAN,
      reasons: [{ reason: 'no rate band covers 42 LB', count: 1, example: '103996' }],
    })).toBe(true)
  })

  it('is true for a failed write even with nothing to list', () => {
    expect(hasRecalcGaps({ ...CLEAN, failed: 2 })).toBe(true)
  })

  it('is false when the only problem is a count we were not told', () => {
    // Severity and panel-visibility are different questions, and this is the
    // case that separates them: worth a warning toast, but a panel with no
    // rows would be a scary empty box.
    expect(recalcSeverity({ ...CLEAN, failed: undefined })).toBe('warning')
    expect(hasRecalcGaps({ ...CLEAN, failed: undefined })).toBe(false)
  })
})
