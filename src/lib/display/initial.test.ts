import { describe, it, expect } from 'vitest'
import { nameInitial, NO_INITIAL } from '@/lib/display/initial'

// The defect being pinned: `client.name[0].toUpperCase()` on
// src/app/clients/page.tsx, where name = '' throws a TypeError out of a server
// component and costs the operator the entire /clients page -- not one avatar.
//
// Every case below is chosen so that reverting some specific part of the fix
// makes it fail. Reverting to the inline expression fails the first two;
// dropping the trim fails the ' Acme' case; dropping the typeof check fails
// the non-string cases; dropping Array.from fails the astral case.

describe('nameInitial', () => {
  it('returns the uppercase first letter of a normal name', () => {
    expect(nameInitial('acme')).toBe('A')
    expect(nameInitial('Acme Corp')).toBe('A')
  })

  it('does not throw on the empty string', () => {
    // This is the whole point. `name[0]` is undefined and `.toUpperCase()` on
    // undefined is a TypeError; in a server component that is the page, not
    // the avatar. NOT NULL on clients.name does not exclude '' -- and PATCH
    // /api/clients/[id] writes the request body through unvalidated.
    expect(() => nameInitial('')).not.toThrow()
    expect(nameInitial('')).toBe(NO_INITIAL)
  })

  it('returns the placeholder for a whitespace-only name, not an invisible space', () => {
    // ' ' never threw -- it rendered one blank character, so a nameless client
    // looked like a rendering glitch rather than bad data. `!name` is false for
    // ' ', so the add-client POST route lets it through untrimmed.
    expect(nameInitial(' ')).toBe(NO_INITIAL)
    expect(nameInitial('   ')).toBe(NO_INITIAL)
    expect(nameInitial('\t\n')).toBe(NO_INITIAL)
  })

  it('ignores leading whitespace on an otherwise good name', () => {
    // ' Acme' used to render a blank avatar for a real client.
    expect(nameInitial(' Acme')).toBe('A')
    expect(nameInitial('\t acme  ')).toBe('A')
  })

  it('returns the placeholder for values that are not strings at all', () => {
    // Callers read PostgREST rows typed `any`, so nothing upstream proves this
    // is a string. [] and {} are truthy, so they clear the POST route's
    // `if (!name)` guard too.
    expect(nameInitial(null)).toBe(NO_INITIAL)
    expect(nameInitial(undefined)).toBe(NO_INITIAL)
    expect(nameInitial(0)).toBe(NO_INITIAL)
    expect(nameInitial(false)).toBe(NO_INITIAL)
    expect(nameInitial([])).toBe(NO_INITIAL)
    expect(nameInitial({})).toBe(NO_INITIAL)
  })

  it('takes the first code point, not the first UTF-16 unit', () => {
    // '\u{1D49C}cme'[0] is a lone high surrogate, which renders as the
    // replacement glyph. Distinguishes Array.from(s)[0] from s[0].
    expect(nameInitial('\u{1D49C}cme')).toBe('\u{1D49C}')
    expect(nameInitial('\u{1F3ED} Acme')).toBe('\u{1F3ED}')
  })

  it('always yields something visible, for every input the row could hold', () => {
    // The property the page actually depends on: one non-blank character, and
    // never a throw. Asserted over the inputs together so that a future
    // placeholder change cannot quietly reintroduce a blank avatar.
    const inputs: unknown[] = [
      '', ' ', '\t', 'acme', ' Acme', '\u{1F3ED}', null, undefined, 0, false, [], {}, NaN,
    ]
    for (const input of inputs) {
      const initial = nameInitial(input)
      expect(initial.length).toBeGreaterThan(0)
      expect(initial.trim()).not.toBe('')
    }
  })

  it('has a placeholder that is a visible glyph', () => {
    // Tested directly: a constant with no test of its own is exactly the kind
    // of thing that survives being changed to '' or ' '.
    expect(NO_INITIAL).toBe('?')
    expect(NO_INITIAL.trim()).not.toBe('')
  })
})
