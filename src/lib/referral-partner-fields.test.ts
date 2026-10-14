import { describe, it, expect } from 'vitest'
import { partnerWriteFields } from './referral-partner-fields'

// WHY THIS MODULE EXISTS AT ALL.
//
// /api/referrals/partners built its update as
//   { name, company: company ?? null, email: email ?? null, ... }
// and then stripped the keys whose value was `undefined`. But `?? null`
// has already turned every absent key into null by that point, so the
// strip removed nothing and a partial POST wrote nulls across the row.
//
// The live caller that does this is the "approve" button: it sends
// { id, name, status: 'active' } and nothing else, so approving a
// website sign-up ERASED their company, email, phone, partner type,
// refer method and notes. Email is the field portal access requires, so
// the partner then could not be invited and nobody could see why.
//
// Hence a pure function, under test, rather than a correction buried in
// a route handler nothing can cover.

const ok = (body: Record<string, unknown>) => {
  const r = partnerWriteFields(body)
  if ('error' in r) throw new Error(`unexpected refusal: ${r.error}`)
  return r.fields
}

describe('partnerWriteFields — absent keys', () => {
  it('writes ONLY the columns the caller actually sent', () => {
    const fields = ok({ id: 'p1', name: 'Dana', status: 'active' })
    expect(fields).toHaveProperty('name', 'Dana')
    expect(fields).toHaveProperty('status', 'active')
    expect(fields).not.toHaveProperty('company')
    expect(fields).not.toHaveProperty('email')
    expect(fields).not.toHaveProperty('phone')
    expect(fields).not.toHaveProperty('partner_type')
    expect(fields).not.toHaveProperty('refer_method')
    expect(fields).not.toHaveProperty('notes')
    expect(fields).not.toHaveProperty('tax_status')
  })

  it('does NOT reactivate an inactive partner on an unrelated edit', () => {
    // The old route wrote `status: status ?? 'active'` on updates too, so
    // editing a note reopened portal access to a partner who had been cut
    // off. That is the one wipe here with a security consequence.
    const fields = ok({ id: 'p1', name: 'Dana', notes: 'called back' })
    expect(fields).not.toHaveProperty('status')
  })

  it('still defaults a NEW partner to active', () => {
    const fields = ok({ name: 'Dana' })
    expect(fields).toHaveProperty('status', 'active')
  })

  it('stamps updated_at every time', () => {
    expect(ok({ id: 'p1', name: 'Dana' }).updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })
})

describe('partnerWriteFields — explicit clears', () => {
  it('clears a column the caller explicitly blanked', () => {
    // An empty string from a form input means "I deleted this", which is a
    // decision, unlike an absent key which means "I was not editing it".
    expect(ok({ id: 'p1', name: 'Dana', phone: '' })).toHaveProperty('phone', null)
  })
  it('clears a column the caller explicitly nulled', () => {
    expect(ok({ id: 'p1', name: 'Dana', notes: null })).toHaveProperty('notes', null)
  })
  it('keeps a real value', () => {
    expect(ok({ id: 'p1', name: 'Dana', company: 'Katz LLC' })).toHaveProperty(
      'company',
      'Katz LLC',
    )
  })
})

describe('partnerWriteFields — name', () => {
  it('refuses a create with no name', () => {
    const r = partnerWriteFields({})
    expect(r).toHaveProperty('error')
  })
  it('refuses to blank the name of an existing partner', () => {
    // A nameless row is unreadable on every screen that lists partners.
    const r = partnerWriteFields({ id: 'p1', name: '   ' })
    expect(r).toHaveProperty('error')
  })
  it('allows an edit that does not mention the name', () => {
    expect(ok({ id: 'p1', notes: 'x' })).not.toHaveProperty('name')
  })
})

describe('partnerWriteFields — tax_status (§2a.7)', () => {
  it('accepts the three recorded statuses', () => {
    for (const value of ['us_person', 'foreign_individual', 'foreign_entity']) {
      expect(ok({ id: 'p1', tax_status: value })).toHaveProperty('tax_status', value)
    }
  })
  it('accepts an explicit clear back to unset', () => {
    expect(ok({ id: 'p1', tax_status: '' })).toHaveProperty('tax_status', null)
    expect(ok({ id: 'p1', tax_status: null })).toHaveProperty('tax_status', null)
  })
  it('REFUSES an unrecognised value rather than writing it', () => {
    // The database CHECK constraint would reject it too, as a 500 reading
    // "new row violates check constraint". Refusing here makes it a 400 a
    // staff member can act on -- and if the constraint were ever dropped,
    // this is what stops a typo becoming a value taxStatusOf() reads as
    // unset, which looks to the partner like a screen that never unblocks.
    const r = partnerWriteFields({ id: 'p1', tax_status: 'US_PERSON' })
    expect(r).toHaveProperty('error')
    expect((r as { error: string }).error).toMatch(/tax status/i)
  })
  it('refuses a non-string', () => {
    expect(partnerWriteFields({ id: 'p1', tax_status: 7 })).toHaveProperty('error')
  })
})

describe('partnerWriteFields — ignores what it does not own', () => {
  it('never writes a column the caller invented', () => {
    // The body is staff-supplied JSON. An allowlist is why a POST carrying
    // `signup_bonus_amount` or `agreement_status` cannot reach the row:
    // those price money and are set by the DocuSign webhook, not a form.
    const fields = ok({ id: 'p1', name: 'Dana', signup_bonus_amount: 5000, agreement_status: 'signed' })
    expect(fields).not.toHaveProperty('signup_bonus_amount')
    expect(fields).not.toHaveProperty('agreement_status')
  })
  it('never writes the id as a column', () => {
    expect(ok({ id: 'p1', name: 'Dana' })).not.toHaveProperty('id')
  })
})
