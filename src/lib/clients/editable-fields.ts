// What a client write is allowed to say.
//
// PATCH /api/clients/[id] used to be `update(await req.json())` -- the parsed
// body, whole, with no allowlist and no per-field check. requireStaff() gates
// it, so this was never an anonymous hole, but every column on `clients` was
// writable to any value by any staff-authenticated request, including columns
// no UI edits and some that are not editable data at all:
//
//   - founding_bonus_seq carries a partial UNIQUE index
//     (clients_founding_bonus_seq_uniq). Two clients cannot hold seq 3, and
//     the launch offer is capped at ten.
//   - referral_partner_id, referral_signup_date, referral_first_payment_date
//     drive the referral payout. referral_first_payment_date is the trigger
//     for the $300 signup bonus.
//   - acquisition_campaign_id, acquisition_date attribute spend on /pnl.
//
// Those are set by SQL, deliberately, one client at a time. A typo in a PATCH
// body should not be able to move money, so this module names the columns the
// endpoint actually serves and rejects everything else.
//
// The confirmed consequence of the old shape, measured 2026-10-05:
// `PATCH {"name": ""}` wrote an empty string, because `name text not null`
// permits '' and no check constraint existed. That empty name used to take
// out the whole /clients server-component render; 00dd53e made the avatar
// initial total (src/lib/display/initial.ts) so the page now survives it.
// This module is the other half -- the page no longer crashes AND the row can
// no longer be written. supabase/clients_name_not_blank.sql is the third,
// in the database, for writers that never pass through here.

/**
 * One allowlisted column.
 *
 * `nullable` is about what the caller may ask for, and it decides what a blank
 * string means. On a nullable column '' means "clear this", so it becomes
 * null; on `name` there is nothing to clear it to, so '' is a rejection.
 */
interface Field {
  nullable: boolean
  /** Returns an error message, or null when the trimmed value is acceptable. */
  check?: (value: string) => string | null
}

/**
 * Must be digits, 5 to 10 of them.
 *
 * Not cosmetic: every reader of origin_zip derives the zone-chart lookup key
 * as `String(origin_zip ?? '').replace(/\D/g, '').slice(0, 3)` -- see
 * api/clients/[id]/zone-chart/route.ts and lib/billing/recalculate.ts. That
 * strips junk rather than refusing it, so 'ABC12345' silently becomes prefix
 * '123' and the shipment is priced against the wrong origin. The range is the
 * one the editor itself can produce (OriginZipEditor strips non-digits and
 * requires at least five, capped at ten), so this refuses nothing a person
 * can type into the field.
 */
function zipDigits(value: string): string | null {
  return /^\d{5,10}$/.test(value) ? null : 'origin_zip must be 5 to 10 digits'
}

/**
 * The columns PATCH /api/clients/[id] may write.
 *
 * Derived from the live callers, not from the table: OriginZipEditor sends
 * origin_zip, ZenventoryCredentials sends the three zenventory_* fields, and
 * name/email/phone are the identity fields POST already accepts -- a client
 * that can be created with a name should be renameable without a hand-written
 * SQL statement.
 *
 * `active` is deliberately absent. Nothing in the app toggles it today, and
 * `.eq('active', true)` is what decides whether a client is synced at all
 * (lib/sync/zenventory.ts), so adding it here would be adding a switch for
 * the sync with no screen asking for it.
 *
 * zenventory_api_key and zenventory_api_secret ARE allowlisted even though no
 * file under supabase/ adds them: the live table has them -- ZenventoryCredentials
 * writes them and syncClientAssignments selects and filters on them in
 * production -- so they were added through the SQL editor without a committed
 * migration. supabase/ is therefore not a complete record of this table, and
 * an allowlist built only from it would have broken credential saving.
 */
const EDITABLE: Record<string, Field> = {
  name: { nullable: false },
  email: { nullable: true },
  phone: { nullable: true },
  origin_zip: { nullable: true, check: zipDigits },
  zenventory_api_key: { nullable: true },
  zenventory_api_secret: { nullable: true },
  zenventory_secure_key: { nullable: true },
}

