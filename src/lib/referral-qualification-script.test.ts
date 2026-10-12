import { describe, it, expect, vi } from 'vitest'

/**
 * Runs `scripts/check-referral-qualification.ts` inside the test suite.
 *
 * WHY THIS WRAPPER EXISTS
 * -----------------------
 * That script holds the only checks in the repo that cover the bonus
 * qualification LOGIC — which invoice clears which bar, and the
 * fail-closed reading of a bespoke partner row whose contracted bars are
 * zeroed. On 2026-10-12 the standing $500/month threshold and the 60-day
 * wait were both dropped, and that drop created a shape collision: the
 * standing programme and a zeroed bespoke row now resolve to the same
 * three nulls and must give OPPOSITE answers. `QualifyBars.unbarred`
 * carries the answer so it is never inferred from the nulls.
 *
 * Reverting that — rewriting `qualifiesInMonth` to infer "no bars" from
 * three nulls, or hardcoding `unbarred: true` in the bespoke branch —
 * breaks 5 and 12 of the script's checks respectively, and broke NONE of
 * the 1277 tests in this suite. `npm test` is `vitest run`; there is no
 * CI. So until this file existed, the guard on a $300 payout decision ran
 * only when somebody remembered to type the command.
 *
 * It is a wrapper, not a copy. Duplicating 440 lines of fixtures would
 * give two sets of checks to keep in agreement, and the next person to
 * change the terms would update one of them.
 *
 * HOW
 * ---
 * The script is top-level-executing and ends in `process.exit`, which
 * would kill the vitest worker, so `exit` is stubbed and the code
 * captured. Its stdout is captured too and the FAIL lines are put in the
 * failure message — an exit code alone would say "something is wrong"
 * without saying which check, which is the whole value of the script.
 */
describe('scripts/check-referral-qualification.ts', () => {
  it('passes every qualification check', async () => {
    let exitCode: number | undefined
    const output: string[] = []

    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(((code?: number) => {
        exitCode = code
        // Deliberately does NOT throw. The script's last statement is the
        // exit call, so returning normally lets it finish; throwing here
        // would surface as an unhandled error instead of a named check.
        return undefined
      }) as never)
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      output.push(args.map(String).join(' '))
    })

    try {
      await import('../../scripts/check-referral-qualification')
    } finally {
      exitSpy.mockRestore()
      logSpy.mockRestore()
    }

    const failed = output.filter((l) => l.startsWith('FAIL'))

    // Asserted before the exit code, so a broken check reports by name.
    expect(failed, `qualification checks failed:\n${failed.join('\n')}`).toEqual([])

    // The script must have actually run and reached its own verdict. A
    // silent no-op would satisfy the line above: no output, no failures.
    expect(output.some((l) => l.startsWith('PASS')), 'the script produced no PASS lines — did it run?').toBe(true)
    // Trimmed: the script prints its verdict with a leading blank line.
    expect(output.at(-1)?.trim()).toBe('ALL CHECKS PASSED')
    expect(exitCode).toBe(0)
  })
})
