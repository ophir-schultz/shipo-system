// The avatar initial on the client list, as a total function.
//
// The shape this replaces is `client.name[0].toUpperCase()`, inlined in
// src/app/clients/page.tsx. It is partial in two directions and both of them
// are reachable:
//
//   - name === ''        -> name[0] is undefined, .toUpperCase() throws
//     TypeError. /clients is a server component, so the throw is not a broken
//     avatar in one row -- it takes out the whole render and the operator gets
//     an error boundary instead of their client list. Nothing on the screen
//     names the row that caused it. `name text not null` in schema.sql does
//     NOT stop this: NOT NULL permits the empty string.
//
//   - name === ' '       -> no throw, but the avatar renders one invisible
//     space, and the name is stored untrimmed.
//
// CORRECTION, recorded rather than quietly edited. Those two notes used to end
// "and PATCH /api/clients/[id] passes the request body straight into .update()
// with no validation at all" and "the POST guard is `if (!name)`, and ' ' is
// truthy, so a whitespace-only name survives the form (HTML `required` accepts
// a space)". Both described the API as it was, and both are now out of date:
// src/lib/clients/editable-fields.ts gives each route an allowlist that trims
// and refuses a blank name. supabase/clients_name_not_blank.sql adds the same
// rule as a check constraint -- status UNKNOWN until that file is applied and
// supabase/verify/clients_name_not_blank_verify.sql confirms it.
//
// This function is still load-bearing for two reasons. A row written BEFORE
// those layers existed can still be in the table, and /clients has to render
// it rather than die on it. And the constraint is added NOT VALID on purpose,
// so the database tolerates such a row by design.
//
// Trimming before taking the first character also fixes ' Acme', which today
// renders a blank avatar for a perfectly good client.
//
// This lives in a plain .ts rather than beside the markup because
// vitest.config.ts includes only `src/**/*.test.ts` -- logic inside a .tsx
// cannot be given a test at all in this repo.

/**
 * Shown when a name cannot yield an initial.
 *
 * Deliberately a visible glyph and not '' or a space: the reason this function
 * exists is that a bad name was invisible on the screen, and a blank avatar
 * would keep it that way.
 */
export const NO_INITIAL = '?'

/**
 * The uppercase first character of a name, or NO_INITIAL.
 *
 * `unknown` rather than `string` because the callers read PostgREST rows typed
 * `any`, so the compiler is not actually checking that this is a string -- a
 * JSON body of `{"name": []}` also clears the POST route's `!name` guard.
 *
 * Takes the first code POINT, not the first UTF-16 unit: '𝒜cme'[0] is a lone
 * high surrogate, which renders as a replacement glyph.
 */
export function nameInitial(name: unknown): string {
  if (typeof name !== 'string') return NO_INITIAL
  const trimmed = name.trim()
  // Guards the index below -- after this, position 0 is guaranteed to exist.
  if (trimmed === '') return NO_INITIAL
  return Array.from(trimmed)[0].toUpperCase()
}
