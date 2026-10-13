import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { redactForStorage } from './docusign-redact'

/** What Connect sends when nobody has ticked a box they should not have. */
const plain = {
  event: 'envelope-completed',
  data: {
    envelopeId: 'c0ffee00-1111-2222-3333-444455556666',
    envelopeSummary: {
      status: 'completed',
      sentDateTime: '2026-10-13T09:41:38.000Z',
      customFields: {
        textCustomFields: [
          { name: 'partner_id', value: 'a1b2c3d4-5566-7788-99aa-bbccddeeff00' },
          { name: 'w9', value: 'included' },
        ],
      },
      recipients: {
        signers: [{ email: 'dana@example.com', name: 'Dana Katz' }],
      },
    },
  },
}

function json(value: unknown): string {
  return JSON.stringify(value)
}

describe('redactForStorage', () => {
  it('keeps everything the webhook actually reads', () => {
    // The controls. A redactor that returned {} would satisfy every
    // assertion in the next block and destroy the replay log, so what the
    // payload must still CONTAIN is asserted first and in more detail than
    // what it must not.
    const out = redactForStorage(plain) as typeof plain
    expect(out.event).toBe('envelope-completed')
    expect(out.data.envelopeId).toBe('c0ffee00-1111-2222-3333-444455556666')
    expect(out.data.envelopeSummary.status).toBe('completed')
    expect(out.data.envelopeSummary.sentDateTime).toBe('2026-10-13T09:41:38.000Z')
    expect(out.data.envelopeSummary.customFields.textCustomFields).toEqual([
      { name: 'partner_id', value: 'a1b2c3d4-5566-7788-99aa-bbccddeeff00' },
      { name: 'w9', value: 'included' },
    ])
    expect(out.data.envelopeSummary.recipients.signers[0].email).toBe('dana@example.com')
  })

  it('leaves a clean payload byte-identical', () => {
    // Stronger than the field-by-field check above: nothing is dropped,
    // reordered or stringified on the common path.
    expect(json(redactForStorage(plain))).toEqual(json(plain))
  })

  it('does not mutate what it was given', () => {
    // The webhook resolves the partner from the ORIGINAL payload and
    // verifies the HMAC over the original bytes. A redactor that edited in
    // place would be a redactor that changed the evidence.
    const before = json(plain)
    redactForStorage({ ...plain, ssn: '123-45-6789' })
    expect(json(plain)).toEqual(before)
  })

  it('redacts an SSN wherever it appears', () => {
    expect(json(redactForStorage({ ssn: '123-45-6789' }))).not.toContain('123-45-6789')
    expect(json(redactForStorage({ deep: { deeper: ['123-45-6789'] } }))).not.toContain(
      '123-45-6789',
    )
    // Under an innocent key, too. The key name is not the evidence.
    expect(json(redactForStorage({ notes: 'tin 123-45-6789 ok' }))).not.toContain('123-45-6789')
  })

  it('redacts an EIN and an unseparated nine-digit run', () => {
    expect(json(redactForStorage({ ein: '12-3456789' }))).not.toContain('12-3456789')
    expect(json(redactForStorage({ tin: '123456789' }))).not.toContain('123456789')
  })

  it('keeps the rest of the sentence around a redacted number', () => {
    // Declined reasons are free text a partner wrote. Losing the whole
    // sentence because it contained a number would cost us the only
    // explanation we get.
    const out = redactForStorage({ declinedReason: 'wrong ein 12-3456789, resend please' })
    expect(json(out)).toContain('resend please')
    expect(json(out)).not.toContain('12-3456789')
  })

  it('drops the signed document rather than storing a W-9 image', () => {
    const out = json(
      redactForStorage({
        documents: [{ documentId: '1', documentBase64: 'JVBERi0xLjcKJUlNQUdF' }],
      }),
    )
    expect(out).not.toContain('JVBERi0xLjcK')
    expect(out).toContain('dropped')
  })

  it('drops typed field values, which on a W-9 are the TIN', () => {
    for (const key of ['tabs', 'formData', 'documentFields', 'tabData']) {
      const out = json(redactForStorage({ [key]: [{ name: 'f1_11', value: '123-45-6789' }] }))
      expect(out).not.toContain('123-45-6789')
      expect(out).not.toContain('f1_11')
    }
  })

  it('throws away a long string even under a key it does not know', () => {
    // The catch-all, and the only protection against a payload shape we
    // have not seen. A base64 PDF arriving as `envelopeDocument` or
    // `pdfContent` is caught on size alone.
    const blob = 'A'.repeat(5000)
    const out = json(redactForStorage({ somethingNew: blob }))
    expect(out).not.toContain('AAAAAAAAAA')
    expect(out).toContain('omitted: 5000 chars')
  })

  it('records that something was refused instead of hiding it', () => {
    // An absent key reads as "DocuSign did not send it". That is a
    // different fact from "DocuSign sent it and we refused", and only the
    // second one means a checkbox needs un-ticking.
    const out = redactForStorage({ documents: ['x'] }) as Record<string, string>
    expect(out.documents).toMatch(/dropped/i)
    expect(Object.keys(out)).toContain('documents')
  })

  it('survives a hostile shape without throwing', () => {
    expect(() => redactForStorage(null)).not.toThrow()
    expect(() => redactForStorage(undefined)).not.toThrow()
    expect(() => redactForStorage(42)).not.toThrow()
    expect(() => redactForStorage('123-45-6789')).not.toThrow()
    expect(redactForStorage('123-45-6789')).toBe('[redacted]')
    // Deep nesting is bounded rather than recursing until the stack goes.
    let nested: unknown = 'bottom'
    for (let i = 0; i < 200; i++) nested = { next: nested }
    expect(() => redactForStorage(nested)).not.toThrow()
  })
})

