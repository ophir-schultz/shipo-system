# Partner Portal: Disclaimer, W-9 Gate, More Data, Client Claims — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put a versioned disclaimer and a self-serviceable W-9 gate in front of the partner statement, show a partner every input to his own payment, and let him submit client claims that only a staff approval can turn into money.

**Architecture:** Every decision is a pure function in a `.ts` module under test; the `.tsx` components and route handlers only render and persist what those functions decide. Two new tables (`partner_terms_acceptances`, `partner_client_claims`) are append-only consent/claim records — neither is read by any money path except through a staff-set `client_id`. The W-9 becomes its own DocuSign envelope with the accountant as a `carbonCopies` recipient, so the taxpayer identification number never enters a Shipo process.

**Tech Stack:** Next.js 16.2.9 (App Router, server components), React 19.2.4, TypeScript, Supabase (`supabaseAdmin`, service role), vitest 3.2.7, DocuSign eSignature REST + Connect.

**Spec:** `docs/superpowers/specs/2026-10-13-partner-portal-disclaimer-claims-data-design.md` (approved by Ophir 2026-10-13). Read §2, §2a, §3, §4 before starting; the plan argues from it and does not restate its reasoning.

## Global Constraints

- **This is not the Next.js in your training data.** Read the relevant guide in `node_modules/next/dist/docs/01-app/` before writing any route handler, page, or server action. Heed deprecation notices. (`AGENTS.md`)
- `vitest.config.ts` has `include: ['src/**/*.test.ts']` and `environment: 'node'`. **Nothing in a `.tsx` can be covered.** Every decision, every assembled string, every message map lives in a `.ts` module with a sibling `.test.ts`.
- **supabase-js parses `.select()` at the type level.** A select string must be ONE single-line string literal preceded by `// prettier-ignore`. A concatenated expression is not a literal type and the row degrades to `GenericStringError`, surfacing as unrelated type errors elsewhere.
- **Migrations are `supabase/*.sql`, idempotent, and applied by hand by Ophir in the Supabase SQL editor.** The implementer writes the file and never applies it. Every migration ends with a commented `VERIFICATION` block whose query returns `present = true`.
- **Verify a column exists before selecting it.** A missing column 42703s the session select in `getPartnerFromSession()` and locks every partner out of the portal.
- `PARTNER_TERMS_VERSION = '2026-10-13'`. Bumping it re-prompts every partner — that is correct and must stay a deliberate act.
- **The disclaimer wording is attorney-gated.** Build the mechanism with the §2.4 draft text; the text is replaced after redline. Do not block on the attorney.
- **Partner-facing copy may never contain a staff instruction.** No `/reactivate|set the first-payment|re-send|re-sending the agreement|send a new one/i` in any string a partner can see.
- **Never log a partner login code, session token, or any TIN-shaped value.**
- **Never fetch the signed W-9 PDF into our process, and never email it ourselves.** Forwarding is a DocuSign `carbonCopies` recipient only. (§2a.5, Risk 5)
- `ACCOUNTANT_W9_EMAIL` is configuration. **The implementer never invents a value**; tests inject one. Ophir sets the real one in Vercel.
- **Do not send any DocuSign envelope.** Builders produce `status: 'created'` and nothing in this plan calls the send API.
- Do not commit anything unless explicitly asked. Do not stage the parallel session's files (`src/lib/billing/profit-rollup*`, `src/app/dashboard/page.tsx`, `scripts/mutate-*.py`, `supabase/store_mapping_discovery_tabs_u_v.sql`).
- `src/lib/billing/profit-rollup.test.ts > reconcile > subtracts exactly…` fails on `main` and is **not yours**. Ignore it; judge your work by the suites you touch.

## Review Focus

Five things the spec implies, that no task above would otherwise test, and that would bite a real person:

1. **`x-forwarded-for` on Vercel is a comma-separated chain, not one address.** Storing the whole string, or taking the last hop, makes the acceptance record evidence of a proxy rather than of a partner. Expected: the first entry, trimmed. → tested in Task 2.
2. **A client whose `referral_first_payment_date` is in the future, or before its `referral_signup_date`.** The invoice form accepts future periods and the dates are hand-set. Expected: "awaiting first payment" / no window, never "month 0 of 12" and never a negative month. → tested in Task 9, where `windowPosition` is born.
3. **A double-clicked Accept button sends two concurrent POSTs.** Sequential idempotency is not concurrent idempotency. Expected: one acceptance row, both responses `200`. → tested in Task 3.
4. **A claim submitted with a whitespace-only or absurdly long company name.** Expected: whitespace-only rejected as a validation error (same generic body), length capped before insert, so the staff queue cannot be flooded with a 100 KB cell. → tested in Task 12.
5. **A partner whose agreement is voided, or whose row goes `inactive`, between the gate rendering and the POST landing.** The gate is a render; the route is the control. Expected: every new partner route re-asks `getPartnerFromSession()` and refuses, exactly as `verify-code` does. → tested in Tasks 3 and 12.

---

## Task 1: Terms versioning and text (`partner-terms.ts`)

Pure library, no database, no UI. Everything later in §2 depends on its shape.

**Files:**
- Create: `src/lib/partner-terms.ts`
- Test: `src/lib/partner-terms.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export const PARTNER_TERMS_VERSION = '2026-10-13'
  export interface TermsSection { heading: string; body: string }
  export const PARTNER_TERMS_SECTIONS: ReadonlyArray<TermsSection>
  export interface Acceptance { terms_version: string }
  export function needsAcceptance(acceptances: ReadonlyArray<Acceptance>): boolean
  ```

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest'
import {
  PARTNER_TERMS_VERSION,
  PARTNER_TERMS_SECTIONS,
  needsAcceptance,
} from './partner-terms'

describe('needsAcceptance', () => {
  it('is true with no acceptances at all', () => {
    expect(needsAcceptance([])).toBe(true)
  })
  it('is false once the current version is accepted', () => {
    expect(needsAcceptance([{ terms_version: PARTNER_TERMS_VERSION }])).toBe(false)
  })
  it('is TRUE when only an older version was accepted', () => {
    expect(needsAcceptance([{ terms_version: '2026-01-01' }])).toBe(true)
  })
  it('is false when the current version appears among several', () => {
    expect(
      needsAcceptance([
        { terms_version: '2026-01-01' },
        { terms_version: PARTNER_TERMS_VERSION },
        { terms_version: '2025-06-06' },
      ]),
    ).toBe(false)
  })
  it('is TRUE when only a FUTURE version was accepted', () => {
    expect(needsAcceptance([{ terms_version: '2099-01-01' }])).toBe(true)
  })
})

