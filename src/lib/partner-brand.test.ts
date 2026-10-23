import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

// Brand layer for the partner portal (spec 2026-10-20 §6).
//
// WHY THIS FILE EXISTS AT ALL. The portal declared `--color-shipo:
// #00AAFF` and called it the brand. All 415KB of https://shipousa.com/ was
// grepped on 2026-10-20 and that value appears ZERO times. The live site is
// a white page with a #0b3361 navy header bar; the cyan was invented. A
// token NAMED after the brand is not evidence it IS the brand, so these
// tests pin the audited values rather than the names.
//
// Everything here reads source text, because vitest cannot cover a .tsx --
// the same approach, and the same two traps, as partner-terms.test.ts:
//
//   1. COMMENTS ARE STRIPPED FIRST. A grep over source counts its own
//      prose. This very file names `#0a0f1a` and `#00AAFF` a dozen times
//      while asserting their absence from the partner screens; without
//      stripping, the explanation of a rule would violate it.
//
//   2. EVERY ABSENCE TEST HAS A CONTROL. `expect(src).not.toContain(x)`
//      passes over an empty string, so a typo'd path, a renamed file or a
//      read that silently yields '' reads as a clean bill of health. The
//      first test below proves the reader actually read something before
//      any absence is believed.

const PARTNER_SURFACES = [
  'src/app/partner/layout.tsx',
  'src/app/partner/login/page.tsx',
  'src/app/partner/page.tsx',
  'src/components/partner/BatchClaimForm.tsx',
  'src/components/partner/ClaimForm.tsx',
  'src/components/partner/LoginForm.tsx',
  'src/components/partner/SignOutButton.tsx',
  'src/components/partner/Statement.tsx',
  'src/components/partner/TermsGate.tsx',
  'src/components/partner/W9Prompt.tsx',
]

const GLOBALS = 'src/app/globals.css'

// Comments stripped: /* block */, // line, and {/* jsx */} are all places a
// hex value can legitimately be discussed.
const codeOf = (file: string) =>
  readFileSync(file, 'utf8')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

// The audited palette. These are the values that appear on the live site,
// with the hit counts from the 2026-10-20 grep.
const BRAND = {
  ink: '#0b3361', // 35 hits -- navy. Header bar, headings, BODY TEXT.
  action: '#1a73e8', // 30 hits -- buttons and links.
  accent: '#e0ee47', // 15 hits -- lime. Rules and fills ONLY, never text.
  surface: '#f4f8fd',
  surface2: '#f6f8fb',
  page: '#ffffff',
}

// The palette that was never Shipo's.
const WRONG_PALETTE = ['#00AAFF', '#0090DD', '#33BBFF']

// WCAG 2.1 relative luminance and contrast. Written out rather than
// imported so the thresholds below are checked against the real formula
// and not against a number I typed. The first draft of the spec claimed
// #1a73e8 was 4.6:1; it is 4.51:1, which changed the guidance -- the blue
// clears AA for normal text by 0.01 and therefore cannot carry body text.
function luminance(hex: string): number {
  const h = hex.replace('#', '')
  const channels = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
  const [r, g, b] = channels.map((c) =>
    c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4),
  )
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a: string, b: string): number {
  const [la, lb] = [luminance(a), luminance(b)]
  const [hi, lo] = la > lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}

describe('partner brand: the reader works (control for every absence test below)', () => {
  // Without this, a renamed file turns every `not.toContain` into a
  // vacuous pass and the suite reports a clean theme over a dark one.
  it('reads every partner surface and finds real code in each', () => {
    for (const file of PARTNER_SURFACES) {
      const src = codeOf(file)
      expect(src.length, `${file} read as empty`).toBeGreaterThan(100)
      expect(src, `${file} has no import -- is this the right file?`).toContain(
        'import',
      )
    }
  })

  it('reads globals.css and finds the tailwind import', () => {
    expect(codeOf(GLOBALS)).toContain('@import "tailwindcss"')
  })

  it('the comment stripper removes a hex in a comment but keeps one in code', () => {
    // A control for the control. If the stripper silently stopped working,
    // the absence tests would start failing on this file's own prose --
    // or worse, keep passing for the wrong reason.
    const sample = `// bg-[#0a0f1a] in a line comment\n/* #00AAFF in a block */\nconst keep = '#0b3361'`
    const stripped = sample
      .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    expect(stripped).not.toContain('#0a0f1a')
    expect(stripped).not.toContain('#00AAFF')
    expect(stripped).toContain('#0b3361')
  })
})