describe('the webhook actually redacts before it writes', () => {
  // The module above is only worth having if the insert uses it. A correct
  // redactor nobody calls stores the SSN and stays green forever.
  //
  // Imports are stripped before the call check, for a reason that was
  // measured elsewhere in this repo: a check that only required the source
  // to CONTAIN the function name was satisfied by the import line, so it
  // tested a mention where it needed to test a use.
  function body(src: string): string {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*)/.test(line))
      .filter((line) => !/^\s*import\b/.test(line))
      .join('\n')
  }

  const src = body(readFileSync('src/app/api/partner/agreement-webhook/route.ts', 'utf8'))

  it('the stripper drops imports and prose but keeps calls', () => {
    expect(body('  payload: redactForStorage(p)\n')).toContain('redactForStorage(')
    expect(body("import { redactForStorage } from '@/lib/docusign-redact'\n")).not.toContain(
      'redactForStorage',
    )
    expect(body('  // redactForStorage explains itself\n')).not.toContain('redactForStorage')
  })

  it('calls it', () => {
    expect(src).toContain('redactForStorage(')
  })

  // Every `payload:` in the file is NOT the thing to check — the first
  // version of this test did that and failed on `let payload:
  // ConnectPayload`, a type annotation. The invariant is about what gets
  // WRITTEN, so the search is scoped to the bodies of .insert({...}).
  function insertBodies(source: string): string[] {
    return [...source.matchAll(/\.insert\(\{([\s\S]*?)\n\s*\}\)/g)].map((m) => m[1])
  }

  it('the insert scraper finds the insert', () => {
    // A scraper that matches nothing passes the next test by examining
    // nothing, so it is measured here instead of trusted.
    const bodies = insertBodies(src)
    expect(bodies.length).toBeGreaterThan(0)
    expect(bodies.join('\n')).toContain('envelope_id')
    expect(insertBodies("x.insert({\n  a: 1,\n})")).toEqual(['\n  a: 1,'])
  })

  it('stores no payload that has not been through it', () => {
    // The defect this forbids is the line that used to be here: `payload:
    // payload as unknown as Record<string, unknown>`. Asserting the call
    // alone would not catch a SECOND, raw insert added alongside it — so
    // every payload column in every insert must name the redactor.
    const assignments = insertBodies(src)
      .flatMap((b) => [...b.matchAll(/payload:\s*([^\n,]+)/g)])
      .map((m) => m[1])
    expect(assignments.length).toBeGreaterThan(0)
    for (const value of assignments) {
      expect(value).toContain('redactForStorage(')
    }
  })
})