/** The columns POST /api/clients may write. A new client is identity only. */
const CREATABLE: Record<string, Field> = {
  name: EDITABLE.name,
  email: EDITABLE.email,
  phone: EDITABLE.phone,
}

export type ClientFields = Record<string, string | null>

export type ParsedFields =
  | { ok: true; fields: ClientFields }
  | { ok: false; error: string }

/**
 * Trim, and read '' as a request to clear the column.
 *
 * Trimming is not tidiness. ' ' already passes the POST route's `if (!name)`
 * guard and the form's HTML `required`, which is how a whitespace-only client
 * name can exist. And on the credentials it is load-bearing in the other
 * direction: saving the Zenventory form with a field left empty wrote '', and
 * '' is NOT null, so syncClientAssignments' `.not('zenventory_api_key', 'is',
 * null)` filter kept selecting that client and authenticating with an empty
 * key -- a client that fails every scheduled run for ever. Clearing to null
 * takes it out of the sync instead.
 */
function clean(key: string, raw: unknown, field: Field): { value: string | null } | { error: string } {
  if (raw === null) {
    if (field.nullable) return { value: null }
    return { error: `${key} must not be blank` }
  }
  // Not `String(raw)`: the callers read PostgREST rows typed `any` and a JSON
  // body is arbitrary, so {"name": []} and {"name": 0} both arrive here.
  // Coercing them would store '' and '0' as names.
  if (typeof raw !== 'string') return { error: `${key} must be a string` }

  const trimmed = raw.trim()
  if (trimmed === '') {
    if (field.nullable) return { value: null }
    return { error: `${key} must not be blank` }
  }

  const failed = field.check?.(trimmed)
  if (failed) return { error: failed }
  return { value: trimmed }
}

function parse(body: unknown, allowed: Record<string, Field>, required: string[]): ParsedFields {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: 'Body must be a JSON object.' }
  }

  const keys = Object.keys(body)

  // Reject rather than drop. A caller that sends founding_bonus_seq is wrong
  // about this endpoint, and silently succeeding while writing nothing is the
  // worse answer -- it reports that the money field was saved.
  //
  // Object.hasOwn and NOT `k in allowed`. `in` walks the prototype chain, so
  // it answers true for '__proto__', 'toString' and 'constructor' -- and
  // JSON.parse('{"__proto__": "x"}') really does produce an own key of that
  // name. With `in` those three names cleared the allowlist, and
  // `allowed['toString']` then handed clean() a FUNCTION as its field spec:
  // `.nullable` undefined, `.check` undefined, so the value sailed through
  // into the patch. Measured first-hand before this line was written.
  const unknown = keys.filter((k) => !Object.hasOwn(allowed, k))
  if (unknown.length > 0) {
    return {
      ok: false,
      error:
        `Not editable here: ${[...unknown].sort().join(', ')}. `
        + `Allowed: ${Object.keys(allowed).sort().join(', ')}.`,
    }
  }

  for (const key of required) {
    if (!keys.includes(key)) return { ok: false, error: `${key} is required` }
  }

  const fields: ClientFields = {}
  // Iterate the allowlist, not the body, so the written column order does not
  // depend on the caller's key order.
  for (const key of Object.keys(allowed)) {
    if (!keys.includes(key)) continue
    const result = clean(key, (body as Record<string, unknown>)[key], allowed[key])
    if ('error' in result) return { ok: false, error: result.error }
    fields[key] = result.value
  }

  if (Object.keys(fields).length === 0) {
    return { ok: false, error: 'No editable fields in the request body.' }
  }

  return { ok: true, fields }
}

/** The patch PATCH /api/clients/[id] should apply, or the reason it should 400. */
export function parseClientPatch(body: unknown): ParsedFields {
  return parse(body, EDITABLE, [])
}

/** The row POST /api/clients should insert, or the reason it should 400. */
export function parseNewClient(body: unknown): ParsedFields {
  return parse(body, CREATABLE, ['name'])
}
