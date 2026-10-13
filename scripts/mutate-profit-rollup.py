#!/usr/bin/env python3
"""Mutation-check the reconciling roll-up in profit-rollup.ts.

Each mutant is a change a plausible refactor would make, and several of them
are the ORIGINAL dashboard defect re-introduced: revenue summed over rows whose
cost is unknown, profit read from the stored column, the margin subtracted in
floats. A suite that stays green under those is not pinning the thing the
module exists to guarantee.

Same two guards as scripts/mutate-client-filter.py, both learned the hard way:
  * A mutant whose `old` string is absent does not apply, and an unapplied
    mutant reads as SURVIVED -- a false clean bill of health. So every mutant
    asserts its replacement landed, and that the target was unique.
  * Restore is verified byte-identical, not assumed, because this file is on
    the money path and a half-restored mutant is worse than no mutation test.
"""
import filecmp, shutil, subprocess, sys, tempfile, os

SRC = 'src/lib/billing/profit-rollup.ts'
TEST = 'src/lib/billing/profit-rollup.test.ts'

MUTANTS = [
    # ── The original defect, re-introduced three different ways ──────────────
    ('profit read from the stored profit_loss column',
     'profit: (revCents - costCents) / 100,',
     'profit: rows.reduce((s, r) => s + (priceOf(r.profit_loss) ?? 0), 0),'),

    ('margin subtracted in floats instead of cents',
     'profit: (revCents - costCents) / 100,',
     'profit: revCents / 100 - costCents / 100,'),

    ('uncosted rows counted in revenue anyway',
     'if (cost === null) { uncosted++; continue }',
     'if (cost === null) { uncosted++; revCents += Math.round(rate * 100); continue }'),

    ('unrated rows counted in cost anyway',
     'if (rate === null) { unrated++; continue }',
     'if (rate === null) { unrated++; costCents += Math.round(cost * 100); continue }'),

    # Floats accumulated into the "cents" counters. Whole-dollar fixtures like
    # (10, 7) still subtract exactly, so this is the mutant the hand-picked
    # cases are weakest against and the 500 random row sets are strongest
    # against -- it is here to show the property test earns its place.
    ('rate accumulated unrounded into the cents counter',
     'const rateCents = Math.round(rate * 100)',
     'const rateCents = rate * 100'),

    ('cost accumulated unrounded into the cents counter',
     'const costCents_ = Math.round(cost * 100)',
     'const costCents_ = cost * 100'),

    # ── The bucket partition ────────────────────────────────────────────────
    ('both-null checked last, so unmeasured never fires',
     '''    if (rate === null && cost === null) { unmeasured++; continue }
    if (rate === null) { unrated++; continue }
    if (cost === null) { uncosted++; continue }''',
     '''    if (rate === null) { unrated++; continue }
    if (cost === null) { uncosted++; continue }
    if (rate === null && cost === null) { unmeasured++; continue }'''),

    ('unrated and uncosted swapped',
     '''    if (rate === null) { unrated++; continue }
    if (cost === null) { uncosted++; continue }''',
     '''    if (rate === null) { uncosted++; continue }
    if (cost === null) { unrated++; continue }'''),

    ('excluded row silently dropped from every count',
     'if (cost === null) { uncosted++; continue }',
     'if (cost === null) { continue }'),

    # ── null vs zero ────────────────────────────────────────────────────────
    ('truthiness instead of null check, so a rate of 0 is "missing"',
     'if (rate === null) { unrated++; continue }',
     'if (!rate) { unrated++; continue }'),

    ('a cost of 0 treated as missing',
     'if (cost === null) { uncosted++; continue }',
     'if (!cost) { uncosted++; continue }'),

    ('reconciledOrUnknown publishes zeros instead of UNKNOWN',
     'return { revenue: null, cost: null, profit: null }',
     'return { revenue: 0, cost: 0, profit: 0 }'),

    ('reconciledOrUnknown calls an empty period UNKNOWN too',
     'if (r.counted > 0 && r.reconciled === 0) {',
     'if (r.reconciled === 0) {'),

    # This one exists to positive-control the on-screen group. That group's
    # helper used to bail out when revenue came back null, so this mutant --
    # everything is UNKNOWN, always -- would have satisfied four of its five
    # tests by rendering nothing at all. If this reads SURVIVED, the helper has
    # regressed to a silent pass.
    ('reconciledOrUnknown answers UNKNOWN unconditionally',
     'if (r.counted > 0 && r.reconciled === 0) {',
     'if (true) {'),

    # ── marginPct ───────────────────────────────────────────────────────────
    ('marginPct returns 0% instead of null on zero revenue',
     'if (r.reconciled === 0 || r.revenue === 0) return null',
     'if (false) return null'),

    ('marginPct divides by cost instead of revenue',
     'return (r.profit / r.revenue) * 100',
     'return (r.profit / r.cost) * 100'),

    # ── combineReconciled ───────────────────────────────────────────────────
    ('combineReconciled accumulates profit instead of deriving it',
     'out.profit = (revCents - costCents) / 100',
     'out.profit = parts.reduce((s, p) => s + p.profit, 0)'),

    ('combineReconciled mutates a shared module-level object',
     'const out: Reconciled = { ...EMPTY }',
     'const out: Reconciled = EMPTY'),

    ('combineReconciled drops the unrated count',
     'out.unrated += p.unrated',
     'out.unrated += 0'),

    ('combineReconciled adds revenue in floats',
     'revCents += Math.round(p.revenue * 100)',
     'revCents += p.revenue * 100'),

    # ── exclusionNote ───────────────────────────────────────────────────────
    ('exclusionNote fires when nothing was excluded',
     'if (excluded <= 0) return \'\'',
     'if (excluded < 0) return \'\''),

    ('exclusionNote names the non-actionable bucket first',
     '''  if (r.unrated > 0) reasons.push(`${r.unrated} with no agreed rate`)
  if (r.uncosted > 0) reasons.push(`${r.uncosted} awaiting carrier cost`)''',
     '''  if (r.uncosted > 0) reasons.push(`${r.uncosted} awaiting carrier cost`)
  if (r.unrated > 0) reasons.push(`${r.unrated} with no agreed rate`)'''),

    ('exclusionNote prints an empty bucket',
     'if (r.unmeasured > 0) reasons.push(`${r.unmeasured} with neither`)',
     'reasons.push(`${r.unmeasured} with neither`)'),

    # ── stale diagnostic ────────────────────────────────────────────────────
    ('an absent profit_loss counted as stale',
     'if (stored !== null && Math.round(stored * 100) !== rateCents - costCents_) stale++',
     'if (Math.round((stored ?? 0) * 100) !== rateCents - costCents_) stale++'),

    ('stale never fires',
     'if (stored !== null && Math.round(stored * 100) !== rateCents - costCents_) stale++',
     'if (false) stale++'),

    # ── the two deliberately-different revenue questions ────────────────────
    ('invoiceableRevenue reads the cost column',
     "return sumPriced(rows as ReadonlyArray<object> | null | undefined, 'client_rate')",
     "return sumPriced(rows as ReadonlyArray<object> | null | undefined, 'actual_cost')"),

    ('invoiceableRevenue narrowed to the reconciled rows, collapsing the two',
     "return sumPriced(rows as ReadonlyArray<object> | null | undefined, 'client_rate')",
     "return sumPriced((rows ?? []).filter(r => priceOf(r.actual_cost) !== null) as ReadonlyArray<object>, 'client_rate')"),

    ('otherIncome reads the wrong column from each source',
     '''    sumPriced(warehouse, 'total'),
    sumPriced(manual, 'amount'),''',
     '''    sumPriced(warehouse, 'amount'),
    sumPriced(manual, 'total'),'''),
]


