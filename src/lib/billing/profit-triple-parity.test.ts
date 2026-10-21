// Static check over the repo's own source: no screen may rebuild a
// revenue/cost/profit triple out of three independent sums.
//
// WHY THIS EXISTS, AND WHY IT IS A SOURCE CHECK AND NOT A BEHAVIOURAL ONE.
//
// The defect documented at the head of ./profit-rollup.ts was not a wrong
// formula. It was three correct sums stacked in a column:
//
//   sumPriced(rows, 'client_rate')     revenue
//   sumPriced(rows, 'actual_cost')     cost
//   sumPriced(rows, 'profit_loss')     "profit"
//
// Each call is honest in isolation -- `sumPriced` skips the rows it cannot read
// and hands back the count it withheld. The lie is that the three skip
// DIFFERENT rows, so they describe three different sets of shipments, and a
// third figure under a rule reads as a subtraction that was never performed. On
// 2026-10-13 all three dashboard periods were loss-making by their own two
// figures and all three printed a profit in green.
//
// It was fixed on the dashboard in the commit that added ./profit-rollup.ts --
// and the identical pattern stayed in FOUR other places for another week:
// /losses, /shipments, the Reports shipments tab and the /billing shipments
// tab. So the same period showed a different profit depending on which screen
// you opened it on, which is the fastest way for a team to stop believing any
// number in the system. All five now call `reconcile`.
//
// Nothing in vitest can catch that recurrence. vitest.config.ts excludes
// `.test.tsx`, so no component or page on this list can be rendered in a test
// at all; and even if it could, each individual figure would assert correctly
// -- `sumPriced` is right, it is right in every one of these files, and it was
// right on 2026-10-13 while the screen was wrong. There is no runtime
// observation that distinguishes "three honest sums" from "three honest sums
// stacked as a subtraction", because the stacking happens in JSX, in the
// reader's head. The difference exists only in the shape of the source. Hence
// readFileSync here and no import of the code under test.
//
// WHAT THIS DOES NOT CLAIM. It cannot prove any screen renders the right
// figure, only that none of them derives a margin from mismatched row sets this
// particular way. A screen could still subtract two `sumPriced` totals held in
// differently-named variables and this check would pass -- see the second
// describe block, which closes the specific variant that was live in
// BillingView.tsx. The cents identity and the four-bucket partition that make
// `reconcile` trustworthy are pinned behaviourally in ./profit-rollup.test.ts;
// this file only pins that the screens go through it.

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/** Where the screens live. Not src/lib -- the libs are the thing being used. */
const ROOTS = ['src/app', 'src/components']

/**
 * Every .ts/.tsx file under the roots.
 *
 * Recursive and extension-filtered rather than a hardcoded list of the five
 * known offenders, because a hardcoded list cannot fail for a file nobody
 * thought to add to it -- and a sixth screen summing a sixth triple is exactly
 * the thing this is here to catch.
 */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) sourceFiles(path, out)
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(path)
  }
  return out
}

const FILES = ROOTS.flatMap(r => sourceFiles(r)).sort()

/**
 * Does this file sum `column` with `sumPriced`?
 *
 * `sumPriced(` and not `Priced(`: `sumAbsPriced(rows, 'profit_loss')` is a
 * LEGITIMATE and different call -- it totals the magnitude of known losses over
 * rows that are all `is_loss = true`, which is a loss report, not a margin. It
 * appears in /losses on purpose and must not be caught here. The two names do
 * not substring-match each other, which is the only reason this regex can tell
 * them apart.
 *
 * `[^)]*` stops at the closing paren, so a `sumPriced(x, 'a')` on one line
 * followed by `'profit_loss'` on another cannot be mistaken for one call.
 */
function sums(src: string, column: string): boolean {
  return new RegExp(`sumPriced\\([^)]*'${column}'`).test(src)
}

