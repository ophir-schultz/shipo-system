# Re-review: Pick-Date / Watermark Change

> **Provenance banner, added in `6779251`+1 at commit time — not part of the original review.**
> Written **13:17 on 2026-10-01 against HEAD `fad4881`**. Where the text below says
> "current state", "at HEAD" or "today", it means `fad4881`, **not** the tree you are
> reading now — 20+ commits have landed since, and several findings here are closed or
> were restated after being checked. This file is committed for **provenance**: it is the
> traceable source behind the `FROM-REVIEW` item IDs in `handover-2026-10-02.md`. Read
> that file first for current status, then come here for the detail. **Re-verify against
> the code before acting on anything below.**

**Branch:** `ledger/complete-the-ledger` · **HEAD:** `fad4881`  
**Scope:** `pick-date.ts`, `pick-date.test.ts`, `zenventory.ts`, `calculate-charges.ts`, `calculate-charges.test.ts`, `ledger_01_orders.sql`, `ledger_04_views.sql`  
**Reviewer:** Independent (sub-agent, no access to author)

---

## 1. Verdict

**APPROVED WITH FINDINGS** — the core design is sound and the safety direction is correct throughout; one Important finding (persistent undated picks become silent after the initial alert) and one Minor finding (the unpricedOrders counter misses the exact failure mode it is named after in the undated-pick scenario).

---

## 2. Q1 — the 24-hour bound

**The reasoning is valid.** The argument is:

- Inside 24 hours: the pick happened either today or yesterday. The before-06:00 rule was designed for exactly that adjacency, so the watermark is either right or off by the one day the rule handles. That is bounded and acknowledged error.
- Past 24 hours: the error is in days and unbounded by anything in the data. The correct answer to "I cannot bound the error" is null, not today's date.

**Is the bound reachable in normal operation (spurious rejections)?**  
No. The cron gaps are 8h, 6h, and 10h (06:00→14:00, 14:00→20:00, 20:00→06:00). The maximum single-gap between consecutive runs is 10h. Even if a run is slow, Vercel's `maxDuration = 300s` (5 minutes) means a run cannot extend significantly. The bound tolerates two consecutive missed runs (e.g. 10h + 10h = 20h, inside 24h, still passes). A gap of 24h exactly passes (`gapHours <= maxGapHours` is inclusive).

**DST transitions:** The gap calculation is entirely in UTC milliseconds — `(now.getTime() - previous.getTime()) / 3_600_000` — so DST is irrelevant to it. DST only affects `watermarkPickDate`, which is handled by `Intl.DateTimeFormat`, not by this check.

**Clients with no orders:** If a client has a healthy run that processed zero orders, that run still closes with status `'ok'` and records a `finished_at`. The next run finds that row, computes a sub-24h gap, and returns true. No spurious false trigger.

**When the bound misfires, which direction?** It fails conservatively. A false rejection leaves `pick_date = null`, which is recoverable by a manual backfill or a later healthy run (if the line is ever re-picked). A false acceptance fabricates a date that is set once and never corrected. The code comment states this explicitly, and the implementation confirms it: `gapHours < 0` (clock skew / future timestamp) also returns false, not true.

**One edge case worth noting but not blocking:** `now` is captured at `const now = new Date()` (zenventory.ts:72) *before* the Supabase query for `previousRun`. If that query takes several seconds, the effective gap measured is slightly shorter than reality. This is conservative (makes the guard more permissive, not more rejecting), so it errs in the safe direction.

---

## 3. Q2 — the sticky marker

**Sticking and unsticking:**

The stickiness predicate in `zenventory.ts:186` is:
```
if (line.picked && !pickDate && pickSource !== 'unknown')
```

This correctly implements the sticky marker:
- A line already marked `pick_date_source = 'unknown'` (with `pick_date = null`) does not re-enter the watermark branch on a subsequent healthy run, which is the point. Without this guard, a line left undated during an outage would get stamped with the later run's date — which is MORE wrong than the date that was declined in the first place.

**The unpick path correctly clears it:**

`zenventory.ts:209`:
```
if (!line.picked && (pickDate || pickSource)) {
  pickDate = null
  pickSource = null
}
```

When a line with `pick_date_source = 'unknown'` and `pick_date = null` becomes unpicked: `(null || 'unknown')` is `'unknown'`, which is truthy — so both fields are cleared to null. On the NEXT run where the line is picked again (during a healthy window), `pickSource` is now null, so `pickSource !== 'unknown'` is true, and the watermark is written correctly. This is the right behaviour, and the code comment at line 204 names it explicitly.

**The `'unknown'` value in the schema:**

`ledger_01_orders.sql:74`: `pick_date_source text` — no CHECK constraint. The column accepts any string value, so `'unknown'` is legal without a migration.

