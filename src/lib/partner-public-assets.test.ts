import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { config } from '../proxy'

/**
 * Every asset the PARTNER portal loads has to be reachable without a
 * staff session.
 *
 * THE LOGO WAS BROKEN IN PRODUCTION AND NOTHING SAID SO. src/proxy.ts
 * guards the staff screens and excludes a short list of paths from that
 * guard. `shipo-logo.jpg` is on the list — it is what the staff login and
 * sidebar use. The partner header's own asset never was, so
 * GET /shipo-logo.svg answered 307 to /login and every partner who opened
 * the portal saw a broken-image icon where the logo should be.
 *
 * partner-brand.test.ts could not catch it. It asked whether the layout
 * REFERENCES the file and whether the file is white — both true the whole
 * time. Reachability is a fact about the middleware matcher, which is a
 * different file, and the two were never compared. The bug was found by
 * rendering the page and looking at it.
 *
 * So this reads the matcher and asserts the partner's assets are excluded
 * from it. An asset added to the header later, and forgotten here, fails.
 */

const MATCHER = config.matcher[0]

/** True when the staff guard would run for `path` — i.e. it is NOT excluded. */
function guarded(path: string): boolean {
  return new RegExp(`^${MATCHER}$`).test(path)
}

/** Assets the partner layout requests, read off the layout itself. */
function assetsReferencedByPartnerLayout(): string[] {
  const src = readFileSync('src/app/partner/layout.tsx', 'utf8')
  return [...src.matchAll(/src="(\/[^"]+\.(?:png|jpg|jpeg|svg|webp|ico|css|js))"/g)].map((m) => m[1])
}

describe('partner portal assets are reachable without a staff session', () => {
  it('finds the assets the layout asks for (control)', () => {
    // Without this, an empty list would make every assertion below pass
    // over nothing — the same trap partner-brand.test.ts guards with its
    // own reader control.
    expect(assetsReferencedByPartnerLayout().length).toBeGreaterThan(0)
  })

  it.each(assetsReferencedByPartnerLayout())('%s is not behind the staff guard', (asset) => {
    expect(guarded(asset)).toBe(false)
  })

  it('still guards an ordinary staff page (control)', () => {
    // Proves `guarded` can return true at all. Without it, a matcher that
    // excluded everything — or a broken regex — would read as a clean
    // pass on every assertion above.
    expect(guarded('/clients')).toBe(true)
    expect(guarded('/adjustments')).toBe(true)
  })

  it('leaves the partner routes themselves excluded', () => {
    // These were already excluded; asserted so a matcher edit that fixes
    // the logo cannot quietly put the portal itself behind staff auth.
    expect(guarded('/partner')).toBe(false)
    expect(guarded('/partner/login')).toBe(false)
  })
})
