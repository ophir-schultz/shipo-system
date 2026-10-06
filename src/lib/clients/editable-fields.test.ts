import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseClientPatch, parseNewClient } from './editable-fields'

// The subject is what a client write is ALLOWED to say, so most of these are
// refusals. The two that matter most in production are the first group (a
// money column cannot be reached through this endpoint) and the blank-name
// pair (the confirmed 2026-10-05 defect: PATCH {"name": ""} wrote '').

/**
 * The error message, or a loud marker if the parse unexpectedly succeeded.
 *
 * The marker deliberately does NOT echo the accepted field names. It used to
 * return `UNEXPECTEDLY ACCEPTED: ${JSON.stringify(result.fields)}`, and a
 * mutation proved that defeats the assertion it is used in: with CREATABLE
 * widened to EDITABLE, `parseNewClient({name: 'Acme', origin_zip: '07001'})`
 * succeeds, and the JSON of what it accepted CONTAINS 'origin_zip' -- so
 * `expect(refusal(...)).toContain('origin_zip')` passed on the mutant. The
 * count is as much diagnosis as can be given without the assertion being able
 * to match the diagnostic.
 */
function refusal(result: ReturnType<typeof parseClientPatch>): string {
  return result.ok
    ? `UNEXPECTEDLY ACCEPTED: wrote ${Object.keys(result.fields).length} field(s)`
    : result.error
}

/** The fields, or a loud marker if the parse unexpectedly failed. */
function accepted(result: ReturnType<typeof parseClientPatch>): unknown {
  return result.ok ? result.fields : `UNEXPECTEDLY REFUSED: ${result.error}`
}

describe('parseClientPatch — columns off limits', () => {
  // Every one of these is a column that exists on `clients` and that the old
  // `update(await req.json())` would have written. They are listed
  // individually rather than in one body so that a partial allowlist cannot
  // pass on the strength of its neighbours.
  const forbidden: Array<[string, unknown]> = [
    ['founding_bonus_seq', 3],
    ['referral_partner_id', '00000000-0000-0000-0000-000000000001'],
    ['referral_signup_date', '2026-01-01'],
    ['referral_first_payment_date', '2026-01-01'],
    ['acquisition_campaign_id', '00000000-0000-0000-0000-000000000002'],
    ['acquisition_date', '2026-01-01'],
    ['active', false],
    ['id', '00000000-0000-0000-0000-000000000003'],
    ['created_at', '1999-01-01'],
  ]

  for (const [column, value] of forbidden) {
    it(`refuses ${column}`, () => {
      const result = parseClientPatch({ [column]: value })
      expect(result.ok).toBe(false)
      // Names the column, so an operator who hits this learns which key was
      // the problem rather than that "something" was rejected.
      expect(refusal(result)).toContain(column)
    })
  }

  it('refuses the whole body when one key among valid ones is not editable', () => {
    // The hazard a per-key loop invites: write the fields you recognise and
    // ignore the rest, which would report success for a request that asked to
    // move the founding bonus.
    const result = parseClientPatch({ origin_zip: '07001', founding_bonus_seq: 4 })
    expect(result.ok).toBe(false)
    expect(refusal(result)).toContain('founding_bonus_seq')
  })

  it('lists the allowed columns in the refusal', () => {
    expect(refusal(parseClientPatch({ nope: 'x' }))).toContain('origin_zip')
  })
})

describe('parseClientPatch — inherited property names are not an allowlist entry', () => {
  // `k in allowed` answers true for all three of these, because `in` walks the
  // prototype chain. JSON.parse('{"__proto__": "x"}') produces an own key of
  // that name, so this is reachable from a request body, and `allowed.toString`
  // is a function whose .nullable and .check are both undefined -- so the
  // value passed every subsequent check. Object.hasOwn is the fix.
  for (const key of ['__proto__', 'toString', 'constructor', 'hasOwnProperty']) {
    it(`refuses ${key}`, () => {
      const result = parseClientPatch(JSON.parse(`{"${key}": "x"}`))
      expect(result.ok).toBe(false)
    })
  }

  it('refuses __proto__ even when it arrives beside a legitimate field', () => {
    const result = parseClientPatch(JSON.parse('{"origin_zip": "07001", "__proto__": "x"}'))
    expect(result.ok).toBe(false)
  })
})

