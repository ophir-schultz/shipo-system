// What a staff POST to /api/referrals/partners is allowed to write.
//
// Two rules, and both exist because they were broken:
//
//   1. AN ABSENT KEY IS NOT A CLEAR. The route used to build its update as
//      `company: company ?? null` and then delete the keys whose value was
//      `undefined` -- but `?? null` had already replaced every absent key
//      with null, so nothing was deleted and a partial POST wrote nulls
//      across the row. The live caller that does this is the approve
//      button, which sends { id, name, status } and nothing else, so
//      approving a website sign-up erased the partner's company, email,
//      phone, type, refer method and notes. Email is what portal access
//      requires, so the partner then could not be invited and the screen
//      gave no reason.
//
//      An absent key means "I was not editing that". An empty string or an
//      explicit null means "I deleted it". Only the second clears.
//
//   2. STATUS DOES NOT DEFAULT ON AN EDIT. `status ?? 'active'` ran on
//      updates too, so editing a note reactivated a partner who had been
//      set inactive -- reopening portal access and every live session with
//      it. A new partner still defaults to active; an existing one keeps
//      whatever it has unless the caller says otherwise.
//
// The allowlist is the third rule and was never broken, only implicit:
// this body is staff-supplied JSON, and the columns that price money
// (signup_bonus_amount, the bonus bars) or record a signature
// (agreement_status, agreement_signed_at, w9_received_at) are written by
// the DocuSign webhook and by hand in the database, never by this form.

import { taxStatusOf } from './partner-tax-status'

/** Columns this route may write, each of which may also be cleared. */
const NULLABLE = [
  'company',
  'email',
  'phone',
  'partner_type',
  'refer_method',
  'notes',
  'tax_status',
] as const

export type PartnerWriteResult =
  | { fields: Record<string, unknown> }
  | { error: string }

/**
 * The column/value pairs to write, or the reason we refuse.
 *
 * Refusing rather than silently dropping a bad value is deliberate for
 * tax_status: a typo that wrote an unrecognised string would read back
 * through taxStatusOf() as UNSET, which blocks the partner's W-9 screen
 * with no trace of why -- the partner waits and nobody knows he is waiting.
 */
export function partnerWriteFields(body: Record<string, unknown>): PartnerWriteResult {
  const fields: Record<string, unknown> = { updated_at: new Date().toISOString() }
  const creating = !body.id

  if ('name' in body) {
    const name = body.name
    if (typeof name !== 'string' || !name.trim()) {
      return { error: 'Partner name is required.' }
    }
    fields.name = name
  } else if (creating) {
    return { error: 'Partner name is required.' }
  }

  if ('status' in body && typeof body.status === 'string' && body.status.trim()) {
    fields.status = body.status
  } else if (creating) {
    fields.status = 'active'
  }

  for (const key of NULLABLE) {
    if (!(key in body)) continue
    const raw = body[key]

    // '' and null are both "clear it": an empty text input and an
    // unselected dropdown are the same decision from a staff member.
    if (raw === null || raw === '') {
      fields[key] = null
      continue
    }

    if (key === 'tax_status') {
      if (typeof raw !== 'string' || taxStatusOf(raw) === null) {
        return {
          error:
            'Unrecognised tax status. Choose US person, foreign individual or foreign entity, or leave it unrecorded.',
        }
      }
      fields[key] = raw
      continue
    }

    if (typeof raw !== 'string') {
      return { error: `Expected text for ${key}.` }
    }
    fields[key] = raw
  }

  return { fields }
}