def run_tests():
    r = subprocess.run(['npx', 'vitest', 'run', TEST],
                       capture_output=True, text=True)
    return r.returncode == 0


def main():
    with tempfile.TemporaryDirectory() as tmp:
        pristine = os.path.join(tmp, 'pristine.ts')
        shutil.copyfile(SRC, pristine)
        original = open(SRC).read()

        if not run_tests():
            print('ABORT: suite is not green before mutating')
            return 1

        survived = []
        for name, old, new in MUTANTS:
            if old not in original:
                print(f'ABORT: mutant target absent -- {name}')
                return 1
            if original.count(old) != 1:
                print(f'ABORT: target not unique ({original.count(old)}x) -- {name}')
                return 1

            mutated = original.replace(old, new, 1)
            open(SRC, 'w').write(mutated)

            # Prove the mutation landed. An unapplied mutant reads as SURVIVED.
            on_disk = open(SRC).read()
            assert on_disk == mutated and on_disk != original, name

            killed = not run_tests()

            shutil.copyfile(pristine, SRC)
            assert filecmp.cmp(pristine, SRC, shallow=False), f'restore failed: {name}'
            assert open(SRC).read() == original, f'restore not byte-identical: {name}'

            print(f'{"KILLED " if killed else "SURVIVED"}  {name}')
            if not killed:
                survived.append(name)

        if not run_tests():
            print('ABORT: suite not green after restore')
            return 1

        print(f'\n{len(MUTANTS) - len(survived)}/{len(MUTANTS)} killed')
        for s in survived:
            print(f'  SURVIVED: {s}')
        return 1 if survived else 0


if __name__ == '__main__':
    sys.exit(main())
