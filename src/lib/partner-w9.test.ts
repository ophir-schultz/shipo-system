import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  W9_CUSTOM_FIELD,
  W9_INCLUDED,
  holdsW9,
  payoutBlockedReason,
  w9Label,
} from './partner-w9'

describe('holdsW9', () => {
  it('is true only on a recorded date', () => {
    expect(holdsW9({ w9_received_at: '2026-10-13T09:00:00.000Z' })).toBe(true)
  })

  it('treats every flavour of absent as absent', () => {
    // Fail-closed, and the direction matters: a false positive here pays
    // money out against a taxpayer identification number we do not have.
    for (const w9_received_at of [null, undefined, '']) {
      expect(holdsW9({ w9_received_at })).toBe(false)
    }
    expect(holdsW9({})).toBe(false)
  })
})

describe('payoutBlockedReason', () => {
  it('passes a partner whose W-9 is on file', () => {
    expect(payoutBlockedReason({ w9_received_at: '2026-10-13T09:00:00.000Z' })).toBeNull()
  })

  it('refuses one whose is not, and says what to do about it', () => {
    const reason = payoutBlockedReason({ w9_received_at: null })
    expect(reason).toMatch(/W-9/)
    expect(reason!.length).toBeGreaterThan(20)
    expect(reason).not.toMatch(/^[A-Z_]+$/)
  })

  it('is about payment, not about portal access', () => {
    // The two gates are deliberately separate: the agreement opens the
    // portal, the W-9 opens payment. A partner reading their own statement
    // while we cannot yet pay them is a legitimate state, and a reason that
    // mentioned signing in would send staff to fix the wrong thing.
    const reason = payoutBlockedReason({})!
    expect(reason).not.toMatch(/sign in|log in|portal access/i)
    expect(reason).toMatch(/pay/i)
  })
})

describe('w9Label', () => {
  it('names both states plainly', () => {
    expect(w9Label({ w9_received_at: '2026-10-13T09:00:00.000Z' })).toEqual({
      text: 'on file',
      tone: 'good',
    })
    expect(w9Label({}).text).toBe('missing')
    expect(w9Label({}).tone).toBe('bad')
  })
})

describe('the webhook records the W-9 only on evidence', () => {
  // The stamp is the whole mechanism: if it fires unconditionally then
  // every partner who signs is marked payable, including the ones whose
  // envelope predated the W-9 — and the column becomes a worse lie than
  // the memory it replaced, because now it looks like a record.
  function body(src: string): string {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*)/.test(line))
      .filter((line) => !/^\s*import\b/.test(line))
      .join('\n')
  }

  const src = body(readFileSync('src/app/api/partner/agreement-webhook/route.ts', 'utf8'))

  it('the stripper keeps code and drops prose and imports', () => {
    expect(body('  w9_received_at: now,\n')).toContain('w9_received_at')
    expect(body('  // w9_received_at is stamped below\n')).not.toContain('w9_received_at')
    expect(body("import { W9_INCLUDED } from '@/lib/partner-w9'\n")).not.toContain('W9_INCLUDED')
  })

  it('asks the envelope whether it carried one', () => {
    expect(src).toContain(`customField(payload, W9_CUSTOM_FIELD)`)
  })

  it('shares this module’s vocabulary instead of its own literals', () => {
    // A rename on either side would otherwise record every W-9 we receive
    // as not received — a silent failure that surfaces as a partner being
    // told we cannot pay them. Importing the constants is what makes that
    // impossible rather than merely unlikely, so a copy of either literal
    // in the route is itself the defect.
    expect(src).toContain('W9_CUSTOM_FIELD')
    expect(src).toContain('W9_INCLUDED')
    expect(src).not.toContain(`'${W9_CUSTOM_FIELD}'`)
    expect(src).not.toContain(`'${W9_INCLUDED}'`)
  })

  it('never writes the column unconditionally', () => {
    // Every mention of the column in the route must be guarded. The
    // reversion this catches is one character of editing: replacing the
    // conditional spread with `w9_received_at: now,`.
    const mentions = [...src.matchAll(/.*w9_received_at.*/g)].map((m) => m[0])
    expect(mentions.length).toBeGreaterThan(0)
    for (const line of mentions) {
      expect(line).toMatch(/\?|w9Received \?|\.\.\.\(/)
      expect(line).not.toMatch(/^\s*w9_received_at:\s*now,?\s*$/)
    }
  })

  it('records the column name the migration actually adds', () => {
    // The phantom-column class: a name consistent everywhere in the code
    // and absent from the database. supabase/partner_w9.sql is the only
    // place it is created.
    const sql = readFileSync('supabase/partner_w9.sql', 'utf8')
    expect(sql).toMatch(/alter table referral_partners add column if not exists w9_received_at/)
    expect(src).toContain('w9_received_at')
  })
})