describe('parseClientPatch — name', () => {
  it('refuses the empty string', () => {
    // The 2026-10-05 measurement. `name text not null` does not stop '':
    // NOT NULL permits it.
    expect(refusal(parseClientPatch({ name: '' }))).toContain('must not be blank')
  })

  it('refuses whitespace only', () => {
    // ' ' is truthy, so it cleared the POST route's `if (!name)` guard, and
    // HTML `required` accepts a single space.
    expect(refusal(parseClientPatch({ name: '   ' }))).toContain('must not be blank')
  })

  it('refuses a tab-and-newline-only name', () => {
    expect(refusal(parseClientPatch({ name: '\t\n ' }))).toContain('must not be blank')
  })

  it('refuses null', () => {
    expect(refusal(parseClientPatch({ name: null }))).toContain('must not be blank')
  })

  it('refuses a non-string, rather than coercing it', () => {
    // {"name": []} clears a `!name` guard and String([]) is '', so a coercing
    // implementation stores the empty name this module exists to prevent.
    expect(refusal(parseClientPatch({ name: [] }))).toContain('must be a string')
    expect(refusal(parseClientPatch({ name: 0 }))).toContain('must be a string')
    expect(refusal(parseClientPatch({ name: {} }))).toContain('must be a string')
    expect(refusal(parseClientPatch({ name: false }))).toContain('must be a string')
  })

  it('trims a surrounding-whitespace name', () => {
    // ' Acme' rendered a blank avatar on /clients for a perfectly good client.
    expect(accepted(parseClientPatch({ name: '  Acme Corp  ' }))).toEqual({ name: 'Acme Corp' })
  })

  it('keeps interior whitespace', () => {
    expect(accepted(parseClientPatch({ name: 'Acme  Corp' }))).toEqual({ name: 'Acme  Corp' })
  })
})

describe('parseClientPatch — nullable text columns', () => {
  it('clears a blank credential to null rather than writing the empty string', () => {
    // Load-bearing, and in the opposite direction from name. Saving the
    // Zenventory form with a field left empty wrote '', and '' is not null, so
    // syncClientAssignments' `.not('zenventory_api_key', 'is', null)` filter
    // kept selecting that client and authenticating with an empty key -- it
    // failed every scheduled run. null takes it out of the sync instead.
    expect(accepted(parseClientPatch({ zenventory_api_key: '' })))
      .toEqual({ zenventory_api_key: null })
  })

  it('clears blank email and phone to null', () => {
    expect(accepted(parseClientPatch({ email: '', phone: '  ' })))
      .toEqual({ email: null, phone: null })
  })

  it('accepts an explicit null as a request to clear', () => {
    expect(accepted(parseClientPatch({ zenventory_secure_key: null })))
      .toEqual({ zenventory_secure_key: null })
  })

  it('trims a pasted credential', () => {
    // A key copied out of a web console arrives with a trailing newline, and
    // that is a classic cause of an auth failure nobody can explain.
    expect(accepted(parseClientPatch({ zenventory_api_secret: '  sk-abc123\n' })))
      .toEqual({ zenventory_api_secret: 'sk-abc123' })
  })

  it('refuses a non-string credential', () => {
    expect(refusal(parseClientPatch({ zenventory_api_key: 12345 }))).toContain('must be a string')
  })

  it('does not echo the credential value in a refusal', () => {
    // The error goes to the client and into logs.
    const result = parseClientPatch({ zenventory_api_key: 12345, bogus: 1 })
    expect(refusal(result)).not.toContain('12345')
  })

  it('accepts all three zenventory fields together, as the editor sends them', () => {
    expect(accepted(parseClientPatch({
      zenventory_api_key: 'k',
      zenventory_api_secret: 's',
      zenventory_secure_key: 'sk',
    }))).toEqual({
      zenventory_api_key: 'k',
      zenventory_api_secret: 's',
      zenventory_secure_key: 'sk',
    })
  })
})

