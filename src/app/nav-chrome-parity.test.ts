import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'

// Every nav link must land on a screen that can be navigated back out of.
//
// THE DEFECT THIS EXISTS FOR. The root layout (src/app/layout.tsx) renders
// nothing but <html>/<body> -- no Sidebar. Each section supplies its own
// layout.tsx. So a page directory with no layout above it renders its content
// directly inside <body>: on the browser's default white background, flush to
// the viewport edge, with no navigation and no way back except the browser's
// own button.
//
// It is invisible to every other gate. tsc is happy -- a layout is not a type.
// The route builds, renders, and returns 200. `next build` lists it beside the
// working pages. Nothing is thrown. The page simply has no way out of it, and
// the only way to find that out is to open it.
//
// WHY A TEST AND NOT JUST THE FIX. This has now happened five times:
//
//   /ledger      caught by hand; its layout.tsx carries the note "without it
//                /ledger renders bare and flush to the viewport edge with no
//                sidebar" -- the bug, already diagnosed in the repo, in a file
//                that fixed one instance and could not prevent the next
//   /referrals   in the nav, shipped, nobody noticed
//   /marketing   in the nav, shipped, nobody noticed
//   /scan        in the nav, shipped, nobody noticed
//   /pnl         URL-only, a P&L screen
//   /statements  caught here, before shipping, only because adding the nav
//                entry prompted a look at what the link would land on
//
// Five of those six were found by somebody opening the page. That is the gate
// this replaces, and it is not a gate that scales to a team starting tomorrow.
//
// The failure is cheap to make because adding a route is `mkdir` plus one file,
// and the layout is a SEPARATE file you have to know to copy. Nothing about
// writing page.tsx reminds you.

const APP = 'src/app'

/** Deliberately bare. Each needs a reason, because each is a hole in the check. */
const NO_CHROME_BY_DESIGN = new Map<string, string>([
  // You are not logged in yet, so a sidebar full of links you cannot follow
  // would be worse than none.
  [`${APP}/login`, 'the login screen itself'],
  // The landing page carries its own full-height background and its own
  // navigation as four link cards -- it IS a navigation screen, so the sidebar
  // would be a second copy of its only content. Structural, too: nothing can
  // sit above src/app, so this entry is not a waiver so much as the one case
  // the rule cannot apply to.
  [APP, 'the root landing page, which is itself a menu'],
])

/**
 * Page directories, found on disk rather than from a hand-kept list -- the
 * point is to catch the route somebody adds without telling this file.
 */
function pageDirs(): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (entry.name === 'page.tsx') out.push(dirname(p))
    }
  }
  walk(APP)
  return out.sort()
}

/**
 * The layout files between a page and the root, nearest first.
 *
 * Next nests layouts, so a page inherits from every ancestor. `partner/login`
 * is covered by `partner/layout.tsx` and the rate-sheet deep link by
 * `rate-sheets/layout.tsx` -- neither needs one of its own, and a check that
 * only looked in the page's own directory would report both as defects and get
 * itself deleted for crying wolf.
 *
 * The ROOT layout is excluded from the result, because it is exactly the thing
 * that provides no chrome. Counting it would make every page pass and this
 * whole file assert nothing.
 */
function layoutChain(pageDir: string): string[] {
  const chain: string[] = []
  let dir = pageDir
  while (dir.startsWith(APP)) {
    const layout = join(dir, 'layout.tsx')
    if (dir !== APP && existsSync(layout)) chain.push(layout)
    if (dir === APP) break
    dir = dirname(dir)
  }
  return chain
}

/** The hrefs in the staff sidebar's nav array, in order. */
function navHrefs(): string[] {
  const src = readFileSync('src/components/layout/Sidebar.tsx', 'utf8')
  const nav = /const nav = \[([\s\S]*?)\n\]/.exec(src)
  if (nav === null) return []
  return [...nav[1].matchAll(/href:\s*'([^']*)'/g)].map(m => m[1])
}

/** The hrefs on the root landing page's card grid. */
function landingHrefs(): string[] {
  const src = readFileSync(`${APP}/page.tsx`, 'utf8')
  return [...src.matchAll(/<Link href="([^"]*)"/g)].map(m => m[1])
}

/**
 * The screens that turn work into a figure someone sends a client. A new
 * operator's first screen is the landing menu, so one of these missing from it
 * is a screen that does not exist as far as they are concerned.
 *
 * This is not a style rule, it is the defect that just happened: /statements
 * shipped, worked, and sat in no menu, so the only way to reach it was to be
 * told the URL. The landing page had drifted to four cards while the nav had
 * fourteen entries, and nothing could notice because the two lists are written
 * out by hand in different files.
 */
