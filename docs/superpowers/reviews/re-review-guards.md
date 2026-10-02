# Re-review: guards and tests — `ledger/complete-the-ledger` (60e948a..fad4881)

> **Provenance banner, added in `6779251`+1 at commit time — not part of the original review.**
> Written **13:17 on 2026-10-01 against HEAD `fad4881`**. Where the text below says
> "current state", "at HEAD" or "today", it means `fad4881`, **not** the tree you are
> reading now — 20+ commits have landed since, and several findings here are closed or
> were restated after being checked. This file is committed for **provenance**: it is the
> traceable source behind the `FROM-REVIEW` item IDs in `handover-2026-10-02.md`. Read
> that file first for current status, then come here for the detail. **Re-verify against
> the code before acting on anything below.**

Reviewer: Claude Sonnet 4.6 · Date: 2026-10-01

---

## 1. Verdict

**APPROVED WITH FINDINGS** — the three guards are structurally sound and the security claim is true, but one error message misquotes its own threshold, and `blankOrderNumber` is misrouted to `log` when it belongs in `errors`.

---

## 2. Q1 — the blast-radius floor

### Is `rows.length` the right comparand?

`rows.length` is the count of charge rows this run _built_ before writing them. The guard reads: refuse the sweep when `staleCandidates > rows.length`. This is the correct operand for the stated property — "a single recalculation should not be able to halve the ledger unattended" — because what the sweep removes was produced by a calculator, and what the calculator produced is exactly `rows.length`.

Three legitimate scenarios where the guard would block a correct sweep:

1. **Client offboarded** — all rate-card lines removed. `rows.length = 0`, any existing charges trigger the guard. This is _correct_ behaviour: offboarding should be a deliberate, confirmed step, not an automatic wipe driven by the absence of rate-card lines. The operator sees the alert and deletes manually after confirming.

2. **Dedup fix collapsing rows** — a fix that turns N charge rows per order into N/2. `staleCandidates` (the old N rows) exceeds `rows.length` (the new N/2 rows). The guard trips. The operator must run the sweep by hand once satisfied. Recoverable.

3. **Window of all-cancelled orders** — if `buildCharges` emits nothing for cancelled orders and staleCandidates > 0, the guard fires. Same recovery path.

In every case the false refusal is loud (`run.fail` → non-`'ok'` status → throttle not satisfied → next cron fires immediately → monitor email with `staleDeleteRefused`) and the _alternative_ (unrecoverable deletion of billing history) is worse. The asymmetry justifies the early threshold.

### Is refusal recoverable, and does it wedge?

Not permanently wedged. `run.fail` causes `close()` to resolve `'failed'` (because `rowsWritten = 0` in the typical rate-card-empty scenario). `status != 'ok'` means the throttle is never satisfied, so the next run is not silenced. The system will alert every ~8 hours until someone acts.

`order_charges` after a refused sweep: the upsert has already run, so charges that _still exist_ in the new calculation are updated in place (single row per `order_id,charge_key`). Stale rows — those whose `charge_key` the calculator no longer produces — survive. This can inflate per-order totals for the affected orders. The monitor message correctly warns "totals may double-count", and the run's non-`'ok'` status makes this visible.

### Is the refusal a `run.fail` or a warning?

`run.fail` is correct. A refused sweep means billing history is left in an unknown state. It must prevent the throttle from silencing the next attempt, and `warn()` does not increment `errors.count()`, so `close()` would resolve `'ok'` and the throttle would swallow the next run. The code does this right.

### First run against an empty table

`staleCandidates = 0`, `rows.length = N` (charges built from a populated rate card). `0 > N` is `false`. Guard does not fire. Correct.

If the rate card is also empty on a first run: `staleCandidates = 0`, `rows.length = 0`. `0 > 0` is `false`. Guard does not fire; sweep is a no-op. Correct.

### "Named once used twice" — verified

```
// persist-charges.ts lines 400–410
const countUnreadable           = !candidatesCounted                   // defined once
const wouldDeleteMoreThanItBuilt = staleCandidates > rows.length       // defined once
const refuseSweep               = countUnreadable || wouldDeleteMoreThanItBuilt

if (refuseSweep && staleCandidates > 0) staleDeleteRefused = staleCandidates  // use 1

if (countUnreadable) { … }                         // use 2a (selects which run.fail message)
} else if (wouldDeleteMoreThanItBuilt) { … }       // use 2b
```

Both conditions are computed exactly once and read in exactly two places. No third site recomputes either expression. The claim in the comment is accurate.

---

## 3. Q2 — fail-closed verification

### Relevant lines of `src/lib/require-staff.ts`

```typescript
// line 51
const secret = process.env.CRON_SECRET || process.env.MONITOR_SECRET

if (secret) {                                         // line 53
  const auth = req.headers.get('authorization') ?? ''
  if (auth === `Bearer ${secret}`) return null        // pass
}

const denied = await requireStaff()                   // falls through to session check
```

