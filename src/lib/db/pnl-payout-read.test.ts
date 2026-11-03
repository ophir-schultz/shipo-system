// The partner payout block used to ignore referral_payouts errors.
//
// `payoutsRes.data ?? []` turns a failed read into an empty ledger, and an
// empty ledger is what a partner who has been paid nothing looks like.
// computeOwed then marks every line unpaid, and the Paid figure is $0.00.
// This file is a source check because PartnerPayouts.tsx is excluded from
// vitest (only src/**/*.test.ts runs) and the defect is the missing branch,
// not a number a double can reproduce.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = readFileSync(join(__dirname, '../../components/pnl/PartnerPayouts.tsx'), 'utf8')

describe('PartnerPayouts payout read', () => {
  it('does not treat a failed referral_payouts read as nothing paid', () => {
    expect(SRC).toContain('payoutsRes.error')
    expect(SRC).toContain('payoutsReadFailed')
    // The paid total is withheld when the read failed. A summarize() over an
    // empty payout list is the bug this guards.
    const failedBranch = SRC.slice(SRC.indexOf('payoutsReadFailed'))
    expect(failedBranch).toContain('totals: payoutsReadFailed ? null : summarize(lines)')
    expect(SRC).toContain('Paid is not $0')
  })
})
