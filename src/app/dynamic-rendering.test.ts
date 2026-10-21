import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

// ============================================================
// A PAGE THAT READS THE DATABASE MUST NOT BE PRERENDERED.
//
// WHAT THIS CAUGHT, AND WHAT IT COSTS
//
// On 2026-10-21 two Vercel preview builds failed with:
//
//   Error occurred prerendering page "/clients"
//   Error: Missing required environment variable NEXT_PUBLIC_SUPABASE_URL
//   Export encountered an error on /clients/page, exiting the build.
//
// The missing variable was the SYMPTOM. The defect is that /clients runs
// a Supabase read during `next build` at all. In the App Router a page is
// statically prerendered unless something opts it out, and a direct
// supabase-js call is not something Next can see — it is not a tracked
// `fetch`, so nothing marks the page dynamic. Twenty sibling pages say
// `export const dynamic = 'force-dynamic'`. Five did not.
//
// The build failure is the LOUD half and it is the harmless half. The
// quiet half is production, where the variable IS set: there the
// prerender SUCCEEDS, and the client list is baked into the build output
// at deploy time. The page then serves that snapshot until the next
// deploy — a staff member looking at /clients sees the roster as it was
// when the branch last shipped, with no indication the data is frozen. A
// screen that is wrong and says nothing is worse than a build that stops.
//
// WHY THIS IS A TEST AND NOT A FIXED LIST OF FILES
//
// Naming the five would pass forever and protect nothing: the next page
// somebody adds with a `supabaseAdmin` read is the next one baked. The
// invariant is the rule itself — reads the database => declares dynamic —
// so the test derives its own subject list from the tree every run.
// ============================================================

const APP_DIR = join(__dirname)

/**
 * Comments are stripped BEFORE matching, and that is not fastidiousness.
 * A grep over source counts its own prose: the paragraph above contains
 * the exact string `export const dynamic`, so a naive search of any file
 * carrying a note like this one would find it and report a page guarded
 * when it is not. Strip first, then match on a real statement.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

function pageFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...pageFiles(full))
    else if (entry.name === 'page.tsx') out.push(full)
  }
  return out
}

/** Does this page reach the database while rendering? */
function readsDatabase(code: string): boolean {
  return /from\s+['"]@\/lib\/supabase['"]/.test(code)
}

/**
 * Anchored to the start of a line. `dynamic` must be a real module
 * export, not a word inside a string or an object literal.
 */
function declaresDynamic(code: string): boolean {
  return /^\s*export\s+const\s+dynamic\s*=/m.test(code)
}

/**
 * `searchParams` and `params` are Promises in this version of Next, and
 * awaiting either opts the page out of prerendering on its own. Such a
 * page is already dynamic and does not need the explicit export.
 */
function awaitsRequestData(code: string): boolean {
  return /await\s+searchParams|await\s+params/.test(code)
}

describe('pages that read the database are not prerendered', () => {
  const pages = pageFiles(APP_DIR).map((path) => {
    const code = stripComments(readFileSync(path, 'utf8'))
    return { path, rel: relative(APP_DIR, path), code }
  })

  // ---- control -----------------------------------------------------
  // Borrowed from verify-partner-ledger.mjs. If the walk returns nothing,
  // or the detector matches nothing, every assertion below is a sentence
  // that would print whether or not a single page were guarded. These two
  // lines are what make a green run mean something.
  it('can see the pages it is meant to be checking', () => {
    expect(pages.length).toBeGreaterThan(10)
    expect(pages.filter((p) => readsDatabase(p.code)).length).toBeGreaterThan(0)
    // And the detector must be capable of reporting a page as UNGUARDED,
    // or "all guarded" is not a finding.
    expect(declaresDynamic('const dynamic = 1')).toBe(false)

    // The line anchor defeats a `//` comment on its own — `//` is not
    // whitespace, so the match fails without any stripping. Asserted
    // because the first draft of this file claimed the opposite and was
    // wrong about its own regex.
    expect(declaresDynamic('// export const dynamic = "x"')).toBe(false)

    // A BLOCK comment is the case the anchor does NOT defeat: the inner
    // line genuinely starts with `export`, so the regex matches prose.
    // This is the whole reason stripComments exists, and these two lines
    // are the proof that it is load-bearing rather than decoration.
    const blockComment = '/*\nexport const dynamic = "force-dynamic"\n*/'
    expect(declaresDynamic(blockComment)).toBe(true)
    expect(declaresDynamic(stripComments(blockComment))).toBe(false)
  })

  it('every page that reads the database declares force-dynamic', () => {
    const unguarded = pages
      .filter((p) => readsDatabase(p.code))
      .filter((p) => !declaresDynamic(p.code))
      .filter((p) => !awaitsRequestData(p.code))
      .map((p) => p.rel)

    expect(
      unguarded,
      'These pages run a Supabase read during `next build`. On a preview ' +
        'deployment that fails the build; on production it silently bakes ' +
        "the data into the deploy. Add \"export const dynamic = 'force-dynamic'\".",
    ).toEqual([])
  })
})