describe('parseClientPatch — origin_zip', () => {
  it('accepts a five-digit ZIP', () => {
    expect(accepted(parseClientPatch({ origin_zip: '07001' }))).toEqual({ origin_zip: '07001' })
  })

  it('accepts ZIP+4 without a dash, which the editor can produce', () => {
    expect(accepted(parseClientPatch({ origin_zip: '070011234' })))
      .toEqual({ origin_zip: '070011234' })
  })

  it('trims before validating', () => {
    expect(accepted(parseClientPatch({ origin_zip: ' 07001 ' }))).toEqual({ origin_zip: '07001' })
  })

  it('refuses a ZIP with letters in it', () => {
    // Every reader does `.replace(/\D/g, '').slice(0, 3)`, which does not
    // refuse this -- it silently prices the client against origin prefix 123.
    expect(refusal(parseClientPatch({ origin_zip: 'ABC12345' }))).toContain('5 to 10 digits')
  })

  it('refuses a dashed ZIP+4, because the readers would strip the dash silently', () => {
    expect(refusal(parseClientPatch({ origin_zip: '07001-1234' }))).toContain('5 to 10 digits')
  })

  it('refuses too few digits', () => {
    // Fewer than three digits leaves the prefix short and the zone lookup
    // cannot match; four is what a mistyped ZIP looks like.
    expect(refusal(parseClientPatch({ origin_zip: '1234' }))).toContain('5 to 10 digits')
    expect(refusal(parseClientPatch({ origin_zip: '12' }))).toContain('5 to 10 digits')
  })

  it('refuses too many digits', () => {
    expect(refusal(parseClientPatch({ origin_zip: '12345678901' }))).toContain('5 to 10 digits')
  })

  it('clears a blank ZIP to null', () => {
    expect(accepted(parseClientPatch({ origin_zip: '' }))).toEqual({ origin_zip: null })
  })
})

describe('parseClientPatch — body shape', () => {
  it('refuses an empty object', () => {
    // `.update({})` is a statement that asks for nothing. Answering 200 to it
    // would report a save that did not happen.
    expect(refusal(parseClientPatch({}))).toContain('No editable fields')
  })

  it('refuses a JSON array', () => {
    expect(refusal(parseClientPatch(['name', 'x']))).toContain('JSON object')
  })

  it('refuses null', () => {
    expect(refusal(parseClientPatch(null))).toContain('JSON object')
  })

  it('refuses a bare string or number', () => {
    expect(refusal(parseClientPatch('name=x'))).toContain('JSON object')
    expect(refusal(parseClientPatch(7))).toContain('JSON object')
  })
})

