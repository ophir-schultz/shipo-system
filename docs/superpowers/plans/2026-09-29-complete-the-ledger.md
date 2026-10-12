# Complete the Ledger — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every dollar of cost and revenue visible per order, per client, per
day, so the business can see where money leaks.

**Architecture:** The real logic moves into pure, dependency-free functions under
`src/lib/ledger/` that can be unit-tested without a database. The existing sync
files become thin I/O shells that call them. New tables (`orders`,
`order_items`, `order_charges`, `cost_rates`, `operating_costs`,
`client_store_ids`, `sync_runs`) are additive — nothing existing is dropped or
rewritten — and four views roll them up.

**Tech Stack:** Next.js 16, TypeScript 5, Supabase (`@supabase/supabase-js`),
Vitest (added by Task 1 — the repo currently has no test framework).

**Spec:** `docs/superpowers/specs/2026-09-29-complete-the-ledger-design.md`

---

## Global Constraints

Every task's requirements implicitly include this section.

- **NEVER `git push`.** The branch is `main` with a live remote at
  `github.com/ophir-schultz/shipo-system`, wired to Vercel. A push deploys.
  Task 1 moves work onto a feature branch. Commits are fine; pushing requires
  Ophir's explicit say-so, every time, with no exceptions.
- **No error object may be discarded.** Not `const { data } = await ...` when an
  `error` is available, and not a bare `catch {}`. Both patterns exist in
  `src/lib/sync/shipstation.ts` today and both are why a live bug went unseen.
  Every error is counted into `sync_runs.errors`.
- **Warehouse time is `America/New_York`**, resolved through `Intl`, never a
  hardcoded UTC offset. The offset changes twice a year; the timezone name does
  not.
- **Money is `numeric` in Postgres and handled as a number in TS only for
  arithmetic that is immediately rounded to 2dp.** Never compare currency with
  `===` in a test; use a 0.005 tolerance.
- **`basis` and `is_estimate` are not optional.** Any cost derived from a rate
  that is not measured carries `basis` of `derived` or `estimated`, and any
  charge built from it carries `is_estimate = true`. No display may present a
  derived cost as measured.
- **Migrations are hand-applied.** This repo has no migration runner —
  `supabase/*.sql` files are pasted into the Supabase SQL editor by a human.
  Schema tasks end by handing the file to Ophir, not by running it.
- **Do not run Section B of `scripts/proposed-zone-chart-198.sql`.** It would
  convert a correct UPS zone chart into a wrong one.

---

## Inputs that arrive later, and why nothing waits on them

Ophir will supply these as they become available. **No task in this plan is
blocked by their absence**, which is deliberate — the spec was designed so that
missing inputs degrade honestly rather than halt work.

| Input | What it unblocks | What happens without it |
| --- | --- | --- |
| Warehouse payroll | Real `cost_per_pick` | Seeded `basis = 'estimated'`; charges carry `is_estimate` |
| Packaging material costs | Real material cost | Same |
| Rent and utilities | Real `cost_per_pallet_month` | Same |
| Software subscriptions | Overhead line in `pnl_monthly` | Row absent; net = gross |
| Nayax + Creative Pea Zenventory 2.0 keys | Order/pick data for 2 of 8 clients | Other 6 clients sync; these 2 recorded as `status = 'partial'` |
| Orcam / Suteka / Crisp Power rate cards | Revenue on their charges | `amount = null`, flagged as unpriced, never silently zero |
| Pallet and shelf positions per client per month | Monthly storage billing (Task 18) | No storage charge raised; on the Nayax card that is $25 a pallet-month going unbilled |
| Nayax quote's qualifying conditions | The 18 `description` fields | Left null. A paraphrase would lose the conditions that decide when a rate applies |

**The six measured leaks (spec §5.3.1) need none of the above.** `leaks_monthly`
(Task 15) is the direct answer to *"where are the leaks"* and depends on no cost
rate being correct. That is why it lands before the P&L views.

When an input arrives, it is a row inserted into `cost_rates`,
`operating_costs` or `client_storage_months` with a new effective date — not a
code change, and not a rewrite of history. The one exception is the three
outstanding rate cards, which are a new seed file plus a recalculation; Task
14's pack test exists specifically to prove that a card pricing a service Nayax
does not buy needs no code change to be billed.

---

## Review Focus

Failure modes the spec implies but which no task's happy path would exercise.
Each has a test pinned to the task that owns the code.

1. **Daylight-saving transition.** `vercel.json` schedules in UTC; the warehouse
   runs on Eastern. On 2026-11-01 the 06:00 UTC cron moves from 02:00 to 01:00
   local, and a pick-date rule written against a fixed offset silently misdates
   a day. *Pinned to Task 4.*
2. **Blank or null identifiers in `charge_key`.** 14 labels a month carry a blank
   order number (spec §3.2). A key built from an empty string collapses every
   such row onto one, and the unique index then makes them overwrite each other —
   data loss disguised as idempotency. *Pinned to Task 3.*
3. **Two cron runs overlapping.** The stale-delete step removes charges whose
   `calculated_at` predates the current run. If a second run starts mid-flight it
   deletes the first run's fresh rows. *Pinned to Task 14.*
4. **A cost rate that is missing versus one that is zero.** `cost = null` means
   unknown and must be excluded from margin; `cost = 0` means free and counts.
   Conflating them reports unknown costs as pure profit — the exact error the
   whole project exists to stop. *Pinned to Task 13.*
5. **Quantity of zero or below on a pick.** `quantity_picked = 0` means not
   picked and must raise no charge; a negative value is a data error, not a
   credit. Neither may produce a silent negative charge. *Pinned to Task 12.*

---

## File Structure

**New — pure logic, no database, fully unit-testable:**

| File | Responsibility |
| --- | --- |
| `src/lib/ledger/carrier.ts` | `carrierCode` → `source`; flags unknown carriers |
| `src/lib/ledger/charge-key.ts` | Deterministic `charge_key` per charge type |
| `src/lib/ledger/pick-date.ts` | Warehouse-local date + the before-06:00 rule |
| `src/lib/billing/classify-sku.ts` | Device vs component, with precedence |
| `src/lib/ledger/variance.ts` | Held-standard labour variance |
| `src/lib/ledger/order-line.ts` | Normalise Zenventory lines; reject negative quantities |
| `src/lib/ledger/cost-rate.ts` | Effective-dated cost lookup; unknown ≠ free |
| `src/lib/ledger/run-lock.ts` | Refuse to start while another run is open |
| `src/lib/ledger/calculate-charges.ts` | Build `order_charges` from orders, items, shipments |
| `src/lib/ledger/storage-charges.ts` | Build the monthly, order-less storage charges |

**New — database-facing:**

| File | Responsibility |
| --- | --- |
| `src/lib/ledger/sync-run.ts` | Open/close a `sync_runs` row; collect errors |
| `src/lib/ledger/load-charge-inputs.ts` | Assemble `ChargeInput[]` so the calculator stays pure |
| `src/lib/ledger/persist-charges.ts` | Take the lock, upsert, scoped stale-delete |

**New — screen:**

| File | Responsibility |
| --- | --- |
| `src/app/api/ledger/summary/route.ts` | Read the views; compute the variance via `variance.ts` |
| `src/app/ledger/page.tsx` | Five tables, no charts |

**New — migrations, hand-applied in this order:**

`supabase/ledger_01_orders.sql` → `ledger_02_cost.sql` →
`ledger_03_charges.sql` → `ledger_04_views.sql` →
`ledger_05_seed_nayax.sql` → `ledger_06_seed_cost_rates.sql` →
`ledger_07_storage.sql`

Each of the first four ships a `supabase/verify/*.sql` companion that asserts
its constraints actually fire and rolls itself back.

**Modified:**

| File | Change |
| --- | --- |
| `src/lib/sync/shipstation.ts` | Re-key on `shipmentId`; keep errors; derive `source`; allow negative adjustments; drop the carrier filter |
| `src/lib/sync/zenventory.ts` | Persist orders and items instead of discarding them; per-client run records |
| `src/app/api/agent/monitor/route.ts` | Call the widened syncs, the charge calculator and the storage biller |
| `package.json` | Vitest and a `test` script |

---

## Charge types the calculator does not raise yet

Spec §4 names six warehouse charge types in scope: pick, pack, storage,
receiving, materials, surcharges. Four are built (pick, pack, shipping,
surcharge) and storage is built in Task 18. **Three are seeded on the rate card
but raise no charge, and each is blocked on a specific missing input rather than
on effort.** They are listed here so the gap is a recorded decision instead of
something a reader discovers by noticing an absence.

| Charge type | What blocks it | What would unblock it |
| --- | --- | --- |
| `receiving` | No sync fetches inbound receipts. Zenventory's order endpoints describe outbound only, so there is no record that a pallet or carton ever arrived. | A Zenventory receipts endpoint, or a declared monthly count in the shape of Task 18's `client_storage_months`. |
| `material` | Nothing records **which box** an order shipped in. `cost_rates` prices `box_small` and `box_medium` separately, and the Nayax card bills materials at cost + 15%, so a charge cannot be raised without knowing which was used. | A box-size field on the pick, or a declared per-order average. |
| `return` | ShipStation's `isReturnLabel` says a return **label was bought**, which is already billed as shipping. It does not say a return was **received and processed**, which is what the $3.00 per-box line prices. | A returns-received feed, or the reconciliation work in piece 2. |

**None of these is guessed at in the meantime.** An order that should have
carried one of them simply has no such charge, and the resulting under-billing
is visible in `leaks_monthly` as picked-but-never-billed rather than hidden
behind an invented number. That is the deliberate choice: a missing charge that
shows up as a leak is recoverable; a fabricated one is not.

---

## Task 1: Safety branch and a test framework

Nothing else in this plan can be verified until this lands. The repo has **zero
test files** and no `test` script, and work is currently sitting on `main`.

**Files:**
- Modify: `package.json`
- Create: `vitest.config.ts`
- Create: `src/lib/ledger/smoke.test.ts` (deleted in step 7)

**Interfaces:**
- Consumes: nothing
- Produces: `npm test` runs Vitest; `@/` resolves to `src/` inside tests

- [ ] **Step 1: Get off `main` before anything is committed**

```bash
git checkout -b ledger/complete-the-ledger
git branch --show-current   # must print ledger/complete-the-ledger
```

If this prints `main`, stop and fix it. Every later commit assumes the branch.

- [ ] **Step 2: Install Vitest**

```bash
npm install -D vitest@^3 vite-tsconfig-paths@^5
```

`vite-tsconfig-paths` is required because the codebase imports via `@/lib/...`
and Vitest will not resolve that alias without it.

- [ ] **Step 3: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
```

`environment: 'node'` is correct here: every module this plan tests is pure
logic or server-side. No jsdom, no React testing.

- [ ] **Step 4: Add the test script to `package.json`**

In the `"scripts"` block, alongside the existing `"lint": "eslint"`:

```json
    "test": "vitest run",
    "test:watch": "vitest"
```

- [ ] **Step 5: Write a smoke test that proves the alias resolves**

Create `src/lib/ledger/smoke.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { calcBilledWeightOz } from '@/lib/billing/dim-weight'

describe('vitest wiring', () => {
  it('resolves the @/ alias into existing source', () => {
    expect(calcBilledWeightOz(32, 16)).toBe(32)
  })
})
```

This imports real existing code rather than asserting `true === true`, so it
fails loudly if the alias is misconfigured.

- [ ] **Step 6: Run it**

Run: `npm test`
Expected: PASS, 1 test. If it fails with "Cannot find module '@/lib/...'", the
`vite-tsconfig-paths` plugin is not loading — fix before continuing.

- [ ] **Step 7: Delete the smoke test and confirm the runner still works**

```bash
rm src/lib/ledger/smoke.test.ts
npm test
```

Expected: Vitest reports no test files found, and exits. That is fine — Task 2
adds the first real test.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json vitest.config.ts
git commit -m "Add Vitest so the ledger work can be tested at all"
```

---

## Task 2: Carrier code to source mapping

Fixes spec §5.5 step 3. `src/lib/sync/shipstation.ts:72` hardcodes
`source: 'stamps'`. Once the carrier filter comes off (Task 10), that would
label 776 UPS shipments a month as Stamps.com — corrupting the exact column
piece 2 reconciles against, and doing it invisibly because `'stamps'` is a
valid-looking value.

**Files:**
- Create: `src/lib/ledger/carrier.ts`
- Test: `src/lib/ledger/carrier.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `sourceForCarrier(carrierCode: string | null | undefined): CarrierSource`
  where `interface CarrierSource { source: string; known: boolean }`.
  Used by Task 9 and Task 13.

- [ ] **Step 1: Write the failing test**

Create `src/lib/ledger/carrier.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { sourceForCarrier } from '@/lib/ledger/carrier'