describe('PARTNER_TERMS_SECTIONS', () => {
  it('covers all four risk areas', () => {
    expect(PARTNER_TERMS_SECTIONS).toHaveLength(5)
  })
  it('names confidentiality, estimates, client data and contractor status', () => {
    const headings = PARTNER_TERMS_SECTIONS.map((s) => s.heading.toLowerCase()).join(' | ')
    expect(headings).toMatch(/confidential/)
    expect(headings).toMatch(/estimate/)
    expect(headings).toMatch(/client/)
    expect(headings).toMatch(/contractor/)
  })
  it('states that the signed agreement governs', () => {
    const all = PARTNER_TERMS_SECTIONS.map((s) => s.body).join(' ')
    expect(all).toMatch(/agreement governs/i)
  })
  it('contains no staff instruction', () => {
    const all = PARTNER_TERMS_SECTIONS.map((s) => `${s.heading} ${s.body}`).join(' ')
    expect(all).not.toMatch(/reactivate|set the first-payment|re-send|send a new one/i)
  })
  it('has no empty heading or body', () => {
    for (const s of PARTNER_TERMS_SECTIONS) {
      expect(s.heading.trim().length).toBeGreaterThan(0)
      expect(s.body.trim().length).toBeGreaterThan(0)
    }
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/partner-terms.test.ts`
Expected: FAIL — "Failed to resolve import './partner-terms'"

- [ ] **Step 3: Implement `src/lib/partner-terms.ts`**

Five sections, in this order, with the headings and bodies drafted from spec §2.4 — (a) Confidentiality, (b) The figures are good-faith estimates, not an account stated, (c) No client solicitation and no use of client data, (d) Independent contractor, own taxes, W-9 first, and (e) a closing section stating that if this screen and the signed agreement disagree, **the agreement governs**.

Write the bodies from §2.4's text, not from memory. Specific values §2.4 pins and the copy must carry: Section 6 of the agreement for confidentiality; disputes in writing **within 30 days**; clawback is **offset-only** per agreement **3.9**; lines marked "not final" / "not priced yet" are **not owed**.

Header comment must record the two load-bearing facts: that this file is the *draft for the attorney to redline* and that **bumping `PARTNER_TERMS_VERSION` re-prompts every partner**.

`needsAcceptance` is `!acceptances.some(a => a.terms_version === PARTNER_TERMS_VERSION)` — an exact match on the current constant, never a comparison or a `>=`, which is what makes a future-dated acceptance still re-prompt.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/partner-terms.test.ts && npx tsc --noEmit`
Expected: PASS, and no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/partner-terms.ts src/lib/partner-terms.test.ts
git commit -m "feat(partner): versioned disclaimer text and needsAcceptance"
```

---

## Task 2: Acceptance table and the acceptance read

The migration plus the one function that turns a request into a storable acceptance row. Separate from Task 3 because a reviewer can reject the storage shape while approving the gate, and because the migration needs Ophir's hand before Task 3 can run against a real database.

**Files:**
- Create: `supabase/partner_terms_acceptances.sql`
- Create: `src/lib/partner-terms-record.ts`
- Test: `src/lib/partner-terms-record.test.ts`

**Interfaces:**
- Consumes: `PARTNER_TERMS_VERSION` from Task 1.
- Produces:
  ```ts
  /** First hop of an x-forwarded-for chain, trimmed. Null when absent or blank. */
  export function clientIp(forwardedFor: string | null | undefined): string | null
  export const USER_AGENT_MAX = 400
  export function acceptanceRow(input: {
    partnerId: string
    forwardedFor: string | null | undefined
    userAgent: string | null | undefined
  }): {
    referral_partner_id: string
    terms_version: string
    ip: string | null
    user_agent: string | null
  }
  ```

- [ ] **Step 1: Write the migration `supabase/partner_terms_acceptances.sql`**

The DDL is fixed by spec §2.2 — copy it verbatim (table, both indexes, `enable row level security`). Follow `supabase/partner_w9.sql` for house style: a header comment block explaining *why a row per (partner, version) rather than two columns on `referral_partners`* (§2.2: columns would be overwritten when the text changes, destroying the only thing the row is for), `create table if not exists` so it is idempotent, and a trailing commented `VERIFICATION` block whose query returns `present = true`.

The header must also state that `ip` and `user_agent` are **evidence, not telemetry** — recorded as read, never used to infer a location.

- [ ] **Step 2: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest'
import { clientIp, acceptanceRow, USER_AGENT_MAX } from './partner-terms-record'
import { PARTNER_TERMS_VERSION } from './partner-terms'

describe('clientIp', () => {
  it('takes the FIRST hop of a Vercel chain', () => {
    expect(clientIp('203.0.113.7, 198.51.100.2, 10.0.0.1')).toBe('203.0.113.7')
  })
  it('trims surrounding whitespace', () => {
    expect(clientIp('  203.0.113.7  ')).toBe('203.0.113.7')
  })
  it('returns a single address unchanged', () => {
    expect(clientIp('203.0.113.7')).toBe('203.0.113.7')
  })
  it('is null for absent, empty or whitespace-only headers', () => {
    expect(clientIp(null)).toBeNull()
    expect(clientIp(undefined)).toBeNull()
    expect(clientIp('')).toBeNull()
    expect(clientIp('   ')).toBeNull()
    expect(clientIp(' , 10.0.0.1')).toBeNull()
  })
})

describe('acceptanceRow', () => {
  it('stamps the CURRENT version, never one supplied by the caller', () => {
    const row = acceptanceRow({ partnerId: 'p1', forwardedFor: null, userAgent: null })
    expect(row.terms_version).toBe(PARTNER_TERMS_VERSION)
  })
  it('carries the partner id and the first-hop ip', () => {
    const row = acceptanceRow({
      partnerId: 'p1',
      forwardedFor: '203.0.113.7, 10.0.0.1',
      userAgent: 'Mozilla/5.0',
    })
    expect(row.referral_partner_id).toBe('p1')
    expect(row.ip).toBe('203.0.113.7')
    expect(row.user_agent).toBe('Mozilla/5.0')
  })
  it('truncates a long user agent and nulls an empty one', () => {
    const row = acceptanceRow({ partnerId: 'p1', forwardedFor: null, userAgent: 'x'.repeat(5000) })
    expect(row.user_agent).toHaveLength(USER_AGENT_MAX)
    expect(acceptanceRow({ partnerId: 'p1', forwardedFor: null, userAgent: '' }).user_agent).toBeNull()
  })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run src/lib/partner-terms-record.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `src/lib/partner-terms-record.ts`**

`USER_AGENT_MAX = 400`, matching the `.slice(0, 400)` already used in `verify-code/route.ts`. `acceptanceRow` reads `PARTNER_TERMS_VERSION` itself rather than accepting a version parameter — the route validates the client's claimed version, the row records the server's.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/lib/partner-terms-record.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Ask Ophir to apply the migration, and verify**

Give him the file path prefixed `shipo-system/supabase/partner_terms_acceptances.sql` and the VERIFICATION query. Do not proceed to Task 3's manual check until he confirms `present = true`.

- [ ] **Step 7: Commit**

```bash
git add supabase/partner_terms_acceptances.sql src/lib/partner-terms-record.ts src/lib/partner-terms-record.test.ts
git commit -m "feat(partner): append-only terms acceptance table and row builder"
```

---

## Task 3: The disclaimer gate and the acceptance route

**Files:**
- Create: `src/app/api/partner/accept-terms/route.ts`
- Create: `src/components/partner/TermsGate.tsx`
- Modify: `src/app/partner/page.tsx` (18 lines today — the check goes **before** `<Statement>` is constructed)
- Test: `src/lib/partner-terms.test.ts` (extend) — the route is exercised by hand; its decision logic is already covered by Tasks 1–2

**Interfaces:**
- Consumes: `needsAcceptance`, `PARTNER_TERMS_SECTIONS`, `PARTNER_TERMS_VERSION` (Task 1); `acceptanceRow` (Task 2); `getPartnerFromSession()` from `src/lib/partner-auth.ts`.
- Produces: `TermsGate` as a client component taking `{ sections: ReadonlyArray<TermsSection>; version: string }`, POSTing to `/api/partner/accept-terms` and reloading on success.

- [ ] **Step 1: Read the Next.js 16 route-handler and server-component guides**

Run: `ls node_modules/next/dist/docs/01-app/` and read the route handler + `cookies()`/`headers()` pages. `cookies()` is awaited in this codebase (`verify-code/route.ts`); confirm the same for `headers()` before using it.

- [ ] **Step 2: Implement `POST /api/partner/accept-terms`**

Session cookie only. Body is `{ version: string }` and nothing else. In order:

1. `getPartnerFromSession()` — null ⇒ `401`. **This is the control, not the gate**: the gate is a render and the partner's row can go `inactive` or `voided` in between (Review Focus 5). `getPartnerFromSession` already re-asks `portalAccessBlock` on every request, so this one call covers it.
2. Body parse failure, or `version !== PARTNER_TERMS_VERSION` ⇒ `409` with `{ error: 'These terms have changed. Reload the page.' }` — so a stale tab cannot accept last week's text (§2.6).
3. Select existing acceptances for this partner at this version. One or more ⇒ `200 { success: true }` and **no insert** (§2.6 idempotent).
4. Insert `acceptanceRow({ partnerId, forwardedFor: req.headers.get('x-forwarded-for'), userAgent: req.headers.get('user-agent') })`.
5. On insert error, `console.error` with `partner.id` and the Postgres code/message, and return `500`. Never return `200` on a failed insert — a partner who was told "accepted" and has no row is the one case this table exists to prevent.

Concurrent double-submit (Review Focus 3): step 3 does not serialize, so two simultaneous POSTs can both insert. Handle it by making the duplicate harmless rather than impossible — add `create unique index if not exists` on `(referral_partner_id, terms_version)` to the Task 2 migration (amend the file, re-ask Ophir to re-apply; it is idempotent) and treat a `23505` unique violation from step 4 as success.

- [ ] **Step 3: Implement the gate in `src/app/partner/page.tsx`**

After `getPartnerFromSession()` and before `<Statement>` is constructed:

```
const partner = await getPartnerFromSession()
if (!partner) redirect('/partner/login')

// read this partner's acceptances
if (needsAcceptance(acceptances)) return <TermsGate ... />

return <Statement partner={partner} />
```

The acceptance read is a `select('terms_version')` on `partner_terms_acceptances` filtered by `referral_partner_id`. **A failed read must gate, not pass** — fall through to `<TermsGate>` on error, because showing the statement on an unreadable acceptance table is the only failure here with a legal consequence. Say so in a comment.

§2.1: the gate must render **without reading any ledger data**. An unaccepted partner's request must never touch `partner_client_monthly`. That is satisfied by returning before `<Statement>` exists, since `loadPartnerLedger` is called inside it.

- [ ] **Step 4: Implement `TermsGate.tsx`**

Renders `PARTNER_TERMS_SECTIONS` as headings and bodies, a single "I accept these terms" button, and the version string visible on screen. No scroll-to-bottom enforcement, no checkbox-per-section — one deliberate act, recorded. Disable the button while the POST is in flight. On `409`, tell the partner the terms changed and reload.

- [ ] **Step 5: Add the gate-order assertion to `partner-terms.test.ts`**

The gate lives in a `.tsx`, which vitest's `include` cannot cover, so assert the ordering over the source text instead. This is the only automated guard available for §2.1, and the property is real: the acceptance check must appear before `<Statement` is constructed.

```ts
import { readFileSync } from 'node:fs'

it('the acceptance gate precedes the statement in partner/page.tsx', () => {
  const src = readFileSync('src/app/partner/page.tsx', 'utf8')
  const gate = src.indexOf('needsAcceptance')
  const statement = src.indexOf('<Statement')
  expect(gate).toBeGreaterThan(-1)
  expect(statement).toBeGreaterThan(-1)
  expect(gate).toBeLessThan(statement)
})
```

Run it once with the two lines swapped to confirm it fails; a guard that cannot fail is decoration.

- [ ] **Step 6: Run it, as a partner**

Run: `npm run dev`, then sign in as the test partner and confirm, in order: the disclaimer renders first; the statement is unreachable until Accept; after Accept the statement renders; a reload does not re-prompt; a second POST returns `200` with still exactly one row. Check the Supabase row carries a plausible `ip` and `user_agent`.

Then the one that matters: double-click Accept and confirm **one** row.

- [ ] **Step 7: Verify the suite and types**

Run: `npx vitest run src/lib && npx tsc --noEmit && npx eslint src/app/api/partner/accept-terms/route.ts src/components/partner/TermsGate.tsx src/app/partner/page.tsx`
Expected: PASS, clean.

- [ ] **Step 8: Commit**

```bash
git add src/app/api/partner/accept-terms/route.ts src/components/partner/TermsGate.tsx src/app/partner/page.tsx src/lib/partner-terms.test.ts supabase/partner_terms_acceptances.sql
git commit -m "feat(partner): disclaimer gate before the statement, with recorded acceptance"
```

---

## Task 4: Partner-voice W-9 messages and the statement gate

Buildable now. Nothing in it waits on the accountant's address.

**Files:**
- Modify: `src/lib/partner-w9.ts` (add the partner-voice map beside the existing staff-voice `payoutBlockedReason`)
- Modify: `src/lib/partner-w9.test.ts`
- Modify: `src/app/partner/page.tsx` (second gate, after the disclaimer)
- Create: `src/components/partner/W9Gate.tsx`

**Interfaces:**
- Consumes: `holdsW9(partner)` — already exists, already evidence-only. **Do not write a second predicate.**
- Produces:
  ```ts
  export type W9Block = 'not_held'
  export function w9Block(partner: W9Candidate): W9Block | null
  /** Addressed to the partner, in the dashboard, where they can act on it. */
  export function w9PartnerMessage(partner: W9Candidate): string | null
  ```

`w9Block` returns `'not_held'` when `!holdsW9(partner)`. A one-member union looks redundant and is not: it makes `Record<W9Block, string>` total at compile time, which is the mechanism `partner-access.ts` uses and the reason a new blocking state cannot be added to one voice and forgotten in the other.

- [ ] **Step 1: Write the failing tests in `partner-w9.test.ts`**

```ts
describe('w9PartnerMessage', () => {
  it('is null once we hold a W-9', () => {
    expect(w9PartnerMessage({ w9_received_at: '2026-10-14T00:00:00Z' })).toBeNull()
  })
  it('blocks on a null, undefined or blank timestamp', () => {
    expect(w9PartnerMessage({ w9_received_at: null })).not.toBeNull()
    expect(w9PartnerMessage({})).not.toBeNull()
    expect(w9PartnerMessage({ w9_received_at: '' })).not.toBeNull()
  })
  it('never hands the partner a staff instruction', () => {
    const msg = w9PartnerMessage({ w9_received_at: null })!
    expect(msg).not.toMatch(/re-send|re-sending the agreement|send a new one|reactivate/i)
  })
  it('says something the partner can do here', () => {
    expect(w9PartnerMessage({ w9_received_at: null })!).toMatch(/sign|complete/i)
  })
  it('differs from the staff sentence', () => {
    const p = { w9_received_at: null }
    expect(w9PartnerMessage(p)).not.toBe(payoutBlockedReason(p))
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/lib/partner-w9.test.ts`
Expected: FAIL — `w9PartnerMessage is not a function`.

- [ ] **Step 3: Implement `w9Block` / `w9PartnerMessage` in `partner-w9.ts`**

Add a `const PARTNER_REASON: Record<W9Block, string>` beside the existing staff sentence. Comment it the way `partner-access.ts` comments its pair: one function decides, two maps phrase it, and the dangerous direction is a state added to one map and missed in the other.

- [ ] **Step 4: Implement the second gate**

In `src/app/partner/page.tsx`, after the disclaimer check and before `<Statement>`:

```
if (!holdsW9(partner)) return <W9Gate partner={partner} />
```

`partner.w9_received_at` is already carried on `SessionPartner` — no new read. §2.1's ordering is the point: the disclaimer precedes anything that collects a taxpayer identification number, so this check must come second.

`W9Gate.tsx` renders `w9PartnerMessage(partner)` and, for now, a disabled "Sign your W-9" button with "we are setting this up — email Support@shipousa.com if you need it today". Task 8 replaces the button with the embedded signing launch. A gate with no exit is a lockout, so the support address is not optional even in this interim state.

- [ ] **Step 5: Run the tests and the app**

Run: `npx vitest run src/lib/partner-w9.test.ts && npx tsc --noEmit`
Then sign in as a partner with `w9_received_at` null and confirm the W-9 screen appears after Accept, and that the statement is unreachable. Set the timestamp, reload, confirm the statement appears.

- [ ] **Step 6: Commit**

```bash
git add src/lib/partner-w9.ts src/lib/partner-w9.test.ts src/components/partner/W9Gate.tsx src/app/partner/page.tsx
git commit -m "feat(partner): W-9 gate with partner-voice copy, ahead of the statement"
```

---

## Task 5: Tax status, and a builder that refuses anything but a US person

§2a.7. One column, one guard, one test. The test that matters is the refusal.

**Files:**
- Create: `supabase/partner_tax_status.sql`
- Create: `src/lib/partner-tax-status.ts`
- Test: `src/lib/partner-tax-status.test.ts`
- Modify: `src/lib/docusign-envelope.ts` (the guard, and `EnvelopePartner`)
- Modify: `src/lib/docusign-envelope.test.ts`
- Modify: `src/lib/partner-auth.ts` (carry the column on `SessionPartner`'s select — **verify it exists first**)
- Modify: `src/components/referrals/ReferralsManager.tsx` — the partner editor `/referrals` renders, so staff can set it. Note its two pre-existing lint warnings (~line 82 unused `partnerName`, ~line 97 `err: any`) are **not yours**; leave them.

**Interfaces:**
- Produces:
  ```ts
  export type PartnerTaxStatus = 'us_person' | 'foreign_individual' | 'foreign_entity'
  /** Null/unknown is UNSET — never defaulted to us_person. */
  export function taxStatusOf(value: string | null | undefined): PartnerTaxStatus | null
  /** Null when a W-9 is the right form; otherwise why it is not. */
  export function w9Refusal(status: PartnerTaxStatus | null): string | null
  ```
- `EnvelopePartner` gains `tax_status?: string | null`.

- [ ] **Step 1: Write the migration**

`alter table referral_partners add column if not exists tax_status text;` — **no default**. §2a.7: *"Default it to nothing — unset, not US person, because a default that happens to be the safe answer today is not a guard."* Add a `check` constraint allowing only the three values or null. Header comment records that W-8BEN / W-8BEN-E are deliberately not built and that this column exists so "US only for now" is enforced rather than remembered. Trailing VERIFICATION block.

- [ ] **Step 2: Write the failing tests for `partner-tax-status.ts`**

```ts
describe('taxStatusOf', () => {
  it('reads the three known values', () => {
    expect(taxStatusOf('us_person')).toBe('us_person')
    expect(taxStatusOf('foreign_individual')).toBe('foreign_individual')
    expect(taxStatusOf('foreign_entity')).toBe('foreign_entity')
  })
  it('is null for unset, blank and unrecognised values', () => {
    expect(taxStatusOf(null)).toBeNull()
    expect(taxStatusOf(undefined)).toBeNull()
    expect(taxStatusOf('')).toBeNull()
    expect(taxStatusOf('US_PERSON')).toBeNull()
    expect(taxStatusOf('ecommerce_agency')).toBeNull()
  })
})

describe('w9Refusal', () => {
  it('allows a US person', () => {
    expect(w9Refusal('us_person')).toBeNull()
  })
  it('refuses an UNSET status', () => {
    expect(w9Refusal(null)).toMatch(/tax status/i)
  })
  it('names the form a foreign individual would need', () => {
    expect(w9Refusal('foreign_individual')).toMatch(/W-8BEN(?!-E)/)
  })
  it('names the form a foreign entity would need', () => {
    expect(w9Refusal('foreign_entity')).toMatch(/W-8BEN-E/)
  })
})
```

- [ ] **Step 3: Write the builder-refusal tests in `docusign-envelope.test.ts`**

These are the ones §2a.7 calls "the test that matters". **Against `buildPartnerAgreementEnvelope` only** — `buildW9Envelope` does not exist until Task 6, which repeats these four against it using the same `w9Refusal` guard. Writing them against a function that is not there yet fails on the import rather than on the guard, which is a different and uninformative red.

```ts
it('refuses to build for a foreign individual', () => {
  expect(() => buildPartnerAgreementEnvelope({ ...valid, partner: { ...valid.partner, tax_status: 'foreign_individual' } }))
    .toThrow(/W-8BEN/)
})
it('refuses to build for a foreign entity', () => {
  expect(() => buildPartnerAgreementEnvelope({ ...valid, partner: { ...valid.partner, tax_status: 'foreign_entity' } }))
    .toThrow(/W-8BEN-E/)
})
it('refuses to build when the tax status is UNSET', () => {
  expect(() => buildPartnerAgreementEnvelope({ ...valid, partner: { ...valid.partner, tax_status: null } }))
    .toThrow(/tax status/i)
})
it('never returns a partially built envelope on refusal', () => {
  // the throw is the assertion: no object is returned to inspect
  expect(() => buildPartnerAgreementEnvelope({ ...valid, partner: { ...valid.partner, tax_status: null } })).toThrow()
})
```

Note for Task 7: the agreement envelope keeps this guard after the W-9 is split out of it. A foreign partner must not be sent the *agreement* either, until a W-8 path exists — the gate is "US only for now", not "US only for the W-9".

- [ ] **Step 4: Run to verify they fail**

Run: `npx vitest run src/lib/partner-tax-status.test.ts src/lib/docusign-envelope.test.ts`
Expected: FAIL on both files.

- [ ] **Step 5: Implement**

`partner-tax-status.ts` as above. In `docusign-envelope.ts`, add the refusal alongside the existing `if (!partner.id) throw` guards — `const refusal = w9Refusal(taxStatusOf(partner.tax_status)); if (refusal) throw new Error(...)`. It must sit **before** any document assembly, so there is no partially built envelope to return.

- [ ] **Step 6: Verify the column, then carry it**

Run the VERIFICATION query output Ophir gives you. Only once `present = true`, add `tax_status` to the `getPartnerFromSession()` select — as part of the single-line `// prettier-ignore` literal, never a concatenation. A column that is not there 42703s the select and locks every partner out.

- [ ] **Step 7: Add the staff control**

A select in `ReferralsManager.tsx`, the partner editor `/referrals` renders: *unset / US person / foreign individual / foreign entity*, with unset as the rendered state for null and no auto-selection. Staff-facing only — no change to the intake form and no new question for the partner (§2a.7).

- [ ] **Step 8: Run everything**

Run: `npx vitest run src/lib && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add supabase/partner_tax_status.sql src/lib/partner-tax-status.ts src/lib/partner-tax-status.test.ts src/lib/docusign-envelope.ts src/lib/docusign-envelope.test.ts src/lib/partner-auth.ts src/components/referrals/ReferralsManager.tsx
git commit -m "feat(partner): tax status column and a builder that refuses non-US partners"
```

---

## Task 6: The W-9-only envelope, with the accountant carbon-copied

**Not blocked.** The spec said this task needs the accountant's address first; it does not. The address is configuration read at build time, so the builder and its tests can be written now with an injected value, and only the *deployment* waits on Ophir. That is the whole point of §2a.5's "configuration, not a literal" — and the test that protects it is the one asserting a **missing** value throws.

**Files:**
- Modify: `src/lib/docusign-envelope.ts` — export `w9PartnerTabs` (today private at `:228`), add `buildW9Envelope`
- Modify: `src/lib/docusign-envelope.test.ts`

**Interfaces:**
- Consumes: `w9PartnerTabs()`, `W9_CUSTOM_FIELD`, `W9_INCLUDED` (`partner-w9.ts`), `PARTNER_ID_FIELD`, `ENVELOPE_TYPE_FIELD`/`_VALUE`, `SHIPO_RECIPIENT_ID`, `PARTNER_RECIPIENT_ID`, `w9Refusal`/`taxStatusOf` (Task 5).
- Produces:
  ```ts
  export const ACCOUNTANT_RECIPIENT_ID = '3'
  export interface BuildW9EnvelopeInput {
    partner: EnvelopePartner
    /** Page 1 of the IRS W-9, base64. Same source as the agreement builder used. */
    w9DocumentBase64: string
    /** From ACCOUNTANT_W9_EMAIL. Asserted non-empty — a blank is a refused envelope. */
    accountantEmail: string
    accountantName: string
    /** DocuSign embedded signing: set this and the partner receives NO email. */
    clientUserId: string
  }
  export function buildW9Envelope(input: BuildW9EnvelopeInput): Record<string, unknown>
  ```

Taking `accountantEmail` as a parameter rather than reading `process.env` inside the builder is deliberate: it keeps the builder pure and testable, and puts the env read in the one caller (Task 8's route), which asserts it once.

- [ ] **Step 1: Write the failing tests**

```ts
const valid: BuildW9EnvelopeInput = {
  partner: { id: 'p1', name: 'Jane Doe', email: 'jane@example.com', tax_status: 'us_person' },
  w9DocumentBase64: 'JVBERi0=',
  accountantEmail: 'accountant@example.com',
  accountantName: 'Test Accountant',
  clientUserId: 'p1',
}

it('is a draft', () => {
  expect(buildW9Envelope(valid).status).toBe('created')
})

it('sets the w9 custom field from the shared constants, by name', () => {
  const fields = buildW9Envelope(valid).customFields.textCustomFields
  const f = fields.find((x) => x.name === W9_CUSTOM_FIELD)
  expect(f).toBeDefined()
  expect(f.value).toBe(W9_INCLUDED)
})

it('carries the partner id so the webhook can resolve the row', () => {
  const fields = buildW9Envelope(valid).customFields.textCustomFields
  expect(fields.find((x) => x.name === PARTNER_ID_FIELD).value).toBe('p1')
})

it('sets the account-required envelope type', () => {
  const fields = buildW9Envelope(valid).customFields.textCustomFields
  expect(fields.find((x) => x.name === ENVELOPE_TYPE_FIELD).value).toBe(ENVELOPE_TYPE_VALUE)
})

it('carbon-copies the accountant exactly once', () => {
  const ccs = recipientsOf(buildW9Envelope(valid)).carbonCopies
  expect(ccs).toHaveLength(1)
  expect(ccs[0].email).toBe('accountant@example.com')
})

it('routes the carbon copy AFTER the signer', () => {
  const r = recipientsOf(buildW9Envelope(valid))
  expect(Number(r.carbonCopies[0].routingOrder)).toBeGreaterThan(
    Number(r.signers.find((s) => s.recipientId === PARTNER_RECIPIENT_ID).routingOrder),
  )
})

it('THROWS when the accountant address is missing or blank', () => {
  expect(() => buildW9Envelope({ ...valid, accountantEmail: '' })).toThrow(/accountant/i)
  expect(() => buildW9Envelope({ ...valid, accountantEmail: '   ' })).toThrow(/accountant/i)
})

it('sets clientUserId on the partner signer, so DocuSign sends no email', () => {
  const signer = recipientsOf(buildW9Envelope(valid)).signers
    .find((s) => s.recipientId === PARTNER_RECIPIENT_ID)
  expect(signer.clientUserId).toBe('p1')
})

it('contains the W-9 document and no agreement template', () => {
  const env = buildW9Envelope(valid)
  expect(JSON.stringify(env)).not.toContain(AGREEMENT_TEMPLATE_ID)
})

it('keeps every W-9 tab that the agreement envelope sent', () => {
  // the same w9PartnerTabs() source, so a required tab cannot be lost in the split
  expect(w9TabLabels(buildW9Envelope(valid))).toEqual(w9TabLabels(buildPartnerAgreementEnvelope(validAgreement)))
})

// Task 5's guard, repeated here because this is the builder that carries the TIN
it('refuses a foreign individual, a foreign entity and an UNSET tax status', () => {
  const at = (tax_status: string | null) => () =>
    buildW9Envelope({ ...valid, partner: { ...valid.partner, tax_status } })
  expect(at('foreign_individual')).toThrow(/W-8BEN/)
  expect(at('foreign_entity')).toThrow(/W-8BEN-E/)
  expect(at(null)).toThrow(/tax status/i)
})
```

Write `recipientsOf` and `w9TabLabels` as local helpers in the test file.

The `accountantEmail: ''` case is the control §6 of the spec names: *"A test that only checks the happy path would stay green on an envelope silently CC'd to nobody."*

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/lib/docusign-envelope.test.ts`
Expected: FAIL — `buildW9Envelope is not a function`.

- [ ] **Step 3: Implement `buildW9Envelope`**

One composite template holding the W-9 document (`transformPdfFields: 'false'`, as the agreement builder already does and for the same reason). Guards first, in this order: partner id / name / email, `w9DocumentBase64`, `w9Refusal(taxStatusOf(partner.tax_status))`, non-blank `accountantEmail`. Shipo stays a listed signer with no tabs so routing is unambiguous; the partner carries `w9PartnerTabs()` and `clientUserId`; the accountant is a `carbonCopies` recipient at `ACCOUNTANT_RECIPIENT_ID` with a routing order after the partner's.

`emailSubject` and `emailBlurb` matter less than usual here — the partner signs embedded and gets no email — but the accountant's copy carries the subject, so it must name the partner and say W-9.

Comment the reason the accountant is a CC and not an email we send: we never hold the bytes. Point at `docusign-redact.ts` and Risk 5.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/lib/docusign-envelope.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Ask Ophir for `ACCOUNTANT_W9_EMAIL`**

A named human at the accounting firm, not a shared inbox (§2a.9.4 — the same objection already raised against `support@sterlingaudithealth.com`). **He sets it in Vercel; you never set an env var yourself.** Nothing in Tasks 6–8's *code* waits on it; only a real send does.

- [ ] **Step 6: Commit**

```bash
git add src/lib/docusign-envelope.ts src/lib/docusign-envelope.test.ts
git commit -m "feat(docusign): W-9-only envelope with the accountant carbon-copied"
```

---

## Task 7: The agreement envelope becomes agreement-only

Separable from Task 6 and sequenced after it so the replacement exists before the capability is removed. §2a.9.3: this changes code that is already tested and already sent once.

**Files:**
- Modify: `src/lib/docusign-envelope.ts` — drop composite template `'2'` and `w9DocumentBase64` from `BuildEnvelopeInput`; rewrite `emailBlurb`
- Modify: `src/lib/docusign-envelope.test.ts`
- Modify: `src/app/api/partner/agreement-webhook/route.ts` — the W-9 inference must survive the split
- Modify: any send script passing `w9DocumentBase64`

- [ ] **Step 1: Write the failing tests**

```ts
it('no longer carries the W-9 document', () => {
  const env = buildPartnerAgreementEnvelope(valid)
  expect(env.compositeTemplates).toHaveLength(1)
  expect(JSON.stringify(env)).not.toContain('IRS Form W-9')
})
it('no longer sets the w9 custom field', () => {
  const fields = buildPartnerAgreementEnvelope(valid).customFields.textCustomFields
  expect(fields.find((f) => f.name === W9_CUSTOM_FIELD)).toBeUndefined()
})
it('no longer advertises the W-9 in the email blurb', () => {
  expect(buildPartnerAgreementEnvelope(valid).emailBlurb).not.toMatch(/W-9|round trip/i)
})
it('still requires partner id, name and email', () => { /* existing guards, unchanged */ })
```

And in the webhook's tests: an agreement-only completed envelope must stamp `agreement_status='signed'` and **leave `w9_received_at` null**; a W-9-only completed envelope must stamp `w9_received_at` and **not** touch `agreement_status`.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/lib/docusign-envelope.test.ts`
Expected: FAIL — two composite templates, W-9 field present.

- [ ] **Step 3: Implement the split**

Remove composite template `'2'`, the `w9DocumentBase64` field and its guard, the `W9_CUSTOM_FIELD` entry, and the "saves a second round trip" sentence from `emailBlurb` (§2a.3 states the cost plainly: splitting gives that round trip back; the blurb must stop claiming otherwise).

In the webhook, the two stamps must become independent: the agreement stamp keyed on the agreement envelope completing, the W-9 stamp keyed on `W9_CUSTOM_FIELD === W9_INCLUDED` — which the W-9 envelope sets and the agreement envelope no longer does. The existing "signed but no W-9" log branch (`route.ts:216-226`) stops being an anomaly and becomes the normal path; re-voice or delete that log accordingly, because a warning that fires on every signing is noise that hides the next real one.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/lib && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/docusign-envelope.ts src/lib/docusign-envelope.test.ts src/app/api/partner/agreement-webhook/route.ts
git commit -m "refactor(docusign): agreement envelope drops the W-9, webhook stamps split"
```

---

## Task 8: Embedded signing — the dashboard W-9 screen

**Files:**
- Create: `src/app/api/partner/w9-sign/route.ts`
- Modify: `src/components/partner/W9Gate.tsx`

**Interfaces:**
- Consumes: `buildW9Envelope` (Task 6), `getPartnerFromSession()`, the existing DocuSign auth/client used by whatever sends envelopes today, and `w9Page1Base64` (the W-9 bytes source the agreement send script used).
- Produces: `POST /api/partner/w9-sign` → `{ url: string }`, a DocuSign recipient view URL.

- [ ] **Step 1: Read the Next.js 16 route-handler guide if you have not already this session**

- [ ] **Step 2: Implement `POST /api/partner/w9-sign`**

1. `getPartnerFromSession()` — null ⇒ `401`.
2. `holdsW9(partner)` already true ⇒ `409`. Nothing to sign; a second W-9 envelope per partner is a second TIN collection.
3. Read `process.env.ACCOUNTANT_W9_EMAIL`. Blank ⇒ `503` with a partner-safe message and a `console.error` naming the missing variable. **This is the only place the env is read.** Do not default it, do not fall back to a Shipo address — a W-9 delivered to nobody is the failure §2a.5 names.
4. `buildW9Envelope({ ... clientUserId: partner.id })`. `partner.tax_status` flows through, so Task 5's refusal applies here: a foreign partner reaching this route gets a thrown builder, caught and returned as a `409` naming the right form, and no envelope.
5. Create the envelope, then `createRecipientView` for the partner recipient with the same `clientUserId`, `returnUrl` pointing back at `/partner`.
6. Return `{ url }`. **Never log the URL** — it is a bearer credential for a signing session.

§2a.9.1: if the view URL fails, the partner must get a plain "email us and we will send the form instead" fallback, or the gate is a lockout. Return a `502` with that sentence; `W9Gate` renders it.

§2a.8 requires the W-9 envelope id to be recorded in `partner_agreement_events` alongside the agreement's, with the payload redacted. **Verify this needs no new code before writing any** — the webhook resolves the partner from `PARTNER_ID_FIELD`, which `buildW9Envelope` sets, so the W-9 envelope's events should land there already. If they do not, the gap is in the webhook, not here, and it belongs in Task 7. Confirm by inspecting `partner_agreement_events` after the first real envelope and check `docusign-redact.ts` still strips the document bytes for this envelope shape — it was written against the agreement's.

Note on envelope status: `buildW9Envelope` returns `status: 'created'` (a draft), and an embedded recipient view requires a `sent` envelope. **Do not change the builder's constant.** The route is the one place that promotes it, by an explicit `status: 'sent'` override at the call site with a comment saying why — so "draft always" stays true of every builder and the single exception is visible at the place a human authorised it. Ask Ophir before the first real promotion; this is a send.

- [ ] **Step 3: Implement the button in `W9Gate.tsx`**

Replace the disabled button: POST, then `window.location.href = url`. Keep `w9PartnerMessage(partner)` as the heading copy and keep the support address for the `502`/`503` cases.

- [ ] **Step 4: Run it, as a partner**

Against a partner with `tax_status = 'us_person'` and `w9_received_at` null. **Stop before clicking Sign on a real envelope and show Ophir** — this is the first real send and his standing rule is explicit permission per send. Verify, by inspecting the created draft in DocuSign: one document, the accountant listed as a CC, the partner's tabs placed on the form, no agreement text anywhere.

Then the refusal, which needs no send: set `tax_status = 'foreign_entity'` and confirm the route returns `409` naming W-8BEN-E and creates nothing.

- [ ] **Step 5: Verify types and lint**

Run: `npx tsc --noEmit && npx eslint src/app/api/partner/w9-sign/route.ts src/components/partner/W9Gate.tsx`

- [ ] **Step 6: Commit**

```bash
git add src/app/api/partner/w9-sign/route.ts src/components/partner/W9Gate.tsx
git commit -m "feat(partner): sign the W-9 in the dashboard via embedded DocuSign"
```

---

## Task 9: The client roster (§4.1)

The actual complaint. No migration, no new reads — every field is already on `ledger.clients`.

**Files:**
- Create: `src/lib/partner-roster.ts`
- Test: `src/lib/partner-roster.test.ts`
- Modify: `src/components/partner/Statement.tsx`

**Interfaces:**
- Consumes: `ReferredClient` (`referrals.ts:148`) — `id`, `name`, `referral_signup_date`, `referral_first_payment_date`; `LedgerMonth[]` for the current month's figure.
- Produces:
  ```ts
  export interface RosterRow {
    clientId: string
    clientName: string
    referred: string | null          // the signup date as given, or null
    firstPaid: string | null
    /** 'awaiting_first_payment' | 'earning' | 'window_closed' */
    state: RosterState
  }
  export type RosterState = 'awaiting_first_payment' | 'earning' | 'window_closed'
  export const ROSTER_STATE_TEXT: Record<RosterState, string>
  export function rosterRows(clients: ReadonlyArray<ReferredClient>, asOf: Date): RosterRow[]
  /** Null when there is no first paid invoice, or the window is closed, or the date is in the future. */
  export function windowPosition(firstPaid: string | null, asOf: Date): { month: number; of: number } | null
  ```

`asOf` is a parameter, not `new Date()` inside — a function that reads the clock cannot be tested across a window boundary.

`windowPosition` is exported **here**, not in Task 10, because `rosterRows` already needs it to decide `state`. Task 10 extends its return with `closesAfter` and renders it; it does not add a second piece of date arithmetic. One function answers "where in the window is this client" for both tasks, so the roster's state and the displayed month cannot disagree about a boundary.

- [ ] **Step 1: Write the failing tests**

```ts
it('lists EVERY client, earning or not', () => {
  expect(rosterRows([awaiting, earning], JAN_2026)).toHaveLength(2)
})
it('a client with no first payment reads awaiting, not a zero', () => {
  const row = rosterRows([awaiting], JAN_2026)[0]
  expect(row.state).toBe('awaiting_first_payment')
  expect(ROSTER_STATE_TEXT[row.state]).not.toMatch(/\$0|month 0/)
})
it('a client inside its window reads earning', () => {
  const row = rosterRows([{ ...base, referral_first_payment_date: '2026-01-10' }], new Date('2026-03-01'))[0]
  expect(row.state).toBe('earning')
})
it('a client past 12 months reads window_closed', () => {
  const row = rosterRows([{ ...base, referral_first_payment_date: '2025-01-10' }], new Date('2026-03-01'))[0]
  expect(row.state).toBe('window_closed')
})
it('is empty for a partner with no clients', () => {
  expect(rosterRows([], JAN_2026)).toEqual([])
})
it('every state has partner-safe text with no staff instruction', () => {
  for (const t of Object.values(ROSTER_STATE_TEXT)) {
    expect(t).not.toMatch(/set the first-payment|re-send|reactivate/i)
  }
})

describe('windowPosition', () => {
  it('is null with no first paid invoice', () => {
    expect(windowPosition(null, JAN_2026)).toBeNull()
  })
  it('month 1 of 12 in the first paid month', () => {
    expect(windowPosition('2026-01-15', new Date('2026-01-20'))).toMatchObject({ month: 1, of: 12 })
  })
  it('month 12 of 12 in the last month', () => {
    expect(windowPosition('2026-01-15', new Date('2026-12-20'))).toMatchObject({ month: 12, of: 12 })
  })
  it('is null once the window has closed', () => {
    expect(windowPosition('2026-01-15', new Date('2027-02-01'))).toBeNull()
  })
  // Review Focus 2 — these dates are hand-set and can be in the future
  it('never returns month 0 or a negative month for a FUTURE first-payment date', () => {
    expect(windowPosition('2027-01-15', new Date('2026-10-14'))).toBeNull()
  })
  it('reads as awaiting when the first payment predates the signup date', () => {
    // nonsense data must read as unknown, not as a window that opened before the referral
    const row = rosterRows(
      [{ ...base, referral_signup_date: '2026-06-01', referral_first_payment_date: '2026-01-01' }],
      new Date('2026-07-01'),
    )[0]
    expect(row.state).toBe('awaiting_first_payment')
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/lib/partner-roster.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `partner-roster.ts`**

`windowPosition` is `REFERRAL_TERMS.COMMISSION_MONTHS` months from `referral_first_payment_date`; derive it the way `computeOwed` does (`monthIndex`) rather than with a second date arithmetic, so the two cannot disagree about a boundary month. `rosterRows` maps its result to `state`: null-with-a-date ⇒ `window_closed`, null-without ⇒ `awaiting_first_payment`, otherwise `earning`.

In the test file declare `base` as a valid `ReferredClient` fixture — `id`, `name`, `referral_partner_id`, `referral_signup_date` — overriding only the field each test is about, plus `const JAN_2026 = new Date('2026-01-15')`, `awaiting` (no `referral_first_payment_date`) and `earning` (one inside the window).

Two rules the spec leaves open and this plan fixes, split by which function can see the inputs:

- **In `windowPosition`:** a first-payment date after `asOf` returns null, by the same `[start, start + COMMISSION_MONTHS)` bound that closes the window — one condition, not a separate future-date branch. Never month 0, never a negative month.
- **In `rosterRows`:** a first-payment date earlier than that client's `referral_signup_date` is unusable data, so the row is `awaiting_first_payment` regardless of what `windowPosition` returns. This check lives here, not in `windowPosition`, because only the roster has the signup date — which is also why `windowPosition` keeps its two-date signature that Task 10 consumes.

- [ ] **Step 4: Render it in `Statement.tsx`**

A "Clients you referred" section with the §4.1 columns — Client, Referred, First paid, Commission window, This month — rendered **above** the monthly statements and **outside** the `s.months.length === 0` branch, so a partner with a live but not-yet-earning client sees his client instead of "No statement yet". That is the whole fix.

"This month" takes its figure from the current `LedgerMonth` where one exists, and `—` where none does. Follow the existing unknown-vs-zero discipline in this file: an unmeasured figure is not `$0`.

- [ ] **Step 5: Run the tests and the screen**

Run: `npx vitest run src/lib/partner-roster.test.ts && npx tsc --noEmit`
Then view the statement as a partner with one linked, non-earning client and confirm the client is named and the page no longer reads as empty.

- [ ] **Step 6: Commit**

```bash
git add src/lib/partner-roster.ts src/lib/partner-roster.test.ts src/components/partner/Statement.tsx
git commit -m "feat(partner): client roster showing every referred client, earning or not"
```

---

## Task 10: Commission window and per-client bonus state (§4.2, §4.3)

**Files:**
- Modify: `src/lib/partner-roster.ts` — extend `windowPosition`'s return with `closesAfter` + its test
- Create: `src/lib/partner-bonus-state.ts`
- Test: `src/lib/partner-bonus-state.test.ts`
- Modify: `src/components/partner/Statement.tsx`

**Interfaces:**
- Consumes: `windowPosition` (Task 9); `OwedLine` from `referrals.ts:210` and `PayoutStatus` from `referrals.ts:123` — which is `'computed' | 'pending' | 'approved' | 'paid'` and has **no** `'none'` member.
- Produces:
  ```ts
  // partner-roster.ts — the return type gains one field; the date logic is unchanged
  export function windowPosition(
    firstPaid: string | null,
    asOf: Date,
  ): { month: number; of: number; closesAfter: string } | null

  export type BonusState = 'paid' | 'approved' | 'in_review' | 'awaiting_first_payment' | 'not_qualified'
  export const BONUS_STATE_TEXT: Record<BonusState, string>
  /** Re-voices computeOwed's per-client signup_bonus OwedLine for a partner. */
  export function bonusStateFor(line: Pick<OwedLine, 'status' | 'note' | 'period'>): BonusState
  ```

`note` is **optional** on `OwedLine`, so `bonusStateFor` must handle `undefined` — `Pick` preserves that, and a line with no note is the commonest case.

- [ ] **Step 1: Write the failing tests**

Task 9 already covers `windowPosition`'s null cases and its month arithmetic. The only new assertion on it here is the field this task adds:

```ts
it('states the month the window closes', () => {
  expect(windowPosition('2026-01-15', new Date('2026-03-01'))!.closesAfter).toMatch(/December 2026/)
})

describe('bonusStateFor / BONUS_STATE_TEXT', () => {
  it('maps a paid payout to paid', () => {
    expect(bonusStateFor({ status: 'paid', period: '2026-03' })).toBe('paid')
  })
  it('maps an approved payout to approved', () => {
    expect(bonusStateFor({ status: 'approved', period: '2026-03' })).toBe('approved')
  })
  it('handles a line with NO note at all', () => {
    expect(() => bonusStateFor({ status: 'pending', period: '2026-03' })).not.toThrow()
  })
  it('maps an unqualified note to awaiting_first_payment, not an instruction', () => {
    const state = bonusStateFor({
      status: 'pending',
      note: 'No first-payment date set — window has not started',
      period: '2026-03',
    })
    expect(state).toBe('awaiting_first_payment')
    expect(BONUS_STATE_TEXT[state]).not.toMatch(/set the first-payment/i)
  })
  it('every state has partner-safe text', () => {
    for (const t of Object.values(BONUS_STATE_TEXT)) {
      expect(t).not.toMatch(/set the first-payment|re-send|reactivate|qualified on/i)
    }
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/lib/partner-roster.test.ts src/lib/partner-bonus-state.test.ts`
Expected: FAIL — `closesAfter` undefined in the first file, module not found in the second. Task 9's existing assertions stay green; if any of them goes red you have changed the date arithmetic, which this task must not do.

- [ ] **Step 3: Implement**

`windowPosition` gains `closesAfter` only — a month label for `start + COMMISSION_MONTHS - 1`, formatted the way the statement already labels months (`monthLabel`). The `[start, start + COMMISSION_MONTHS)` bound from Task 9 is unchanged. Spec §4.2: nothing for a client with no first paid invoice — *"that is unknown, not month zero."*

`bonusStateFor` **re-voices** `computeOwed`'s existing note; it does not recompute qualification. §4.3 is explicit that `"Set the first-payment date"` is an instruction to Shipo staff and must be re-voiced before a partner sees it, with a `Record<State, string>` so a missing phrasing is a compile error — the same two-map pattern as `partner-access.ts`.

- [ ] **Step 4: Render both**

The roster's "Commission window" cell shows `month N of 12` and the closing month, or `awaiting first payment`. Per-client bonus state renders from `BONUS_STATE_TEXT`.

- [ ] **Step 5: Run to verify they pass**

Run: `npx vitest run src/lib && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/partner-roster.ts src/lib/partner-roster.test.ts src/lib/partner-bonus-state.ts src/lib/partner-bonus-state.test.ts src/components/partner/Statement.tsx
git commit -m "feat(partner): show the 12-month window position and per-client bonus state"
```

---

## Task 11: His own account state (§4.4)

**Files:**
- Modify: `src/components/partner/Statement.tsx` — the only file this task touches

Three facts only: agreement signed and when, W-9 held or not held, and — stated as absent rather than invented — payout method. §4.4's `payout_method` / `payout_details` / `referral_code` columns are **confirmed absent and not proposed here**.

- [ ] **Step 1: Render the panel**

Agreement: `agreementLabel(partner.agreement_status)` plus `partner.agreement_signed_at`, both already on `SessionPartner`. W-9: `w9Label(partner)`, already built and already tested. Payout method: the honest line — we hold no payout details, here is how to send them — because a blank where a bank detail should be reads as "we have it".

This is a render over data already loaded. No new lib and no new test: every decision shown is a function already under test. If you find yourself writing an `if` here, it belongs in a `.ts`.

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit && npx eslint src/components/partner/Statement.tsx`
Then view it with `w9_received_at` set and null, and with `agreement_signed_at` null, confirming no cell reads as a value we do not hold.

- [ ] **Step 3: Commit**

```bash
git add src/components/partner/Statement.tsx
git commit -m "feat(partner): show agreement, W-9 and payout-method state"
```

---

## Task 12: Client claims — table and submission route

Largest piece, last, most review (§5.5). This task is the only new path to money in the whole plan.

**Files:**
- Create: `supabase/partner_client_claims.sql`
- Create: `src/lib/partner-claims.ts`
- Test: `src/lib/partner-claims.test.ts`
- Create: `src/app/api/partner/claims/route.ts`

**Interfaces:**
- Produces:
  ```ts
  /** The ONE response body. Identical for every outcome that is not a 4xx on shape. */
  export const CLAIM_RECEIVED = 'Received. We will review this and come back to you.'
  export const CLAIM_DAILY_CAP = 5
  export const CLAIM_FIELD_MAX = 300
  export const CLAIM_NOTE_MAX = 2000
  export type ClaimStatus = 'submitted' | 'approved' | 'rejected' | 'duplicate'
  export interface ClaimInput { company_name?: unknown; website?: unknown; contact_name?: unknown; contact_email?: unknown; note?: unknown }
  /** Null when the input cannot be stored; otherwise the row, trimmed and capped. */
  export function claimRow(partnerId: string, input: ClaimInput, forwardedFor: string | null | undefined):
    | { ok: true; row: Record<string, unknown> }
    | { ok: false; reason: 'no_company' }
  /** True when the submission must be refused. FAILS CLOSED on a null count. */
  export function overDailyCap(countToday: number | null): boolean
  ```

- [ ] **Step 1: Write the migration**

DDL fixed by spec §3.3 — copy it verbatim, both indexes, RLS enabled. The header comment must carry §3.3's own warning: `decision_note` is staff-facing and **must never reach the partner surface**, so partner-side selects name columns explicitly and never `select('*')`. Trailing VERIFICATION block.

- [ ] **Step 2: Write the failing tests**

```ts
describe('overDailyCap — fails CLOSED', () => {
  it('refuses when the count could not be read', () => {
    expect(overDailyCap(null)).toBe(true)
  })
  it('allows under the cap and refuses at it', () => {
    expect(overDailyCap(0)).toBe(false)
    expect(overDailyCap(CLAIM_DAILY_CAP - 1)).toBe(false)
    expect(overDailyCap(CLAIM_DAILY_CAP)).toBe(true)
  })
})

describe('claimRow', () => {
  it('trims and keeps a normal company name', () => {
    const r = claimRow('p1', { company_name: '  Acme Co  ' }, null)
    expect(r.ok && r.row.company_name).toBe('Acme Co')
  })
  // Review Focus 4
  it('refuses a whitespace-only or missing company name', () => {
    expect(claimRow('p1', { company_name: '   ' }, null).ok).toBe(false)
    expect(claimRow('p1', {}, null).ok).toBe(false)
    expect(claimRow('p1', { company_name: 123 }, null).ok).toBe(false)
  })
  it('caps every field before insert', () => {
    const r = claimRow('p1', { company_name: 'x'.repeat(10_000), note: 'y'.repeat(10_000) }, null)
    expect(r.ok && (r.row.company_name as string)).toHaveLength(CLAIM_FIELD_MAX)
    expect(r.ok && (r.row.note as string)).toHaveLength(CLAIM_NOTE_MAX)
  })
  it('defaults status to submitted and never sets client_id', () => {
    const r = claimRow('p1', { company_name: 'Acme' }, null)
    expect(r.ok && r.row.status).toBe('submitted')
    expect(r.ok && r.row).not.toHaveProperty('client_id')
  })
  it('records the first-hop ip', () => {
    const r = claimRow('p1', { company_name: 'Acme' }, '203.0.113.7, 10.0.0.1')
    expect(r.ok && r.row.submitted_ip).toBe('203.0.113.7')
  })
})

describe('CLAIM_RECEIVED — the leak test (§3.2)', () => {
  it('says nothing about the company', () => {
    expect(CLAIM_RECEIVED).not.toMatch(/already|exist|found|attributed|another partner|client/i)
  })
})
```

The byte-identical-response test in spec §6 is the route's, not the library's, and it is **the one that will be tempting to weaken**. It belongs in Step 5.

- [ ] **Step 3: Run to verify they fail**

Run: `npx vitest run src/lib/partner-claims.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `partner-claims.ts`**

`claimRow` builds only partner-supplied columns plus `submitted_ip` and `status: 'submitted'`. It must not emit `client_id`, `decided_by`, `decided_at` or `decision_note` at all — not as null, not as undefined. §3.1: nothing is attributed by the act of submitting, and the shape of the inserted row is where that is enforced.

`overDailyCap(null) === true` is the §3.2 requirement in one line: *"The cap fails closed — if the count query errors, refuse the submission. (`/api/referrals/intake`'s ceiling fails open on a failed COUNT. Do not copy that.)"* Comment it with that citation, naming the route not to copy.

Reuse `clientIp` from Task 2 rather than re-parsing the header.

- [ ] **Step 5: Implement `POST /api/partner/claims`**

In order:

1. `getPartnerFromSession()` null ⇒ `401` (Review Focus 5 — the gate is a render, the route is the control).
2. Count this partner's claims in the last 24 hours. `overDailyCap` ⇒ **return `CLAIM_RECEIVED` with `200`**, not a 429, and log the refusal server-side. A distinguishable rate-limit response is itself a signal, and §3.2's rule is that the endpoint answers nothing.
3. `claimRow`; `ok: false` ⇒ `400` with a generic shape error. This response may differ from the others, because it is about the request's shape, not about Shipo's client list.
4. Insert. On error, `console.error` with the partner id and the Postgres code, and return **`500`** with "We could not record that — please try again."

Step 4 is the one to get right, because the two rules in this route point in opposite directions and the wrong instinct is to make them agree: **conceal whether the company is known; never conceal whether we stored the claim.** A partner told "received" over a failed insert has silently lost a claim worth $300 plus twelve months of share.

Then, in the test file, the test that protects §3.2:

```ts
it('responds byte-identically for a new company, an existing Shipo client, and a company another partner already claimed', async () => {
  const bodies = await Promise.all([newCo, existingClient, claimedByOther].map(post))
  expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1)
})
```

If this needs a running server or a Supabase stub, put it in `partner-claims.test.ts` against an injected client rather than weakening it to a unit test of `CLAIM_RECEIVED`. The constant being one string is not the property under test; **the route reaching the same response down three different code paths** is.

- [ ] **Step 6: Run everything**

Run: `npx vitest run src/lib && npx tsc --noEmit && npx eslint src/app/api/partner/claims/route.ts src/lib/partner-claims.ts`
Expected: PASS, clean.

- [ ] **Step 7: Ask Ophir to apply the migration and verify `present = true`**

- [ ] **Step 8: Commit**

```bash
git add supabase/partner_client_claims.sql src/lib/partner-claims.ts src/lib/partner-claims.test.ts src/app/api/partner/claims/route.ts
git commit -m "feat(partner): client claims table and a submission route that answers nothing"
```

---

## Task 13: The partner's claims surface (§3.5)

**Files:**
- Create: `src/components/partner/ClaimForm.tsx`
- Modify: `src/components/partner/Statement.tsx`
- Modify: `src/lib/partner-claims.ts` + test — the partner-voice status map

**Interfaces:**
- Produces:
  ```ts
  export type ClaimPartnerState = 'under_review' | 'approved' | 'not_approved'
  export const CLAIM_PARTNER_TEXT: Record<ClaimPartnerState, string>
  export function claimPartnerState(status: string | null | undefined): ClaimPartnerState
  ```

`'duplicate'` and `'rejected'` both map to `'not_approved'`. That collapse is the point: §3.4 says the partner is told "not approved" and to contact us, never the reason, because a reason like "already attributed" is the §3.2 leak arriving by a different door.

- [ ] **Step 1: Write the failing tests**

```ts
it('maps submitted to under_review', () => {
  expect(claimPartnerState('submitted')).toBe('under_review')
})
it('maps approved to approved', () => {
  expect(claimPartnerState('approved')).toBe('approved')
})
it('maps BOTH rejected and duplicate to not_approved', () => {
  expect(claimPartnerState('rejected')).toBe('not_approved')
  expect(claimPartnerState('duplicate')).toBe('not_approved')
})
it('maps an unknown or null status to under_review, the safe answer', () => {
  expect(claimPartnerState(null)).toBe('under_review')
  expect(claimPartnerState('something_new')).toBe('under_review')
})
it('no partner-facing text leaks a reason or another partner', () => {
  for (const t of Object.values(CLAIM_PARTNER_TEXT)) {
    expect(t).not.toMatch(/already|another partner|duplicate|attributed|existing client/i)
  }
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/lib/partner-claims.test.ts`
Expected: FAIL — `claimPartnerState is not a function`.

- [ ] **Step 3: Implement the map, then the surface**

In `Statement.tsx`, inside the roster section from Task 9: this partner's own claims, listed by state and date, plus `<ClaimForm>`. The select names columns explicitly — `id, company_name, status, created_at` — and **never** `decision_note`. §3.3 is explicit that keeping it out means naming columns, and `select('*')` on this table is the mistake that needs no further explanation.

The form posts to `/api/partner/claims` and renders `CLAIM_RECEIVED` on success regardless of anything. It must not pre-check, autocomplete, or validate a company name against anything — any one of those turns the form into a lookup against Shipo's client list.

- [ ] **Step 4: Run to verify they pass, then use it**

Run: `npx vitest run src/lib/partner-claims.test.ts && npx tsc --noEmit`
Then submit a claim as the test partner, three times with three different company names: one new, one matching a real Shipo client, one matching a client already linked to another partner. **Compare the three response bodies and the three rendered screens.** They must be indistinguishable. Then submit past the cap and confirm the response is still identical.

- [ ] **Step 5: Commit**

```bash
git add src/components/partner/ClaimForm.tsx src/components/partner/Statement.tsx src/lib/partner-claims.ts src/lib/partner-claims.test.ts
git commit -m "feat(partner): submit and track client claims, with no answer leaked"
```

---

## Task 14: The staff claims queue (§3.4)

The approval is the single write that creates money, and it is a human act with a name attached.

**Files:**
- Create: `src/app/api/referrals/claims/route.ts` (staff: list, decide)
- Create: `src/components/referrals/ClaimsQueue.tsx`
- Modify: `src/app/referrals/page.tsx` — render the queue; the existing screen is `ReferralsManager.tsx`, so check which of the two owns the layout before adding a section
- Modify: `src/lib/partner-claims.ts` + test — the conflict rule

**Interfaces:**
- Produces:
  ```ts
  /** Null when the approval may proceed; otherwise why it must not. */
  export function approvalConflict(args: {
    claimPartnerId: string
    client: { id: string; referral_partner_id: string | null }
  }): string | null
  ```

- [ ] **Step 1: Write the failing tests**

```ts
describe('approvalConflict', () => {
  it('allows an unattributed client', () => {
    expect(approvalConflict({ claimPartnerId: 'p1', client: { id: 'c1', referral_partner_id: null } })).toBeNull()
  })
  it('allows a re-approval to the SAME partner', () => {
    expect(approvalConflict({ claimPartnerId: 'p1', client: { id: 'c1', referral_partner_id: 'p1' } })).toBeNull()
  })
  it('RAISES when the client belongs to another partner', () => {
    expect(approvalConflict({ claimPartnerId: 'p1', client: { id: 'c1', referral_partner_id: 'p2' } }))
      .toMatch(/another partner/i)
  })
})
```

And the route-level one, which is the real guard — §3.4: *"Approving a claim for a client already attributed to another partner must raise a conflict, not silently re-point the row."*

```ts
it('writes NOTHING when approval conflicts', async () => {
  const before = await snapshot(['clients', 'partner_client_claims'])
  const res = await approve(claimForAlreadyAttributedClient)
  expect(res.status).toBe(409)
  expect(await snapshot(['clients', 'partner_client_claims'])).toEqual(before)
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/lib/partner-claims.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the staff route**

Staff-authenticated (the Supabase Auth path `src/proxy.ts` already enforces — a partner session can never satisfy it). Three actions, each recording `decided_by` and `decided_at`:

- **approve** — check `approvalConflict` first; on conflict return `409` and write nothing, not even the claim's status. Otherwise set `client_id`, set `clients.referral_partner_id`, status `approved`. §3.4: this is the single write that creates money.
- **reject** — status `rejected`, reason into `decision_note`.
- **duplicate** — status `duplicate`, no attribution.

- [ ] **Step 4: Implement the queue component**

Per claim: what the partner typed, and — because staff may see it — whether the named company resembles an existing client and whether that client already carries a `referral_partner_id` (§3.4). The resemblance hint is staff-only and must never be reachable from a partner route.

- [ ] **Step 5: Run to verify they pass, then use it**

Run: `npx vitest run src/lib && npx tsc --noEmit && npx eslint src/app/api/referrals/claims/route.ts src/components/referrals/ClaimsQueue.tsx src/app/referrals/page.tsx`

Then, on `/referrals`: approve a clean claim and confirm `clients.referral_partner_id` is set and the partner's statement now shows the client. Attempt to approve a claim for a client already attributed to someone else and confirm the conflict, and that **nothing changed in either table.**

- [ ] **Step 6: Commit**

```bash
git add src/app/api/referrals/claims/route.ts src/components/referrals/ClaimsQueue.tsx src/app/referrals/page.tsx src/lib/partner-claims.ts src/lib/partner-claims.test.ts
git commit -m "feat(referrals): staff claims queue, with approval conflicts refused"
```

---

## Blocked and parallel items

Not tasks, but they gate going live and should not be discovered late:

- **`ACCOUNTANT_W9_EMAIL`** — Ophir sets it in Vercel. A named human at the firm, not a shared inbox. Task 6's code does not wait on it; a real send does.
- **The §2.4 disclaimer text goes to the attorney**, with §2.5's open question in the same pass: whether showing a partner a client's order-level detail needs a clause in the **client** agreement. §2.5 is live on the statement today, before any task here.
- **The 2026 1099-NEC threshold** — for the accountant. No threshold is hardcoded anywhere and none should be added.
- **`RESEND_API_KEY` in Vercel production** (task #8) — a real partner on the deployed host cannot get a login code without it, so none of this is reachable in production until it is set.