**When both vars are unset:** `undefined || undefined = undefined`. `if (undefined)` is false. Bearer branch is skipped entirely. Falls through to `requireStaff()`. This is `createClient().auth.getUser()` returning `{ data: { user: null }, error: ... }` on any error (Supabase SDK contract: never throws, returns `user: null` on auth failure). `!user` → 401. **Confirmed: fails CLOSED.**

**When one is set, one is not:** `'abc' || undefined = 'abc'`. Bearer branch runs against the set value. The absent one has no effect. Correct.

**Empty-string vars:** `'' || '' = ''`. Falsy. Bearer branch skipped. Falls to `requireStaff()`. Closed.

**Timing safety:** `auth === \`Bearer ${secret}\`` is not constant-time. This does not matter in practice: the secret is a server-side env var (a Vercel cron secret), timing oracle attacks require sub-millisecond precision and many sequential requests, and HTTP round-trip jitter is orders of magnitude larger than string comparison time. For a cron secret (not a user password) this is not a meaningful exposure.

**`requireStaff()` fail-closed on error:** Supabase's `getUser()` returns `{ data: { user: null }, error: AuthError }` rather than throwing when the auth service is unavailable. `!null` → 401. If `createClient()` itself throws, the exception propagates to Next.js's unhandled-error boundary and returns a 500 — no data is returned in either case. Closed.

**Proxy exclusion confirmed:** `src/proxy.ts` config matcher (line 104):
```
'/((?!_next/static|_next/image|favicon.ico|shipo-logo.jpg|chat.js|api/|partner$|partner/|rate-sheets/).*)'
```
`api/` is excluded. The proxy never runs for `/api/ledger/summary`. The route-level check is the only check.

**Handler return path:** `src/app/api/ledger/summary/route.ts` lines 25–28:
```typescript
const denied = await requireStaffOrCron(req)
if (denied) return denied          // hard return — unreachable past this when denied
return NextResponse.json(await getLedgerSummary())
```
No path returns data when `denied` is set.

**Conclusion: the claim holds completely.** An unconfigured deployment fails closed.

---

## 4. Q3 — monitor reporting

### Counters that reach a human (errors[]) vs. log only

| Counter | Dest | Correct? |
|---|---|---|
| `syncResult.errors` | `errors[]` | Yes — shipments not recorded, revenue missing |
| `syncResult.unknownCarrier` | `log[]` | Defensible — shipment written, cost null not wrong |
| `syncResult.blankOrderNumber` | `log[]` | **Arguable** — see finding below |
| `clientsFailed` | `errors[]` | Yes |
| `clientResult.undated_picks` | `errors[]` | Yes |
| `chargeResult.failedOrders` | `errors[]` | Yes |
| `chargeResult.staleDeleteRefused` | `errors[]` | Yes |
| `chargeResult.unpricedOrders` | `errors[]` | Yes |
| `chargeResult.unknownCostCharges` | `log[]` | Defensible — cost null, not wrong |
| `chargeResult.unknownCarrierCharges` | `log[]` | Defensible — cost null, not wrong |

### `blankOrderNumber` belongs in `errors[]`

The comment's reasoning is: "an unrecognised carrier code leaves the cost null rather than wrong, and the shipment row is still written." That is true for `unknownCarrier`. It is not true for `blankOrderNumber`. A shipment with no order number **cannot be matched to a Zenventory order**, so it receives no client assignment, no pick records, and generates zero revenue. This is not "cost unknown" — it is the entire billing record missing. Under the governing principle, an error that leaves revenue unrecorded is at least as urgent as one that leaves cost unrecorded.

### `syncResult.refunds` not reported

`syncShipments` returns `{ ..., refunds, ... }`. The monitor reads every other field in the result but never reads `refunds`. Refund records are still created in `rate_adjustments` with `status = 'pending'`, so the section-4c scan (`pending carrier adjustments`) will surface them. This is an indirect coverage that works in practice, but the omission is inconsistent with the rest of the sync reporting.

### Recurring noise

`unknownCarrierCharges` and `unknownCostCharges` fire into `log[]` on every run that has un-costed labels. For a warehouse with labels that take days to be rated by the carrier, these will appear in every single run report. Since they are already in `log[]` (informational), not `errors[]`, they do not inflate the `🚨` subject line, so the noise does not train a human to ignore critical alerts. Acceptable.

`undated_picks` goes to `errors[]`. After a long outage, picks with no prior watermark can remain undated indefinitely. This _could_ produce a recurring `🚨` subject line until someone resolves those picks. The comment calls this "expected on the first run after an outage", which is accurate; subsequent runs will date new picks via the watermark, so the count should trend to zero. Not a design defect, but an operator should know it can persist.

---

## 5. TESTS THAT CANNOT FAIL

All four tests under `describe('recalculateCharges — the stale-delete blast radius')` can fail. Rationale:

**Test 1 — "refuses a sweep that would delete more than the run built"** (line 153): Uses `rateCard: []` so `rows.length = 0`. If the guard were removed (sweep always runs), all four stale rows would be deleted, `staleDeleteRefused` would stay 0, `deleted` would be 4, and `result.staleDeleteRefused` → `expect(false).toBe(4)` fails. The preservation assertion `chargeKeysFor('order-a')` would also fail. **Can go red.**