const MONEY_SCREENS = ['/billing', '/statements', '/reports'] as const

describe('every page renders inside some chrome', () => {
  it('found the routes and the nav it is about to judge', () => {
    // A guard on the guard. If the walk breaks or Sidebar's nav array is
    // renamed, both lists go empty, every loop below iterates nothing, and the
    // suite passes green while checking nothing. That is the failure mode of
    // every filesystem-scraping test and it has to be made loud.
    const dirs = pageDirs()
    expect(dirs.length, 'page.tsx files found under src/app').toBeGreaterThanOrEqual(22)
    expect(dirs).toContain(`${APP}/statements`)
    expect(dirs).toContain(`${APP}/billing`)
    // A dynamic segment, so the walk is proven to descend past the first level.
    expect(dirs).toContain(`${APP}/rate-sheets/[slug]/[id]/[token]`)

    const hrefs = navHrefs()
    expect(hrefs.length, 'hrefs scraped from the nav array').toBeGreaterThanOrEqual(14)
    expect(hrefs).toContain('/statements')
  })

  it('the root layout still provides no chrome, which is why sections must', () => {
    // The premise of layoutChain's exclusion of the root. If someone later
    // moves the Sidebar INTO the root layout, every section layout becomes a
    // duplicate and this file's whole model is wrong -- so it must fail here
    // and be rewritten, rather than quietly keep demanding redundant files.
    const root = readFileSync(`${APP}/layout.tsx`, 'utf8')
    expect(root).not.toContain('Sidebar')
  })

  for (const dir of pageDirs()) {
    const reason = NO_CHROME_BY_DESIGN.get(dir)

    it(`${relative(APP, dir)} ${reason === undefined ? 'has a layout above it' : `is bare on purpose (${reason})`}`, () => {
      const chain = layoutChain(dir)
      if (reason === undefined) {
        // Reported as the directory itself rather than a bare 0 !== 1, so a
        // regression names the route somebody has to go and look at.
        expect(chain, `${dir} has no layout.tsx above it, so it renders bare`)
          .not.toEqual([])
      } else {
        expect(chain, `${dir} is listed as bare by design but now has ${chain.join(', ')}`)
          .toEqual([])
      }
    })
  }

  for (const href of navHrefs()) {
    it(`the nav's ${href} lands on a screen with the sidebar`, () => {
      // Stronger than "some layout", and specific to the nav: a link in the
      // sidebar that lands somewhere WITHOUT the sidebar is a one-way door.
      // /partner and /rate-sheets have deliberately sidebar-less layouts, which
      // is correct for them and would be a defect for anything reachable from
      // the staff nav -- so this claim is scoped to the nav rather than applied
      // to every page.
      const dir = join(APP, href)
      expect(existsSync(dir), `the nav links to ${href} but ${dir} does not exist`).toBe(true)

      const chain = layoutChain(dir)
      expect(chain, `${href} has no layout above it`).not.toEqual([])

      const rendersSidebar = chain.some(f => /<Sidebar\s*\/>/.test(readFileSync(f, 'utf8')))
      expect(rendersSidebar, `no layout above ${href} renders <Sidebar />: ${chain.join(', ')}`)
        .toBe(true)
    })
  }
})

describe('the landing page is a usable way in', () => {
  it('found the cards it is about to judge', () => {
    // Same guard-on-the-guard as above. If the card markup changes shape --
    // a component extracted, double quotes becoming braces -- the scrape
    // returns nothing and every claim below passes over an empty list.
    const cards = landingHrefs()
    expect(cards.length, 'cards scraped from the landing grid').toBeGreaterThanOrEqual(6)
  })

  it.each(MONEY_SCREENS)('%s is on the landing page', href => {
    // A deliberately short list, and not "the landing page must mirror the
    // nav". The landing grid is a CURATED subset -- fourteen cards would be a
    // worse menu than six -- so the claim is about the screens that decide
    // what a client is charged, not about completeness.
    expect(landingHrefs(), `the landing menu omits ${href}`).toContain(href)
  })

  for (const href of landingHrefs()) {
    it(`the landing card for ${href} goes somewhere real`, () => {
      // A card is a bigger promise than a nav row: it has a title and a
      // sentence describing what it does, so one pointing at a dead route
      // reads as a feature that exists rather than a broken link.
      expect(existsSync(join(APP, href)), `no route at ${join(APP, href)}`).toBe(true)
      // And it must be in the sidebar too, or clicking it is a one-way trip
      // into a screen the nav gives no way back to.
      expect(navHrefs(), `${href} is on the landing page but not in the nav`).toContain(href)
    })
  }
})