describe('sourceForCarrier', () => {
  it('maps stamps_com to the stamps source', () => {
    expect(sourceForCarrier('stamps_com')).toEqual({ source: 'stamps', known: true })
  })

  it('maps ups_walleted to its own source, not stamps', () => {
    expect(sourceForCarrier('ups_walleted')).toEqual({
      source: 'shipstation_ups',
      known: true,
    })
  })

  it('is case-insensitive, because the sync upper-cases carrier elsewhere', () => {
    expect(sourceForCarrier('UPS_WALLETED').source).toBe('shipstation_ups')
  })

  it('keeps an unknown carrier verbatim and flags it rather than coercing', () => {
    expect(sourceForCarrier('fedex')).toEqual({ source: 'fedex', known: false })
  })

  it('never silently returns stamps for a carrier it does not recognise', () => {
    // The whole point of this module. A wrong-but-plausible value is worse
    // than an obviously unknown one.
    expect(sourceForCarrier('dhl_ecommerce').source).not.toBe('stamps')
  })

  it('treats a missing carrier as unknown, not as stamps', () => {
    expect(sourceForCarrier(null)).toEqual({ source: 'unknown', known: false })
    expect(sourceForCarrier(undefined)).toEqual({ source: 'unknown', known: false })
    expect(sourceForCarrier('')).toEqual({ source: 'unknown', known: false })
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- carrier`
Expected: FAIL — "Failed to resolve import '@/lib/ledger/carrier'".

- [ ] **Step 3: Write the implementation**

Create `src/lib/ledger/carrier.ts`:

```ts
/**
 * ShipStation carrier code -> the `source` we record on a shipment.
 *
 * This exists because src/lib/sync/shipstation.ts hardcoded `source: 'stamps'`
 * for every row while a `carrierCode: 'stamps_com'` filter made that
 * accidentally true. Removing the filter (see the ledger spec §5.5) makes it
 * false for 80% of shipments, so the value has to be derived.
 *
 * `ups_walleted` is ShipStation's own UPS account, not a direct UPS account.
 * It reconciles against the ShipStation invoice, so it gets its own source
 * rather than a generic 'ups'.
 */
export interface CarrierSource {
  /** Value stored in `shipments.source`. */
  source: string
  /** False means: report this, do not trust downstream reconciliation on it. */
  known: boolean
}

const KNOWN: Record<string, string> = {
  stamps_com: 'stamps',
  ups_walleted: 'shipstation_ups',
}

export function sourceForCarrier(carrierCode: string | null | undefined): CarrierSource {
  const code = (carrierCode ?? '').trim().toLowerCase()
  if (!code) return { source: 'unknown', known: false }

  const mapped = KNOWN[code]
  if (mapped) return { source: mapped, known: true }

  // Verbatim, never coerced. An unknown carrier is a reportable finding
  // (spec §7), not a row to quietly file under Stamps.com.
  return { source: code, known: false }
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test -- carrier`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ledger/carrier.ts src/lib/ledger/carrier.test.ts
git commit -m "Derive shipment source from carrier code instead of assuming Stamps.com"
```

---

## Task 3: Deterministic charge keys

Fixes spec §5.2. Without an idempotency key, `order_charges` is inserted into by
a cron that runs three times a day, so every charge triples daily and the P&L
climbs on its own.

**Carries Review Focus item 2.**

**Files:**
- Create: `src/lib/ledger/charge-key.ts`
- Test: `src/lib/ledger/charge-key.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `type ChargeType = 'shipping' | 'pick' | 'pack' | 'material' | 'storage' | 'receiving' | 'surcharge' | 'return'`
  - `chargeKey(input: ChargeKeyInput): string` — throws `BlankIdentifierError` on
    an empty identifier
  - `class BlankIdentifierError extends Error`

  Used by Task 14. Note the field is named `chargeType`, not `type` —
  Task 14's calls must match.

- [ ] **Step 1: Write the failing test**

Create `src/lib/ledger/charge-key.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { BlankIdentifierError, chargeKey } from '@/lib/ledger/charge-key'

describe('chargeKey', () => {
  it('keys a shipping charge on the ShipStation shipment id', () => {
    expect(chargeKey({ chargeType: 'shipping', shipmentId: '91827364' }))
      .toBe('shipment:91827364')
  })

  it('keys pick and pack separately for the same order line', () => {
    const item = { orderItemId: 'a1b2c3' }
    expect(chargeKey({ chargeType: 'pick', ...item })).toBe('item:a1b2c3:pick')
    expect(chargeKey({ chargeType: 'pack', ...item })).toBe('item:a1b2c3:pack')
  })

  it('includes the variant in a material key, so two box sizes do not collide', () => {
    expect(chargeKey({ chargeType: 'material', orderItemId: 'a1', variant: 'box_small' }))
      .toBe('item:a1:material:box_small')
    expect(chargeKey({ chargeType: 'material', orderItemId: 'a1', variant: 'box_large' }))
      .not.toBe(chargeKey({ chargeType: 'material', orderItemId: 'a1', variant: 'box_small' }))
  })

  it('keys storage on the month, because storage has no order', () => {
    expect(chargeKey({ chargeType: 'storage', periodMonth: '2026-09-01' }))
      .toBe('storage:2026-09-01')
  })

  it('keys a surcharge on the shipment and the surcharge code', () => {
    expect(chargeKey({ chargeType: 'surcharge', shipmentId: '55', surchargeCode: 'peak' }))
      .toBe('shipment:55:peak')
  })

  it('is stable: the same input always produces the same key', () => {
    const input = { chargeType: 'pick' as const, orderItemId: 'zz' }
    expect(chargeKey(input)).toBe(chargeKey(input))
  })

  // --- Review Focus item 2 -------------------------------------------------
  // 14 labels a month carry a blank order number. If a blank identifier
  // produced a key, every one of them would collapse onto 'shipment:' and the
  // unique index would make them overwrite each other -- silent data loss
  // wearing idempotency as a disguise. Refusing to build the key is the only
  // safe answer; the caller reports it as unattributed spend instead.
  it('refuses to build a key from a blank identifier', () => {
    expect(() => chargeKey({ chargeType: 'shipping', shipmentId: '' }))
      .toThrow(BlankIdentifierError)
    expect(() => chargeKey({ chargeType: 'shipping', shipmentId: '   ' }))
      .toThrow(BlankIdentifierError)
  })

  it('refuses a null or undefined identifier just as firmly', () => {
    // @ts-expect-error deliberately passing a bad value the DB could yield
    expect(() => chargeKey({ chargeType: 'pick', orderItemId: null }))
      .toThrow(BlankIdentifierError)
    expect(() => chargeKey({ chargeType: 'pick', orderItemId: undefined }))
      .toThrow(BlankIdentifierError)
  })

  it('names the offending field in the error, so the log is actionable', () => {
    expect(() => chargeKey({ chargeType: 'storage', periodMonth: '' }))
      .toThrow(/periodMonth/)
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- charge-key`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `src/lib/ledger/charge-key.ts`:

```ts
/**
 * Deterministic identity for a row in `order_charges`.
 *
 * The monitor cron runs three times a day and recalculates charges each time.
 * An insert-only calculator would therefore triple every charge daily. The key
 * is derived from the record the charge is ABOUT, so the same input always
 * produces the same key and recalculation becomes an upsert.
 *
 * See the ledger spec, section 5.2.
 */

export type ChargeType =
  | 'shipping' | 'pick' | 'pack' | 'material'
  | 'storage' | 'receiving' | 'surcharge' | 'return'

export class BlankIdentifierError extends Error {
  constructor(field: string, chargeType: ChargeType) {
    super(`Cannot build a charge_key for '${chargeType}': ${field} is blank.`)
    this.name = 'BlankIdentifierError'
  }
}

export type ChargeKeyInput =
  | { chargeType: 'shipping' | 'return'; shipmentId: string }
  | { chargeType: 'surcharge'; shipmentId: string; surchargeCode: string }
  | { chargeType: 'pick' | 'pack' | 'receiving'; orderItemId: string }
  | { chargeType: 'material'; orderItemId: string; variant: string }
  | { chargeType: 'storage'; periodMonth: string }

/** Blank, whitespace, null and undefined are all refused. */
function require_(value: unknown, field: string, chargeType: ChargeType): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new BlankIdentifierError(field, chargeType)
  }
  return value.trim()
}

export function chargeKey(input: ChargeKeyInput): string {
  switch (input.chargeType) {
    case 'shipping':
    case 'return':
      return `shipment:${require_(input.shipmentId, 'shipmentId', input.chargeType)}`

    case 'surcharge': {
      const id = require_(input.shipmentId, 'shipmentId', input.chargeType)
      const code = require_(input.surchargeCode, 'surchargeCode', input.chargeType)
      return `shipment:${id}:${code}`
    }

    case 'pick':
    case 'pack':
    case 'receiving':
      return `item:${require_(input.orderItemId, 'orderItemId', input.chargeType)}:${input.chargeType}`

    case 'material': {
      const id = require_(input.orderItemId, 'orderItemId', input.chargeType)
      const variant = require_(input.variant, 'variant', input.chargeType)
      return `item:${id}:material:${variant}`
    }

    case 'storage':
      return `storage:${require_(input.periodMonth, 'periodMonth', input.chargeType)}`
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test -- charge-key`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ledger/charge-key.ts src/lib/ledger/charge-key.test.ts
git commit -m "Give every charge a deterministic key so recalculation stops duplicating"
```

---

## Task 4: Warehouse-local pick dates

Implements spec §5.2. A pick finished at 17:00 Monday is first seen by the 02:00
Tuesday cron, so a watermark set before 06:00 local belongs to the previous
warehouse day.

**Carries Review Focus item 1.**

**Files:**
- Create: `src/lib/ledger/pick-date.ts`
- Test: `src/lib/ledger/pick-date.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `WAREHOUSE_TZ: string` (`'America/New_York'`)
  - `warehouseParts(at: Date, timeZone?: string): { date: string; hour: number }`
  - `watermarkPickDate(observedAt: Date, timeZone?: string): string` — `YYYY-MM-DD`

  Used by Task 12, which stamps `order_items.pick_date` as Zenventory lines
  are persisted.

- [ ] **Step 1: Write the failing test**

Create `src/lib/ledger/pick-date.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { warehouseParts, watermarkPickDate } from '@/lib/ledger/pick-date'

describe('warehouseParts', () => {
  it('reports the local date and hour, not the UTC ones', () => {
    // 2026-09-30T01:30Z is still 2026-09-29 at 21:30 in the warehouse.
    expect(warehouseParts(new Date('2026-09-30T01:30:00Z')))
      .toEqual({ date: '2026-09-29', hour: 21 })
  })
})

describe('watermarkPickDate', () => {
  it('stamps today when the sync runs during the working day', () => {
    // 14:00Z = 10:00 EDT, the mid-day cron.
    expect(watermarkPickDate(new Date('2026-09-29T14:00:00Z'))).toBe('2026-09-29')
  })

  it('stamps today for the last cron of the working day', () => {
    // 20:00Z = 16:00 EDT.
    expect(watermarkPickDate(new Date('2026-09-29T20:00:00Z'))).toBe('2026-09-29')
  })

  it('stamps the PREVIOUS day for the overnight cron', () => {
    // 06:00Z = 02:00 EDT. Nothing is picked at 2am; this run is evidence
    // about the day that just ended.
    expect(watermarkPickDate(new Date('2026-09-29T06:00:00Z'))).toBe('2026-09-28')
  })

  it('treats 05:59 local as the previous day and 06:00 as today', () => {
    expect(watermarkPickDate(new Date('2026-09-29T09:59:00Z'))).toBe('2026-09-28')
    expect(watermarkPickDate(new Date('2026-09-29T10:00:00Z'))).toBe('2026-09-29')
  })

  it('rolls back across a month boundary', () => {
    expect(watermarkPickDate(new Date('2026-10-01T06:00:00Z'))).toBe('2026-09-30')
  })

  it('rolls back across a year boundary', () => {
    expect(watermarkPickDate(new Date('2026-01-01T07:00:00Z'))).toBe('2025-12-31')
  })

  // --- Review Focus item 1 -------------------------------------------------
  // vercel.json schedules in UTC, which is fixed. Eastern is not. The 06:00Z
  // cron is 02:00 EDT in summer but 01:00 EST in winter -- both before 06:00
  // local, so both must roll back. A fixed -4 offset would put the winter run
  // at 02:00 and still work; a fixed -5 offset would put the summer run at
  // 01:00 and still work. The bug only appears if someone computes the date
  // from a stored offset that disagrees with the real one, which is why this
  // must go through Intl and why both seasons are tested.
  it('rolls back correctly in winter, when Eastern is UTC-5', () => {
    expect(watermarkPickDate(new Date('2026-01-15T06:00:00Z'))).toBe('2026-01-14')
  })

  it('handles the autumn transition day itself', () => {
    // 2026-11-01: EDT ends at 02:00 local. 06:00Z is 02:00 EDT -> 01:00 EST.
    expect(watermarkPickDate(new Date('2026-11-01T06:00:00Z'))).toBe('2026-10-31')
  })

  it('handles the spring transition day itself', () => {
    // 2026-03-08: EST ends at 02:00 local, clocks jump to 03:00.
    expect(watermarkPickDate(new Date('2026-03-08T06:00:00Z'))).toBe('2026-03-07')
  })

  it('gives the same answer regardless of the machine timezone', () => {
    // Vercel runs in UTC; a developer laptop does not. The result must not
    // depend on which.
    const at = new Date('2026-09-29T06:00:00Z')
    expect(watermarkPickDate(at, 'America/New_York')).toBe('2026-09-28')
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- pick-date`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `src/lib/ledger/pick-date.ts`:

```ts
/**
 * When did the pick happen?
 *
 * Zenventory gives us no usable pick timestamp -- `completedDate` was empty on
 * all 391 orders sampled -- so the date is derived from when our own sync first
 * observed a picked quantity. See the ledger spec, section 3.5.
 *
 * THE BEFORE-06:00 RULE. The crons in vercel.json fire at 06:00, 14:00 and
 * 20:00 UTC. In the warehouse that is roughly 02:00, 10:00 and 16:00. A pick
 * finished at 17:00 Monday is therefore first seen by the 02:00 Tuesday run, so
 * a watermark set before 06:00 local is evidence about the day that just ended.
 *
 * THIS IS COUPLED TO vercel.json. If the cron times change, this rule changes
 * with them. vercel.json carries a comment pointing back here.
 *
 * ASSUMPTION, NOT MEASUREMENT: that nothing is picked between midnight and 6am.
 * That is Ophir's account of how the warehouse runs, and the data cannot
 * confirm it, because the only pick timestamps available are our own
 * observation times. If a night shift is ever added, this rule silently
 * misdates an entire shift. Recorded here so it can be found on that day.
 */

export const WAREHOUSE_TZ = 'America/New_York'

/** Hour before which a watermark belongs to the previous warehouse day. */
const DAY_START_HOUR = 6

/**
 * The calendar date and hour at `at`, as seen in the warehouse.
 *
 * Uses Intl rather than an offset so it stays correct across both daylight
 * saving transitions. `en-CA` is chosen because it formats as YYYY-MM-DD.
 */
export function warehouseParts(
  at: Date,
  timeZone: string = WAREHOUSE_TZ
): { date: string; hour: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at)

  const get = (type: string) => parts.find(p => p.type === type)?.value ?? ''

  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    hour: Number(get('hour')),
  }
}

/** Subtract one day from a YYYY-MM-DD string without touching timezones. */
function previousDay(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number)
  // Date.UTC handles month and year rollover, including leap years.
  const prev = new Date(Date.UTC(y, m - 1, d - 1))
  return prev.toISOString().slice(0, 10)
}

/**
 * The warehouse day a pick observed at `observedAt` should be credited to.
 * Returns YYYY-MM-DD.
 */
export function watermarkPickDate(
  observedAt: Date,
  timeZone: string = WAREHOUSE_TZ
): string {
  const { date, hour } = warehouseParts(observedAt, timeZone)
  return hour < DAY_START_HOUR ? previousDay(date) : date
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test -- pick-date`
Expected: PASS, 11 tests. If the winter test fails while the summer one passes,
the implementation is using an offset rather than `Intl` — go back to step 3.

- [ ] **Step 5: Point `vercel.json` back at this rule**

The coupling must be discoverable from both ends. In `vercel.json`, the crons
array cannot carry comments (it is strict JSON), so add the note to
`src/app/api/agent/monitor/route.ts` instead, at the top of the file:

```ts
// CRON COUPLING: vercel.json fires this route at 06:00, 14:00 and 20:00 UTC.
// src/lib/ledger/pick-date.ts derives pick dates from those times via a
// before-06:00-local rule. Change the schedule and you must change that rule.
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/ledger/pick-date.ts src/lib/ledger/pick-date.test.ts \
        src/app/api/agent/monitor/route.ts
git commit -m "Derive pick dates in warehouse time, correct across DST"
```

---

## Task 5: SKU classification — device versus component

**Files:**
- Create: `src/lib/billing/classify-sku.ts`
- Test: `src/lib/billing/classify-sku.test.ts`

**Spec:** §5.6.

**Why this is its own task.** A pick charged at component rate when it should be
device rate loses $0.12. That is small per unit and invisible in aggregate,
which is exactly why it needs a test rather than a careful reading. The rule is
two lines of code and the whole task is really about the precedence between the
two signals and about what happens when both are silent.

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  ```ts
  export type SkuClass = 'device' | 'component'
  export type ClassificationSource = 'sku_prefix' | 'category' | 'default'
  export function classifySku(input: { sku: string; category?: string | null }):
    { skuClass: SkuClass; source: ClassificationSource }
  ```
  Task 11 (charge calculation) calls this and stores both returned fields on the
  `order_charges` row as `is_component` and `classification_source`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/billing/classify-sku.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { classifySku } from '@/lib/billing/classify-sku'

describe('classifySku', () => {
  it('classifies an R-prefix SKU as a device', () => {
    expect(classifySku({ sku: 'R144GUSB01S10' }))
      .toEqual({ skuClass: 'device', source: 'sku_prefix' })
  })

  it('classifies a D-prefix SKU as a device', () => {
    expect(classifySku({ sku: 'D200X' }))
      .toEqual({ skuClass: 'device', source: 'sku_prefix' })
  })

  // The measured finding from spec §5.6: category is blank on exactly the two
  // highest-volume readers. If prefix did not win, both would be demoted to
  // component rate and the loss would never surface.
  it('prefers the prefix over a blank category on the two known readers', () => {
    for (const sku of ['R144GUSB01S10', 'R144GUSY01S10']) {
      expect(classifySku({ sku, category: '' }))
        .toEqual({ skuClass: 'device', source: 'sku_prefix' })
    }
  })

  // Precedence, stated as a test rather than as a comment: even an actively
  // wrong category loses to the prefix.
  it('prefers the prefix over a contradicting category', () => {
    expect(classifySku({ sku: 'R144GUSB01S10', category: 'Accessory' }))
      .toEqual({ skuClass: 'device', source: 'sku_prefix' })
  })

  it('falls back to category when the prefix does not recognise the SKU', () => {
    expect(classifySku({ sku: 'CABLE-01', category: 'Device' }))
      .toEqual({ skuClass: 'device', source: 'category' })
  })

  it('matches category case-insensitively', () => {
    expect(classifySku({ sku: 'CABLE-01', category: 'DEVICE' }))
      .toEqual({ skuClass: 'device', source: 'category' })
  })

  it('defaults to component when neither signal fires', () => {
    expect(classifySku({ sku: 'CABLE-01', category: null }))
      .toEqual({ skuClass: 'component', source: 'default' })
    expect(classifySku({ sku: 'CABLE-01' }))
      .toEqual({ skuClass: 'component', source: 'default' })
  })

  // Lower-case SKUs arrive from at least one storefront. Treating 'r144g...'
  // as a component would be a silent 12-cent leak per unit.
  it('matches the prefix case-insensitively', () => {
    expect(classifySku({ sku: 'r144gusb01s10' }))
      .toEqual({ skuClass: 'device', source: 'sku_prefix' })
  })

  it('ignores surrounding whitespace on the SKU', () => {
    expect(classifySku({ sku: '  D200X  ' }))
      .toEqual({ skuClass: 'device', source: 'sku_prefix' })
  })

  // A prefix rule must match a prefix, not a substring. 'XR100' contains an R
  // but does not start with one.
  it('does not match R or D appearing later in the SKU', () => {
    expect(classifySku({ sku: 'XR100' }))
      .toEqual({ skuClass: 'component', source: 'default' })
  })

  it('treats a blank SKU as a component rather than throwing', () => {
    expect(classifySku({ sku: '' }))
      .toEqual({ skuClass: 'component', source: 'default' })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- classify-sku`
Expected: FAIL — `Failed to resolve import "@/lib/billing/classify-sku"`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/billing/classify-sku.ts`:

```ts
// Device versus component, per spec §5.6.
//
// Precedence is SKU prefix, then Zenventory's native `category`, then
// component. The prefix wins deliberately: `category` is blank on
// R144GUSB01S10 and R144GUSY01S10, the two highest-volume readers, so a
// category-first rule would demote both to the lower pick rate and the
// shortfall would never appear anywhere as an error.

export type SkuClass = 'device' | 'component'
export type ClassificationSource = 'sku_prefix' | 'category' | 'default'

const DEVICE_PREFIXES = ['R', 'D'] as const

export function classifySku(input: {
  sku: string
  category?: string | null
}): { skuClass: SkuClass; source: ClassificationSource } {
  const sku = (input.sku ?? '').trim().toUpperCase()

  if (DEVICE_PREFIXES.some((p) => sku.startsWith(p))) {
    return { skuClass: 'device', source: 'sku_prefix' }
  }

  const category = (input.category ?? '').trim().toLowerCase()
  if (category === 'device') {
    return { skuClass: 'device', source: 'category' }
  }
  if (category === 'component' || category === 'accessory') {
    return { skuClass: 'component', source: 'category' }
  }

  return { skuClass: 'component', source: 'default' }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- classify-sku`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/billing/classify-sku.ts src/lib/billing/classify-sku.test.ts
git commit -m "Classify SKUs by prefix, with category as fallback"
```

---

## Task 6: Labour variance against a held standard

**Files:**
- Create: `src/lib/ledger/variance.ts`
- Test: `src/lib/ledger/variance.test.ts`

**Spec:** §5.3.2.

**The trap this task exists to avoid.** The natural way to write this is
`standardRate = payroll / picks`, and then variance is `payroll - standardRate *
picks`, which is identically zero for every input. The code would run, the
dashboard would show a tidy $0.00, and the number would be meaningless. The
standard rate must be **held** — baselined once, stored in `cost_rates`, and
passed in — so that when payroll and the standard disagree the difference
surfaces. The first test below is written specifically so that a
divide-to-derive implementation cannot pass it.

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  ```ts
  export interface VarianceInput {
    actualCost: number | null   // e.g. payroll for the month
    standardRate: number | null // HELD rate from cost_rates, never derived here
    quantity: number
  }
  export interface VarianceResult {
    absorbed: number | null   // standardRate * quantity
    variance: number | null   // actualCost - absorbed; positive = overspend
    basis: 'measured' | 'estimated' | 'unavailable'
  }
  export function labourVariance(input: VarianceInput): VarianceResult
  ```
  **Task 19 is the only caller.** It reads the three measured inputs from the
  `labour_variance_inputs` view and runs them through this function, so the
  subtraction has exactly one implementation. Task 19 must render a `null`
  `variance` as "not computable — payroll not entered", never as `0`: a zero
  variance and an unknown variance look the same on screen and mean opposite
  things.

- [ ] **Step 1: Write the failing test**

Create `src/lib/ledger/variance.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { labourVariance } from '@/lib/ledger/variance'

describe('labourVariance', () => {
  // THE LOAD-BEARING TEST. An implementation that derives the standard rate
  // from actualCost / quantity returns 0 here. It must return 400.
  it('is non-zero when payroll and the held standard disagree', () => {
    const r = labourVariance({
      actualCost: 5000,
      standardRate: 0.23,
      quantity: 20000,
    })
    expect(r.absorbed).toBeCloseTo(4600, 6)
    expect(r.variance).toBeCloseTo(400, 6)
    expect(r.basis).toBe('measured')
  })

  it('reports a negative variance when we spent less than standard', () => {
    const r = labourVariance({
      actualCost: 4000,
      standardRate: 0.23,
      quantity: 20000,
    })
    expect(r.variance).toBeCloseTo(-600, 6)
  })

  it('is exactly zero only when the two genuinely agree', () => {
    const r = labourVariance({
      actualCost: 4600,
      standardRate: 0.23,
      quantity: 20000,
    })
    expect(r.variance).toBeCloseTo(0, 6)
    expect(r.basis).toBe('measured')
  })

  // The payroll figure is one of the four inputs that arrive later. Until it
  // does, the honest answer is null, not zero. Zero would read on the
  // dashboard as "no labour leak", which is a claim we cannot make yet.
  it('returns null variance, not zero, when payroll has not arrived', () => {
    const r = labourVariance({
      actualCost: null,
      standardRate: 0.23,
      quantity: 20000,
    })
    expect(r.absorbed).toBeCloseTo(4600, 6)
    expect(r.variance).toBeNull()
    expect(r.basis).toBe('unavailable')
  })

  // Symmetric case: the rate card has not been baselined yet.
  it('returns null absorbed and null variance when the standard is missing', () => {
    const r = labourVariance({
      actualCost: 5000,
      standardRate: null,
      quantity: 20000,
    })
    expect(r.absorbed).toBeNull()
    expect(r.variance).toBeNull()
    expect(r.basis).toBe('unavailable')
  })

  // A held standard of exactly zero is a real, deliberate value — a free
  // operation — and is NOT the same as an absent one. This is the scalar
  // half of Review Focus item 4; Task 13 covers the database half.
  it('treats a standard rate of zero as a real rate, not a missing one', () => {
    const r = labourVariance({
      actualCost: 500,
      standardRate: 0,
      quantity: 20000,
    })
    expect(r.absorbed).toBeCloseTo(0, 6)
    expect(r.variance).toBeCloseTo(500, 6)
    expect(r.basis).toBe('measured')
  })

  // A month with no picks absorbs nothing, so every dollar of payroll is
  // variance. That is the correct answer and must not be special-cased away.
  it('reports all payroll as variance in a month with no picks', () => {
    const r = labourVariance({
      actualCost: 5000,
      standardRate: 0.23,
      quantity: 0,
    })
    expect(r.absorbed).toBeCloseTo(0, 6)
    expect(r.variance).toBeCloseTo(5000, 6)
  })

  it('refuses a negative quantity rather than inventing negative absorption', () => {
    expect(() => labourVariance({
      actualCost: 5000, standardRate: 0.23, quantity: -5,
    })).toThrow(/quantity/i)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- variance`
Expected: FAIL — `Failed to resolve import "@/lib/ledger/variance"`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/ledger/variance.ts`:

```ts
// Standard-cost variance, per spec §5.3.2.
//
// `standardRate` is HELD: it is baselined once into cost_rates and read from
// there. It is never computed as actualCost / quantity. Deriving it that way
// makes variance identically zero for every input, which is the failure this
// module was written to prevent — see the first test in variance.test.ts.
//
// Null in, null out. A missing payroll figure or a missing held rate means the
// answer is not yet known, which is a different claim from "no leak". The
// callers render null as "not yet known".

export interface VarianceInput {
  actualCost: number | null
  standardRate: number | null
  quantity: number
}

export interface VarianceResult {
  absorbed: number | null
  variance: number | null
  basis: 'measured' | 'estimated' | 'unavailable'
}

export function labourVariance(input: VarianceInput): VarianceResult {
  const { actualCost, standardRate, quantity } = input

  if (!Number.isFinite(quantity) || quantity < 0) {
    throw new RangeError(`labourVariance: quantity must be >= 0, got ${quantity}`)
  }

  // `== null` is deliberate: it catches null and undefined while letting a
  // genuine 0 through as a real rate.
  const absorbed = standardRate == null ? null : standardRate * quantity

  if (absorbed == null || actualCost == null) {
    return { absorbed, variance: null, basis: 'unavailable' }
  }

  return { absorbed, variance: actualCost - absorbed, basis: 'measured' }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- variance`
Expected: PASS, 8 tests. If the first test reports `variance: 0`, the
implementation is deriving the standard rate instead of holding it.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ledger/variance.ts src/lib/ledger/variance.test.ts
git commit -m "Compute labour variance against a held standard rate"
```

---

## Task 7: Migration 1 — orders, order items, store map, sync runs

**Files:**
- Create: `supabase/ledger_01_orders.sql`
- Create: `supabase/verify/ledger_01_verify.sql`

**Spec:** §5.2.

**How migrations work in this repo — read this before starting.** There is no
migration runner. `supabase/` holds hand-applied `.sql` files and someone pastes
them into the Supabase SQL editor. That has two consequences for every migration
task in this plan:

1. **The file must be idempotent.** Assume it will be run twice, because
   sooner or later it will be. Use `create table if not exists`, `create index
   if not exists`, and wrap constraint additions in a `do $$ ... $$` guard.
2. **You cannot verify it yourself.** Each migration ships with a companion
   verification script under `supabase/verify/`. Applying the migration and
   running the verification is Ophir's step, not yours. Write the file, commit
   it, and hand it over with the exact instruction below. Do not proceed to the
   task that depends on it until he confirms the verification passed.

**Interfaces:**
- Consumes: existing `clients(id)`.
- Produces: tables `client_store_ids`, `orders`, `order_items`, `sync_runs`.
  Task 9 references `orders(id)` and `order_items(id)`. Task 10 writes
  `order_items.pick_date` and `pick_date_source`. Task 14 writes `sync_runs`.

- [ ] **Step 1: Write the migration**

Create `supabase/ledger_01_orders.sql`:

```sql
-- Complete the ledger, migration 1 of 4: the order side.
-- Spec: docs/superpowers/specs/2026-09-29-complete-the-ledger-design.md §5.2
-- Apply order: ledger_01_orders -> ledger_02_cost -> ledger_03_charges
--              -> ledger_04_views
-- Safe to run more than once.

-- One ShipStation store belongs to exactly one client. The unique index is on
-- store_id alone, not (client_id, store_id): the whole point is that a store
-- cannot map two ways.
create table if not exists client_store_ids (
  id         uuid primary key default uuid_generate_v4(),
  client_id  uuid not null references clients(id),
  store_id   text not null,
  store_name text,
  created_at timestamptz default now()
);
create unique index if not exists client_store_ids_store_id_key
  on client_store_ids (store_id);

-- An order exists whether or not it ever becomes a shipment. This is the
-- anchor the whole ledger hangs from.
create table if not exists orders (
  id             uuid primary key default uuid_generate_v4(),
  client_id      uuid references clients(id),
  order_key      text not null,
  order_number   text not null,
  source         text not null,
  order_date     date,
  cancelled      boolean default false,
  cancelled_date date,
  created_at     timestamptz default now()
);

-- Two partial indexes, not one. `unique (client_id, order_key)` does not
-- constrain rows where client_id is null, because NULLs are distinct in SQL,
-- so unattributed orders would duplicate silently on every run.
create unique index if not exists orders_client_order_key
  on orders (client_id, order_key) where client_id is not null;
create unique index if not exists orders_source_order_key
  on orders (source, order_key) where client_id is null;
create index if not exists orders_order_date_idx on orders (order_date);

-- One row per line. line_ordinal exists because the sync deletes and reinserts
-- lines, which destroys the UUID a watermark is stored against; and SKU alone
-- is not a key, because kits repeat the same SKU on several lines.
create table if not exists order_items (
  id                    uuid primary key default uuid_generate_v4(),
  order_id              uuid references orders(id) on delete cascade,
  source                text not null,
  line_ordinal          int  not null,
  sku                   text,
  description           text,
  quantity_ordered      numeric(10,2),
  quantity_picked       numeric(10,2),
  is_component          boolean,
  classification_source text,
  pick_date             date,
  pick_date_source      text,
  is_estimate           boolean default false,
  unique (order_id, source, line_ordinal)
);
create index if not exists order_items_pick_date_idx
  on order_items (pick_date) where pick_date is not null;
create index if not exists order_items_sku_idx on order_items (sku);

-- Records each run so that a missed day is detectable rather than silently
-- becoming a gap in the pick history. client_id is per-row because Zenventory
-- syncs per client and a 401 on one client must be recordable without marking
-- the whole run failed.
create table if not exists sync_runs (
  id               uuid primary key default uuid_generate_v4(),
  source           text not null,
  client_id        uuid references clients(id),
  mode             text not null,
  window_start     date,
  window_end       date,
  started_at       timestamptz not null default now(),
  finished_at      timestamptz,
  status           text not null,
  rows_seen        int default 0,
  rows_written     int default 0,
  unpriced_before  int,
  unpriced_after   int,
  errors           jsonb default '[]'::jsonb,
  created_at       timestamptz default now()
);
create index if not exists sync_runs_source_started_idx
  on sync_runs (source, started_at desc);
```

- [ ] **Step 2: Write the verification script**

Create `supabase/verify/ledger_01_verify.sql`. This is not decoration: the two
partial indexes on `orders` are the part most likely to be typed wrong, and a
missing one fails silently by allowing duplicates rather than by erroring.

```sql
-- Verifies ledger_01_orders.sql. Run AFTER applying it.
-- Every statement below should print 'PASS'. Rolls itself back.
begin;

-- The unattributed-order index is the one that matters. If it is missing,
-- this second insert succeeds and the ledger will double-count.
insert into orders (client_id, order_key, order_number, source)
  values (null, 'VERIFY-1', 'VERIFY-1', 'shipstation');
do $$
begin
  begin
    insert into orders (client_id, order_key, order_number, source)
      values (null, 'VERIFY-1', 'VERIFY-1', 'shipstation');
    raise exception 'FAIL: duplicate unattributed order was accepted';
  exception when unique_violation then
    raise notice 'PASS: unattributed orders are constrained';
  end;
end $$;

-- Line identity is (order_id, source, line_ordinal), so the same SKU may
-- legitimately repeat on two lines of a kit.
do $$
declare oid uuid;
begin
  select id into oid from orders where order_key = 'VERIFY-1';
  insert into order_items (order_id, source, line_ordinal, sku)
    values (oid, 'zenventory', 1, 'KIT-A'), (oid, 'zenventory', 2, 'KIT-A');
  raise notice 'PASS: a repeated SKU on two lines is accepted';
  begin
    insert into order_items (order_id, source, line_ordinal, sku)
      values (oid, 'zenventory', 1, 'KIT-A');
    raise exception 'FAIL: duplicate line_ordinal was accepted';
  exception when unique_violation then
    raise notice 'PASS: line_ordinal is unique per order and source';
  end;
end $$;

-- A store must not map to two clients.
do $$
declare cid uuid;
begin
  select id into cid from clients limit 1;
  insert into client_store_ids (client_id, store_id) values (cid, 'VERIFY-STORE');
  begin
    insert into client_store_ids (client_id, store_id) values (cid, 'VERIFY-STORE');
    raise exception 'FAIL: a store mapped twice';
  exception when unique_violation then
    raise notice 'PASS: store_id is globally unique';
  end;
end $$;

rollback;
```

- [ ] **Step 3: Commit, then hand over for application**

```bash
git add supabase/ledger_01_orders.sql supabase/verify/ledger_01_verify.sql
git commit -m "Add ledger migration 1: orders, order items, store map, sync runs"
```

Then say to Ophir, in these words:

> Migration 1 is ready at `supabase/ledger_01_orders.sql`. Please paste it into
> the Supabase SQL editor and run it, then run
> `supabase/verify/ledger_01_verify.sql` and tell me whether every line printed
> PASS. The verification rolls itself back and writes nothing. I will not start
> Task 9 until you confirm.

Stop here and wait. Tasks 9, 10 and 11 all write to these tables; starting them
against a schema that was never applied produces code that cannot be run.

---

## Task 8: Migration 2 — the cost side

**Files:**
- Create: `supabase/ledger_02_cost.sql`
- Create: `supabase/verify/ledger_02_verify.sql`

**Spec:** §5.2, "New: the cost side".

**Depends on:** nothing in Task 7 structurally, but apply it second so the
numbering matches the order `order_charges` needs (`cost_rates` must exist
before Task 9's `cost_rate_id` foreign key).

**The one part that is easy to get wrong.** `cost_rates` needs an exclusion
constraint, not just a unique index. The unique index constrains
`effective_from` alone, which does nothing to stop a row whose `effective_to`
overruns the next row's start. Two rates would then match the same
`charge_date`, a charge would take whichever the planner happened to return
first, and margin would change between runs with no input changing. The
exclusion constraint needs the `btree_gist` extension, which must be created in
the same file or the constraint fails with a confusing operator-class error.

**Interfaces:**
- Consumes: nothing.
- Produces: tables `cost_rates`, `operating_costs`. Task 9 references
  `cost_rates(id)`. Task 11 looks rates up by `charge_date`. Task 13 tests the
  null-versus-zero distinction against this table.

- [ ] **Step 1: Write the migration**

Create `supabase/ledger_02_cost.sql`:

```sql
-- Complete the ledger, migration 2 of 4: the cost side.
-- Spec: docs/superpowers/specs/2026-09-29-complete-the-ledger-design.md §5.2
-- Safe to run more than once.

-- Required by the exclusion constraint below: it mixes equality (=) on text
-- with overlap (&&) on a range, and plain btree cannot do that.
create extension if not exists btree_gist;

-- What a thing costs US, effective-dated. Every lookup is by charge_date, not
-- by now(), so that a rate change does not rewrite last month's margin.
create table if not exists cost_rates (
  id             uuid primary key default uuid_generate_v4(),
  cost_type      text not null,
  variant        text,
  unit           text not null,
  rate           numeric(10,4) not null,
  effective_from date not null,
  effective_to   date,
  basis          text not null,
  note           text,
  created_at     timestamptz default now()
);
create unique index if not exists cost_rates_type_variant_from
  on cost_rates (cost_type, coalesce(variant, ''), effective_from);

-- Two rates for the same thing must never cover the same day. Without this,
-- charge calculation is non-deterministic.
do $$
begin
  alter table cost_rates add constraint cost_rates_no_overlap
    exclude using gist (
      cost_type            with =,
      coalesce(variant,'') with =,
      daterange(effective_from, effective_to, '[)') with &&
    );
exception when duplicate_object then
  raise notice 'cost_rates_no_overlap already present';
end $$;

-- The monthly bills. `allocation` decides whether a cost is pushed down to
-- individual orders or only subtracted at the top.
create table if not exists operating_costs (
  id           uuid primary key default uuid_generate_v4(),
  period_month date not null,
  category     text not null,
  vendor       text,
  amount       numeric(12,2) not null,
  allocation   text not null default 'overhead',
  note         text,
  created_at   timestamptz default now()
);
create unique index if not exists operating_costs_month_category_vendor
  on operating_costs (period_month, category, coalesce(vendor, ''));
create index if not exists operating_costs_month_idx
  on operating_costs (period_month);
```

- [ ] **Step 2: Write the verification script**

Create `supabase/verify/ledger_02_verify.sql`:

```sql
-- Verifies ledger_02_cost.sql. Run AFTER applying it. Rolls itself back.
begin;

-- Adjacent ranges must be allowed: '[)' means effective_to is exclusive, so a
-- rate ending 2026-02-01 and one starting 2026-02-01 do not overlap.
insert into cost_rates (cost_type, variant, unit, rate, effective_from, effective_to, basis)
  values ('pick', 'device', 'per_unit', 0.2300, '2026-01-01', '2026-02-01', 'estimated');
insert into cost_rates (cost_type, variant, unit, rate, effective_from, effective_to, basis)
  values ('pick', 'device', 'per_unit', 0.2500, '2026-02-01', null, 'estimated');
do $$ begin raise notice 'PASS: adjacent effective ranges are accepted'; end $$;

-- Overlapping ranges must not be.
do $$
begin
  begin
    insert into cost_rates (cost_type, variant, unit, rate, effective_from, effective_to, basis)
      values ('pick', 'device', 'per_unit', 0.2900, '2026-01-15', '2026-03-01', 'estimated');
    raise exception 'FAIL: overlapping cost rates were accepted';
  exception when exclusion_violation then
    raise notice 'PASS: overlapping cost rates are rejected';
  end;
end $$;

-- A different variant is a different thing and may overlap freely.
insert into cost_rates (cost_type, variant, unit, rate, effective_from, effective_to, basis)
  values ('pick', 'component', 'per_unit', 0.2000, '2026-01-15', '2026-03-01', 'estimated');
do $$ begin raise notice 'PASS: a different variant may overlap'; end $$;

-- A null variant must behave as one value, not as "matches nothing".
insert into cost_rates (cost_type, variant, unit, rate, effective_from, basis)
  values ('storage', null, 'per_pallet_month', 12.0000, '2026-01-01', 'estimated');
do $$
begin
  begin
    insert into cost_rates (cost_type, variant, unit, rate, effective_from, basis)
      values ('storage', null, 'per_pallet_month', 14.0000, '2026-02-01', 'estimated');
    raise exception 'FAIL: two open-ended null-variant rates overlap and were accepted';
  exception when exclusion_violation then
    raise notice 'PASS: null variant is treated as a single value';
  end;
end $$;

rollback;
```

That last block is the one worth reading twice. `coalesce(variant,'')` inside
the constraint is what makes two null-variant rows collide; without it, `null <>
null` and the constraint would let both open-ended storage rates sit on top of
each other.

- [ ] **Step 3: Commit, then hand over for application**

```bash
git add supabase/ledger_02_cost.sql supabase/verify/ledger_02_verify.sql
git commit -m "Add ledger migration 2: cost rates and operating costs"
```

Then say to Ophir:

> Migration 2 is ready at `supabase/ledger_02_cost.sql`. Same routine: apply it,
> then run `supabase/verify/ledger_02_verify.sql` and tell me whether every line
> printed PASS. If `create extension btree_gist` fails on permissions, stop and
> tell me — the overlap constraint depends on it and I would rather change the
> approach than ship without it.

---

## Task 9: Migration 3 — charges, and a real key for shipments

**Files:**
- Create: `supabase/ledger_03_charges.sql`
- Create: `supabase/verify/ledger_03_verify.sql`

**Spec:** §5.2 (`order_charges`), §6 (`client_warehouse_rates`), §5.2
(`zone_chart`).

**Depends on:** Task 7 applied (`orders`) and Task 8 applied (`cost_rates`).
Both are referenced by foreign key here, so this migration errors immediately if
either is missing — which is the behaviour we want.

**Why `shipments` is touched here.** The sync currently matches on
`order_number`, which is not unique: 776 of the 1,095 shipments in a 30-day
window were invisible behind the carrier filter, and among them order numbers
repeat for multi-package orders, reships and return labels. ShipStation's own
`shipmentId` is the only stable identity available, and the `shipments` table
has no column for it. Adding the column is a schema change, so it belongs in a
migration, but it is only *used* in Task 10.

The column is added nullable and backfilled from `raw_data`, which already holds
the full payload — no API call is needed. The unique index is created **after**
the backfill and is partial, so that any row whose `raw_data` somehow lacks a
`shipmentId` stays out of the way rather than blocking the whole migration.

**Interfaces:**
- Consumes: `orders(id)`, `clients(id)`, `cost_rates(id)`,
  `client_warehouse_rates(id)`, `shipments`.
- Produces: table `order_charges`; column
  `shipments.shipstation_shipment_id bigint`; `client_warehouse_rates` extended
  with `category`, `label`, `rate_type`, `description`, `effective_from`,
  `effective_to`, and a nullable `rate`; `zone_chart.carrier`.
  Task 10 writes `shipstation_shipment_id`. Task 14 writes `order_charges`.
  Task 15's views read `order_charges`.

- [ ] **Step 1: Write the migration**

Create `supabase/ledger_03_charges.sql`:

```sql
-- Complete the ledger, migration 3 of 4: the charge record.
-- Spec: docs/superpowers/specs/2026-09-29-complete-the-ledger-design.md §5.2, §6
-- Requires ledger_01_orders.sql and ledger_02_cost.sql to have been applied.
-- Safe to run more than once.

-- ---------------------------------------------------------------------------
-- A stable identity for shipments.
-- order_number is not unique: multi-package orders, reships and return labels
-- all repeat it. ShipStation's shipmentId is the only stable key available.
-- ---------------------------------------------------------------------------
alter table shipments add column if not exists shipstation_shipment_id bigint;

-- Backfill from the payload we already store. No API call needed.
update shipments
set shipstation_shipment_id = (raw_data->>'shipmentId')::bigint
where shipstation_shipment_id is null
  and raw_data ? 'shipmentId'
  and raw_data->>'shipmentId' ~ '^[0-9]+$';

-- Partial, so rows with no shipmentId do not block the index. If this fails
-- with a unique violation, the database already holds duplicate shipment rows
-- from the insert-path defect (spec §3.2) and they must be reconciled before
-- this migration can complete. Stop and report rather than dropping the index.
create unique index if not exists shipments_shipstation_id_key
  on shipments (shipstation_shipment_id)
  where shipstation_shipment_id is not null;

-- ---------------------------------------------------------------------------
-- The margin record: the one table carrying both what we charged and what it
-- cost.
-- ---------------------------------------------------------------------------
create table if not exists order_charges (
  id                 uuid primary key default uuid_generate_v4(),
  order_id           uuid references orders(id) on delete cascade,
  client_id          uuid references clients(id),
  rate_id            uuid references client_warehouse_rates(id),
  cost_rate_id       uuid references cost_rates(id),
  charge_key         text not null,
  charge_type        text not null,
  label              text not null,
  quantity           numeric(10,2),
  unit_rate          numeric(10,4),
  amount             numeric(10,2) not null,
  cost               numeric(10,2),
  cost_basis         text,
  charge_date        date not null,
  charge_date_source text,
  source             text not null,
  is_estimate        boolean default false,
  calculated_at      timestamptz default now()
);

-- Two partial unique indexes, for the same reason `orders` needed two. Not
-- every charge belongs to an order: storage is billed monthly against a client,
-- and unattributed label spend belongs to neither. A single
-- unique (order_id, charge_key) would not constrain those rows at all, so the
-- one category of charge that CANNOT be re-derived from an order document would
-- be the one silently duplicated three times a day.
create unique index if not exists order_charges_order_key
  on order_charges (order_id, charge_key) where order_id is not null;
create unique index if not exists order_charges_client_key
  on order_charges (client_id, charge_key) where order_id is null;

create index if not exists order_charges_order_idx on order_charges (order_id);
create index if not exists order_charges_client_date_idx
  on order_charges (client_id, charge_date);
create index if not exists order_charges_type_date_idx
  on order_charges (charge_type, charge_date);
-- The stale-delete in Task 14 scans by (order_id, calculated_at).
create index if not exists order_charges_calculated_idx
  on order_charges (calculated_at);

-- ---------------------------------------------------------------------------
-- The client rate card gains structure and effective dates.
-- ---------------------------------------------------------------------------
alter table client_warehouse_rates add column if not exists category       text;
alter table client_warehouse_rates add column if not exists label          text;
alter table client_warehouse_rates add column if not exists rate_type      text;
alter table client_warehouse_rates add column if not exists description    text;
alter table client_warehouse_rates add column if not exists effective_from date;
alter table client_warehouse_rates add column if not exists effective_to   date;

-- `category` and `label` are the QUOTE's words, kept for display. `charge_type`
-- and `variant` are the CALCULATOR's words, used for lookup. They have to be
-- separate columns: Task 14 looks a rate up by (charge_type, variant), and
-- without these it would have to string-match on
-- 'Device pick + serial number scan' — which breaks the first time another
-- client's quote words the same service differently.
alter table client_warehouse_rates add column if not exists charge_type text;
alter table client_warehouse_rates add column if not exists variant     text;

create index if not exists client_warehouse_rates_lookup_idx
  on client_warehouse_rates (client_id, charge_type, variant, effective_from);

-- `at_cost` lines have no rate of their own: the amount is whatever the carrier
-- charged. Without dropping NOT NULL they cannot be expressed at all, and the
-- workaround — storing 0 — would read as "free", which is the exact
-- null-versus-zero confusion this project exists to stop.
do $$
begin
  alter table client_warehouse_rates alter column rate drop not null;
exception when others then
  raise notice 'client_warehouse_rates.rate was already nullable';
end $$;

-- `service_type` is `not null` in the original schema with no default, and its
-- four permitted values ('pick_pack', 'storage', 'receiving', 'special_task')
-- do not cover the eighteen quote lines. Left as it is, EVERY insert in Task 16
-- fails on a not-null violation. It is superseded by `charge_type` and kept
-- only so existing rows, and anything still reading it, are not broken.
do $$
begin
  alter table client_warehouse_rates alter column service_type drop not null;
exception when others then
  raise notice 'client_warehouse_rates.service_type was already nullable';
end $$;

-- ---------------------------------------------------------------------------
-- The zone chart holds a UPS chart. Now that UPS traffic is visible, a USPS
-- chart will need to sit BESIDE it, not replace it.
-- ---------------------------------------------------------------------------
alter table zone_chart add column if not exists carrier text;
update zone_chart set carrier = 'UPS' where carrier is null;
```

**One line in there is load-bearing and easy to skim past.** The
`update zone_chart set carrier = 'UPS'` assumes every existing row is a UPS row.
That was verified earlier in this project: the existing chart is a correct UPS
chart. It also means `scripts/proposed-zone-chart-198.sql` Section B must never
be run — it would overwrite correct UPS data with USPS values. If you find
yourself reaching for that file, stop.

- [ ] **Step 2: Write the verification script**

Create `supabase/verify/ledger_03_verify.sql`:

```sql
-- Verifies ledger_03_charges.sql. Run AFTER applying it. Rolls itself back.
begin;

-- The client-keyed index is the one that protects storage and unattributed
-- spend. If it is missing, three crons a day triple those charges.
do $$
declare cid uuid;
begin
  select id into cid from clients limit 1;
  insert into order_charges
    (order_id, client_id, charge_key, charge_type, label, amount, charge_date, source)
    values (null, cid, 'storage:2026-09-01', 'storage', 'Storage', 100, '2026-09-01', 'verify');
  begin
    insert into order_charges
      (order_id, client_id, charge_key, charge_type, label, amount, charge_date, source)
      values (null, cid, 'storage:2026-09-01', 'storage', 'Storage', 100, '2026-09-01', 'verify');
    raise exception 'FAIL: a duplicate order-less charge was accepted';
  exception when unique_violation then
    raise notice 'PASS: order-less charges are constrained by (client_id, charge_key)';
  end;
end $$;

-- And the order-keyed one.
do $$
declare oid uuid; cid uuid;
begin
  select id into cid from clients limit 1;
  insert into orders (client_id, order_key, order_number, source)
    values (cid, 'VERIFY-3', 'VERIFY-3', 'zenventory') returning id into oid;
  insert into order_charges
    (order_id, client_id, charge_key, charge_type, label, amount, charge_date, source)
    values (oid, cid, 'shipment:999', 'shipping', 'Shipping', 8.20, '2026-09-01', 'verify');
  begin
    insert into order_charges
      (order_id, client_id, charge_key, charge_type, label, amount, charge_date, source)
      values (oid, cid, 'shipment:999', 'shipping', 'Shipping', 8.20, '2026-09-01', 'verify');
    raise exception 'FAIL: a duplicate order charge was accepted';
  exception when unique_violation then
    raise notice 'PASS: order charges are constrained by (order_id, charge_key)';
  end;
end $$;

-- An at-cost rate line must be expressible with no rate at all.
do $$
declare cid uuid;
begin
  select id into cid from clients limit 1;
  insert into client_warehouse_rates (client_id, rate_type, label, rate)
    values (cid, 'at_cost', 'Carrier freight at cost', null);
  raise notice 'PASS: client_warehouse_rates.rate accepts null';
exception when not_null_violation then
  raise exception 'FAIL: rate is still NOT NULL; at-cost lines cannot be stored';
end $$;

-- How much of the shipment backfill actually landed. Not an assertion — a
-- number to report back, because it sizes the duplicate-row problem.
select count(*)                                    as shipments_total,
       count(shipstation_shipment_id)              as with_shipment_id,
       count(*) - count(shipstation_shipment_id)   as missing_shipment_id
from shipments;

rollback;
```

- [ ] **Step 3: Commit, then hand over for application**

```bash
git add supabase/ledger_03_charges.sql supabase/verify/ledger_03_verify.sql
git commit -m "Add ledger migration 3: order charges and a stable shipment key"
```

Then say to Ophir:

> Migration 3 is ready at `supabase/ledger_03_charges.sql`. Apply it, then run
> `supabase/verify/ledger_03_verify.sql`. Two things I need back: whether every
> line printed PASS, and the three numbers from the final `select` —
> shipments_total, with_shipment_id, missing_shipment_id. If the migration
> itself fails on `shipments_shipstation_id_key` with a unique violation, that
> means the duplicate-insert defect has already written duplicate rows and we
> need to clean those up before going further. Send me the error and stop.

---

## Task 10: Make the ShipStation sync correct, with the filter still on

**Files:**
- Create: `src/lib/ledger/sync-run.ts`
- Test: `src/lib/ledger/sync-run.test.ts`
- Modify: `src/lib/sync/shipstation.ts` (whole file)

**Spec:** §3.2, §5.5 steps 1–4.

**Depends on:** Tasks 2 (`sourceForCarrier`), 7 and 9 applied.

**Read this before touching the file.** This task fixes four defects while
deliberately leaving `carrierCode: 'stamps_com'` in place. That is not an
oversight and not laziness — it is the whole point of splitting this from Task
11. Dropping the filter multiplies the row count by 3.4×. If the fixes and the
widening ship together and something breaks, there is no way to tell which
caused it. Fix first against the traffic we already handle, confirm it is
stable, then widen.

The four defects, each verified against the current source:

1. **Line 28–32: the match discards its error.** `.single()` returns
   `{ data: null, error: PGRST116 }` when more than one row matches — it does
   not throw. The error is destructured away, `existingShipment` is `null`, the
   `if` at line 76 is false, and control reaches `.insert()` at line 114. **The
   sync inserts a duplicate, silently, on every run.** This is already
   happening, today, on the 14 blank-order-number labels.
2. **Line 82: `diff > 0.01` makes refunds unrecordable.** A cost *decrease* —
   which is what a void or a refund looks like — fails the test and is never
   written to `rate_adjustments`. We can see money leave and not see it come
   back.
3. **Line 72: `source: 'stamps'` is hardcoded.** Harmless while the filter is
   on. The moment Task 11 lands, every UPS label is labelled a Stamps.com
   label.
4. **Line 117: `catch {}` counts errors without keeping any of them.**
   `results.errors++` tells you something failed and nothing else.

**Interfaces:**
- Consumes: `sourceForCarrier` from Task 2.
- Produces:
  ```ts
  // src/lib/ledger/sync-run.ts
  export interface SyncRunHandle {
    id: string | null
    seen(n?: number): void
    wrote(n?: number): void
    fail(context: string, err: unknown): void
    close(status?: 'ok' | 'partial' | 'failed'): Promise<void>
  }
  export function collectErrors(): {
    push(context: string, err: unknown): void
    list(): Array<{ context: string; message: string }>
    count(): number
  }
  export async function openSyncRun(input: {
    source: string
    clientId?: string | null
    mode: 'backfill' | 'live'
    windowStart?: string | null
    windowEnd?: string | null
  }): Promise<SyncRunHandle>
  ```
  Task 12 opens one `sync_runs` row per Zenventory client using the same
  helper.

- [ ] **Step 1: Write the failing test for the error collector**

Only `collectErrors` is unit-testable here; `openSyncRun` writes to Supabase and
is exercised by the manual check in step 6. Splitting the collector out is what
makes the interesting half testable at all.

Create `src/lib/ledger/sync-run.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { collectErrors } from '@/lib/ledger/sync-run'

describe('collectErrors', () => {
  it('starts empty', () => {
    const e = collectErrors()
    expect(e.count()).toBe(0)
    expect(e.list()).toEqual([])
  })

  it('keeps the message of an Error, not just a count', () => {
    const e = collectErrors()
    e.push('shipment 123', new Error('duplicate key'))
    expect(e.count()).toBe(1)
    expect(e.list()[0]).toEqual({ context: 'shipment 123', message: 'duplicate key' })
  })

  // Supabase returns error objects, not Error instances. `String(err)` on one
  // yields '[object Object]', which is exactly as useless as the bare catch
  // this replaces.
  it('extracts .message from a Supabase-style error object', () => {
    const e = collectErrors()
    e.push('row 9', { message: 'PGRST116: multiple rows returned', code: 'PGRST116' })
    expect(e.list()[0].message).toContain('PGRST116')
  })

  it('does not produce [object Object] for an unrecognised value', () => {
    const e = collectErrors()
    e.push('row 9', { weird: true })
    expect(e.list()[0].message).not.toContain('[object Object]')
    expect(e.list()[0].message).toContain('weird')
  })

  it('survives a thrown string and a thrown null', () => {
    const e = collectErrors()
    e.push('a', 'plain string failure')
    e.push('b', null)
    expect(e.count()).toBe(2)
    expect(e.list()[0].message).toBe('plain string failure')
    expect(e.list()[1].message).toBe('null')
  })

  // A run that fails on every one of 1,095 rows must not write a 1,095-entry
  // JSON blob into sync_runs.errors. The cap keeps the column readable; the
  // count stays exact.
  it('caps the stored list at 50 but keeps counting', () => {
    const e = collectErrors()
    for (let i = 0; i < 200; i++) e.push(`row ${i}`, new Error('boom'))
    expect(e.count()).toBe(200)
    expect(e.list()).toHaveLength(50)
    expect(e.list()[0].context).toBe('row 0')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- sync-run`
Expected: FAIL — `Failed to resolve import "@/lib/ledger/sync-run"`.

- [ ] **Step 3: Write `src/lib/ledger/sync-run.ts`**

```ts
import { supabaseAdmin } from '@/lib/supabase'

// A sync run that fails silently is indistinguishable from one that had
// nothing to do. sync_runs makes the difference recordable, and collectErrors
// keeps what went wrong rather than only how often.

const MAX_STORED_ERRORS = 50

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  if (err === null) return 'null'
  if (err === undefined) return 'undefined'
  if (typeof err === 'object') {
    const m = (err as { message?: unknown }).message
    if (typeof m === 'string') return m
    // JSON.stringify rather than String(): String() gives '[object Object]',
    // which loses the only information the error had.
    try { return JSON.stringify(err) } catch { return 'unserialisable error' }
  }
  return String(err)
}

export function collectErrors() {
  const stored: Array<{ context: string; message: string }> = []
  let n = 0
  return {
    push(context: string, err: unknown) {
      n++
      if (stored.length < MAX_STORED_ERRORS) {
        stored.push({ context, message: messageOf(err) })
      }
    },
    list() { return stored },
    count() { return n },
  }
}

export interface SyncRunHandle {
  id: string | null
  seen(n?: number): void
  wrote(n?: number): void
  fail(context: string, err: unknown): void
  close(status?: 'ok' | 'partial' | 'failed'): Promise<void>
}

export async function openSyncRun(input: {
  source: string
  clientId?: string | null
  mode: 'backfill' | 'live'
  windowStart?: string | null
  windowEnd?: string | null
}): Promise<SyncRunHandle> {
  const errors = collectErrors()
  let rowsSeen = 0
  let rowsWritten = 0

  // If the bookkeeping row cannot be written, the sync still runs. Losing the
  // audit trail is bad; refusing to sync because of it is worse.
  const { data } = await supabaseAdmin
    .from('sync_runs')
    .insert({
      source: input.source,
      client_id: input.clientId ?? null,
      mode: input.mode,
      window_start: input.windowStart ?? null,
      window_end: input.windowEnd ?? null,
      status: 'running',
    })
    .select('id')
    .maybeSingle()

  const id: string | null = data?.id ?? null

  return {
    id,
    seen(n = 1) { rowsSeen += n },
    wrote(n = 1) { rowsWritten += n },
    fail(context, err) { errors.push(context, err) },
    async close(status) {
      const resolved =
        status ?? (errors.count() === 0 ? 'ok'
                 : rowsWritten > 0 ? 'partial' : 'failed')
      if (!id) return
      await supabaseAdmin.from('sync_runs').update({
        finished_at: new Date().toISOString(),
        status: resolved,
        rows_seen: rowsSeen,
        rows_written: rowsWritten,
        errors: errors.list(),
      }).eq('id', id)
    },
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- sync-run`
Expected: PASS, 6 tests.

- [ ] **Step 5: Rewrite the matching and adjustment logic in `shipstation.ts`**

Replace the body of `syncShipments` in `src/lib/sync/shipstation.ts`. Keep the
`carrierCode: 'stamps_com'` line exactly where it is — Task 11 removes it, this
task does not.

```ts
import { supabaseAdmin } from '@/lib/supabase'
import { getShipments } from '@/lib/api/shipstation'
import { calcDimWeightOz, calcBilledWeightOz } from '@/lib/billing/dim-weight'
import { sourceForCarrier } from '@/lib/ledger/carrier'
import { openSyncRun } from '@/lib/ledger/sync-run'

export async function syncShipments(daysBack = 30) {
  const dateFrom = new Date()
  dateFrom.setDate(dateFrom.getDate() - daysBack)
  const dateStr = dateFrom.toISOString().split('T')[0]

  const run = await openSyncRun({
    source: 'shipstation',
    mode: 'live',
    windowStart: dateStr,
    windowEnd: new Date().toISOString().split('T')[0],
  })

  let page = 1
  let hasMore = true
  const results = {
    created: 0, updated: 0, adjustments: 0, refunds: 0,
    errors: 0, unknownCarrier: 0, blankOrderNumber: 0,
  }

  while (hasMore) {
    const data = await getShipments({
      shipDateStart: dateStr,
      page,
      pageSize: 100,
      // Task 11 removes this line. It stays here so that the fixes in this
      // task can be proven against traffic we already handle.
      carrierCode: 'stamps_com',
    })

    const shipments = data.shipments ?? []
    if (shipments.length === 0 || page >= (data.pages ?? 1)) hasMore = false

    for (const s of shipments) {
      run.seen()
      try {
        // DEFECT 1, FIXED. The old code matched on order_number with
        // .single() and destructured the error away. .single() returns
        // {data: null, error: PGRST116} when several rows match — it does not
        // throw — so a multi-package order fell through to .insert() and
        // duplicated itself on every run. shipmentId is unique per label.
        const shipmentId = Number(s.shipmentId)
        if (!Number.isFinite(shipmentId)) {
          run.fail('missing shipmentId', { orderNumber: s.orderNumber })
          results.errors++
          continue
        }

        const { data: existingShipment, error: matchError } = await supabaseAdmin
          .from('shipments')
          .select('id, actual_cost, client_id')
          .eq('shipstation_shipment_id', shipmentId)
          .maybeSingle()

        // DEFECT 4, FIXED. The error is inspected, not discarded.
        if (matchError) {
          run.fail(`match shipment ${shipmentId}`, matchError)
          results.errors++
          continue
        }

        const orderNumber = String(s.orderNumber ?? '').trim()
        if (!orderNumber) results.blankOrderNumber++

        const dims = s.dimensions ?? {}
        const lengthIn = dims.length ?? 0
        const widthIn = dims.width ?? 0
        const heightIn = dims.height ?? 0

        const weightRaw = s.weight?.value ?? 0
        const weightUnit = s.weight?.units ?? 'ounces'
        const weightOz = weightUnit === 'pounds' ? weightRaw * 16 : weightRaw

        const carrier = s.carrierCode?.toUpperCase() ?? ''
        const service = s.serviceCode ?? ''
        const dimWeightOz = calcDimWeightOz(lengthIn, widthIn, heightIn, carrier, service)
        const billedWeightOz = calcBilledWeightOz(weightOz, dimWeightOz)

        // DEFECT 3, FIXED. source is derived from the carrier code instead of
        // being hardcoded to 'stamps'. Unknown carriers are counted, not
        // guessed at.
        const { source, known } = sourceForCarrier(s.carrierCode ?? '')
        if (!known) {
          results.unknownCarrier++
          run.fail(`unknown carrier ${s.carrierCode}`, { shipmentId })
        }

        const newCost = parseFloat(String(s.shipmentCost ?? 0))

        const shipmentData = {
          shipstation_shipment_id: shipmentId,
          order_number: orderNumber,
          order_date: s.orderDate,
          ship_date: s.shipDate,
          carrier,
          service,
          tracking_number: s.trackingNumber ?? '',
          recipient_name: s.shipTo?.name ?? '',
          recipient_city: s.shipTo?.city ?? '',
          recipient_state: s.shipTo?.state ?? '',
          recipient_zip: s.shipTo?.postalCode ?? '',
          weight: parseFloat(weightOz.toFixed(2)),
          weight_unit: 'ounces',
          length: lengthIn || null,
          width: widthIn || null,
          height: heightIn || null,
          dim_unit: dims.units ?? 'inches',
          dim_weight: dimWeightOz,
          billed_weight: parseFloat(billedWeightOz.toFixed(2)),
          actual_cost: newCost,
          source,
          raw_data: s,
        }

        if (existingShipment) {
          const prevCost = parseFloat(String(existingShipment.actual_cost ?? 0))
          const diff = parseFloat((newCost - prevCost).toFixed(2))

          // DEFECT 2, FIXED. The old guard was `diff > 0.01`, so only cost
          // INCREASES were recorded. A void or a refund is a decrease and was
          // structurally invisible: we could see money leave and never see it
          // come back.
          if (Math.abs(diff) > 0.01 && existingShipment.client_id) {
            const { data: existingAdj, error: adjError } = await supabaseAdmin
              .from('rate_adjustments')
              .select('id')
              .eq('shipment_id', existingShipment.id)
              .eq('adjustment_amount', diff)
              .maybeSingle()

            if (adjError) {
              run.fail(`adjustment lookup ${shipmentId}`, adjError)
            } else if (!existingAdj) {
              const { error: insError } = await supabaseAdmin
                .from('rate_adjustments').insert({
                  shipment_id: existingShipment.id,
                  client_id: existingShipment.client_id,
                  order_number: orderNumber,
                  original_cost: prevCost,
                  adjusted_cost: newCost,
                  adjustment_amount: diff,
                  reason: diff > 0 ? 'Carrier rate adjustment' : 'Refund or void',
                  adjustment_date: new Date().toISOString(),
                  status: 'pending',
                })
              if (insError) run.fail(`adjustment insert ${shipmentId}`, insError)
              else if (diff > 0) results.adjustments++
              else results.refunds++
            }
          }

          const { error: updError } = await supabaseAdmin
            .from('shipments').update(shipmentData).eq('id', existingShipment.id)
          if (updError) { run.fail(`update ${shipmentId}`, updError); results.errors++ }
          else { results.updated++; run.wrote() }
        } else {
          const { error: insError } = await supabaseAdmin
            .from('shipments').insert(shipmentData)
          if (insError) { run.fail(`insert ${shipmentId}`, insError); results.errors++ }
          else { results.created++; run.wrote() }
        }
      } catch (err) {
        // Still a catch, but it keeps what it caught.
        run.fail(`shipment ${s?.shipmentId ?? 'unknown'}`, err)
        results.errors++
      }
    }

    page++
  }

  await run.close()
  return results
}

export async function syncAdjustments() {
  return syncShipments(30)
}
```

- [ ] **Step 6: Verify against live data, read-only first**

Run the sync once, then check that it did not duplicate anything:

```bash
npm run dev
# in another shell:
curl -s -X POST localhost:3000/api/sync/shipments -d '{"daysBack":30}' \
  -H 'content-type: application/json' | jq
```

Then in the Supabase SQL editor:

```sql
-- Must return zero rows. Before this task it would not have.
select shipstation_shipment_id, count(*)
from shipments
where shipstation_shipment_id is not null
group by 1 having count(*) > 1;

-- The run is now on the record, with its errors readable.
select source, status, rows_seen, rows_written,
       jsonb_array_length(errors) as error_count, errors
from sync_runs order by started_at desc limit 3;
```

Run the sync a **second** time and confirm `created` is 0 and the duplicate
query still returns nothing. Running it twice is the actual test of defect 1; a
single run cannot tell you whether the duplicate path is gone.

- [ ] **Step 7: Commit**

```bash
git add src/lib/ledger/sync-run.ts src/lib/ledger/sync-run.test.ts \
        src/lib/sync/shipstation.ts
git commit -m "Fix ShipStation sync: stable key, refunds, derived source, kept errors"
```

Nothing is deployed. The branch stays local until Ophir confirms.

---

## Task 11: Drop the carrier filter

**Files:**
- Modify: `src/lib/sync/shipstation.ts` (one line removed, one comment added)

**Spec:** §3.1, §5.5 step 5, §9 step 3.

**Depends on:** Task 10 committed, run twice against live data, and confirmed
to produce no duplicates.

**This is a one-line change and it is the single largest change in the whole
project.** `carrierCode: 'stamps_com'` at line 19 currently hides 776 of 1,095
shipments in a 30-day window — $12,484 a month of label cost, about 80% of the
largest variable cost in the business. Every downstream number is wrong until it
goes. It gets its own task, and its own deploy, for exactly that reason: when
the numbers move by 3.4× overnight, nobody should have to wonder which of five
changes did it.

**What will look like a problem and is not.** Immediately after this lands:

- `shipments` row count roughly triples over the next full sync window
- Total recorded cost rises by roughly $12,500 a month
- `unknown carrier` counts appear in the result for any carrier code Task 2's
  map does not recognise — these are informational, and the shipment is still
  stored with the code kept verbatim
- Margin on every client falls, because cost that was always being spent is now
  being counted

None of these are regressions. All of them are the defect being fixed.

**Interfaces:** unchanged. `syncShipments` keeps its signature and its return
shape.

- [ ] **Step 1: Record the before-state**

Before changing anything, capture the numbers, so that the after-state can be
compared to something rather than described. In the Supabase SQL editor:

```sql
select count(*)                     as shipments,
       count(distinct carrier)      as carriers,
       sum(actual_cost)             as total_cost,
       min(ship_date)               as earliest,
       max(ship_date)               as latest
from shipments
where ship_date >= current_date - interval '30 days';

select carrier, count(*), sum(actual_cost)
from shipments
where ship_date >= current_date - interval '30 days'
group by 1 order by 2 desc;
```

Paste both results into the commit message body. This is the baseline the §9
rollout compares against and it cannot be reconstructed afterwards.

- [ ] **Step 2: Remove the filter**

In `src/lib/sync/shipstation.ts`, delete the `carrierCode` line and replace it
with a comment recording why it is gone, so nobody re-adds it as a performance
optimisation:

```ts
    const data = await getShipments({
      shipDateStart: dateStr,
      page,
      pageSize: 100,
      // DO NOT re-add carrierCode. Filtering to 'stamps_com' hid 776 of 1,095
      // shipments in a 30-day window — about $12,500/month of UPS label cost,
      // roughly 80% of the largest variable cost in the business. Every P&L
      // figure depends on this call returning all carriers.
      // Spec: docs/superpowers/specs/2026-09-29-complete-the-ledger-design.md §3.1
    })
```

- [ ] **Step 3: Verify the widening, before anything is deployed**

```bash
npm run dev
# in another shell:
curl -s -X POST localhost:3000/api/sync/shipments -d '{"daysBack":30}' \
  -H 'content-type: application/json' | jq
```

Expected in the response: `created` in the high hundreds on the first run,
`unknownCarrier` small or zero, `errors` zero.

Then re-run the two queries from step 1. Expected:

- `shipments` roughly 3.4× the baseline
- `carriers` greater than 1, with UPS codes now present
- `total_cost` up by roughly $12,500 over a 30-day window

Then run the sync a **second** time and confirm `created` is 0 and this returns
nothing:

```sql
select shipstation_shipment_id, count(*)
from shipments
where shipstation_shipment_id is not null
group by 1 having count(*) > 1;
```

If duplicates appear now and did not in Task 10, the cause is the widened
traffic hitting a path the narrow traffic never reached — stop and investigate
rather than deleting rows.

- [ ] **Step 4: Commit with the evidence attached**

```bash
git add src/lib/sync/shipstation.ts
git commit -F - <<'MSG'
Stop filtering ShipStation to stamps_com

The filter hid 776 of 1,095 shipments in a 30-day window: about $12,500 a
month of UPS label cost, roughly 80% of the largest variable cost in the
business. Every cost and margin figure in the system was computed from the
remaining 20%.

Expect recorded cost to rise and margin to fall. That is the defect being
fixed, not a regression.

Before / after, 30-day window:
  <paste the step 1 and step 3 query results here>
MSG
```

- [ ] **Step 5: Ask before deploying, and deploy this alone**

Say to Ophir:

> The carrier filter is removed and verified locally. This is the change that
> makes recorded shipping cost jump by about $12,500 a month and makes every
> client's margin drop — because we are finally counting money we were always
> spending. Before and after numbers are in the commit.
>
> This one should deploy on its own, with nothing else in the same push, so
> that if anything looks wrong there is only one candidate. May I push the
> branch? Nothing goes to production without you saying yes.

Do not push. Wait.

---

## Task 12: Persist Zenventory orders and lines

**Files:**
- Create: `src/lib/ledger/order-line.ts`
- Test: `src/lib/ledger/order-line.test.ts`
- Modify: `src/lib/sync/zenventory.ts`

**Spec:** §5.2 (`order_items`), §5.5 steps 6–8, §5.6.

**Depends on:** Tasks 5 (`classifySku`), 4 (`watermarkPickDate`), 10
(`openSyncRun`), and migration 1 applied.

**What is actually wrong today.** `syncClientAssignments` already fetches the
complete order, paginating correctly through `getCustomerOrders`. Then, at lines
54–57, it keeps `orderNumber` and throws the rest away:

```ts
for (const order of orders) {
  const orderNumber = String(order.orderNumber ?? order.order_number ?? '')
  if (orderNumber) orderNumbers.push(orderNumber)   // everything else discarded
}
```

The SKUs, the quantities, the picked quantities — the entire inventory detail
this project needs — arrive over the wire three times a day and are dropped on
the floor. No new API call is needed. The fix is to stop discarding.

Two smaller defects go with it:

- **Line 86, `if (clientErrors.length === clients.length)`.** A partial failure
  is invisible: seven clients succeeding and one returning 401 is reported as
  success. Two clients currently return 401 (Nayax and Creative Pea), so this
  is not hypothetical. Each client gets its own `sync_runs` row.
- **Lines 66–82** update shipments one order number at a time, which is slow but
  correct. Leave it. This task is large enough.

**This task carries Review Focus item 5.** `quantity_picked` of zero means "not
picked" and must raise no charge. A negative value is a data error, not a
credit, and must never become a negative charge. The normaliser is where both
are decided, and the tests below are the only place either is pinned.

**Interfaces:**
- Consumes: `classifySku` (Task 5), `watermarkPickDate` and `WAREHOUSE_TZ`
  (Task 4), `openSyncRun` (Task 10).
- Produces:
  ```ts
  export interface RawZenLine {
    sku?: string | null
    description?: string | null
    quantity?: number | string | null
    quantityOrdered?: number | string | null
    quantityPicked?: number | string | null
    category?: string | null
  }
  export interface NormalisedLine {
    line_ordinal: number
    sku: string | null
    description: string | null
    quantity_ordered: number | null
    quantity_picked: number | null
    is_component: boolean
    classification_source: string
    picked: boolean          // true only when quantity_picked > 0
  }
  export class NegativeQuantityError extends Error {}
  export function normaliseLines(raw: RawZenLine[]): NormalisedLine[]
  ```
  Task 14 reads `order_items` rows written from these. `picked` is what decides
  whether a pick charge exists at all.

- [ ] **Step 1: Write the failing test**

Create `src/lib/ledger/order-line.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { normaliseLines, NegativeQuantityError } from '@/lib/ledger/order-line'

describe('normaliseLines', () => {
  it('numbers lines from 1 in the order received', () => {
    const out = normaliseLines([{ sku: 'A' }, { sku: 'B' }, { sku: 'C' }])
    expect(out.map((l) => l.line_ordinal)).toEqual([1, 2, 3])
    expect(out.map((l) => l.sku)).toEqual(['A', 'B', 'C'])
  })

  // Kits repeat a SKU across lines. SKU is not a key; line_ordinal is.
  it('keeps two lines with the same SKU distinct', () => {
    const out = normaliseLines([{ sku: 'KIT-A' }, { sku: 'KIT-A' }])
    expect(out).toHaveLength(2)
    expect(out[0].line_ordinal).toBe(1)
    expect(out[1].line_ordinal).toBe(2)
  })

  it('classifies each line and records which rule fired', () => {
    const out = normaliseLines([
      { sku: 'R144GUSB01S10', category: '' },
      { sku: 'CABLE-01', category: 'Accessory' },
      { sku: 'CABLE-02' },
    ])
    expect(out[0].is_component).toBe(false)
    expect(out[0].classification_source).toBe('sku_prefix')
    expect(out[1].is_component).toBe(true)
    expect(out[1].classification_source).toBe('category')
    expect(out[2].is_component).toBe(true)
    expect(out[2].classification_source).toBe('default')
  })

  // REVIEW FOCUS 5, first half. Zero picked means not picked. If `picked`
  // were true here, Task 14 would raise a pick charge of quantity 0 and the
  // order would carry a $0.00 line that looks like a completed pick.
  it('treats a picked quantity of zero as not picked', () => {
    const out = normaliseLines([{ sku: 'A', quantityOrdered: 5, quantityPicked: 0 }])
    expect(out[0].quantity_picked).toBe(0)
    expect(out[0].picked).toBe(false)
  })

  it('treats a missing picked quantity as not picked, not as zero picked', () => {
    const out = normaliseLines([{ sku: 'A', quantityOrdered: 5 }])
    expect(out[0].quantity_picked).toBeNull()
    expect(out[0].picked).toBe(false)
  })

  // REVIEW FOCUS 5, second half. A negative picked quantity is corrupt input.
  // Silently accepting it produces a negative charge, which reads on the P&L
  // as us paying the client to pick their order.
  it('refuses a negative picked quantity rather than crediting it', () => {
    expect(() => normaliseLines([{ sku: 'A', quantityPicked: -2 }]))
      .toThrow(NegativeQuantityError)
  })

  it('refuses a negative ordered quantity', () => {
    expect(() => normaliseLines([{ sku: 'A', quantityOrdered: -1 }]))
      .toThrow(NegativeQuantityError)
  })

  it('names the offending line in the error, so it can be found', () => {
    try {
      normaliseLines([{ sku: 'A' }, { sku: 'BAD-SKU', quantityPicked: -2 }])
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as Error).message).toContain('BAD-SKU')
      expect((e as Error).message).toContain('2')   // the line ordinal
    }
  })

  // Zenventory returns quantities as strings on some endpoints.
  it('accepts numeric strings', () => {
    const out = normaliseLines([{ sku: 'A', quantityOrdered: '5', quantityPicked: '3' }])
    expect(out[0].quantity_ordered).toBe(5)
    expect(out[0].quantity_picked).toBe(3)
    expect(out[0].picked).toBe(true)
  })

  it('treats an unparseable quantity as unknown, not as zero', () => {
    const out = normaliseLines([{ sku: 'A', quantityPicked: 'n/a' }])
    expect(out[0].quantity_picked).toBeNull()
    expect(out[0].picked).toBe(false)
  })

  it('falls back to `quantity` when `quantityOrdered` is absent', () => {
    const out = normaliseLines([{ sku: 'A', quantity: 4 }])
    expect(out[0].quantity_ordered).toBe(4)
  })

  it('returns an empty array for an order with no lines', () => {
    expect(normaliseLines([])).toEqual([])
  })

  it('keeps a line with no SKU rather than dropping it', () => {
    const out = normaliseLines([{ description: 'Freight surcharge', quantity: 1 }])
    expect(out).toHaveLength(1)
    expect(out[0].sku).toBeNull()
    expect(out[0].is_component).toBe(true)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- order-line`
Expected: FAIL — `Failed to resolve import "@/lib/ledger/order-line"`.

- [ ] **Step 3: Write `src/lib/ledger/order-line.ts`**

```ts
import { classifySku } from '@/lib/billing/classify-sku'

// Normalises Zenventory order lines into order_items shape.
//
// Two decisions here are load-bearing and neither is obvious from the shape of
// the data:
//
//   quantity_picked = 0  means NOT PICKED. It raises no pick charge.
//   quantity_picked < 0  is corrupt input, not a credit. It throws.
//
// Accepting a negative quantity would produce a negative charge, which appears
// on the P&L as the business paying a client to have their order picked. That
// has no meaning and would be very hard to trace back to here.

export interface RawZenLine {
  sku?: string | null
  description?: string | null
  quantity?: number | string | null
  quantityOrdered?: number | string | null
  quantityPicked?: number | string | null
  category?: string | null
}

export interface NormalisedLine {
  line_ordinal: number
  sku: string | null
  description: string | null
  quantity_ordered: number | null
  quantity_picked: number | null
  is_component: boolean
  classification_source: string
  picked: boolean
}

export class NegativeQuantityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NegativeQuantityError'
  }
}

// Unknown is null, never 0. A quantity we could not parse is not a quantity of
// nothing, and the difference decides whether a charge exists.
function toQuantity(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'number' ? v : Number(String(v).trim())
  return Number.isFinite(n) ? n : null
}

export function normaliseLines(raw: RawZenLine[]): NormalisedLine[] {
  return (raw ?? []).map((line, i) => {
    const ordinal = i + 1
    const sku = line.sku?.trim() || null

    const ordered = toQuantity(line.quantityOrdered ?? line.quantity)
    const picked = toQuantity(line.quantityPicked)

    for (const [name, value] of [['ordered', ordered], ['picked', picked]] as const) {
      if (value !== null && value < 0) {
        throw new NegativeQuantityError(
          `Negative ${name} quantity ${value} on line ${ordinal} `
          + `(SKU ${sku ?? 'none'}). A negative quantity is a data error, `
          + `not a credit, and will not be written.`
        )
      }
    }

    const { skuClass, source } = classifySku({
      sku: sku ?? '',
      category: line.category,
    })

    return {
      line_ordinal: ordinal,
      sku,
      description: line.description?.trim() || null,
      quantity_ordered: ordered,
      quantity_picked: picked,
      is_component: skuClass === 'component',
      classification_source: source,
      picked: picked !== null && picked > 0,
    }
  })
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- order-line`
Expected: PASS, 13 tests.

- [ ] **Step 5: Persist orders and lines in `zenventory.ts`**

Replace the discard at lines 54–57. Keep the existing shipment-assignment loop
below it untouched — this step adds persistence, it does not restructure what
already works.

```ts
import { supabaseAdmin } from '@/lib/supabase'
import { getCustomerOrders } from '@/lib/api/zenventory'
import { normaliseLines, NegativeQuantityError } from '@/lib/ledger/order-line'
import { watermarkPickDate } from '@/lib/ledger/pick-date'
import { openSyncRun } from '@/lib/ledger/sync-run'

// ... inside the per-client loop, replacing the orderNumbers.push block:

      for (const order of orders) {
        const orderNumber = String(order.orderNumber ?? order.order_number ?? '').trim()
        if (!orderNumber) { run.fail('blank order number', order); continue }
        orderNumbers.push(orderNumber)

        run.seen()
        try {
          // Upsert the order. order_key is the normalised number; order_number
          // keeps what arrived, so a formatting change upstream does not
          // silently create a second order.
          const { data: orderRow, error: orderErr } = await supabaseAdmin
            .from('orders')
            .upsert({
              client_id: client.id,
              order_key: orderNumber.toUpperCase(),
              order_number: orderNumber,
              source: 'zenventory',
              order_date: order.orderDate ?? order.order_date ?? null,
              cancelled: Boolean(order.cancelled ?? false),
            }, { onConflict: 'client_id,order_key' })
            .select('id')
            .single()

          if (orderErr || !orderRow) {
            run.fail(`order ${orderNumber}`, orderErr ?? 'no row returned')
            continue
          }

          const lines = normaliseLines(
            order.items ?? order.orderItems ?? order.lineItems ?? []
          )

          for (const line of lines) {
            // pick_date is set ONCE and never moved. A partial pick finished on
            // Tuesday still belongs to Monday, when the labour was spent. Read
            // the existing row first so an established date survives.
            const { data: existing } = await supabaseAdmin
              .from('order_items')
              .select('id, pick_date, pick_date_source, quantity_picked')
              .eq('order_id', orderRow.id)
              .eq('source', 'zenventory')
              .eq('line_ordinal', line.line_ordinal)
              .maybeSingle()

            let pickDate = existing?.pick_date ?? null
            let pickSource = existing?.pick_date_source ?? null

            if (line.picked && !pickDate) {
              pickDate = watermarkPickDate(new Date())
              pickSource = 'watermark'
            }
            // The only event that clears a pick date is the pick being undone.
            if (!line.picked && pickDate) {
              pickDate = null
              pickSource = null
            }

            const { error: itemErr } = await supabaseAdmin
              .from('order_items')
              .upsert({
                order_id: orderRow.id,
                source: 'zenventory',
                line_ordinal: line.line_ordinal,
                sku: line.sku,
                description: line.description,
                quantity_ordered: line.quantity_ordered,
                quantity_picked: line.quantity_picked,
                is_component: line.is_component,
                classification_source: line.classification_source,
                pick_date: pickDate,
                pick_date_source: pickSource,
                is_estimate: pickSource === 'watermark',
              }, { onConflict: 'order_id,source,line_ordinal' })

            if (itemErr) run.fail(`item ${orderNumber}:${line.line_ordinal}`, itemErr)
            else run.wrote()
          }
        } catch (err) {
          // A negative quantity fails one order loudly and lets the rest of the
          // client's orders through. Failing the whole run would mean one bad
          // line costs a day of pick history.
          if (err instanceof NegativeQuantityError) {
            run.fail(`order ${orderNumber}: bad quantity`, err)
          } else {
            run.fail(`order ${orderNumber}`, err)
          }
        }
      }
```

- [ ] **Step 6: Give each client its own run record**

Open a `sync_runs` row per client, inside the `for (const client of clients)`
loop and before the pagination loop:

```ts
  for (const client of clients) {
    const run = await openSyncRun({
      source: 'zenventory',
      clientId: client.id,
      mode: 'live',
      windowStart: modifiedFromISO.split('T')[0],
      windowEnd: new Date().toISOString().split('T')[0],
    })
    // ... existing body ...
    await run.close()
  }
```

And replace the all-or-nothing check at line 86:

```ts
  // WAS: if (clientErrors.length === clients.length) throw ...
  //
  // That reported seven successes and one 401 as a clean run. Two clients
  // return 401 today — Nayax and Creative Pea, both awaiting Zenventory 2.0
  // credentials — so a partial failure is the normal state, not an edge case.
  // Each client's outcome is now its own sync_runs row; the throw only remains
  // for the case where nothing at all worked.
  if (clientErrors.length === clients.length) {
    throw new Error(`Zenventory sync failed for every client:\n${clientErrors.join('\n')}`)
  }
  return {
    clients_synced: clients.length - clientErrors.length,
    clients_failed: clientErrors.length,
    mapped: totalMapped,
    updated: totalUpdated,
    skipped: totalSkipped,
    errors: clientErrors,
  }
```

- [ ] **Step 7: Verify against live data**

```bash
npm run dev
curl -s -X POST localhost:3000/api/sync/zenventory -H 'content-type: application/json' | jq
```

Expect `clients_failed: 2` — Nayax and Creative Pea, both 401. That is the
correct answer until their Zenventory 2.0 credentials arrive; it is not a
failure of this task. Then:

```sql
-- Orders and lines now exist where before only order numbers passed through.
select count(*) from orders;
select count(*) from order_items;

-- Each client's outcome is separately visible. Two rows should read 'failed'.
select c.name, r.status, r.rows_seen, r.rows_written,
       jsonb_array_length(r.errors) as errs
from sync_runs r left join clients c on c.id = r.client_id
where r.source = 'zenventory'
order by r.started_at desc limit 10;

-- Classification sanity: the two known readers must be devices.
select sku, is_component, classification_source
from order_items
where sku in ('R144GUSB01S10', 'R144GUSY01S10')
limit 10;
```

That last query is the live check on Task 5. If either reader comes back with
`is_component = true`, the prefix rule is not firing and every device pick for
Nayax is being under-billed by $0.12.

- [ ] **Step 8: Commit**

```bash
git add src/lib/ledger/order-line.ts src/lib/ledger/order-line.test.ts \
        src/lib/sync/zenventory.ts
git commit -m "Persist Zenventory orders and lines instead of discarding them"
```

---

## Task 13: Cost-rate lookup, and the difference between unknown and free

**Files:**
- Create: `src/lib/ledger/cost-rate.ts`
- Test: `src/lib/ledger/cost-rate.test.ts`

**Spec:** §5.2 (effective dating), §5.4.

**Depends on:** Task 8's migration applied, so the rates have somewhere to live.
The pure function does not need the database.

**This task carries Review Focus item 4, and it is the one I would most expect
to go wrong.** `cost = null` means we do not know what this cost. `cost = 0`
means it was free. Conflating them turns every unknown cost into pure profit —
precisely the error the whole project exists to stop, and it fails in the
flattering direction, so nobody reports it as a bug.

The trap is ordinary JavaScript. `cost || 0` and `Number(cost)` and
`sum += cost ?? 0` all quietly turn "unknown" into "zero". Any one of them,
anywhere in the chain, silently inflates margin. The function below returns a
discriminated result so that callers cannot accidentally add an unknown to a
running total, and the tests pin it.

**The lookup is by `charge_date`, never by `now()`.** A rate change must not
rewrite last month's margin. `effective_from` is inclusive, `effective_to` is
exclusive — matching the `'[)'` range in the Task 8 exclusion constraint. If the
two disagreed, a rate could be valid in the constraint's view and invalid in the
code's, on exactly one day per rate change.

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export interface CostRateRow {
    id: string
    cost_type: string
    variant: string | null
    unit: string
    rate: number
    effective_from: string   // 'YYYY-MM-DD'
    effective_to: string | null
    basis: 'measured' | 'derived' | 'estimated'
  }
  export type CostLookup =
    | { known: true;  rateId: string; rate: number; basis: CostRateRow['basis'] }
    | { known: false; rateId: null;   rate: null;   basis: null; reason: string }

  export function findCostRate(
    rates: CostRateRow[],
    query: { costType: string; variant?: string | null; chargeDate: string },
  ): CostLookup

  export function costOf(lookup: CostLookup, quantity: number): number | null
  export function sumKnownCosts(values: Array<number | null>):
    { total: number; unknownCount: number }
  ```
  Task 14 calls `findCostRate` per charge and writes `cost_rate_id`,
  `cost` and `cost_basis`. Task 15's views must treat a null `cost` as unknown.

- [ ] **Step 1: Write the failing test**

Create `src/lib/ledger/cost-rate.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  findCostRate, costOf, sumKnownCosts, type CostRateRow,
} from '@/lib/ledger/cost-rate'

const rates: CostRateRow[] = [
  { id: 'r1', cost_type: 'pick', variant: 'device', unit: 'per_unit',
    rate: 0.23, effective_from: '2026-01-01', effective_to: '2026-06-01',
    basis: 'derived' },
  { id: 'r2', cost_type: 'pick', variant: 'device', unit: 'per_unit',
    rate: 0.27, effective_from: '2026-06-01', effective_to: null,
    basis: 'derived' },
  { id: 'r3', cost_type: 'pick', variant: 'component', unit: 'per_unit',
    rate: 0.20, effective_from: '2026-01-01', effective_to: null,
    basis: 'estimated' },
  { id: 'r4', cost_type: 'receiving', variant: null, unit: 'per_order',
    rate: 0, effective_from: '2026-01-01', effective_to: null,
    basis: 'measured' },
]

describe('findCostRate', () => {
  it('finds the rate in force on the charge date', () => {
    const r = findCostRate(rates, {
      costType: 'pick', variant: 'device', chargeDate: '2026-03-15',
    })
    expect(r).toMatchObject({ known: true, rateId: 'r1', rate: 0.23 })
  })

  it('does not let a later rate rewrite an earlier month', () => {
    const march = findCostRate(rates, {
      costType: 'pick', variant: 'device', chargeDate: '2026-03-15' })
    const july = findCostRate(rates, {
      costType: 'pick', variant: 'device', chargeDate: '2026-07-15' })
    expect(march).toMatchObject({ rate: 0.23 })
    expect(july).toMatchObject({ rate: 0.27, rateId: 'r2' })
  })

  // effective_from inclusive, effective_to exclusive — matching the '[)'
  // daterange in the Task 8 constraint. If these disagreed, exactly one day
  // per rate change would behave differently in code than in the database.
  it('treats effective_from as inclusive', () => {
    expect(findCostRate(rates, {
      costType: 'pick', variant: 'device', chargeDate: '2026-06-01',
    })).toMatchObject({ rateId: 'r2' })
  })

  it('treats effective_to as exclusive', () => {
    expect(findCostRate(rates, {
      costType: 'pick', variant: 'device', chargeDate: '2026-05-31',
    })).toMatchObject({ rateId: 'r1' })
  })

  it('matches an open-ended rate with no effective_to', () => {
    expect(findCostRate(rates, {
      costType: 'pick', variant: 'component', chargeDate: '2030-01-01',
    })).toMatchObject({ known: true, rateId: 'r3' })
  })

  it('matches a null variant against a null-variant rate', () => {
    expect(findCostRate(rates, {
      costType: 'receiving', chargeDate: '2026-03-01',
    })).toMatchObject({ known: true, rateId: 'r4' })
  })

  // REVIEW FOCUS 4, first half. A rate of exactly zero is a real rate. It is
  // `known`, and it makes the cost 0 — an operation that is genuinely free.
  it('returns known for a rate of zero', () => {
    const r = findCostRate(rates, { costType: 'receiving', chargeDate: '2026-03-01' })
    expect(r.known).toBe(true)
    expect(r.rate).toBeCloseTo(0, 6)
    expect(costOf(r, 10)).toBe(0)
  })

  // REVIEW FOCUS 4, second half. No rate at all is unknown, and unknown is
  // null. If this returned 0, every cost we have not yet loaded would appear
  // on the P&L as pure profit.
  it('returns unknown, not zero, when no rate covers the date', () => {
    const r = findCostRate(rates, {
      costType: 'pick', variant: 'device', chargeDate: '2025-12-31' })
    expect(r.known).toBe(false)
    expect(r.rate).toBeNull()
    expect(costOf(r, 10)).toBeNull()
  })

  it('returns unknown for a cost type that has no rates', () => {
    const r = findCostRate(rates, { costType: 'gift_wrap', chargeDate: '2026-03-01' })
    expect(r.known).toBe(false)
    expect((r as { reason: string }).reason).toContain('gift_wrap')
  })

  it('does not fall back to a different variant', () => {
    const r = findCostRate(rates, {
      costType: 'pick', variant: 'pallet', chargeDate: '2026-03-01' })
    expect(r.known).toBe(false)
  })

  it('carries the basis through, so estimates can be labelled', () => {
    expect(findCostRate(rates, {
      costType: 'pick', variant: 'component', chargeDate: '2026-03-01',
    })).toMatchObject({ basis: 'estimated' })
  })
})

describe('costOf', () => {
  it('multiplies a known rate by quantity', () => {
    const r = findCostRate(rates, {
      costType: 'pick', variant: 'device', chargeDate: '2026-03-01' })
    expect(costOf(r, 100)).toBeCloseTo(23, 6)
  })

  it('stays null for an unknown rate whatever the quantity', () => {
    const r = findCostRate(rates, { costType: 'nope', chargeDate: '2026-03-01' })
    expect(costOf(r, 0)).toBeNull()
    expect(costOf(r, 1000)).toBeNull()
  })
})

describe('sumKnownCosts', () => {
  // The aggregation half of the same hazard. `values.reduce((a,b) => a + (b??0))`
  // would return 8 here and report no problem, which reads as "these three
  // charges cost us $8" when one of them is simply not known yet.
  it('excludes unknowns from the total and counts them separately', () => {
    expect(sumKnownCosts([5, null, 3])).toEqual({ total: 8, unknownCount: 1 })
  })

  it('distinguishes a zero cost from an unknown one', () => {
    expect(sumKnownCosts([5, 0, 3])).toEqual({ total: 8, unknownCount: 0 })
  })

  it('reports an all-unknown set as total 0 with every entry counted', () => {
    expect(sumKnownCosts([null, null])).toEqual({ total: 0, unknownCount: 2 })
  })

  it('handles an empty set', () => {
    expect(sumKnownCosts([])).toEqual({ total: 0, unknownCount: 0 })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- cost-rate`
Expected: FAIL — `Failed to resolve import "@/lib/ledger/cost-rate"`.

- [ ] **Step 3: Write `src/lib/ledger/cost-rate.ts`**

```ts
// Effective-dated cost rate lookup.
//
// The distinction this module exists to protect:
//
//   rate = 0     the operation is FREE. cost is 0. It counts.
//   no rate      the cost is UNKNOWN. cost is null. It must not count.
//
// Conflating them reports unknown costs as pure profit, which is the exact
// error this whole project exists to stop, and it fails in the flattering
// direction so nobody files a bug about it.
//
// The result is a discriminated union rather than `number | null` so that a
// caller cannot write `cost || 0` without noticing what they are doing.
//
// Lookup is by charge_date, never by now(): a rate change must not rewrite
// last month's margin. effective_from is inclusive and effective_to exclusive,
// matching the '[)' daterange in the cost_rates exclusion constraint.

export interface CostRateRow {
  id: string
  cost_type: string
  variant: string | null
  unit: string
  rate: number
  effective_from: string
  effective_to: string | null
  basis: 'measured' | 'derived' | 'estimated'
}

export type CostLookup =
  | { known: true;  rateId: string; rate: number; basis: CostRateRow['basis'] }
  | { known: false; rateId: null;   rate: null;   basis: null; reason: string }

export function findCostRate(
  rates: CostRateRow[],
  query: { costType: string; variant?: string | null; chargeDate: string },
): CostLookup {
  const variant = query.variant ?? null

  const match = (rates ?? []).find((r) =>
    r.cost_type === query.costType
    && (r.variant ?? null) === variant
    && r.effective_from <= query.chargeDate
    && (r.effective_to === null || query.chargeDate < r.effective_to)
  )

  if (!match) {
    return {
      known: false, rateId: null, rate: null, basis: null,
      reason: `No cost rate for ${query.costType}`
            + `/${variant ?? 'none'} on ${query.chargeDate}`,
    }
  }

  return { known: true, rateId: match.id, rate: match.rate, basis: match.basis }
}

export function costOf(lookup: CostLookup, quantity: number): number | null {
  if (!lookup.known) return null
  return lookup.rate * quantity
}

export function sumKnownCosts(values: Array<number | null>): {
  total: number
  unknownCount: number
} {
  let total = 0
  let unknownCount = 0
  for (const v of values ?? []) {
    if (v === null || v === undefined) unknownCount++
    else total += v
  }
  return { total, unknownCount }
}
```

The string comparison on dates is deliberate and safe: `'YYYY-MM-DD'` sorts
lexicographically in the same order it sorts chronologically. Parsing to `Date`
here would reintroduce a timezone question that has no business being in a
rate lookup.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- cost-rate`
Expected: PASS, 17 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ledger/cost-rate.ts src/lib/ledger/cost-rate.test.ts
git commit -m "Look up cost rates by charge date, keeping unknown distinct from free"
```

---

## Task 14: Build the charges, and survive two crons at once

**Files:**
- Create: `src/lib/ledger/run-lock.ts`
- Test: `src/lib/ledger/run-lock.test.ts`
- Create: `src/lib/ledger/calculate-charges.ts`
- Test: `src/lib/ledger/calculate-charges.test.ts`
- Create: `src/lib/ledger/persist-charges.ts`
- Modify: `src/app/api/agent/monitor/route.ts`

**Spec:** §5.2 (`charge_key`, upsert and stale-delete), §5.5 step 9, §5.7.

**Depends on:** Tasks 3 (`chargeKey`), 5 (`classifySku`), 10 (`openSyncRun`),
12 (`order_items` populated), 13 (`findCostRate`), migrations 1–3 applied.

**This task carries Review Focus item 3, and the mechanism is worth
understanding before writing any code.** Recalculation is upsert plus
stale-delete: charges are upserted on `(order_id, charge_key)`, and charges
whose source record has vanished are removed by deleting rows for that order
whose `calculated_at` predates the current run. That is correct for one run at
a time and destructive for two.

Picture run A starting at 10:00:00 and still working at 10:00:30 when run B
starts. Run B's cutoff is 10:00:30. Every charge run A has already written
carries `calculated_at` of about 10:00:05, which is *before* B's cutoff. B's
stale-delete removes them — rows that are not stale at all, just recent. The
order loses charges it should have, and the next run puts them back, so the
ledger oscillates and nothing ever errors.

Two defences, because either alone is thin:

1. **A lock.** A second run that finds a live one exits immediately and says so.
   This is the real fix.
2. **Scope the stale-delete to the orders this run actually touched**, not to
   the whole table. If the lock is ever bypassed, the blast radius is one
   order's charges rather than every charge in the database.

**Interfaces:**
- Consumes: `chargeKey`, `ChargeType` (Task 3); `findCostRate`, `costOf`,
  `CostRateRow` (Task 13); `openSyncRun` (Task 10).
- Produces:
  ```ts
  // run-lock.ts
  export const STALE_RUN_MINUTES = 30
  export function canStart(
    openRuns: Array<{ started_at: string; status: string }>,
    now: Date,
  ): { ok: true } | { ok: false; reason: string }

  // calculate-charges.ts
  export interface ChargeInput {
    order:     { id: string; clientId: string | null; cancelled: boolean }
    items:     Array<{ id: string; sku: string | null; quantityPicked: number | null
                       isComponent: boolean; pickDate: string | null }>
    shipments: Array<{ id: string; shipmentId: number; shipDate: string
                       actualCost: number | null; voided: boolean }>
    rateCard:  Array<{ id: string; chargeType: string; variant: string | null
                       rate: number | null; rateType: string }>
    costRates: CostRateRow[]
    peakSurchargePct: number    // 0 when not in a peak window
  }
  export interface BuiltCharge {
    order_id: string; client_id: string | null; charge_key: string
    charge_type: string; label: string; quantity: number | null
    unit_rate: number | null; amount: number; cost: number | null
    cost_basis: string | null; rate_id: string | null; cost_rate_id: string | null
    charge_date: string; charge_date_source: string; source: string
    is_estimate: boolean
  }
  export function buildCharges(input: ChargeInput): BuiltCharge[]
  ```
  Task 15's views read the persisted rows.

- [ ] **Step 1: Write the failing test for the lock**

Create `src/lib/ledger/run-lock.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { canStart, STALE_RUN_MINUTES } from '@/lib/ledger/run-lock'

const now = new Date('2026-09-29T10:00:30Z')
const minutesAgo = (m: number) =>
  new Date(now.getTime() - m * 60_000).toISOString()

describe('canStart', () => {
  it('allows a run when nothing is in flight', () => {
    expect(canStart([], now)).toEqual({ ok: true })
  })

  it('allows a run when previous runs have finished', () => {
    expect(canStart([{ started_at: minutesAgo(5), status: 'ok' }], now))
      .toEqual({ ok: true })
  })

  // REVIEW FOCUS 3. This is the case that corrupts the ledger: run A started
  // 30 seconds ago and is still writing. Run B must not start.
  it('refuses a run while another is live', () => {
    const r = canStart([{ started_at: minutesAgo(0.5), status: 'running' }], now)
    expect(r.ok).toBe(false)
    expect((r as { reason: string }).reason).toMatch(/in progress/i)
  })

  // A crashed run leaves 'running' behind forever. Without a staleness cutoff
  // one crash stops charge calculation permanently and silently.
  it('allows a run when the live one is older than the stale cutoff', () => {
    expect(canStart(
      [{ started_at: minutesAgo(STALE_RUN_MINUTES + 1), status: 'running' }], now,
    )).toEqual({ ok: true })
  })

  it('still refuses just inside the stale cutoff', () => {
    expect(canStart(
      [{ started_at: minutesAgo(STALE_RUN_MINUTES - 1), status: 'running' }], now,
    ).ok).toBe(false)
  })

  it('ignores an unparseable started_at rather than blocking forever', () => {
    expect(canStart([{ started_at: 'not a date', status: 'running' }], now))
      .toEqual({ ok: true })
  })
})
```

- [ ] **Step 2: Run it, confirm it fails, then write `run-lock.ts`**

Run: `npm test -- run-lock` — expect FAIL on the missing import.

```ts
// Prevents two charge-calculation runs from overlapping.
//
// Recalculation deletes charges whose calculated_at predates the current run.
// If a second run starts while the first is still writing, the second's cutoff
// is LATER than the first's fresh rows, so it deletes them. The order loses
// charges, the next run restores them, and nothing ever errors — the ledger
// simply oscillates. See calculate-charges.ts for the second defence.

export const STALE_RUN_MINUTES = 30

export function canStart(
  openRuns: Array<{ started_at: string; status: string }>,
  now: Date,
): { ok: true } | { ok: false; reason: string } {
  for (const r of openRuns ?? []) {
    if (r.status !== 'running') continue

    const started = new Date(r.started_at).getTime()
    // A run whose timestamp we cannot read must not block every future run.
    if (!Number.isFinite(started)) continue

    const ageMinutes = (now.getTime() - started) / 60_000
    if (ageMinutes < STALE_RUN_MINUTES) {
      return {
        ok: false,
        reason: `A charge run started ${ageMinutes.toFixed(1)} minutes ago is `
              + `still in progress. Skipping this one.`,
      }
    }
  }
  return { ok: true }
}
```

Run: `npm test -- run-lock` — expect PASS, 6 tests.

- [ ] **Step 3: Write the failing test for charge building**

Create `src/lib/ledger/calculate-charges.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { buildCharges, type ChargeInput } from '@/lib/ledger/calculate-charges'
import type { CostRateRow } from '@/lib/ledger/cost-rate'

const costRates: CostRateRow[] = [
  { id: 'cr-pick-d', cost_type: 'pick', variant: 'device', unit: 'per_unit',
    rate: 0.23, effective_from: '2026-01-01', effective_to: null, basis: 'derived' },
  { id: 'cr-pick-c', cost_type: 'pick', variant: 'component', unit: 'per_unit',
    rate: 0.20, effective_from: '2026-01-01', effective_to: null, basis: 'estimated' },
]

const base: ChargeInput = {
  order: { id: 'o1', clientId: 'c1', cancelled: false },
  items: [],
  shipments: [],
  rateCard: [
    { id: 'rc-pick-d', chargeType: 'pick', variant: 'device',    rate: 0.32, rateType: 'per_unit' },
    { id: 'rc-pick-c', chargeType: 'pick', variant: 'component', rate: 0.20, rateType: 'per_unit' },
    { id: 'rc-ship',   chargeType: 'shipping', variant: null,    rate: null, rateType: 'at_cost' },
  ],
  costRates,
  peakSurchargePct: 0,
}

describe('buildCharges', () => {
  it('raises no charges for an order with nothing picked and nothing shipped', () => {
    expect(buildCharges(base)).toEqual([])
  })

  it('raises a pick charge per picked line, keyed on the line', () => {
    const out = buildCharges({ ...base, items: [
      { id: 'i1', sku: 'R144GUSB01S10', quantityPicked: 4, isComponent: false, pickDate: '2026-09-01' },
    ]})
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      charge_key: 'item:i1:pick',
      charge_type: 'pick',
      quantity: 4,
      unit_rate: 0.32,
      amount: 1.28,
      cost: expect.closeTo(0.92, 6),
      cost_basis: 'derived',
      cost_rate_id: 'cr-pick-d',
      rate_id: 'rc-pick-d',
      charge_date: '2026-09-01',
    })
  })

  it('prices a component pick at the component rate', () => {
    const out = buildCharges({ ...base, items: [
      { id: 'i2', sku: 'CABLE-01', quantityPicked: 5, isComponent: true, pickDate: '2026-09-01' },
    ]})
    expect(out[0]).toMatchObject({ unit_rate: 0.20, amount: 1.00, cost: expect.closeTo(1.00, 6) })
  })

  // REVIEW FOCUS 5, at the charge layer. Task 12 stops a zero-picked line at
  // the normaliser; this stops it again here, because order_items may also be
  // written by the ShipStation path.
  it('raises no pick charge for a line with zero picked', () => {
    expect(buildCharges({ ...base, items: [
      { id: 'i3', sku: 'A', quantityPicked: 0, isComponent: true, pickDate: '2026-09-01' },
    ]})).toEqual([])
  })

  it('raises no pick charge for a line with no pick date', () => {
    expect(buildCharges({ ...base, items: [
      { id: 'i4', sku: 'A', quantityPicked: 3, isComponent: true, pickDate: null },
    ]})).toEqual([])
  })

  it('raises no charges at all for a cancelled order', () => {
    expect(buildCharges({
      ...base,
      order: { ...base.order, cancelled: true },
      items: [{ id: 'i5', sku: 'A', quantityPicked: 3, isComponent: true, pickDate: '2026-09-01' }],
    })).toEqual([])
  })

  it('bills shipping at cost and records the carrier cost', () => {
    const out = buildCharges({ ...base, shipments: [
      { id: 's1', shipmentId: 555, shipDate: '2026-09-02', actualCost: 8.20, voided: false },
    ]})
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      charge_key: 'shipment:555',
      charge_type: 'shipping',
      amount: 8.20,
      cost: 8.20,
      cost_basis: 'measured',
      charge_date: '2026-09-02',
      charge_date_source: 'ship_date',
    })
  })

  // A voided label contributes $0 to measured cost. Leaving it in would
  // overstate spend by the amount that was refunded; it is counted instead in
  // the voided-label leak line (Task 15).
  it('gives a voided shipment zero amount and zero cost', () => {
    const out = buildCharges({ ...base, shipments: [
      { id: 's2', shipmentId: 556, shipDate: '2026-09-02', actualCost: 9.10, voided: true },
    ]})
    expect(out[0]).toMatchObject({ amount: 0, cost: 0 })
  })

  // An unknown carrier cost must stay unknown. Writing 0 here would report a
  // free shipment, which is the null-versus-zero error from Task 13 arriving
  // by a different route.
  it('leaves cost null when the carrier cost is unknown', () => {
    const out = buildCharges({ ...base, shipments: [
      { id: 's3', shipmentId: 557, shipDate: '2026-09-02', actualCost: null, voided: false },
    ]})
    expect(out[0].cost).toBeNull()
    expect(out[0].amount).toBe(0)
  })

  it('leaves cost null and flags an estimate when no cost rate covers the date', () => {
    const out = buildCharges({
      ...base,
      items: [{ id: 'i6', sku: 'A', quantityPicked: 2, isComponent: true, pickDate: '2025-06-01' }],
    })
    expect(out[0].cost).toBeNull()
    expect(out[0].cost_basis).toBeNull()
    expect(out[0].is_estimate).toBe(true)
  })

  it('flags an estimate when the cost rate itself is estimated', () => {
    const out = buildCharges({ ...base, items: [
      { id: 'i7', sku: 'CABLE', quantityPicked: 1, isComponent: true, pickDate: '2026-09-01' },
    ]})
    expect(out[0].cost_basis).toBe('estimated')
    expect(out[0].is_estimate).toBe(true)
  })

  it('raises no charge when the client has no rate card line for it', () => {
    const out = buildCharges({
      ...base,
      rateCard: base.rateCard.filter((r) => r.chargeType !== 'pick'),
      items: [{ id: 'i8', sku: 'A', quantityPicked: 3, isComponent: true, pickDate: '2026-09-01' }],
    })
    expect(out).toEqual([])
  })

  // Peak surcharge is 8% of pick and pack only. It must NOT apply to
  // at-cost carrier freight — a surcharge on a pass-through cost is
  // overbilling — and must not compound on itself.
  it('applies the peak surcharge to picks but not to shipping', () => {
    const out = buildCharges({
      ...base,
      peakSurchargePct: 8,
      items: [{ id: 'i9', sku: 'R1', quantityPicked: 10, isComponent: false, pickDate: '2026-09-01' }],
      shipments: [{ id: 's4', shipmentId: 558, shipDate: '2026-09-01', actualCost: 8.20, voided: false }],
    })
    const sur = out.filter((c) => c.charge_type === 'surcharge')
    expect(sur).toHaveLength(1)
    // 10 * 0.32 = 3.20, 8% of which is 0.256 -> 0.26
    expect(sur[0].amount).toBeCloseTo(0.26, 2)
    expect(sur[0].cost).toBeNull()
    // A constant key, not a chargeKey() call: the surcharge is levied on the
    // order, not on a shipment, and (order_id, charge_key) is the unique index.
    expect(sur[0].charge_key).toBe('surcharge:peak')
  })

  it('raises no surcharge when the percentage is zero', () => {
    const out = buildCharges({ ...base, peakSurchargePct: 0, items: [
      { id: 'i10', sku: 'R1', quantityPicked: 10, isComponent: false, pickDate: '2026-09-01' },
    ]})
    expect(out.some((c) => c.charge_type === 'surcharge')).toBe(false)
  })

  // Idempotency is the whole point of charge_key. Three crons a day against a
  // non-deterministic key would triple the P&L.
  it('produces identical keys on repeated calls', () => {
    const input = { ...base, items: [
      { id: 'i11', sku: 'R1', quantityPicked: 2, isComponent: false, pickDate: '2026-09-01' },
    ]}
    expect(buildCharges(input).map((c) => c.charge_key))
      .toEqual(buildCharges(input).map((c) => c.charge_key))
  })

  it('rounds amounts to cents', () => {
    const out = buildCharges({ ...base, items: [
      { id: 'i12', sku: 'R1', quantityPicked: 3, isComponent: false, pickDate: '2026-09-01' },
    ]})
    expect(out[0].amount).toBe(0.96)
  })

  // Nayax's quote folds packing into the pick rate, so their card has no
  // ('pack', ...) line and no pack charge may appear. If one does, every Nayax
  // order is being overbilled.
  it('raises no pack charge for a client whose card has no pack line', () => {
    const out = buildCharges({ ...base, items: [
      { id: 'i13', sku: 'R1', quantityPicked: 4, isComponent: false, pickDate: '2026-09-01' },
    ]})
    expect(out.some((c) => c.charge_type === 'pack')).toBe(false)
  })

  // The same calculator, given a card that DOES price packing separately, must
  // raise it without anyone editing the code. This is the test that proves the
  // three outstanding rate cards slot in rather than requiring rework.
  it('raises a pack charge when the card prices packing separately', () => {
    const out = buildCharges({
      ...base,
      rateCard: [...base.rateCard,
        { id: 'rp', chargeType: 'pack', variant: 'device', rate: 0.15, rateType: 'per_unit' }],
      items: [{ id: 'i14', sku: 'R1', quantityPicked: 4, isComponent: false, pickDate: '2026-09-01' }],
    })
    const pack = out.filter((c) => c.charge_type === 'pack')
    expect(pack).toHaveLength(1)
    expect(pack[0].amount).toBeCloseTo(0.60, 6)
    expect(pack[0].charge_key).toBe('item:i14:pack')
  })

  // Peak surcharge is 8% of pick AND pack. With both present the base is the
  // sum, not the pick alone -- an easy off-by-one-line error that underbills.
  it('includes pack in the peak surcharge base', () => {
    const out = buildCharges({
      ...base,
      peakSurchargePct: 8,
      rateCard: [...base.rateCard,
        { id: 'rp', chargeType: 'pack', variant: 'device', rate: 0.15, rateType: 'per_unit' }],
      items: [{ id: 'i15', sku: 'R1', quantityPicked: 10, isComponent: false, pickDate: '2026-09-01' }],
    })
    // pick 10 * 0.32 = 3.20, pack 10 * 0.15 = 1.50, base 4.70, 8% = 0.376 -> 0.38
    const sur = out.find((c) => c.charge_type === 'surcharge')!
    expect(sur.amount).toBeCloseTo(0.38, 2)
  })
})
```

- [ ] **Step 4: Run it, confirm it fails, then write `calculate-charges.ts`**

Run: `npm test -- calculate-charges` — expect FAIL on the missing import.

```ts
import { chargeKey } from '@/lib/ledger/charge-key'
import { findCostRate, costOf, type CostRateRow } from '@/lib/ledger/cost-rate'

// Builds order_charges rows. Pure: no database, no clock, no randomness.
// Everything the calculation needs is passed in, which is what makes the
// idempotency of charge_key testable at all.

export interface ChargeInput {
  order:     { id: string; clientId: string | null; cancelled: boolean }
  items:     Array<{ id: string; sku: string | null; quantityPicked: number | null
                     isComponent: boolean; pickDate: string | null }>
  shipments: Array<{ id: string; shipmentId: number; shipDate: string
                     actualCost: number | null; voided: boolean }>
  rateCard:  Array<{ id: string; chargeType: string; variant: string | null
                     rate: number | null; rateType: string }>
  costRates: CostRateRow[]
  peakSurchargePct: number
}

export interface BuiltCharge {
  order_id: string; client_id: string | null; charge_key: string
  charge_type: string; label: string; quantity: number | null
  unit_rate: number | null; amount: number; cost: number | null
  cost_basis: string | null; rate_id: string | null; cost_rate_id: string | null
  charge_date: string; charge_date_source: string; source: string
  is_estimate: boolean
}

const cents = (n: number) => Math.round(n * 100) / 100

export function buildCharges(input: ChargeInput): BuiltCharge[] {
  // A cancelled order earns nothing and costs nothing. Returning early is
  // simpler than filtering each branch and leaves no path that could miss it.
  if (input.order.cancelled) return []

  const out: BuiltCharge[] = []
  const clientId = input.order.clientId

  const rateFor = (chargeType: string, variant: string | null) =>
    input.rateCard.find((r) =>
      r.chargeType === chargeType && (r.variant ?? null) === variant)

  // ---- picks -------------------------------------------------------------
  for (const item of input.items) {
    // Zero picked means not picked. Null pick date means we do not know when
    // the labour happened, and a charge with no date cannot be reported on.
    if (!item.quantityPicked || item.quantityPicked <= 0) continue
    if (!item.pickDate) continue

    const variant = item.isComponent ? 'component' : 'device'
    const rate = rateFor('pick', variant)
    // No rate card line means we have not agreed a price. Inventing one would
    // be worse than the gap; the gap shows up as "picked but never billed".
    if (!rate || rate.rate === null) continue

    const lookup = findCostRate(input.costRates, {
      costType: 'pick', variant, chargeDate: item.pickDate,
    })
    const cost = costOf(lookup, item.quantityPicked)

    out.push({
      order_id: input.order.id,
      client_id: clientId,
      charge_key: chargeKey({ chargeType: 'pick', orderItemId: item.id }),
      charge_type: 'pick',
      label: `Pick — ${variant}`,
      quantity: item.quantityPicked,
      unit_rate: rate.rate,
      amount: cents(rate.rate * item.quantityPicked),
      cost: cost === null ? null : cents(cost),
      cost_basis: lookup.known ? lookup.basis : null,
      rate_id: rate.id,
      cost_rate_id: lookup.known ? lookup.rateId : null,
      charge_date: item.pickDate,
      charge_date_source: 'pick_date',
      source: 'calculator',
      is_estimate: !lookup.known || lookup.basis === 'estimated',
    })

    // ---- pack --------------------------------------------------------------
    // Nayax includes packing in the pick rate and therefore has no ('pack',
    // 'device') line, so this branch correctly produces nothing for them
    // (spec §5.7). It exists so that when Orcam, Suteka or Crisp Power arrive
    // with a separately-priced pack, their charges appear without anyone
    // editing this file. A branch that is dormant for one client and load-
    // bearing for the next three is cheaper than the rework of adding it later.
    const packRate = rateFor('pack', variant)
    if (packRate && packRate.rate !== null) {
      const packLookup = findCostRate(input.costRates, {
        costType: 'pack', variant, chargeDate: item.pickDate,
      })
      const packCost = costOf(packLookup, item.quantityPicked)

      out.push({
        order_id: input.order.id,
        client_id: clientId,
        charge_key: chargeKey({ chargeType: 'pack', orderItemId: item.id }),
        charge_type: 'pack',
        label: `Pack — ${variant}`,
        quantity: item.quantityPicked,
        unit_rate: packRate.rate,
        amount: cents(packRate.rate * item.quantityPicked),
        cost: packCost === null ? null : cents(packCost),
        cost_basis: packLookup.known ? packLookup.basis : null,
        rate_id: packRate.id,
        cost_rate_id: packLookup.known ? packLookup.rateId : null,
        charge_date: item.pickDate,
        charge_date_source: 'pick_date',
        source: 'calculator',
        is_estimate: !packLookup.known || packLookup.basis === 'estimated',
      })
    }
  }

  // ---- shipping ----------------------------------------------------------
  for (const s of input.shipments) {
    const rate = rateFor('shipping', null)
    if (!rate) continue

    // A voided label was refunded, so it contributes nothing to measured cost.
    // It is counted in the voided-label leak line instead; leaving it in here
    // would overstate spend by the amount that came back.
    const cost = s.voided ? 0 : s.actualCost
    // at_cost means the client pays exactly what we paid. An unknown cost
    // cannot be billed, so the amount is 0 and the cost stays null — the two
    // are different claims and both are true.
    const amount = s.voided ? 0
                 : rate.rateType === 'at_cost' ? (s.actualCost ?? 0)
                 : (rate.rate ?? 0)

    out.push({
      order_id: input.order.id,
      client_id: clientId,
      charge_key: chargeKey({ chargeType: 'shipping', shipmentId: String(s.shipmentId) }),
      charge_type: 'shipping',
      label: s.voided ? 'Shipping (voided)' : 'Shipping',
      quantity: 1,
      unit_rate: rate.rate,
      amount: cents(amount),
      cost: cost === null ? null : cents(cost),
      cost_basis: cost === null ? null : 'measured',
      rate_id: rate.id,
      cost_rate_id: null,
      charge_date: s.shipDate,
      charge_date_source: 'ship_date',
      source: 'calculator',
      is_estimate: false,
    })
  }

  // ---- peak surcharge ----------------------------------------------------
  // 8% of pick and pack only. Explicitly not on at-cost carrier freight —
  // charging a surcharge on a pass-through cost is overbilling — and not on
  // itself, which would compound.
  if (input.peakSurchargePct > 0) {
    const eligible = out.filter((c) => c.charge_type === 'pick' || c.charge_type === 'pack')
    const basis = eligible.reduce((sum, c) => sum + c.amount, 0)
    if (basis > 0) {
      const first = eligible[0]
      out.push({
        order_id: input.order.id,
        client_id: clientId,
        // Not a chargeKey() call, and deliberately so. chargeKey's surcharge
        // shape keys on a SHIPMENT, but a peak surcharge is levied once on the
        // order's whole pick-and-pack total, not on a label. charge_key only
        // has to be unique WITHIN an order — the unique index is
        // (order_id, charge_key) — so a constant is both deterministic and
        // sufficient. Passing the order id in as `shipmentId` would produce
        // 'shipment:<orderId>:peak', which would be a lie in the data.
        charge_key: 'surcharge:peak',
        charge_type: 'surcharge',
        label: `Peak surcharge (${input.peakSurchargePct}%)`,
        quantity: null,
        unit_rate: input.peakSurchargePct,
        amount: cents(basis * input.peakSurchargePct / 100),
        // A surcharge is pure revenue. It has no cost of its own, and 0 would
        // be a claim that it was free to provide.
        cost: null,
        cost_basis: null,
        rate_id: null,
        cost_rate_id: null,
        charge_date: first.charge_date,
        charge_date_source: first.charge_date_source,
        source: 'calculator',
        is_estimate: false,
      })
    }
  }

  return out
}
```

Run: `npm test -- calculate-charges` — expect PASS, 19 tests.

- [ ] **Step 5: Write the persistence layer, with both defences**

Create `src/lib/ledger/persist-charges.ts`:

```ts
import { supabaseAdmin } from '@/lib/supabase'
import { canStart } from '@/lib/ledger/run-lock'
import { openSyncRun } from '@/lib/ledger/sync-run'
import { buildCharges, type ChargeInput } from '@/lib/ledger/calculate-charges'

export async function recalculateCharges(loadOrders: () => Promise<ChargeInput[]>) {
  // DEFENCE 1: the lock. Two runs overlapping would make each delete the
  // other's fresh rows — see run-lock.ts.
  const { data: openRuns } = await supabaseAdmin
    .from('sync_runs')
    .select('started_at, status')
    .eq('source', 'charges')
    .eq('status', 'running')

  const gate = canStart(openRuns ?? [], new Date())
  if (!gate.ok) return { skipped: true, reason: gate.reason }

  const runStartedAt = new Date().toISOString()
  const run = await openSyncRun({ source: 'charges', mode: 'live' })

  let upserted = 0
  let deleted = 0

  try {
    for (const input of await loadOrders()) {
      run.seen()
      const charges = buildCharges(input)

      if (charges.length > 0) {
        const { error } = await supabaseAdmin
          .from('order_charges')
          .upsert(
            charges.map((c) => ({ ...c, calculated_at: new Date().toISOString() })),
            { onConflict: 'order_id,charge_key' },
          )
        if (error) { run.fail(`upsert ${input.order.id}`, error); continue }
        upserted += charges.length
        run.wrote(charges.length)
      }

      // DEFENCE 2: the stale-delete is scoped to THIS order, not to the whole
      // table. If the lock is ever bypassed, the damage is one order's charges
      // rather than every charge in the database.
      const { data: removed, error: delError } = await supabaseAdmin
        .from('order_charges')
        .delete()
        .eq('order_id', input.order.id)
        .lt('calculated_at', runStartedAt)
        .select('id')
      if (delError) run.fail(`stale-delete ${input.order.id}`, delError)
      else deleted += removed?.length ?? 0
    }
    await run.close()
  } catch (err) {
    run.fail('recalculateCharges', err)
    await run.close('failed')
    throw err
  }

  return { skipped: false, upserted, deleted }
}
```

- [ ] **Step 6: Write the loader, and wire it into the monitor route**

`loadOrders` is the only impure half of the calculation, and it is deliberately
kept out of `calculate-charges.ts` so that module stays a pure function. Create
`src/lib/ledger/load-charge-inputs.ts`:

```ts
import { supabaseAdmin } from '@/lib/supabase'
import type { ChargeInput } from '@/lib/ledger/calculate-charges'
import type { CostRateRow } from '@/lib/ledger/cost-rate'

// Assembles ChargeInput[] for every order touched in the window. One query per
// table rather than one per order: a 30-day window is a few thousand orders,
// and a per-order round trip would take minutes and time the cron out.
export async function loadChargeInputs(windowStart: string): Promise<ChargeInput[]> {
  const { data: orders, error: ordersError } = await supabaseAdmin
    .from('orders')
    .select('id, client_id, order_key, cancelled')
    .gte('order_date', windowStart)
  if (ordersError) throw ordersError
  if (!orders?.length) return []

  const orderIds = orders.map((o) => o.id)
  const orderKeys = orders.map((o) => o.order_key)

  const { data: items, error: itemsError } = await supabaseAdmin
    .from('order_items')
    .select('id, order_id, sku, quantity_picked, is_component, pick_date')
    .in('order_id', orderIds)
  if (itemsError) throw itemsError

  // Shipments are keyed to orders by order_number, which is the ONLY join
  // available -- shipments carry no order_id. Blank order numbers therefore
  // match nothing and stay unattributed, which is correct: that spend is
  // reported by leaks_monthly.unattributed_label_spend, not guessed onto an
  // order.
  const { data: shipments, error: shipError } = await supabaseAdmin
    .from('shipments')
    .select('id, shipstation_shipment_id, order_number, ship_date, actual_cost, raw_data')
    .in('order_number', orderKeys.filter(Boolean))
  if (shipError) throw shipError

  const { data: rates, error: ratesError } = await supabaseAdmin
    .from('client_warehouse_rates')
    .select('id, client_id, charge_type, variant, rate, rate_type, effective_from, effective_to')
    .not('charge_type', 'is', null)
  if (ratesError) throw ratesError

  const { data: costRates, error: costError } = await supabaseAdmin
    .from('cost_rates')
    .select('id, cost_type, variant, unit, rate, effective_from, effective_to, basis')
  if (costError) throw costError

  const itemsByOrder = new Map<string, typeof items>()
  for (const it of items ?? []) {
    const list = itemsByOrder.get(it.order_id) ?? []
    list.push(it)
    itemsByOrder.set(it.order_id, list)
  }

  const shipmentsByKey = new Map<string, typeof shipments>()
  for (const s of shipments ?? []) {
    const list = shipmentsByKey.get(s.order_number) ?? []
    list.push(s)
    shipmentsByKey.set(s.order_number, list)
  }

  const ratesByClient = new Map<string, typeof rates>()
  for (const r of rates ?? []) {
    const list = ratesByClient.get(r.client_id) ?? []
    list.push(r)
    ratesByClient.set(r.client_id, list)
  }

  return orders.map((o) => {
    const card = (o.client_id ? ratesByClient.get(o.client_id) : null) ?? []
    // The surcharge percentage is a rate card line like any other, not a
    // constant. Reading it here means a client who does not charge peak simply
    // has no line and gets 0, with no special case anywhere.
    const peak = card.find((r) => r.charge_type === 'surcharge' && r.variant === 'peak')

    return {
      order: {
        id: o.id,
        clientId: o.client_id,
        // A cancelled order earns nothing and costs nothing. The column
        // defaults to false, so a null here means "not cancelled", not
        // "unknown" -- there is no third state to preserve.
        cancelled: o.cancelled === true,
      },
      items: (itemsByOrder.get(o.id) ?? []).map((it) => ({
        id: it.id,
        sku: it.sku,
        quantityPicked: it.quantity_picked === null ? null : Number(it.quantity_picked),
        // is_component is null for lines synced before Task 12. Defaulting an
        // unknown to `true` bills the cheaper component rate, which underbills
        // rather than overbills -- the safe direction when we do not know.
        isComponent: it.is_component ?? true,
        pickDate: it.pick_date,
      })),
      shipments: (shipmentsByKey.get(o.order_key) ?? []).map((s) => ({
        id: s.id,
        shipmentId: s.shipstation_shipment_id,
        shipDate: String(s.ship_date ?? '').slice(0, 10),
        actualCost: s.actual_cost === null ? null : Number(s.actual_cost),
        // ShipStation reports a void as voideDate on the shipment. There is no
        // column for it yet, so it is read from raw_data. Presence, not
        // truthiness: the field is a date string when voided and null when not.
        voided: Boolean((s.raw_data as Record<string, unknown> | null)?.voided)
             || (s.raw_data as Record<string, unknown> | null)?.voideDate != null,
      })),
      rateCard: card.map((r) => ({
        id: r.id,
        chargeType: r.charge_type,
        variant: r.variant,
        rate: r.rate === null ? null : Number(r.rate),
        rateType: r.rate_type,
      })),
      costRates: (costRates ?? []) as CostRateRow[],
      peakSurchargePct: peak?.rate === null || peak === undefined ? 0 : Number(peak.rate),
    }
  })
}
```

Then in `src/app/api/agent/monitor/route.ts`, after the existing sync calls:

```ts
import { recalculateCharges } from '@/lib/ledger/persist-charges'
import { loadChargeInputs } from '@/lib/ledger/load-charge-inputs'

// ... after the existing syncShipments / syncZenventory calls:
const windowStart = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10)
const charges = await recalculateCharges(() => loadChargeInputs(windowStart))
```

Include `charges` in the run summary object the route already composes and
emails, so a `skipped: true` from the lock is visible rather than looking like a
run that did nothing.

**One thing to check by eye before moving on.** Run the sync, then:

```sql
select count(*) from order_charges where charge_type = 'shipping';
select count(*) from shipments where order_number <> '';
```

If the first is far below the second, the `order_number` join is not matching —
most likely whitespace or case. That is a real defect, not a rounding
difference, and it silently loses shipping revenue.

- [ ] **Step 7: Verify idempotency against live data**

**Apply Task 16's two seed files before doing this.** The unit tests above pass
without them because they pass their rate card in, but `recalculateCharges`
against the real database returns nothing at all if no client has a rate card
line — and "no charges" looks exactly like "the calculator is broken."

This is the only test that matters here, and it cannot be a unit test. Run the
recalculation **three times in a row** and confirm the totals do not move:

```sql
select charge_type, count(*), sum(amount), sum(cost)
from order_charges group by 1 order by 1;
```

Identical after run 1, run 2 and run 3. If any number climbs, `charge_key` is
not deterministic and everything downstream inflates three times a day.

Then confirm the lock works: start a recalculation and, while it is running,
POST the route again. The second call must return `skipped: true` with a reason,
not run.

- [ ] **Step 8: Commit**

```bash
git add src/lib/ledger/run-lock.ts src/lib/ledger/run-lock.test.ts \
        src/lib/ledger/calculate-charges.ts src/lib/ledger/calculate-charges.test.ts \
        src/lib/ledger/persist-charges.ts src/lib/ledger/load-charge-inputs.ts \
        src/app/api/agent/monitor/route.ts
git commit -m "Calculate order charges idempotently, and stop runs overlapping"
```

---

## Task 15: Migration 4 — the views, and the leak report

**Files:**
- Create: `supabase/ledger_04_views.sql`
- Create: `supabase/verify/ledger_04_verify.sql`

**Spec:** §5.2 (`pick_days`), §5.3.1, §5.8.

**Depends on:** migrations 1–3 applied, and Task 14 having written at least one
run of `order_charges` — otherwise the views are correct and empty, which is
indistinguishable from correct and broken.

**`leaks_monthly` is the view Ophir actually asked for.** "Check where the leaks
of money are" is answered here and nowhere else. It is also the only view in
this migration that depends on no cost rate being right, which is why it lands
before the P&L views in the same file and should be the first thing looked at
after applying.

**Two things about these views are counterintuitive and both are deliberate.**

*`leaks_monthly` is not netted into `pnl_monthly`.* Some leaks already appear in
the P&L as cost — voided labels and unattributed spend are money that left the
bank — and subtracting them again would double-count. Others are absences
rather than amounts: "picked but never billed" is revenue that does not exist,
and there is nothing to subtract. The two views answer different questions and
are kept apart so that neither corrupts the other.

*Overheads are subtracted at the top, not spread across clients.* So
`pnl_client_monthly` shows **gross** margin, not net. Allocating rent and
software across clients needs an allocation key — revenue share? order share?
floor space? — and every candidate is arguable. Showing gross honestly beats
showing net arbitrarily.

**Interfaces:**
- Consumes: `orders`, `order_items`, `order_charges`, `shipments`,
  `rate_adjustments`, `operating_costs`, `cost_rates`, `clients`.
- Produces: views `pick_days`, `leaks_monthly`, `pnl_client_monthly`,
  `pnl_monthly`. Task 16's screen reads all four.

- [ ] **Step 1: Write the migration**

Create `supabase/ledger_04_views.sql`:

```sql
-- Complete the ledger, migration 4 of 4: the rollup.
-- Spec: docs/superpowers/specs/2026-09-29-complete-the-ledger-design.md §5.8
-- Requires migrations 1-3. Safe to run more than once.

-- ---------------------------------------------------------------------------
-- pick_days: what was picked, per client per day per SKU.
-- A view, not a table, so it cannot drift from the lines it summarises.
-- ---------------------------------------------------------------------------
create or replace view pick_days as
with usable as (          -- only lines carrying real pick evidence
  select oi.*
  from order_items oi
  where oi.pick_date is not null
    and oi.quantity_picked > 0
),
preferred as (            -- one source per order: Zenventory wins
  select distinct on (u.order_id) u.order_id, u.source
  from usable u
  order by u.order_id, case u.source when 'zenventory' then 0 else 1 end
)
select o.client_id, u.pick_date, u.sku,
  max(u.description)      as description,
  bool_or(u.is_component) as is_component,
  count(distinct o.id)    as orders,
  sum(u.quantity_picked)  as units_picked,
  bool_or(u.is_estimate)  as has_estimates,
  min(case u.pick_date_source        -- 1 = least confident
        when 'pickprintdate' then 3
        when 'watermark'     then 2
        when 'modified_date' then 1
        else 0                       -- null/unknown: trust nothing
      end)                as confidence
from usable    u
join orders    o on o.id = u.order_id
join preferred p on p.order_id = u.order_id and p.source = u.source
where not o.cancelled
group by o.client_id, u.pick_date, u.sku;
```

**`usable` must come before `preferred`, and this is the part to get right.** An
earlier draft filtered afterwards. In that version `preferred` chose Zenventory
whenever *any* Zenventory row existed, then the `pick_date is not null` filter
was applied in the outer query. An order whose Zenventory rows had arrived
without a pick date — the normal state until the first watermark lands — would
be assigned to Zenventory, have all its rows filtered out, and **vanish from
`pick_days` entirely**, taking its perfectly good ShipStation pick evidence with
it. Filtering first means "preferred" ranks only among sources that have
something to say.

The confidence column maps `pick_date_source` to an **integer** before `min()`.
`min()` on the raw text returns `'pickprintdate'` alphabetically, ranking the
most-inferred rows as the most trustworthy — exactly backwards.

```sql
-- ---------------------------------------------------------------------------
-- leaks_monthly: the six measured leaks. This is the direct answer to
-- "check where the leaks of money are", and it depends on no cost rate being
-- right. Deliberately NOT netted into pnl_monthly: see the migration header.
-- ---------------------------------------------------------------------------
create or replace view leaks_monthly as

-- 1. Label spend attributable to no order and no client.
select date_trunc('month', s.ship_date)::date as period_month,
       null::uuid                             as client_id,
       'unattributed_label_spend'             as leak,
       'Labels with no order number and no client' as detail,
       count(*)                               as records,
       coalesce(sum(s.actual_cost), 0)        as amount
from shipments s
where coalesce(nullif(trim(s.order_number), ''), null) is null
   or s.client_id is null
group by 1

union all

-- 2. Picked, not cancelled, and no charge was ever raised. This is an ABSENCE:
--    revenue that does not exist, not money that left. `amount` is null
--    because we cannot know what it would have been worth without a rate.
select date_trunc('month', oi.pick_date)::date, o.client_id,
       'picked_never_billed',
       'Orders picked and not cancelled with no pick charge',
       count(distinct o.id),
       null::numeric
from order_items oi
join orders o on o.id = oi.order_id
where oi.pick_date is not null
  and oi.quantity_picked > 0
  and not o.cancelled
  and not exists (
    select 1 from order_charges c
    where c.order_id = o.id and c.charge_type = 'pick')
group by 1, 2

union all

-- 3. Shipments with a cost but no charge: we paid and did not bill.
select date_trunc('month', s.ship_date)::date, s.client_id,
       'unpriced_shipments',
       'Shipments with a carrier cost and no shipping charge',
       count(*), coalesce(sum(s.actual_cost), 0)
from shipments s
where s.actual_cost is not null
  and not exists (
    select 1 from order_charges c
    where c.charge_key = 'shipment:' || s.shipstation_shipment_id::text)
group by 1, 2

union all

-- 4. Charges where what we billed is below what it cost us.
--    `c.cost is not null` is load-bearing: a null cost is UNKNOWN, and an
--    unknown cost is not evidence of a negative margin. Without this test
--    every un-costed charge would be reported as a leak.
select date_trunc('month', c.charge_date)::date, c.client_id,
       'negative_margin_lines',
       'Charges billed below cost',
       count(*), coalesce(sum(c.cost - c.amount), 0)
from order_charges c
where c.cost is not null and c.cost > c.amount
group by 1, 2

union all

-- 5. Carrier re-bills: the cost went up after the label was bought.
select date_trunc('month', a.adjustment_date)::date, a.client_id,
       'carrier_rebills',
       'Carrier raised the cost after purchase',
       count(*), coalesce(sum(a.adjustment_amount), 0)
from rate_adjustments a
where a.adjustment_amount > 0
group by 1, 2

union all

-- 6. Voided labels: bought then voided. Refund exposure until piece 2
--    reconciles against the actual statements. A negative adjustment_amount
--    is what a void or refund looks like, and it was structurally
--    unrecordable before Task 10 changed `diff > 0.01` to `abs(diff) > 0.01`.
select date_trunc('month', a.adjustment_date)::date, a.client_id,
       'voided_labels',
       'Labels purchased then voided or refunded',
       count(*), coalesce(sum(abs(a.adjustment_amount)), 0)
from rate_adjustments a
where a.adjustment_amount < 0
group by 1, 2;

-- ---------------------------------------------------------------------------
-- pnl_client_monthly: revenue and direct cost per client per month.
-- GROSS margin only. Overheads are not allocated across clients.
-- ---------------------------------------------------------------------------
create or replace view pnl_client_monthly as
select date_trunc('month', c.charge_date)::date as period_month,
       c.client_id,
       cl.name                                  as client_name,
       c.charge_type,
       count(*)                                 as charges,
       sum(c.amount)                            as revenue,
       -- sum() already skips nulls, so unknown costs do not become zeros.
       sum(c.cost)                              as cost_known,
       count(*) filter (where c.cost is null)   as cost_unknown_charges,
       sum(c.amount) - coalesce(sum(c.cost), 0) as gross_margin,
       bool_or(c.is_estimate)                   as has_estimates
from order_charges c
left join clients cl on cl.id = c.client_id
group by 1, 2, 3, 4;
```

**`cost_unknown_charges` is not decoration.** `sum(c.cost)` silently skips
nulls, so a month where half the costs have not been loaded produces a
confident-looking `gross_margin` that is too high. The count is how a reader
tells "we made $4,000" from "we made $4,000 on the half we have priced." Task
16's screen must display it wherever it displays margin.

```sql
-- ---------------------------------------------------------------------------
-- pnl_monthly: the business total, with overheads subtracted at the top.
-- ---------------------------------------------------------------------------
create or replace view pnl_monthly as
with revenue as (
  select date_trunc('month', charge_date)::date as period_month,
         sum(amount)                            as revenue,
         sum(cost)                              as direct_cost,
         count(*) filter (where cost is null)   as cost_unknown_charges,
         bool_or(is_estimate)                   as has_estimates
  from order_charges group by 1
),
overhead as (
  select period_month,
         sum(amount) filter (where allocation = 'overhead')       as overhead,
         sum(amount) filter (where allocation = 'direct_labor')   as direct_labor,
         sum(amount) filter (where allocation = 'direct_storage') as direct_storage
  from operating_costs group by 1
)
select coalesce(r.period_month, o.period_month) as period_month,
       r.revenue,
       r.direct_cost,
       r.cost_unknown_charges,
       r.revenue - coalesce(r.direct_cost, 0)   as gross_margin,
       o.overhead, o.direct_labor, o.direct_storage,
       -- Null propagates deliberately. Until operating_costs has a row for the
       -- month, net profit is UNKNOWN, and showing gross margin in its place
       -- would overstate profit by the entire overhead bill.
       r.revenue - coalesce(r.direct_cost, 0)
                 - o.overhead - o.direct_labor - o.direct_storage as net_profit,
       r.has_estimates
from revenue r
full outer join overhead o on o.period_month = r.period_month;
```

- [ ] **Step 2: Write the verification script**

Create `supabase/verify/ledger_04_verify.sql`:

```sql
-- Verifies ledger_04_views.sql. Run AFTER applying it. Rolls itself back.
begin;

-- The pick_days ordering bug: an order with dateless Zenventory rows and good
-- ShipStation rows must still appear. If `usable` were applied after
-- `preferred`, this order would vanish entirely.
do $$
declare cid uuid; oid uuid; n int;
begin
  select id into cid from clients limit 1;
  insert into orders (client_id, order_key, order_number, source)
    values (cid, 'VERIFY-PD', 'VERIFY-PD', 'zenventory') returning id into oid;

  -- Zenventory row: present, but no pick date yet. The normal early state.
  insert into order_items (order_id, source, line_ordinal, sku,
                           quantity_picked, pick_date, pick_date_source)
    values (oid, 'zenventory', 1, 'SKU-PD', 3, null, null);
  -- ShipStation row: real pick evidence.
  insert into order_items (order_id, source, line_ordinal, sku,
                           quantity_picked, pick_date, pick_date_source)
    values (oid, 'shipstation', 1, 'SKU-PD', 3, '2026-09-01', 'watermark');

  select count(*) into n from pick_days where sku = 'SKU-PD';
  if n = 0 then
    raise exception 'FAIL: an order with dateless Zenventory rows vanished from pick_days';
  end if;
  raise notice 'PASS: ShipStation pick evidence survives dateless Zenventory rows';
end $$;

-- Confidence must rank watermark BELOW pickprintdate. Alphabetically it does
-- not, which is why the view maps to integers first.
do $$
declare oid uuid; cid uuid; c int;
begin
  select id into cid from clients limit 1;
  insert into orders (client_id, order_key, order_number, source)
    values (cid, 'VERIFY-CONF', 'VERIFY-CONF', 'zenventory') returning id into oid;
  insert into order_items (order_id, source, line_ordinal, sku,
                           quantity_picked, pick_date, pick_date_source)
    values (oid, 'zenventory', 1, 'SKU-CONF', 1, '2026-09-01', 'pickprintdate'),
           (oid, 'zenventory', 2, 'SKU-CONF', 1, '2026-09-01', 'watermark');
  select confidence into c from pick_days where sku = 'SKU-CONF';
  if c <> 2 then
    raise exception 'FAIL: confidence is %, expected 2 (weakest line wins)', c;
  end if;
  raise notice 'PASS: confidence takes the weakest line';
end $$;

-- A charge with an UNKNOWN cost must not be reported as a negative-margin leak.
do $$
declare cid uuid; oid uuid; n int;
begin
  select id into cid from clients limit 1;
  insert into orders (client_id, order_key, order_number, source)
    values (cid, 'VERIFY-LEAK', 'VERIFY-LEAK', 'zenventory') returning id into oid;
  insert into order_charges (order_id, client_id, charge_key, charge_type,
                             label, amount, cost, charge_date, source)
    values (oid, cid, 'item:x:pick', 'pick', 'Pick', 1.28, null, '2026-09-01', 'verify');
  select count(*) into n from leaks_monthly
    where leak = 'negative_margin_lines' and client_id = cid
      and period_month = '2026-09-01';
  if n > 0 then
    raise exception 'FAIL: an unknown cost was reported as a negative margin';
  end if;
  raise notice 'PASS: unknown cost is not a negative-margin leak';
end $$;

-- And a genuinely negative margin must be.
do $$
declare cid uuid; oid uuid; n int;
begin
  select id into cid from clients limit 1;
  insert into orders (client_id, order_key, order_number, source)
    values (cid, 'VERIFY-LEAK2', 'VERIFY-LEAK2', 'zenventory') returning id into oid;
  insert into order_charges (order_id, client_id, charge_key, charge_type,
                             label, amount, cost, charge_date, source)
    values (oid, cid, 'item:y:pick', 'pick', 'Pick', 1.00, 4.00, '2026-09-01', 'verify');
  select count(*) into n from leaks_monthly
    where leak = 'negative_margin_lines' and client_id = cid;
  if n = 0 then raise exception 'FAIL: a real negative margin was not reported'; end if;
  raise notice 'PASS: a real negative margin is reported';
end $$;

-- Net profit must be NULL, not equal to gross margin, when no operating costs
-- have been entered. This is the whole reason the four cost inputs can arrive
-- later without producing a wrong answer in the meantime.
do $$
declare np numeric; gm numeric;
begin
  select net_profit, gross_margin into np, gm
  from pnl_monthly where period_month = '2026-09-01';
  if np is not null and gm is not null and np = gm then
    raise exception 'FAIL: net profit equals gross margin; overheads are being ignored';
  end if;
  raise notice 'PASS: net profit is null until operating costs exist';
end $$;

rollback;
```

That last check is the one worth keeping. It is the difference between a system
that says "we do not know our net profit yet" and one that confidently reports
gross margin as net and overstates profit by the entire rent bill.

- [ ] **Step 3: Commit, then hand over for application**

```bash
git add supabase/ledger_04_views.sql supabase/verify/ledger_04_verify.sql
git commit -m "Add ledger migration 4: pick days, leak report and P&L views"
```

Then say to Ophir:

> Migration 4 is ready at `supabase/ledger_04_views.sql`. Apply it and run
> `supabase/verify/ledger_04_verify.sql`. Then run this and send me what it
> says — it is the first time the system answers your actual question:
>
> ```sql
> select period_month, leak, records, amount
> from leaks_monthly
> where period_month >= date_trunc('month', current_date - interval '2 months')
> order by period_month desc, amount desc nulls last;
> ```

---

## Task 16: Seed the Nayax rate card and the first cost rates

**Files:**
- Create: `supabase/ledger_05_seed_nayax.sql`
- Create: `supabase/ledger_06_seed_cost_rates.sql`

**Spec:** §6 (the eighteen lines), §5.4 (how cost rates are set).

**Depends on:** migration 3 applied (the rate card needs its new columns and a
nullable `rate`).

**Ordering note that matters.** Apply both of these **before** Task 14's step 7
live verification. Task 14's unit tests pass without them — they pass their
rate card in — but `recalculateCharges` against the real database produces
nothing at all if no client has a rate card line, and "no charges" looks
identical to "the calculator is broken."

**Why Nayax alone.** Nayax is the only client whose rate card we hold. Orcam,
Suteka and Crisp Power are outstanding (§10). This is not a blocker: an order
for a client with no rate card raises no charge and appears in
`leaks_monthly.unpriced_shipments`, which is the correct and visible answer.
When a card arrives, it is one more seed file and a recalculation.

**The eighteen lines are transcribed from the quote, with the quote's own
labels.** Do not tidy the wording. The whole point is that when Ophir reads a
charge on a screen he sees the words he agreed to.

- [ ] **Step 1: Read `rate_type` carefully before writing a single row**

Getting this wrong is an order-of-magnitude error, not a rounding one:

| `rate_type` | `rate` means | Charge |
| --- | --- | --- |
| `per_unit`, `per_carton`, `per_pallet`, `per_shelf`, `per_hour`, `per_box` | dollars per unit | `rate × quantity` |
| `flat` | dollars, once | `rate` |
| `percentage` | **percent, not fraction** — 8.00 is 8% | `base × rate / 100` |
| `cost_plus` | **percent markup on our cost** — 15.00 is cost + 15% | `cost × (1 + rate / 100)` |
| `at_cost` | `rate` is **null** | `cost` |

A null `rate` on any type other than `at_cost` is a data error and must be
reported, never treated as zero.

- [ ] **Step 2: Write `supabase/ledger_05_seed_nayax.sql`**

```sql
-- Nayax rate card, transcribed from the quote. Labels are the quote's own.
-- Spec: docs/superpowers/specs/2026-09-29-complete-the-ledger-design.md §6
-- Safe to run more than once: it deletes this client's seeded rows first.

do $$
declare cid uuid;
begin
  select id into cid from clients where name ilike '%nayax%' limit 1;
  if cid is null then
    raise exception 'No client matching "nayax" found. Check the client name first.';
  end if;

  delete from client_warehouse_rates
   where client_id = cid and effective_from = '2026-01-01';

  insert into client_warehouse_rates
    (client_id, category, label, rate, rate_type,
     charge_type, variant, effective_from, effective_to)
  values
    (cid, 'inbound',  'Pallet receiving',                  20.00, 'per_pallet',
     'receiving', 'pallet',             '2026-01-01', null),
    (cid, 'inbound',  'Carton receiving',                   0.85, 'per_carton',
     'receiving', 'carton',             '2026-01-01', null),
    (cid, 'inbound',  'Container devanning 20ft',         450.00, 'flat',
     'receiving', 'devan_20ft',         '2026-01-01', null),
    (cid, 'inbound',  'Container devanning 40ft',         650.00, 'flat',
     'receiving', 'devan_40ft',         '2026-01-01', null),
    (cid, 'storage',  'Pallet position',                   25.00, 'per_pallet',
     'storage',   'pallet',             '2026-01-01', null),
    (cid, 'storage',  'Shelf',                             12.00, 'per_shelf',
     'storage',   'shelf',              '2026-01-01', null),
    -- These two variants are the exact strings Task 5's classifySku returns.
    -- If they drift, every pick silently loses its rate and the order lands in
    -- leaks_monthly.picked_never_billed instead.
    (cid, 'outbound', 'Device pick + serial number scan',   0.32, 'per_unit',
     'pick',      'device',             '2026-01-01', null),
    (cid, 'outbound', 'Component / accessory pick',         0.20, 'per_unit',
     'pick',      'component',          '2026-01-01', null),
    (cid, 'outbound', 'Full carton pick',                   1.50, 'per_carton',
     'pick',      'carton',             '2026-01-01', null),
    (cid, 'outbound', 'Full pallet scan',                  12.50, 'per_pallet',
     'pick',      'pallet_scan',        '2026-01-01', null),
    (cid, 'outbound', 'Full pallet pick',                  20.00, 'per_pallet',
     'pick',      'pallet',             '2026-01-01', null),
    (cid, 'outbound', 'Pallet + shrink wrap',              15.00, 'per_pallet',
     'pack',      'pallet_shrink_wrap', '2026-01-01', null),
    -- at_cost: rate is null by design. The client pays what the carrier charged.
    -- variant is null: there is one freight line, not one per carrier.
    (cid, 'outbound', 'Carrier freight',                    null, 'at_cost',
     'shipping',  null,                 '2026-01-01', null),
    -- percentage: 8.00 means 8 percent, not 800 percent and not 0.08.
    (cid, 'outbound', 'Peak season surcharge',              8.00, 'percentage',
     'surcharge', 'peak',               '2026-01-01', null),
    (cid, 'returns',  'Return processing',                  3.00, 'per_box',
     'return',    'box',                '2026-01-01', null),
    (cid, 'returns',  'Additional returned item',           0.35, 'per_unit',
     'return',    'unit',               '2026-01-01', null),
    (cid, 'returns',  'Special labour',                    48.00, 'per_hour',
     'return',    'labour_hour',        '2026-01-01', null),
    -- cost_plus: 15.00 means cost + 15 percent.
    (cid, 'returns',  'Packing materials',                 15.00, 'cost_plus',
     'material',  'packing',            '2026-01-01', null);

  raise notice 'Seeded 18 Nayax rate lines';
end $$;

-- Every line must be either priced or explicitly at_cost. This returns rows
-- only if something was typed wrong.
select label, rate_type, rate
from client_warehouse_rates
where rate is null and rate_type <> 'at_cost';

-- The calculator finds rates by (charge_type, variant), so a null charge_type
-- is a line that exists on the quote and can never be billed. This must also
-- return nothing.
select label from client_warehouse_rates
where effective_from = '2026-01-01' and charge_type is null;

-- The two pick variants must read exactly 'device' and 'component', because
-- that is what classifySku returns. Expect exactly 2 rows.
select variant, count(*) from client_warehouse_rates
where charge_type = 'pick' and variant in ('device', 'component')
group by 1;
```

**Four of the eighteen lines are seeded but not yet billable**, and that is
deliberate rather than an oversight. `receiving`, `material` and `return` need
an input no sync currently provides, and `storage` gets its own task. See
"Charge types the calculator does not raise yet" near the top of this plan.
Seeding them now means the rate is on record and the gap is visible as an
unbilled service rather than as silence.

- [ ] **Step 3: Populate `description` from the quote**

The spec requires all eighteen `description` fields populated with the
qualifying conditions **transcribed verbatim, not summarised** — the conditions
are part of the price. The quote text is not in this repository.

Ask Ophir:

> I need the qualifying conditions from the Nayax quote — the small print under
> each of the eighteen lines — transcribed exactly, so I can store them against
> each rate. Summarising them would lose the conditions that decide when a rate
> applies. Can you send the quote, or paste those lines?

Until they arrive, `description` stays null. That is visible and harmless; a
paraphrase would not be.

- [ ] **Step 4: Write `supabase/ledger_06_seed_cost_rates.sql`**

```sql
-- First cost rates. Every one of these is ESTIMATED and marked as such.
-- Spec: docs/superpowers/specs/2026-09-29-complete-the-ledger-design.md §5.4
--
-- These exist so the ledger produces a cost column before the payroll,
-- materials, rent and software figures arrive. Each row's basis is
-- 'estimated', so every charge derived from it carries is_estimate = true and
-- no screen may present it as measured.
--
-- When the real figures arrive they are NOT edited over the top. The estimated
-- row is closed with effective_to and a new row opens beside it, so last
-- month's margin is never rewritten. That is what the overlap constraint in
-- ledger_02_cost.sql enforces.
-- Safe to run more than once.

insert into cost_rates (cost_type, variant, unit, rate, effective_from, basis, note)
values
  ('pick', 'device',    'per_unit', 0.2300, '2026-01-01', 'estimated',
   'Placeholder pending direct_labor payroll. Re-baseline over a FULL month '
   || 'of picks: a partial month divides real payroll by incomplete volume and '
   || 'produces a standard that is permanently too high.'),
  ('pick', 'component', 'per_unit', 0.2000, '2026-01-01', 'estimated',
   'Placeholder pending direct_labor payroll. One blended rate across all '
   || 'clients: per-client rates need time-study data that does not exist.'),
  ('pack', null,        'per_order', 0.1500, '2026-01-01', 'estimated',
   'Placeholder pending direct_labor payroll.'),
  ('material', 'box_small',  'per_order', 0.4500, '2026-01-01', 'estimated',
   'Placeholder pending packaging purchase records. These become the only '
   || 'cost rates that are measured rather than derived.'),
  ('material', 'box_medium', 'per_order', 0.7500, '2026-01-01', 'estimated',
   'Placeholder pending packaging purchase records.'),
  ('storage', null, 'per_pallet_month', 12.0000, '2026-01-01', 'estimated',
   'Placeholder pending rent and utilities allocated direct_storage.')
on conflict do nothing;

-- Nothing here should read as measured yet.
select cost_type, variant, rate, basis from cost_rates order by cost_type, variant;
```

- [ ] **Step 5: Commit, then hand over for application**

```bash
git add supabase/ledger_05_seed_nayax.sql supabase/ledger_06_seed_cost_rates.sql
git commit -m "Seed the Nayax rate card and estimated cost rates"
```

Then say to Ophir:

> Two seed files are ready: `supabase/ledger_05_seed_nayax.sql` (the eighteen
> Nayax lines, using the quote's own labels) and
> `supabase/ledger_06_seed_cost_rates.sql` (placeholder cost rates, every one
> marked `estimated` so nothing derived from them can be presented as measured).
>
> Apply both. The first one ends with a query that returns rows only if
> something is mis-typed — it should return nothing. The second prints the six
> rates; every `basis` should read `estimated`.
>
> When your payroll, materials, rent and software figures arrive, I will add
> them as new rows with new effective dates rather than editing these, so last
> month's margin never changes retroactively.

---

## Task 17: A screen that shows the leaks

**Files:**
- Create: `src/app/ledger/page.tsx`
- Create: `src/app/api/ledger/summary/route.ts`

**Spec:** §5.8.

**Depends on:** all four migrations applied and Task 14 having run at least once.

**Keep this small.** Piece 5 of the programme is the real dashboard, and it is
deliberately last because it is a window onto pieces 1–4 and worth little before
they are correct. This screen exists for one reason: so that the work in Tasks
1–16 can be looked at by a person rather than queried by one. Four tables, no
charts, no filters, no drill-through. Resist every instinct to add more. (Task
19 adds a fifth table, for the labour variance, and that is the last one.)

**The one non-negotiable rule for this screen.** Wherever a margin or a profit
figure appears, the count of unknown costs must appear beside it. `sum(cost)`
skips nulls, so a month with half its costs unloaded shows a confident margin
that is too high. A number without its caveat is worse than no number, because
someone will act on it.

**Interfaces:**
- Consumes: views `leaks_monthly`, `pnl_monthly`, `pnl_client_monthly`,
  `pick_days`.
- Produces: `GET /api/ledger/summary` returning
  ```ts
  {
    leaks:   Array<{ period_month: string; leak: string; detail: string
                     records: number; amount: number | null }>
    monthly: Array<{ period_month: string; revenue: number
                     direct_cost: number | null; cost_unknown_charges: number
                     gross_margin: number; net_profit: number | null
                     has_estimates: boolean }>
    clients: Array<{ period_month: string; client_name: string
                     charge_type: string; revenue: number
                     cost_known: number | null; cost_unknown_charges: number
                     gross_margin: number }>
    picks:   Array<{ pick_date: string; sku: string; units_picked: number
                     orders: number; confidence: number }>
  }
  ```

- [ ] **Step 1: Write the API route**

Create `src/app/api/ledger/summary/route.ts`. Read the four views, most recent
three months, and return them unchanged. No computation here — the views own the
arithmetic, and duplicating it in TypeScript is how the two drift apart.

```ts
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export async function GET() {
  const since = new Date()
  since.setMonth(since.getMonth() - 3)
  const from = `${since.getFullYear()}-${String(since.getMonth() + 1).padStart(2, '0')}-01`

  const [leaks, monthly, clients, picks] = await Promise.all([
    supabaseAdmin.from('leaks_monthly').select('*')
      .gte('period_month', from).order('period_month', { ascending: false }),
    supabaseAdmin.from('pnl_monthly').select('*')
      .gte('period_month', from).order('period_month', { ascending: false }),
    supabaseAdmin.from('pnl_client_monthly').select('*')
      .gte('period_month', from).order('period_month', { ascending: false }),
    supabaseAdmin.from('pick_days').select('*')
      .gte('pick_date', from).order('pick_date', { ascending: false }).limit(200),
  ])

  // Errors are surfaced, not swallowed. A view that fails to load must not
  // render as an empty table — empty and broken look identical otherwise.
  const errors = [leaks, monthly, clients, picks]
    .map((r) => r.error?.message).filter(Boolean)

  return NextResponse.json({
    leaks: leaks.data ?? [],
    monthly: monthly.data ?? [],
    clients: clients.data ?? [],
    picks: picks.data ?? [],
    errors,
  })
}
```

- [ ] **Step 2: Write the page**

Create `src/app/ledger/page.tsx`. Four sections, in this order, because it is
the order of decreasing certainty: leaks first (they depend on no cost rate),
then monthly P&L, then per-client, then picks.

Rules the markup must follow:

- A null `amount` renders as **"not quantified"**, never as `$0.00`. "Picked but
  never billed" has no dollar figure by design — it is revenue that does not
  exist — and showing $0.00 would read as "no problem here."
- A null `net_profit` renders as **"unknown — no operating costs entered"**,
  never as the gross margin.
- Any row with `cost_unknown_charges > 0` shows the count next to the margin,
  in the same cell or immediately beside it.
- Any row with `has_estimates` true is visibly marked as an estimate.
- If `errors` is non-empty, render the messages at the top of the page rather
  than showing empty tables.

Use whatever the app's existing pages use for layout — follow the neighbouring
files rather than introducing a new pattern. This is not the restyle work;
that has its own spec and its own approval, still pending.

- [ ] **Step 3: Look at it**

```bash
npm run dev
open http://localhost:3000/ledger
```

Check each of the five rules above against what is on screen. In particular,
find a row where cost is unknown and confirm the screen says so rather than
implying the margin is complete.

- [ ] **Step 4: Commit**

```bash
git add src/app/ledger/page.tsx src/app/api/ledger/summary/route.ts
git commit -m "Add a read-only ledger screen showing leaks and P&L"
```

---

## Task 18: Monthly storage charges

**Files:**
- Create: `supabase/ledger_07_storage.sql`
- Create: `src/lib/ledger/storage-charges.ts`
- Test: `src/lib/ledger/storage-charges.test.ts`
- Modify: `src/app/api/agent/monitor/route.ts`

**Spec:** §4 (storage is named in scope), §6 (Pallet position $25, Shelf $12),
§5.8 (storage drills only to client-and-month).

**Depends on:** Task 9 (the `order_charges` client-keyed partial unique index),
Task 16 (the two storage rate lines).

**Why storage is its own task and not part of Task 14.** Every other charge is
derived from something a sync already fetched. Storage is not: it is billed per
pallet position per month, and nothing in Zenventory or ShipStation tells us how
many pallet positions a client occupied in September. The number has to be
declared. That makes storage the one charge type whose input is a person rather
than an API, which is a different kind of change and deserves its own review.

**Why it matters enough to build now rather than defer.** At $25 a pallet-month
it is the largest non-shipping line on the Nayax card, and Task 9 already built
the client-keyed partial unique index specifically so an order-less charge could
exist. Leaving that index with nothing writing through it means the one category
of charge that *cannot* be re-derived from an order document is also the one
nobody has tested.

**Interfaces:**
- Produces: `buildStorageCharges(input: StorageInput): BuiltCharge[]` — returns
  the same `BuiltCharge` shape Task 14 defined, with `order_id: null` and
  `client_id` set.

- [ ] **Step 1: Write the declaration table**

Create `supabase/ledger_07_storage.sql`:

```sql
-- What each client occupied, per month. Declared, not measured: no system we
-- integrate with reports pallet positions. `source` records who said so, and
-- `basis` is always 'estimated' until it comes off a warehouse count sheet.
-- Spec: docs/superpowers/specs/2026-09-29-complete-the-ledger-design.md §6

create table if not exists client_storage_months (
  id               uuid primary key default uuid_generate_v4(),
  client_id        uuid not null references clients(id),
  period_month     date not null,
  pallet_positions numeric(10,2),
  shelf_positions  numeric(10,2),
  basis            text not null default 'estimated',
  note             text,
  created_at       timestamptz default now(),
  unique (client_id, period_month)
);

-- period_month must be the first of a month. A row dated the 17th would make
-- charge_key 'storage:2026-09-17' and bill the client twice for September.
alter table client_storage_months
  drop constraint if exists client_storage_months_is_month_start;
alter table client_storage_months
  add constraint client_storage_months_is_month_start
  check (period_month = date_trunc('month', period_month)::date);

-- A position count cannot be negative. Without this a typo becomes a credit.
alter table client_storage_months
  drop constraint if exists client_storage_months_non_negative;
alter table client_storage_months
  add constraint client_storage_months_non_negative
  check (coalesce(pallet_positions, 0) >= 0 and coalesce(shelf_positions, 0) >= 0);
```

Verify it rejects both mistakes — this should raise twice and insert nothing:

```sql
do $$
declare cid uuid;
begin
  select id into cid from clients limit 1;

  begin
    insert into client_storage_months (client_id, period_month, pallet_positions)
      values (cid, '2026-09-17', 4);
    raise exception 'FAIL: a mid-month period_month was accepted';
  exception when check_violation then
    raise notice 'PASS: period_month must be a month start';
  end;

  begin
    insert into client_storage_months (client_id, period_month, pallet_positions)
      values (cid, '2026-09-01', -2);
    raise exception 'FAIL: a negative pallet count was accepted';
  exception when check_violation then
    raise notice 'PASS: negative positions are rejected';
  end;
end $$;
```

- [ ] **Step 2: Write the failing tests**

Create `src/lib/ledger/storage-charges.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { buildStorageCharges } from '@/lib/ledger/storage-charges'

const rateCard = [
  { id: 'rs', chargeType: 'storage', variant: 'pallet', rate: 25, rateType: 'per_pallet' },
  { id: 'rh', chargeType: 'storage', variant: 'shelf',  rate: 12, rateType: 'per_shelf' },
]

const costRates = [
  { id: 'cs', cost_type: 'storage', variant: null, unit: 'per_pallet_month',
    rate: 12, effective_from: '2026-01-01', effective_to: null, basis: 'estimated' as const },
]

const base = {
  clientId: 'c1',
  periodMonth: '2026-09-01',
  palletPositions: 4,
  shelfPositions: 0,
  rateCard,
  costRates,
}

describe('buildStorageCharges', () => {
  it('bills pallet positions at the card rate', () => {
    const out = buildStorageCharges(base)
    const pallet = out.find((c) => c.charge_key === 'storage:2026-09-01:pallet')!
    expect(pallet.amount).toBe(100)
    expect(pallet.quantity).toBe(4)
    expect(pallet.order_id).toBeNull()
    expect(pallet.client_id).toBe('c1')
  })

  it('bills shelf positions separately from pallets', () => {
    const out = buildStorageCharges({ ...base, palletPositions: 2, shelfPositions: 3 })
    expect(out.find((c) => c.charge_key === 'storage:2026-09-01:pallet')!.amount).toBe(50)
    expect(out.find((c) => c.charge_key === 'storage:2026-09-01:shelf')!.amount).toBe(36)
  })

  // Zero positions is a real, known fact: the client stored nothing. It must
  // raise no charge, but it must also not be confused with "we never asked".
  it('raises no charge for zero positions', () => {
    const out = buildStorageCharges({ ...base, palletPositions: 0, shelfPositions: 0 })
    expect(out).toEqual([])
  })

  // A null count means nobody has declared it. Treating it as 0 would silently
  // bill nothing and look identical to a client who genuinely stored nothing.
  it('raises no charge for a null count, and that is not the same as zero', () => {
    const out = buildStorageCharges({ ...base, palletPositions: null, shelfPositions: null })
    expect(out).toEqual([])
  })

  it('charges the storage cost rate against pallet-months', () => {
    const out = buildStorageCharges(base)
    const pallet = out.find((c) => c.charge_key === 'storage:2026-09-01:pallet')!
    expect(pallet.cost).toBe(48)          // 4 pallets * $12
    expect(pallet.cost_basis).toBe('estimated')
    expect(pallet.is_estimate).toBe(true)
  })

  // Shelf storage has no cost rate of its own. Null, not zero -- a shelf is not
  // free to provide, we simply have not costed it.
  it('leaves shelf cost null rather than zero', () => {
    const out = buildStorageCharges({ ...base, palletPositions: 0, shelfPositions: 3 })
    expect(out[0].cost).toBeNull()
    expect(out[0].cost_basis).toBeNull()
  })

  it('raises nothing when the client has no storage line on their card', () => {
    expect(buildStorageCharges({ ...base, rateCard: [] })).toEqual([])
  })

  // Three crons a day. The key must not move.
  it('produces identical keys on repeated calls', () => {
    expect(buildStorageCharges(base).map((c) => c.charge_key))
      .toEqual(buildStorageCharges(base).map((c) => c.charge_key))
  })

  // charge_date is the first of the billed month, not today. Dating it to the
  // run date would move the charge into whichever month the cron happened to
  // run in, and September's storage would land in October's P&L.
  it('dates the charge to the billed month, not the run date', () => {
    expect(buildStorageCharges(base)[0].charge_date).toBe('2026-09-01')
  })
})
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npm test -- storage-charges`
Expected: FAIL — `Failed to resolve import "@/lib/ledger/storage-charges"`.

- [ ] **Step 4: Write the implementation**

Create `src/lib/ledger/storage-charges.ts`:

```ts
import { findCostRate, costOf, type CostRateRow } from '@/lib/ledger/cost-rate'
import type { BuiltCharge } from '@/lib/ledger/calculate-charges'

export interface StorageInput {
  clientId: string
  periodMonth: string               // always a month start, YYYY-MM-01
  palletPositions: number | null    // null = nobody has declared it
  shelfPositions: number | null
  rateCard: Array<{ id: string; chargeType: string; variant: string | null
                    rate: number | null; rateType: string }>
  costRates: CostRateRow[]
}

const cents = (n: number) => Math.round(n * 100) / 100

export function buildStorageCharges(input: StorageInput): BuiltCharge[] {
  const out: BuiltCharge[] = []

  const line = (variant: 'pallet' | 'shelf', qty: number | null, costType: string | null) => {
    // null means undeclared and 0 means "stored nothing". Neither bills, but
    // they are different facts and only the first should ever be chased up.
    if (qty === null || qty <= 0) return

    const rate = input.rateCard.find(
      (r) => r.chargeType === 'storage' && r.variant === variant)
    if (!rate || rate.rate === null) return

    const lookup = costType
      ? findCostRate(input.costRates, { costType, chargeDate: input.periodMonth })
      : null
    const cost = lookup ? costOf(lookup, qty) : null

    out.push({
      // Storage belongs to a client and a month, not to an order. This is the
      // row the client-keyed partial unique index in Task 9 exists for.
      order_id: null,
      client_id: input.clientId,
      // Not chargeKey(): that shape keys storage on the month alone, which
      // would collide pallet and shelf onto one row. The variant has to be in
      // the key, and (client_id, charge_key) is the index it must be unique on.
      charge_key: `storage:${input.periodMonth}:${variant}`,
      charge_type: 'storage',
      label: variant === 'pallet' ? 'Pallet position' : 'Shelf',
      quantity: qty,
      unit_rate: rate.rate,
      amount: cents(rate.rate * qty),
      cost: cost === null ? null : cents(cost),
      cost_basis: lookup?.known ? lookup.basis : null,
      rate_id: rate.id,
      cost_rate_id: lookup?.known ? lookup.rateId : null,
      // The billed month, never the run date.
      charge_date: input.periodMonth,
      charge_date_source: 'period_month',
      source: 'calculator',
      is_estimate: !lookup?.known || lookup.basis === 'estimated',
    })
  }

  line('pallet', input.palletPositions, 'storage')
  // No cost rate exists for shelf storage. Passing null leaves cost null rather
  // than borrowing the pallet rate, which would be inventing a number.
  line('shelf', input.shelfPositions, null)

  return out
}
```

Run: `npm test -- storage-charges` — expect PASS, 9 tests.

- [ ] **Step 5: Persist it from the monitor route**

In `src/app/api/agent/monitor/route.ts`, after the charge recalculation, read
`client_storage_months` for the last three months joined to each client's rate
card and upsert the result. Storage rows have `order_id is null`, so they use
the **client-keyed** index:

```ts
const { data: months } = await supabaseAdmin
  .from('client_storage_months')
  .select('client_id, period_month, pallet_positions, shelf_positions')
  .gte('period_month', monthStart(3))

for (const m of months ?? []) {
  const rows = buildStorageCharges({
    clientId: m.client_id,
    periodMonth: m.period_month,
    palletPositions: m.pallet_positions === null ? null : Number(m.pallet_positions),
    shelfPositions: m.shelf_positions === null ? null : Number(m.shelf_positions),
    rateCard: cardFor(m.client_id),
    costRates: allCostRates,
  })
  if (rows.length === 0) continue
  const { error } = await supabaseAdmin
    .from('order_charges')
    .upsert(rows.map((r) => ({ ...r, calculated_at: new Date().toISOString() })),
            { onConflict: 'client_id,charge_key' })
  if (error) throw error
}
```

**Do not add a stale-delete here.** Task 14's stale-delete is scoped by
`order_id`, and these rows have none; a delete scoped by `client_id` alone would
remove every unattributed charge the client has. Storage rows are corrected by
re-upserting, never by sweeping.

- [ ] **Step 6: Verify, then commit**

Run the sync twice and confirm the totals do not move:

```sql
select period_month, client_id, charge_key, quantity, amount, cost
from order_charges where charge_type = 'storage' order by 1, 3;
```

```bash
git add supabase/ledger_07_storage.sql src/lib/ledger/storage-charges.ts \
        src/lib/ledger/storage-charges.test.ts src/app/api/agent/monitor/route.ts
git commit -m "Bill monthly storage from declared pallet and shelf positions"
```

- [ ] **Step 7: Ask for the numbers**

Say to Ophir:

> Storage is the one charge nothing can measure for us — no system we connect to
> reports how many pallet positions a client occupied. I have built the table and
> the billing; it needs the counts.
>
> For each client, for each month you want billed: how many pallet positions and
> how many shelf positions? A rough figure is fine and I will mark it estimated;
> an absent figure bills nothing at all, which on the Nayax card is $25 a pallet
> a month going unbilled silently.

---

## Task 19: Put the labour variance on the screen

**Files:**
- Modify: `supabase/ledger_04_views.sql` (add one view)
- Modify: `src/app/api/ledger/summary/route.ts`
- Modify: `src/app/ledger/page.tsx`

**Spec:** §5.3.2 (the held-standard variance), §5.8 (`pnl_monthly` carries the
variance lines).

**Depends on:** Task 6 (`labourVariance`), Task 15 (the views), Task 17 (the
screen).

**Why this task exists.** Task 6 built and tested `labourVariance()`, and until
this task nothing calls it. A tested function nobody calls is not a feature —
the spec asks for the variance to be *reported*, and §5.3.2 is explicit that the
report must show the components, "so the cause is visible rather than inferred
from one number."

**Why the arithmetic stays in TypeScript and not in the view.** It would be
shorter to compute `payroll - picks * standard_rate` in SQL. Then there would be
two implementations of the same formula, one tested and one not, and the first
time one changed they would disagree silently. The view supplies the three
measured inputs; `labourVariance()` remains the only place the subtraction
happens.

- [ ] **Step 1: Add the inputs view**

Append to `supabase/ledger_04_views.sql`:

```sql
-- ---------------------------------------------------------------------------
-- labour_variance_inputs: the three measured numbers §5.3.2 needs, and nothing
-- derived from them. The subtraction lives in src/lib/ledger/variance.ts so
-- there is exactly one implementation of it.
--
-- standard_rate is read from cost_rates as it stood ON the month being
-- reported, not as it stands today. Using today's rate would silently rewrite
-- every past month's variance the moment anyone re-baselines -- which is the
-- circularity §5.3.2 exists to prevent, arriving by a different route.
-- ---------------------------------------------------------------------------
create or replace view labour_variance_inputs as
with months as (
  select distinct date_trunc('month', charge_date)::date as period_month
  from order_charges
  where charge_type = 'pick'
),
picked as (
  select date_trunc('month', c.charge_date)::date as period_month,
         sum(c.quantity) as units_picked
  from order_charges c
  where c.charge_type = 'pick'
  group by 1
),
payroll as (
  select period_month, sum(amount) as direct_labor
  from operating_costs
  where allocation = 'direct_labor'
  group by 1
)
select m.period_month,
       p.units_picked,
       -- null, not 0: payroll for a month nobody has entered is unknown, and
       -- a 0 here would report the entire standard cost as a favourable
       -- variance -- a large fictitious saving.
       r.direct_labor,
       (select cr.rate from cost_rates cr
         where cr.cost_type = 'pick'
           and cr.effective_from <= m.period_month
           and (cr.effective_to is null or m.period_month < cr.effective_to)
         order by cr.effective_from desc
         limit 1) as standard_rate,
       case when p.units_picked > 0 and r.direct_labor is not null
            then r.direct_labor / p.units_picked end as implied_actual_rate
from months m
left join picked  p on p.period_month = m.period_month
left join payroll r on r.period_month = m.period_month
order by m.period_month desc;
```

Verify it reports unknown rather than zero before any payroll exists:

```sql
-- Until operating_costs has a direct_labor row, direct_labor MUST be null.
-- If this returns 0.00 the view is claiming we spent nothing on labour.
select period_month, units_picked, direct_labor, standard_rate
from labour_variance_inputs;
```

- [ ] **Step 2: Compute the variance in the summary route**

In `src/app/api/ledger/summary/route.ts`, add the view to the parallel read and
run each row through `labourVariance`:

```ts
import { labourVariance } from '@/lib/ledger/variance'

// ... added to the Promise.all:
supabaseAdmin.from('labour_variance_inputs').select('*')
  .gte('period_month', from).order('period_month', { ascending: false }),

// ... after the reads:
const variance = (varianceRows.data ?? []).map((r) => {
  const v = labourVariance({
    actualCost:   r.direct_labor   === null ? null : Number(r.direct_labor),
    standardRate: r.standard_rate  === null ? null : Number(r.standard_rate),
    quantity:     Number(r.units_picked ?? 0),
  })
  return {
    period_month:        r.period_month,
    units_picked:        Number(r.units_picked ?? 0),
    direct_labor:        r.direct_labor,
    standard_rate:       r.standard_rate,
    implied_actual_rate: r.implied_actual_rate,
    absorbed:            v.absorbed,
    variance:            v.variance,
    basis:               v.basis,
  }
})
```

Add `variance` to the returned JSON.

- [ ] **Step 3: Render it, with the caveat attached**

Add a fifth section to `src/app/ledger/page.tsx`, **below** the leaks table and
labelled as a secondary signal. Spec §5.3.2 ends: *"This is a secondary signal,
and it is labelled as one. Until piece 2 reconciles against actual bills, the
labour variance rests on a standard rate whose own accuracy is unproven."* That
sentence, or something with the same meaning, goes on the screen — not only in
this plan.

Rules:

- A `basis` of `'unavailable'` renders as **"not computable — payroll not
  entered"**, never as `$0.00`. A zero variance and an unknown variance look
  identical on a screen and mean opposite things.
- Show all four components — payroll, units picked, implied actual rate,
  standard rate — beside the variance, per §5.3.2.
- Mark the section as resting on an estimated standard rate for as long as the
  covering `cost_rates` row has `basis = 'estimated'`.

- [ ] **Step 4: Check it says "unknown" today**

`operating_costs` is empty until Ophir's payroll figures arrive, so the correct
output right now is "not computable — payroll not entered" for every month. If
the screen shows a variance figure instead, something is substituting zero for
unknown and it must be found before this ships.

```bash
git add supabase/ledger_04_views.sql src/app/api/ledger/summary/route.ts \
        src/app/ledger/page.tsx
git commit -m "Report the labour variance with its components, or say why not"
```

---

## Closing: ask before anything is pushed

- [ ] **Final step: get an explicit decision from Ophir**

Say to him:

> Piece 1 is complete on the branch `ledger/complete-the-ledger`. Nothing has
> been pushed. Before it goes anywhere, tell me what you would like to do:
>
> 1. Review the branch locally first — I can walk you through what each commit
>    does.
> 2. Push the branch alone, with no deploy, so you can read the diff on GitHub.
> 3. Deploy it. If so, I would still like to send the carrier-filter change
>    (Task 11) as its own push, before or after everything else, so that the
>    jump in recorded cost has exactly one possible cause.
>
> I will not push until you say which.

---