describe('partner brand: tokens carry the audited values', () => {
  it('globals.css defines every --brand-* token with the live site hex', () => {
    const css = codeOf(GLOBALS)
    expect(css).toContain(`--brand-ink: ${BRAND.ink}`)
    expect(css).toContain(`--brand-action: ${BRAND.action}`)
    expect(css).toContain(`--brand-accent: ${BRAND.accent}`)
    expect(css).toContain(`--brand-surface: ${BRAND.surface}`)
    expect(css).toContain(`--brand-surface-2: ${BRAND.surface2}`)
    expect(css).toContain(`--brand-page: ${BRAND.page}`)
  })

  it('leaves --color-shipo* in place, because staff screens still use it', () => {
    // Scope check (D5). The cyan is wrong, but ripping it out app-wide is a
    // separate job Ophir deferred. A green suite here must not mean the
    // staff app lost its colours.
    const css = codeOf(GLOBALS)
    expect(css).toContain('--color-shipo')
  })
})

describe('partner brand: contrast is computed, not asserted', () => {
  it('body-text navy clears AAA on the page background', () => {
    expect(contrast(BRAND.ink, BRAND.page)).toBeGreaterThanOrEqual(7)
  })

  it('action blue clears AA for normal text, and only just', () => {
    const ratio = contrast(BRAND.action, BRAND.page)
    expect(ratio).toBeGreaterThanOrEqual(4.5)
    // Pinned deliberately. The margin is 0.01, so any darkening of the page
    // or lightening of the blue puts it under. If this upper bound ever
    // fails, someone changed the palette and the "blue is not for body
    // text" rule below needs re-deciding, not silently inheriting.
    expect(ratio).toBeLessThan(4.6)
  })

  it('the navy is a long way clearer than the blue, which is why it carries text', () => {
    expect(contrast(BRAND.ink, BRAND.page)).toBeGreaterThan(
      contrast(BRAND.action, BRAND.page) * 2,
    )
  })

  it('the lime accent cannot carry text at any size', () => {
    // 1.27:1. This is not a style preference -- a status communicated by
    // this colour alone is invisible. The test exists so nobody "fixes"
    // the palette by promoting the accent to a text colour.
    expect(contrast(BRAND.accent, BRAND.page)).toBeLessThan(3)
  })

  it('the blue FAILS on the pale surface, so a surface-backed label is the navy', () => {
    // The consequence of the 0.01 margin above. #f4f8fd is a shade off
    // white and that is enough: 4.22:1. The first draft of the light theme
    // put the "approved for payment" badge in blue on this exact
    // background, which is how this test came to exist.
    expect(contrast(BRAND.action, BRAND.surface)).toBeLessThan(4.5)
    expect(contrast(BRAND.ink, BRAND.surface)).toBeGreaterThanOrEqual(7)
  })
})