**Test 2 — "records the refusal as a run failure, not a warning"** (line 174): Uses `rateCard: []`. If `run.warn()` were called instead of `run.fail()`, `errors.count()` would be 0, `close()` would resolve `'ok'`, and `run?.status.not.toBe('ok')` would fail. If the error context string changed, the `.some()` check would fail. **Can go red.**

**Test 3 — "refuses when it cannot count the candidates at all"** (line 193): `failOn` intercepts `order_charges` SELECT with `count='exact'`. If the `failOn` did not intercept (or if the guard ignored the unreadable count), the count would succeed (returning 1), `staleCandidates = 1`, `rows.length = 1` (one charge is built since no `rateCard` override here), `1 > 1 = false`, sweep runs, `item:h:pick` is deleted, `chargeKeysFor.toContain('item:h:pick')` fails. Note: `deletes.toEqual([])` also provides independent coverage. **Can go red.**

**Test 4 — "still sweeps when the run built at least as much as it would remove"** (line 217): One historic charge, one built. If the guard were over-eager (`staleCandidates >= rows.length`), 1 ≥ 1 would trigger refusal, `deleted` would be 0, `result.deleted: 1` fails. If the upsert were broken, `upserted: 1` fails. **Can go red.**

**Fake-supabase weakness check:** The `select()` projection weakness (projection argument discarded) does not undermine these tests — the count query's value comes from `count`, not from the projected columns. The `valuesEqual(undefined, undefined) === true` weakness would only affect the upsert `onConflict` matching if a column name were typo'd; tests 3 and 4 use the correct `'order_id,charge_key'` target, and the resulting behaviour (wrong row updated → deleted not incremented) would cause those tests to fail rather than falsely pass.

---

## 6. Findings

### Minor — M1: Monitor error message misquotes the guard threshold

**File:** `src/app/api/agent/monitor/route.ts` line 184–185  
**What is wrong:** The error message reads:
```
"because that is more than the ${chargeResult.upserted} rows this run wrote"
```
The actual guard in `persist-charges.ts` compares `staleCandidates > rows.length` (rows _built_), not `> upserted` (rows successfully written). When upsert failures occur, `upserted < rows.length`. The email then tells the operator a threshold that is smaller than the one that actually fired — e.g. "more than 7 rows written" when the real threshold was 10 rows built. Under normal operation (no upsert failures) the two numbers agree and the message is accurate. The miswording only surfaces under degraded conditions, but that is precisely when the message most needs to be right.  
**Fix:** Replace `${chargeResult.upserted}` with `${chargeResult.upserted + chargeResult.failedOrders}`, or expose `rowsBuilt` as a separate field on `RecalculateResult`.

---

### Minor — M2: `blankOrderNumber` routed to `log` rather than `errors`

**File:** `src/app/api/agent/monitor/route.ts` lines 84–87  
**What is wrong:** The comment justifies routing both `unknownCarrier` and `blankOrderNumber` to `log` on the grounds that they "leave cost NULL rather than wrong." This reasoning fits `unknownCarrier` (shipment written, client assignable, cost null). It does not fit `blankOrderNumber`: a shipment without an order number cannot be matched to a Zenventory order, so it receives no client assignment, no pick records, and therefore generates no billed revenue at all. The governing principle singles out unrecorded revenue as a primary concern. This shipment is effectively invisible to the entire billing pipeline until corrected.  
**Fix:** Move `blankOrderNumber > 0` into `errors[]` alongside `errors`.

---

### Minor — M3: `syncResult.refunds` never reported

**File:** `src/app/api/agent/monitor/route.ts` (sync reporting block, ~line 68–92)  
**What is wrong:** `syncShipments` returns a `refunds` counter (shipments where the carrier cost decreased — refunds were recorded as `rate_adjustments`). The monitor reads and reports `created`, `updated`, `adjustments`, `errors`, `unknownCarrier`, and `blankOrderNumber`, but never reads `refunds`. Refunds do create pending `rate_adjustments` rows visible via the section-4c scan, so the gap is indirect-coverage rather than silent, but the inconsistency is confusing to anyone reading the sync block.  
**Fix:** Add `refunds` to the sync log line: `${syncResult.adjustments} adjustments · ${syncResult.refunds} refunds`.

---

## 7. Strengths

The "named once, used twice" construction (lines 400–402) is the right engineering response to a guard that had to be expressed in two different contexts — it eliminates the exact drift failure the comment describes. The comment is honest about the scenario that motivated it.

The throttle's two documented properties — only a successful run satisfies it, and a scheduled firing always overrides it — are both implemented correctly. The design of `chargeRunIsDue` as a pure function with explicit inputs, tested separately from the database machinery, makes those properties verifiable without a test database. The vercel.json coupling test (line 477–492) is a good example of a test asserting a cross-file contract rather than a unit fact.

The `requireStaffOrCron` fail-closed design (skip bearer entirely when no secret is configured) is materially safer than the "previous `if (SECRET)` pattern failed OPEN" it replaced, and the `console.error` logging when a request is denied without a secret configured means a Vercel operator will see the problem in logs rather than experiencing silent 401s on the cron.
