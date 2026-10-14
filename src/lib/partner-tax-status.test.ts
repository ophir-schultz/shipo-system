import { describe, it, expect } from 'vitest'
import {
  TAX_STATUS_OPTIONS,
  TAX_STATUS_UNSET_LABEL,
  taxStatusOf,
  w9Refusal,
} from './partner-tax-status'

describe('taxStatusOf', () => {
  it('reads the three known values', () => {
    expect(taxStatusOf('us_person')).toBe('us_person')
    expect(taxStatusOf('foreign_individual')).toBe('foreign_individual')
    expect(taxStatusOf('foreign_entity')).toBe('foreign_entity')
  })
  it('is null for unset, blank and unrecognised values', () => {
    expect(taxStatusOf(null)).toBeNull()
    expect(taxStatusOf(undefined)).toBeNull()
    expect(taxStatusOf('')).toBeNull()
    expect(taxStatusOf('US_PERSON')).toBeNull()
    expect(taxStatusOf('ecommerce_agency')).toBeNull()
  })
})

// The staff dropdown is the ONLY way a tax status gets recorded, and a
// status the database accepts but the dropdown never offers can only be set
// by a hand-written UPDATE. These tests are what the .tsx cannot have:
// vitest's `include` is src/**/*.test.ts, so nothing asserts over a
// component. Keeping the option list in the .ts and checking it here is the
// difference between a guarded list and four literals nobody reads.
describe('TAX_STATUS_OPTIONS', () => {
  it('offers every status taxStatusOf accepts, and nothing it does not', () => {
    for (const { value } of TAX_STATUS_OPTIONS) {
      expect(taxStatusOf(value)).toBe(value)
    }
    expect(TAX_STATUS_OPTIONS).toHaveLength(3)
  })
  it('gives every option a non-empty label distinct from the others', () => {
    const labels = TAX_STATUS_OPTIONS.map((o) => o.label)
    for (const label of labels) expect(label.trim().length).toBeGreaterThan(0)
    expect(new Set(labels).size).toBe(labels.length)
  })
  it('does NOT offer an unset option among the values', () => {
    // Unset is rendered, not chosen: it is the placeholder, with an empty
    // value, so a staff member cannot "select" the state that means nobody
    // looked. Were '' in this list it would read as a deliberate answer.
    expect(TAX_STATUS_OPTIONS.map((o) => o.value as string)).not.toContain('')
    expect(TAX_STATUS_UNSET_LABEL.trim().length).toBeGreaterThan(0)
  })
  it('never labels the unset state as a US person', () => {
    // The whole §2a.7 guard rests on unset NOT reading as US. A placeholder
    // that said "US person (default)" would undo it in the one place a human
    // actually decides.
    expect(TAX_STATUS_UNSET_LABEL).not.toMatch(/us person/i)
  })
})

describe('w9Refusal', () => {
  it('allows a US person', () => {
    expect(w9Refusal('us_person')).toBeNull()
  })
  it('refuses an UNSET status', () => {
    expect(w9Refusal(null)).toMatch(/tax status/i)
  })
  it('names the form a foreign individual would need', () => {
    expect(w9Refusal('foreign_individual')).toMatch(/W-8BEN(?!-E)/)
  })
  it('names the form a foreign entity would need', () => {
    expect(w9Refusal('foreign_entity')).toMatch(/W-8BEN-E/)
  })
})
