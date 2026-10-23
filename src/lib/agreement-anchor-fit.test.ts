import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AGREEMENT_ANCHORS, buildPartnerAgreementEnvelope } from './docusign-envelope'

/**
 * The gap the PDF reserves for a fill anchor must be at least as wide as
 * the box DocuSign draws on top of it.
 *
 * THIS IS THE BUG THAT REACHED A COUNTERPARTY. A DocuSign tab is an
 * OVERLAY: it is positioned at the anchor and painted over whatever is
 * underneath, and it does not reflow the document. The template reserved
 * only the width of the literal text `\pname\` — about seven characters —
 * while the tab is 170pt wide. Any value longer than the anchor string
 * ran over the words after it.
 *
 * It stayed invisible because it depends on the VALUE, not the template.
 * "MileMogul" fitted. "Jimi P Maciel dba MileMogul", the legally correct
 * name for a sole trader, did not: clause 1 rendered the partner's name
 * on top of "with its address at", and the notices clause rendered his
 * email on top of "Notices to Shipo may be given at". Every anchor had
 * resolved to a real coordinate and every test was green, because a
 * coordinate says where a box STARTS and nothing in the API says what it
 * collides with.
 *
 * So the two numbers — the CSS width in the PDF builder and the tab width
 * in the envelope — are a contract, and this is the thing that enforces
 * it. Without it they are two constants in two languages that nothing
 * compares, which is how they drifted in the first place.
 */

const HERE = __dirname
const BUILDER = join(HERE, '../../scripts/build-agreement-pdf.mjs')

/** The reserved-gap widths the PDF builder emits, by anchor name. */
function builderWidths(src: string): Record<string, number> {
  const block = src.match(/const FILL_WIDTH_PT\s*=\s*\{([\s\S]*?)\}/)
  if (!block) throw new Error('FILL_WIDTH_PT not found in build-agreement-pdf.mjs')

  const out: Record<string, number> = {}
  for (const [, name, pt] of block[1].matchAll(/(\w+)\s*:\s*(\d+)/g)) {
    out[name] = Number(pt)
  }
  return out
}

/** The tab widths the envelope actually asks DocuSign to draw. */
function envelopeWidths(): Record<string, number> {
  const env = buildPartnerAgreementEnvelope({
    partner: {
      id: 'x',
      name: 'Dana Katz',
      email: 'dana@example.com',
      company: 'Katz Media LLC',
      tax_status: 'us_person',
      address: '1 Example Street, Providence, RI 02903',
    },
    shipo: { name: 'Ophir Schultz', email: 'ophir@shipousa.com' },
    webhookUrl: 'https://example.com/api/partner/agreement-webhook',
  })

  const byAnchor: Record<string, number> = {}
  for (const composite of env.compositeTemplates ?? []) {
    for (const t of composite.inlineTemplates ?? []) {
      for (const signer of t.recipients?.signers ?? []) {
        for (const tab of signer.tabs?.textTabs ?? []) {
          if ('width' in tab && tab.anchorString) {
            // '\\pname\\' -> 'pname'
            byAnchor[tab.anchorString.replace(/\\/g, '')] = Number(tab.width)
          }
        }
      }
    }
  }
  return byAnchor
}

describe('the PDF reserves room for what DocuSign paints on it', () => {
  const src = readFileSync(BUILDER, 'utf8')

  it('declares a reserved width for every fill anchor', () => {
    const widths = builderWidths(src)
    for (const anchor of ['pname', 'paddr', 'pemail']) {
      expect(widths[anchor], `${anchor} has no reserved width`).toBeGreaterThan(0)
    }
  })

  // Derived from AGREEMENT_ANCHORS rather than typed out, so an anchor
  // renamed there renames the key looked up here instead of leaving this
  // test quietly checking a name that no longer exists.
  it.each(
    [
      AGREEMENT_ANCHORS.partnerNamePrefill,
      AGREEMENT_ANCHORS.partnerAddressPrefill,
      AGREEMENT_ANCHORS.partnerEmailPrefill,
    ].map((a) => a.replace(/\\/g, '')),
  )('reserves at least the drawn width for %s', (name) => {
    const reserved = builderWidths(src)[name]
    const drawn = envelopeWidths()[name]

    expect(drawn, `no tab found for ${name}`).toBeGreaterThan(0)
    // >= and not ===: a wider gap is only whitespace, a narrower one is
    // the collision above.
    expect(reserved).toBeGreaterThanOrEqual(drawn)
  })

  it('emits the reserved width as CSS the renderer will honour', () => {
    // inline-block, because an inline span's width is ignored and the gap
    // would silently collapse back to the anchor text's own width —
    // exactly the state this test exists to prevent, and one that would
    // otherwise still satisfy the numeric checks above.
    expect(src).toMatch(/display:\s*inline-block/)
  })

  // ---- controls: each detector must be able to report a problem ----

  it('reads a width out of a builder that declares one (control)', () => {
    expect(builderWidths('const FILL_WIDTH_PT = { pname: 42 }')).toEqual({ pname: 42 })
  })

  it('throws rather than passing when the map is absent (control)', () => {
    expect(() => builderWidths('const SOMETHING_ELSE = {}')).toThrow(/FILL_WIDTH_PT/)
  })
})