describe('partner brand: the invented cyan is gone from partner screens', () => {
  it('no partner surface references the wrong palette', () => {
    for (const file of PARTNER_SURFACES) {
      const src = codeOf(file).toUpperCase()
      for (const hex of WRONG_PALETTE) {
        expect(src, `${file} still uses ${hex}`).not.toContain(hex.toUpperCase())
      }
    }
  })

  it('no partner surface puts blue text on the pale surface in one class string', () => {
    // Pairs the two tokens the contrast test above says cannot sit
    // together. LIMIT OF THIS TEST: it only catches the pairing when both
    // halves are in the SAME class string. A blue label whose background
    // comes from an ancestor element is invisible to any grep -- the
    // <summary> in Statement.tsx was exactly that case and had to be found
    // by reading. So a green run here is not a clean bill of health for
    // blue-on-surface generally; it pins the cases a grep CAN see.
    for (const file of PARTNER_SURFACES) {
      expect(codeOf(file), `${file} pairs surface bg with action text`).not.toMatch(
        /bg-\[var\(--brand-surface\)\][^'"`]*text-\[var\(--brand-action\)\]/,
      )
    }
  })

  it('no partner surface paints the dark page background', () => {
    // #0a0f1a was the portal's page colour. The live site is white.
    for (const file of PARTNER_SURFACES) {
      expect(codeOf(file).toLowerCase(), `${file} still dark`).not.toContain(
        '#0a0f1a',
      )
    }
  })

  it('no partner surface uses text greys that fail on white', () => {
    // These were legible on #0a0f1a and are not on #ffffff: Tailwind
    // gray-300 is 1.5:1 and gray-400 is 2.8:1 against white. Both are
    // below the 4.5:1 floor for normal text, so a caption in either is
    // decoration, not information.
    for (const file of PARTNER_SURFACES) {
      const src = codeOf(file)
      expect(src, `${file} uses text-gray-300`).not.toContain('text-gray-300')
      expect(src, `${file} uses text-gray-400`).not.toContain('text-gray-400')
    }
  })
})

describe('partner brand: the logo is the one the website serves', () => {
  // THE HEADER USED TO CARRY A DRAWING OF THE LOGO, NOT THE LOGO.
  // public/shipo-logo.svg was 594 bytes of hand-written SVG: the word
  // "Shipo" set in Arial Black italic with two straight rules under it,
  // approximating a wordmark whose letterforms are custom and whose
  // underline is angled. It passed every test here, because the tests
  // asked whether a file was referenced and whether it was white — never
  // whether it was Shipo's.
  //
  // public/shipo-logo.png is the asset shipousa.com actually serves
  // (wp-content/uploads/2021/07/white-transparent-bg.png), trimmed of its
  // transparent padding: 514x500 of which only 322x122 is ink, so used
  // untrimmed it would render as a postage stamp in a header box.
  it('the partner header renders the logo the site serves', () => {
    const src = codeOf('src/app/partner/layout.tsx')
    expect(src).toContain('shipo-logo.png')
    // The imitation must not come back under its old name.
    expect(src).not.toContain('shipo-logo.svg')
  })

  it('the logo file exists and is the real asset, not a drawing of one', () => {
    // Repo-relative, the same way codeOf reads source above.
    const png = readFileSync('public/shipo-logo.png')
    // PNG magic. An SVG renamed to .png would still satisfy a filename
    // check, which is the whole failure being guarded against here.
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))

    // Dimensions live at a fixed offset in the IHDR chunk.
    const width = png.readUInt32BE(16)
    const height = png.readUInt32BE(20)
    expect(width).toBe(322)
    expect(height).toBe(122)
  })

  it('renders it at the asset’s own aspect ratio', () => {
    // The old box was 120x42 (2.857) for a mark that is 2.639 wide. Close
    // enough to look fine and wrong enough to stretch it; a logo is the
    // one image on the page nobody may quietly reshape.
    const src = codeOf('src/app/partner/layout.tsx')
    const w = Number(src.match(/width=\{(\d+)\}/)?.[1])
    const h = Number(src.match(/height=\{(\d+)\}/)?.[1])

    expect(w, 'no width on the logo img').toBeGreaterThan(0)
    expect(h, 'no height on the logo img').toBeGreaterThan(0)
    expect(Math.abs(w / h - 322 / 122)).toBeLessThan(0.05)
  })

  it('the logo sits on the navy bar the site puts it on', () => {
    // The only logo shipousa.com serves is white-transparent-bg.png -- a
    // WHITE mark. The site's header-bar is #0b3361. So white-on-navy is
    // not a choice, it is the site's own treatment, and it is also the
    // only way this asset is visible at all: public/shipo-logo.svg is
    // fill="white", so on a white page it renders as nothing.
    const src = codeOf('src/app/partner/layout.tsx')
    expect(src).toContain('--brand-ink')
  })

  it('the logo links to the marketing site', () => {
    expect(codeOf('src/app/partner/layout.tsx')).toContain('https://shipousa.com')
  })
})