describe('no screen rebuilds the margin from independent sums', () => {
  // Read once. Each `it` below asks a different question of the same bytes.
  const sources = new Map(FILES.map(f => [f, readFileSync(f, 'utf8')]))

  it('finds the screens to check (guards against an empty scan passing)', () => {
    // A recursive walk that silently returned [] would make every assertion
    // below vacuously true, which is the failure mode that let a broken probe
    // report "nothing wrong" earlier in this project's history. Pin a floor and
    // pin that the specific files the fix touched are actually in the set.
    expect(FILES.length).toBeGreaterThan(50)
    for (const f of [
      'src/app/losses/page.tsx',
      'src/app/dashboard/page.tsx',
      'src/components/shipments/ShipmentsTable.tsx',
      'src/components/reports/ReportsTabs.tsx',
      'src/components/billing/BillingView.tsx',
    ]) expect(FILES).toContain(f)
  })

  it('the regex can tell sumPriced from sumAbsPriced', () => {
    // Positive control on the instrument itself. If `sums` matched
    // `sumAbsPriced`, the /losses loss-magnitude total would trip the rule
    // below and the honest fix would be to weaken the rule -- so prove the
    // distinction before relying on it.
    expect(sums("sumPriced(rows, 'profit_loss')", 'profit_loss')).toBe(true)
    expect(sums("sumAbsPriced(rows, 'profit_loss')", 'profit_loss')).toBe(false)
    expect(sums("sumPriced(rows, 'client_rate')", 'profit_loss')).toBe(false)
  })

  // THE RULE. Pairwise, not just the full triple: a file holding a revenue or
  // cost sum next to a stored-profit sum is one JSX edit away from stacking
  // them, and there is no screen that legitimately needs both. The margin comes
  // from `reconcile`; a loss report uses `sumAbsPriced`.
  it.each([
    ['client_rate', 'revenue'],
    ['actual_cost', 'carrier cost'],
  ])('no file sums profit_loss alongside %s (%s)', (column) => {
    const offenders = [...sources]
      .filter(([, src]) => sums(src, 'profit_loss') && sums(src, column))
      .map(([f]) => f)
    expect(offenders, [
      `These files sum the stored profit_loss column alongside ${column}.`,
      'Those two sums skip different rows, so stacking them is a subtraction',
      'between figures measured over different shipments -- the defect at the',
      'head of src/lib/billing/profit-rollup.ts. Use reconcile() for a margin,',
      'or sumAbsPriced() if the figure is a loss total rather than a margin.',
    ].join(' ')).toEqual([])
  })

  it('every file that still sums profit_loss says what for', () => {
    // Not a ban. `sumPriced(rows, 'profit_loss')` remains correct for a LOSS
    // total -- the dashboard's loss card and the Reports loss tab both total
    // known losses over rows that are already filtered to `is_loss = true`.
    // What this pins is that such a file carries no revenue or cost sum to be
    // stacked against (the rule above) and is therefore reporting losses, not
    // computing a margin. Listing them keeps the set small and deliberate: a
    // new name appearing here is a prompt to check which of the two it is.
    const summers = [...sources].filter(([, src]) => sums(src, 'profit_loss')).map(([f]) => f)
    expect(summers.sort()).toEqual([
      'src/app/dashboard/page.tsx',
      'src/components/reports/ReportsTabs.tsx',
    ])
  })
})

describe('the five money screens derive the margin through profit-rollup', () => {
  // The other half of the claim. The rule above says what they must not do;
  // this says what they must do, for the screens that show a margin at all.
  //
  // A hardcoded list is right here and wrong above. Above, the question is
  // "does any file anywhere do the bad thing", which has to be a scan. Here the
  // question is "do these specific five screens still go through the shared
  // rollup", and naming them is the claim -- a scan could only ask it of files
  // that already import it, which is circular.
  const MARGIN_SCREENS = [
    'src/app/dashboard/page.tsx',
    'src/app/losses/page.tsx',
    'src/components/shipments/ShipmentsTable.tsx',
    'src/components/reports/ReportsTabs.tsx',
    'src/components/billing/BillingView.tsx',
  ]

  it.each(MARGIN_SCREENS)('%s imports and calls reconcile', (file) => {
    const src = readFileSync(file, 'utf8')
    expect(src).toMatch(/from '@\/lib\/billing\/profit-rollup'/)
    expect(src).toMatch(/\breconcile\(/)
  })

  it.each(MARGIN_SCREENS)('%s renders the margin through reconciledOrUnknown', (file) => {
    // Calling `reconcile` is not enough on its own: reading `.profit` straight
    // off it prints `+$0.00` in green for a period where not one row could be
    // reconciled, which is the sum over an empty set rendered as an all-clear.
    // `reconciledOrUnknown` is what turns that into a dash while leaving a
    // genuinely empty period as a real $0.
    expect(readFileSync(file, 'utf8')).toMatch(/\breconciledOrUnknown\(/)
  })

  it('no margin screen colours a possibly-null profit with a bare >= 0', () => {
    // `null >= 0` is TRUE in JavaScript, so `profit >= 0 ? 'green' : 'red'`
    // paints an UNKNOWN margin green -- the exact styling of a good result, on
    // a figure nobody could compute. Three of these five screens had that
    // ternary before the fix. The guard is that a null check appears alongside.
    for (const file of MARGIN_SCREENS) {
      const src = readFileSync(file, 'utf8')
      for (const [, expr] of src.matchAll(/([A-Za-z.]*profit[A-Za-z.]*)\s*>=\s*0/gi)) {
        // Either the compared expression is provably non-null by its own name
        // (a `plPositive`-style boolean is not compared here), or the file
        // tests it against null somewhere. Narrow but real: it fails on a
        // re-introduced `known.profit >= 0 ? 'green'` with no null branch.
        expect(
          new RegExp(`${expr.replace('.', '\\.')}\\s*!==\\s*null`).test(src)
            || new RegExp(`${expr.replace('.', '\\.')}\\s*===\\s*null`).test(src),
          `${file} compares ${expr} with >= 0 but never against null; `
          + 'null >= 0 is true, so an UNKNOWN margin would render as a profit.',
        ).toBe(true)
      }
    }
  })
})