**The `'unknown'` value in `pick_days` view:**

The view's WHERE clause (`ledger_04_views.sql:58-59`) is:
```sql
where oi.pick_date is not null
  and oi.quantity_picked > 0
```

Lines with `pick_date_source = 'unknown'` have `pick_date = null` by construction and are excluded before the CASE expression is evaluated. The `else 0` fallback handles it correctly if a row ever arrives with a non-null pick_date but an unknown source, which is not possible under this code but is still harmless.

**No leak into constraints or other views** — the value is a plain text column with no CHECK constraint. No other SQL file in scope references `pick_date_source` by enumerated values.

---

## 4. Q3 — the new silent hole

The question is whether a null `pick_date` (and hence no pick/pack charge) actually reaches a person. Tracing every hop:

**Hop 1: zenventory.ts → `totalUndatedPicks` (source: lines 89, 201, 297-304, 327)**

When a line is first seen as picked during a discontinuity, `undatedPicks` is incremented at line 201. At lines 297-304, `run.warn('undated picks', ...)` records the count into `sync_runs.errors` for the client's zenventory run. At line 304, `totalUndatedPicks += undatedPicks`. The function returns `{ undated_picks: totalUndatedPicks, ... }` at line 327.

**Hop 2: monitor/route.ts reads `clientResult.undated_picks` (line 118-123)**

```ts
if (Number(clientResult.undated_picks ?? 0) > 0) {
  errors.push(...)
}
```

This puts the message into `errors[]`, which triggers the `🚨` subject line and appears in the email body. **This hop is intact.** The `undated_picks` key matches the return value exactly.

**Hop 3: The persist-charges path (calculate-charges.ts → persist-charges.ts)**

When `buildCharges` encounters an item with `qty > 0` and `pickDate = null`, it calls `onWarn?.('undated pick', ...)` at line 127-132. In `persist-charges.ts:248`, `onWarn = (ctx, detail) => run.warn(ctx, detail)`. This warning goes to `sync_runs.errors` for the `source='charges'` run. The `recalculateCharges` return value does NOT include an undated-picks count. The monitor route does NOT read `sync_runs.errors` for warnings — it only reads the return value.

**Gap identified: recurring undated picks are silent after the initial run.**

On the first run after an outage, zenventory.ts writes `pick_date_source = 'unknown'` and increments `undatedPicks`. The monitor email fires.

On all SUBSEQUENT zenventory runs, those lines already have `pick_date_source = 'unknown'`, so the stickiness check (`pickSource !== 'unknown'`) prevents them from re-entering the branch that increments `undatedPicks`. The count stays zero. No re-alert from zenventory.

On every charge recalculation run, `buildCharges` fires a per-order `onWarn` for each undated-pick line. These go to `sync_runs.errors` (kind: 'warning'), but the monitor email never reads `sync_runs.errors` for the charges run — it only reads the function's return value.

The `unpricedOrders` counter (`persist-charges.ts:270-272`) also does not catch these lines, because its predicate is:
```ts
const picked = !input.order.cancelled
  && input.items.some((i) => (i.quantityPicked ?? 0) > 0 && i.pickDate)
```
An order whose only picked items have `pickDate = null` evaluates `picked = false` and is never counted.

**Conclusion:** The initial outage-recovery alert reaches the human. After that, the lines are silent in the email; they can only be found by reading `sync_runs.errors` directly or querying `order_items` for `pick_date_source = 'unknown'`. This is bounded: the risk is that undated lines go un-billed indefinitely without a second prompt. The per-order `buildCharges` warnings in `sync_runs.errors` are findable but not surfaced.

---

## 5. TESTS THAT CANNOT FAIL

**pick-date.test.ts — describe('watermarkIsEvidence') — 8 tests:**

1. **'refuses when there is no previous run at all'** — `null`, `undefined`, and `''` all satisfy `!previousRunFinishedAt` and return `false`. All three assertions use `.toBe(false)` (strict). **Can fail. Sound.**

2. **'refuses an unparseable timestamp'** — `new Date('not a date').getTime()` is `NaN`; `Number.isNaN(NaN)` is `true`; returns `false`. Assertion uses `.toBe(false)`. **Can fail. Sound.**

3. **'refuses a run that finished in the future'** — `hoursAgo(-3)` sets `gapHours = -3 < 0`; returns `false`. Uses `.toBe(false)`. **Can fail. Sound.**

4. **'trusts the normal cron cadence'** — 6h, 8h, 10h all satisfy `<= 24`; return `true`. Uses `.toBe(true)`. **Can fail. Sound.**

5. **'tolerates two consecutive missed runs'** — 18h and 24h both satisfy `<= 24`; return `true`. Uses `.toBe(true)`. **Can fail. Sound.**