// ---------------------------------------------------------------------------
// The blank-name rule exists twice -- here in TypeScript, and as a check
// constraint in supabase/clients_name_not_blank.sql -- because the database
// has writers that do not come through this module: a statement typed into
// the Supabase SQL editor, a Supabase table-editor cell edit, or a future
// route that forgets the allowlist.
//
// This asserts the two agree. What it CANNOT do is say whether the constraint
// is in the live database: there is no psql on this machine and the file is
// applied by pasting it into the Supabase web SQL editor, so the database side
// is UNKNOWN until supabase/verify/clients_name_not_blank_verify.sql has been
// run. This test is about the FILE.
// ---------------------------------------------------------------------------
describe('clients.name against the database check constraint', () => {
  // Read, not paraphrased into a TS constant -- a third copy would pass while
  // the file it claims to describe said something else.
  const sql = readFileSync('supabase/clients_name_not_blank.sql', 'utf8')

  /** The predicate inside `check (...)`, as the migration writes it. */
  function predicate(): string {
    const m = sql.match(
      /add\s+constraint\s+clients_name_not_blank\s+check\s*\(([^)]*)\)/i)
    if (!m) throw new Error(
      'clients_name_not_blank not found in supabase/clients_name_not_blank.sql. '
      + 'If the constraint was renamed, update this test; if it was REMOVED, that '
      + 'is the thing this test exists to report.')
    return m[1].trim()
  }

  it('finds the constraint, so the assertions below are about something', () => {
    // Guards the test itself: a regex that matched nothing would return '' and
    // the toContain below would be the "assertion that passes because it
    // matched nothing" failure the verify scripts in this repo warn about.
    expect(predicate().length).toBeGreaterThan(0)
  })

  it('tests for a non-whitespace character rather than using btrim', () => {
    // btrim's default trim set is a SPACE, not whitespace, so
    // `length(btrim(name)) > 0` admits a tab-only name -- which .trim() and
    // therefore this module refuse. The two layers would disagree on exactly
    // the input a person is least likely to try by hand.
    expect(predicate()).toContain('[^[:space:]]')
    expect(predicate()).not.toContain('btrim')
  })

  it('refuses in TypeScript every shape the SQL positive control submits', () => {
    // The four values in step 2 of
    // supabase/verify/clients_name_not_blank_verify.sql. If a shape is added
    // there it should be added here, and vice versa: the point of two layers
    // is that they cover the same set.
    for (const blank of ['', ' ', '\t', '\n  \t']) {
      expect(parseClientPatch({ name: blank }).ok).toBe(false)
      expect(parseNewClient({ name: blank }).ok).toBe(false)
    }
  })

  it('accepts in TypeScript the name the SQL negative control inserts', () => {
    // Guards against the mirror-image failure: a rule that refuses blanks by
    // refusing everything.
    expect(parseNewClient({ name: 'Verify Co' }).ok).toBe(true)
  })
})

describe('parseNewClient', () => {
  it('accepts the form the new-client page submits', () => {
    expect(accepted(parseNewClient({ name: 'Acme', email: 'a@b.co', phone: '+1 555' })))
      .toEqual({ name: 'Acme', email: 'a@b.co', phone: '+1 555' })
  })

  it('requires name to be present', () => {
    expect(refusal(parseNewClient({ email: 'a@b.co' }))).toContain('name is required')
  })

  it('refuses a whitespace-only name', () => {
    // The whole point of the POST half: `if (!name)` let ' ' through and the
    // client was created with an invisible name.
    expect(refusal(parseNewClient({ name: ' ' }))).toContain('must not be blank')
  })

  it('refuses an empty name', () => {
    expect(refusal(parseNewClient({ name: '' }))).toContain('must not be blank')
  })

  it('trims the name it stores', () => {
    expect(accepted(parseNewClient({ name: ' Acme ' }))).toEqual({ name: 'Acme' })
  })

  it('stores blank email and phone as null, not as the empty string', () => {
    expect(accepted(parseNewClient({ name: 'Acme', email: '', phone: '' })))
      .toEqual({ name: 'Acme', email: null, phone: null })
  })

  it('omits email and phone entirely when the caller does not send them', () => {
    expect(accepted(parseNewClient({ name: 'Acme' }))).toEqual({ name: 'Acme' })
  })

  it('refuses a column that is editable later but not settable at creation', () => {
    // origin_zip and the credentials have their own screens on the client
    // detail page. Creation is identity only, so the create allowlist is
    // narrower than the edit one -- and this asserts they are not the same
    // object by accident.
    expect(refusal(parseNewClient({ name: 'Acme', origin_zip: '07001' })))
      .toContain('origin_zip')
    expect(refusal(parseNewClient({ name: 'Acme', zenventory_api_key: 'k' })))
      .toContain('zenventory_api_key')
  })

  it('refuses a money column at creation too', () => {
    expect(refusal(parseNewClient({ name: 'Acme', founding_bonus_seq: 1 })))
      .toContain('founding_bonus_seq')
  })
})