6. **'refuses once the gap exceeds a day'** — `hoursAgo(WATERMARK_MAX_GAP_HOURS)` = 24h → `24 <= 24` → `true`; `hoursAgo(24.5)` → `false`. Uses `.toBe(true)` and `.toBe(false)`. **Can fail. Sound.**

7. **'refuses the outage this guard exists for'** — 336h → `false`. Uses `.toBe(false)`. **Can fail. Sound.**

8. **'honours an explicit gap bound'** — explicit `maxGapHours` override tested in both directions with `.toBe(false)` and `.toBe(true)`. **Can fail. Sound.**

**calculate-charges.test.ts — 2 undated-pick tests:**

9. **'names the undated picked line it declined to charge'** — The warning message is `"undated pick: client c1: order o1 line i4w (sku R144GUSB01S10) has 3 picked but no pick date..."`. Assertions: `.toHaveLength(1)` (count exact), `.toContain('undated pick')` (context prefix), `.toContain('i4w')` (item id appears as "line i4w"), `.toContain('R144GUSB01S10')` (sku appears literally), `.toContain('3 picked')` (appears as "3 picked but"). All five assertions are grounded in specific values from the message. None match for the wrong reason. **Can fail. Sound.**

10. **'stays quiet about an unpicked line with no pick date'** — Items with `quantityPicked = 0` and `null` hit the `if (qty === null || qty === undefined || qty === 0) continue` guard before reaching the pickDate check. `warnings` stays empty. Assertion is `expect(warnings).toEqual([])` (exact empty array, not `.toBeFalsy()`). **Can fail. Sound.**

All 10 new tests are sound and will go red on the relevant regressions.

---

## 6. Findings

### Important — F1: Undated picks become permanently silent after the initial run

**File:** `src/lib/sync/zenventory.ts` (lines 186, 201), `src/lib/ledger/persist-charges.ts` (lines 270-272), `src/app/api/agent/monitor/route.ts` (lines 118-123)

**What is wrong:** On the first run after an outage, `undated_picks` is reported in the monitor email. On all subsequent runs, those same lines have `pick_date_source = 'unknown'` and the stickiness guard (`pickSource !== 'unknown'`) prevents them from re-entering the undated branch — so `undatedPicks` stays 0 and no alert fires again. The per-order warnings from `buildCharges` for these lines go to `sync_runs.errors` (kind: 'warning') but the monitor route never reads `sync_runs.errors`. The `unpricedOrders` counter also misses them because its predicate requires `i.pickDate` to be non-null. After the initial alert, undated lines sit unbilled indefinitely with no recurring notification.

**What to do:** Add a direct database count of `order_items` rows where `pick_date_source = 'unknown'` to the monitor scan (section 4), and surface the total in `errors[]` if non-zero. Alternatively, add an `undatedPicks` counter to `recalculateCharges`'s return value (counting items where `pickDate == null && qty > 0` in the loader output) and surface that in the email.

---

### Minor — F2: `unpricedOrders` counter misses the undated-pick case

**File:** `src/lib/ledger/persist-charges.ts` (lines 270-272)

**What is wrong:** The predicate for `unpricedOrders` is:
```ts
const picked = !input.order.cancelled
  && input.items.some((i) => (i.quantityPicked ?? 0) > 0 && i.pickDate)
```
An order whose every picked line has `pickDate = null` evaluates `picked = false` — not counted as unpriced, even though it has picked lines that produced no pick charge. This is the failure mode the whole `watermarkIsEvidence` change introduces. The `unpricedOrders` email alert therefore provides no coverage for this case.

**What to do:** Separate the two conditions: count an order as unpriced if it has any line with `qty > 0` (regardless of `pickDate`) but no pick charges emerged. Or add a parallel counter for "picked lines with no pick date" in the return value as described in F1.

---

## 7. Strengths

- The null-vs-zero discipline is maintained throughout: `pick_date = null` correctly means "unknown", not "free". The code comment at zenventory.ts:192-198 names the tradeoff explicitly.
- The stickiness guard (`pickSource !== 'unknown'`) prevents the failure mode it was introduced to fix (a later healthy run stamping a more-wrong date). The unpick-clears path handles re-picked lines correctly.
- `now` is captured before the `previousRun` Supabase query, which makes the gap measurement conservative (slightly shorter than reality, i.e. less likely to reject).
- The test for "refuses when there is no previous run" covers all three falsy forms of "no previous run" (`null`, `undefined`, `''`) in a single assertion block, which is thorough.
- The SQL confidence CASE expression's `else 0` catches any future `pick_date_source` value not yet enumerated, including `'unknown'`, without breaking.
