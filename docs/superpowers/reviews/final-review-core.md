# Final review — calculation and persistence core

> **Provenance banner, added in `6779251`+1 at commit time — not part of the original review.**
> Written **13:17 on 2026-10-01 against HEAD `fad4881`**. Where the text below says
> "current state", "at HEAD" or "today", it means `fad4881`, **not** the tree you are
> reading now — 20+ commits have landed since, and several findings here are closed or
> were restated after being checked. This file is committed for **provenance**: it is the
> traceable source behind the `FROM-REVIEW` item IDs in `handover-2026-10-02.md`. Read
> that file first for current status, then come here for the detail. **Re-verify against
> the code before acting on anything below.**

Branch `ledger/complete-the-ledger`. Slice: `src/lib/ledger/*` (calculation, loading,
persistence) plus `src/lib/billing/classify-sku.ts`, and every `.test.ts` beside them.
Read at current state (all files new on this branch). `npx vitest run` → 16 files, 261
tests, green. `npx tsc --noEmit` → clean. No writes to the tree, no network, no DB.

---

### Strengths (specific, with file:line)

- **`cost-rate.ts:66-72` — the quantity guard runs BEFORE the `known` check.** `costOf`
  throws on a non-finite or negative quantity even when no cost rate was found. This is
  what lets `calculate-charges.ts:118` get away with a `qty === 0` guard that `NaN`
  slips past: the NaN is caught one call later, at the per-order boundary, instead of
  being serialised to Postgres as `null` and read for ever after as "unknown cost".
  Ordering these two checks the other way round would be a silent money bug.

- **`cost-rate.ts:20-33` — `CostLookup` is a discriminated union, not a nullable number.**
  `{ known: false; rate: null }` cannot be `|| 0`-ed by accident because the `rate` field
  is typed `null` on that arm. The cardinal sin is made a type error rather than a
  convention. `sumKnownCosts` (`:79-91`) extends the same discipline: a non-finite value
  counts as unknown rather than poisoning the whole sum to NaN.

- **`calculate-charges.ts:63` — `cents()` uses `toPrecision(12)` before rounding.** On an
  exact half-cent (`16.49 × 0.5 = 8.245`) the naive `Math.round(n*100)/100` rounds DOWN
  and underbills, because the float is `824.4999…`. `toPrecision(12)` collapses that
  error so the half-cent goes up. The `+ 0` normalises `-0`. This is pinned by a test
  written specifically for it (`storage-charges.test.ts:173-184`) with a comment saying
  "DO NOT simplify".

- **`load-charge-inputs.ts:93-104` — pagination stops only on an empty page.** Stopping at
  `batch.length < PAGE_SIZE` would read a server-shortened first page as end-of-table and
  silently drop every remaining row; the 1000-row PostgREST cap truncates without an
  error. The loop also advances by `batch.length`, not by `PAGE_SIZE`, so a short page
  does not skip rows. `PGRST103` is correctly treated as end-of-table, not failure. Every
  one of the six reads in this module goes through it — verified, no bare `.select()`.

- **`load-charge-inputs.ts:189` — undated orders are included via
  `.or('order_date.gte.X,order_date.is.null')`.** `null >= '2026-09-01'` is NULL, not
  TRUE, so a `.gte` alone would make an undated order invisible in every window for ever.
  The count is warned on rather than swallowed.

- **`load-charge-inputs.ts:337-386` — refuses to guess shipment attribution.** A label is
  attached only when exactly one order *anywhere* (including outside the window — the
  `claimantOrders` read at `:264`) claims its order number. Otherwise it is left
  unattributed and named. A charge on the wrong client is worse than a missing one: it
  corrupts two clients' margins and is visible in neither.

- **`charge-key.ts:36, :69-73` — the storage variant is required by the type.** The
  earlier bug (pallet and shelf both keying `storage:2026-09-01`, the partial unique index
  keeping one, half the storage revenue vanishing without an error) is now unrepresentable
  rather than merely fixed at the one call site that had it.

- **`storage-charges.ts:103-109` — the absence/corruption ladder, in the right order.**
  `null|undefined → return` (nobody declared it), then `!isFinite || < 0 → throw`
  (corrupt), then `=== 0 → return` (a real known zero). The shelf branch has no cost
  lookup to catch a NaN downstream, and the test at `storage-charges.test.ts:196-204`
  exists precisely for that asymmetry.

- **`storage-charges.ts:126` — shelf storage gets `cost: null`, not the pallet rate and
  not 0.** A shelf is not free to provide; we simply have not costed it.

- **`persist-charges.ts:217-232` and `persist-storage-charges.ts:229` — per-item failure
  boundaries.** One corrupt order does not cost the other few thousand their charges, and
  a failed order is deliberately excluded from `builtOk` so the stale-delete cannot turn a
  bad line into a missing invoice (`:302`).

- **`persist-charges.ts:270-290` — a failed chunk is retried order-by-order.** Batching for
  latency did not cost the per-order boundary; a chunk error says nothing about which
  order is bad, so it is re-issued one order at a time.

- **`persist-charges.ts:161-174` — an unreadable lock gate skips; an unreadable throttle
  gate proceeds.** The asymmetry is correct and argued in the comment: not knowing whether
  a run is live risks deleting a concurrent run's fresh rows, whereas not knowing when the
  last run succeeded risks only redundant work.

- **`persist-storage-charges.ts` — the orphan detector reports and never deletes.** Pinned
  by a test that asserts zero `insert`, `update` and `delete` statements were issued
  (`persist-storage-charges.test.ts:383-404`), not merely that the row survived.

- **`sync-run.ts:34-60` — independent 50-entry caps for errors and warnings.** With a
  shared budget, 200 unknown-carrier warnings fill the list and the one real error is
  dropped. Tested at `sync-run.test.ts:80-94`.

- **The test suite argues, and it asserts on statements.** `persist-charges.test.ts:98-101`
  asserts the stale-delete carries an `in('order_id', …)` filter at the *statement* level,
  not just that the right rows survived — so deleting the scope from production code fails
  the test even if the fixture happens to be unaffected. `persist-storage-charges.test.ts:250`
  asserts the `.order()` clause is present in the recorded call. `persist-charges.test.ts:387-402`
  reads `vercel.json` from disk so the throttle constant and the cron schedule cannot drift
  apart. `fake-supabase.test.ts` tests the *double* for fidelity against the places
  supabase-js is surprising (PGRST116 returns an error object rather than throwing or
  returning row 0) — a double kinder than production turns every test into false evidence.

---

### Issues

#### Critical

*None.* Nothing in this slice writes a wrong number to `order_charges` or loses committed
revenue under conditions reachable today.

#### Important

**I1. `calculate-charges.ts:192-193` — a shipment with a real carrier cost and no rate-card
line produces no charge row at all, so its COST never enters margin.**
`if (!rate) continue` drops the whole shipment. Spec §7 requires the opposite: "*No rate
card line for a charge* — charge recorded with `amount = null` and flagged, never silently
zero." The cost is real and known (`actual_cost`); only the revenue is unknown. By
dropping the row, the cost is excluded from `order_charges` entirely, and every
margin figure that sums this table is flattered by exactly the freight we paid — the
error direction the whole project exists to prevent.
*Mitigation, verified:* `leaks_monthly` leak 3 `unpriced_shipments`
(`ledger_04_views.sql:200-211`) does detect it — `actual_cost is not null` and no
`shipment:<id>` charge of type `shipping`. So it is not invisible. But it is only visible
to someone who reads the leaks view; the P&L the pricing decision is made from does not
carry it.
*Fix:* emit the row with `amount: null`, `cost: cents(actualCost)`, `cost_basis: 'measured'`,
`rate_id: null`, `is_estimate: true`. `order_charges.amount` is nullable and the check
constraint is `cost is null or cost_basis is not null`, so the row is writable as-is.

**I2. `persist-charges.ts:302-313` — the stale-delete has no blast-radius guard, and
`builtOk` includes orders that produced ZERO charges.**
An order is pushed to `builtOk` (`:234`) whenever `buildCharges` did not throw, including
when it returned `[]`. If the rate card genuinely went away, deleting is arguably correct.
But there is no floor: a configuration change that empties `client_warehouse_rates` for a
client, or a rate card whose every line expired, deletes that client's entire existing
charge history for the window in one run, and the only signal is a `warn('unpriced orders')`
line inside `sync_runs.errors`. The result object returns `deleted` but nothing acts on it.
*Fix:* refuse the sweep (and `fail()` loudly) when `rows.length === 0` but
`deletable.length > 0` — i.e. when a run that saw orders produced no charges at all. That
single condition distinguishes "prices were withdrawn for one client" from "the rate card
read came back structurally empty" without needing a percentage threshold.

**I3. `charge-key.ts:48-50` — `shipping` and `return` produce the same key.**
Both return `shipment:${shipmentId}`. Under the unique `(order_id, charge_key)` index a
shipment carrying both charges collapses to one row. Worse for the write path: two rows
with the same conflict target inside one `upsert` batch makes Postgres raise 21000
("cannot affect row a second time"), which at `persist-charges.ts:263-291` fails the chunk
and then fails that order entirely. `return` is not built today, so this is latent — but
it is armed, and `ledger_04_views.sql:180-183` already has to defend against it with an
extra `charge_type = 'shipping'` test in leak 3.
*Fix:* `return` → `shipment:${id}:return`, matching the `item:<id>:<type>` convention
already used for pick/pack.

**I4. `sync-run.ts:106-108` — a failed `sync_runs` insert silently disables the run-lock
for that run.**
`openSyncRun` logs and continues with `id = null`. The deliberate trade ("losing the audit
trail is bad; refusing to sync because of it is worse") is defensible in isolation, but
`persist-charges.ts` uses that same row as its mutual-exclusion token: `canStart` looks for
`status = 'running'`, and if the insert failed there is no such row. The next invocation —
`AutoSync` polls every 5 minutes from every open tab — sees an empty `openRuns` and starts
concurrently. That is exactly the overlap `run-lock.ts` exists to prevent, and the
consequence is two runs' stale-deletes eating each other's fresh rows. `close()` then
returns at `:120` and discards the error list, the row counts and the status, so the
incident leaves no record anywhere except one `console.error`.
*Fix:* return the open error on the handle and have `recalculateCharges` treat a null `id`
as `cause: 'gate-unreadable'` and skip — same reasoning as `persist-charges.ts:166`. If we
cannot write the token, we cannot hold the lock, and skipping costs one cycle.

**I5. `persist-charges.ts:155-177` — the lock is check-then-act (TOCTOU).**
Between the `select … status = 'running'` at `:155` and the `insert` at `:182` there is an
`await` and a network round trip. Two invocations arriving inside that gap both read an
empty set and both proceed. With three crons a day this is unlikely; with `AutoSync`
polling from N browser tabs every 5 minutes it is a genuine race. Acknowledged implicitly
by the defence-in-depth comments, and the stale-delete's order-id scoping caps the damage,
but the lock itself does not hold.
*Fix:* a Postgres advisory lock (`pg_try_advisory_lock` via RPC) is the correct primitive;
failing that, a unique partial index on `sync_runs (source) where status = 'running'` turns
the second insert into a 23505 the caller can read as "someone else has it".

**I6. No end-to-end double-run idempotency test for `recalculateCharges`.**
Spec §8 names this "*the single most important test in this file: three crons a day make
non-idempotency compound. It covers `shipments` and `order_charges` together.*" Storage has
its exact analogue (`persist-storage-charges.test.ts:89-115`, asserting row count AND
amount sum AND that the second run issues `update` not `insert`). The charge path has the
*ingredients* — `charge_key` determinism (`calculate-charges.test.ts:294`) and the
`onConflict: 'order_id,charge_key'` argument — but never composes them. The throttle in
`recalculateCharges` makes a naive second call skip, which is presumably why it was not
written; the fix is to advance the fake clock past `CHARGE_THROTTLE_MINUTES` (the suite
already uses `vi.setSystemTime` elsewhere) and assert count + sum are unchanged and that no
new `insert` was issued.

#### Minor

**M1. `calculate-charges.ts:229` — `(rate.rate ?? 0)` bills a non-`at_cost` shipping line
with a null rate at exactly $0.** Spec §7 lists "*Null `rate` on a type other than
`at_cost`*" as a data error to be reported. The comment immediately above correctly argues
the null-vs-zero case for `at_cost`, then the fallback arm reintroduces it for `flat`. Emit
`amount: null` plus `onWarn`, matching the `at_cost` treatment.

**M2. `calculate-charges.ts:123` — a `pick` rate-card line with `rate === null` on a
`per_unit` type is skipped silently** (`if (!rate || rate.rate === null) continue`). Same
class as M1: the pick work happened, the cost is known, and no row is produced. Unlike a
shipment there is a detector (`unpricedOrders`, `:243`), so the severity is lower, but the
individual line is not named.

**M3. `calculate-charges.ts:63` — `cents(Infinity)` returns `Infinity`, which
`JSON.stringify` sends as `null`.** A corrupt `actual_cost` would therefore land as an
*unknown* cost rather than as an error — the exact conflation the module guards elsewhere.
Practically unreachable: `num()` at `load-charge-inputs.ts:56` only yields Infinity from the
literal string `"Infinity"` in a numeric column. Cheap to close: throw in `cents()` on a
non-finite input.

**M4. `variance.ts:48` — `standardRate` is not checked for finiteness.** `null` is handled
(and a genuine `0` correctly passes as a real rate, tested at `variance.test.ts:75-87`), but
a NaN rate produces `absorbed: NaN`, `variance: NaN`, `basis: 'measured'` — a *confident*
claim built from garbage. `quantity` gets the guard (`:33`); the rate should too.

**M5. `carrier.ts:29` — `KNOWN[code]` walks the prototype chain.** `sourceForCarrier('constructor')`
returns a function rather than an unknown-carrier result. Not reachable from carrier codes
today; `Object.hasOwn` or a `Map` costs nothing.

**M6. `load-charge-inputs.ts:189` — `windowStart` is interpolated into a `.or()` filter
string.** It is computed internally and never user-supplied, so there is no injection path
today, but `.or()` is the one PostgREST builder that takes raw filter syntax, and a future
caller-supplied window would be a live hole. Validate the shape before interpolating.

**M7. `fake-supabase.ts` — `valuesEqual(null, null) === true`, so the double's upsert
matches on a NULL conflict column where real Postgres would not.** It also does not model
unique indexes at all. Neither currently produces a false green in this slice (the storage
path deliberately avoids `ON CONFLICT` for exactly this reason), but it is the boundary of
what the suite can prove and it is worth a comment in the double.

---

### Tests that cannot fail

**None found.** This is the finding, and it is the one I looked hardest for.

The specific trap — `expect(null).toBeCloseTo(0, N)` passing because null coerces to 0 —
does not occur anywhere in the slice. Every `toBeCloseTo` with a zero-or-nullable expectation
is paired with a companion `not.toBeNull()` guard on the line above it:

| File:line | Guarded value |
|---|---|
| `calculate-charges.test.ts:148-153` | `cost` (nullable via `CostLookup`) |
| `calculate-charges.test.ts:177-180` | `cost` |
| `calculate-charges.test.ts:193-194` | `amount` (null on unreported at-cost freight) |
| `calculate-charges.test.ts:280-282` | `amount` |
| `cost-rate.test.ts:78-81` | `costOf` return |
| `variance.test.ts:41-42` | `variance` |
| `variance.test.ts:83-85` | `absorbed` (zero rate vs missing rate) |
| `variance.test.ts:99-101` | `absorbed` (zero quantity) |

The remaining `toBeCloseTo` calls assert non-zero money (`0.38`, `3.20`, `5.00`, `0.26`,
`7.25`, `8.20`, `0.60`), where a null actual would coerce to 0 and fail. Those are sound.

Checked and clean in the wider family too:

- **No `expect(...)` without a matcher.** Grepped the whole slice.
- **No assertion on a mock standing in for behaviour.** `fake-supabase` records statements,
  and the tests that read `h.db.calls` assert on the *statement the module issued* —
  `persist-charges.test.ts:98-101` (the stale-delete's `order_id` filter),
  `persist-storage-charges.test.ts:121-127` (the `order_id is null` filter),
  `:239-254` (the `.order()` clause), `load-charge-inputs.test.ts:151-156` (the join column).
  These are stronger than outcome assertions, not weaker: they fail when the production
  clause is deleted even if the fixture would survive without it.
- **No test that would pass against a constant return.** Spot-checked the risky shapes.
  `storage-charges.test.ts:128-141` deliberately lists the *superseded* rate first so a bare
  `.find()` fails. `calculate-charges.test.ts:385-396` orders the card newest-first for the
  same reason. `classify-sku.test.ts:64-67` (`XR100`) distinguishes prefix from substring.
  `order-line.test.ts:64-71` asserts `/line 2\b/` rather than a bare `/2/`, with a comment
  explaining that the bare form also matched the `-2` quantity in the same message and so
  passed against an implementation that never named the ordinal.
- **One `try/catch` in a test, and it does not swallow.**
  `storage-charges.test.ts:200-203` catches only *after* a preceding
  `expect(...).toThrow(RangeError)` has already established the throw; the catch exists to
  let the test then assert the output array is empty. The failure is asserted first, so
  nothing is hidden.
- **Indexing hazards avoided.** `storage-charges.test.ts:38` looks the shelf line up by key
  rather than by `out[0]`, with a comment: a test that asserts "the shelf cost is null" must
  fail if the shelf line disappears, not silently start asserting it about whatever row slid
  into position 0.

---

### Declined to judge

- `supabase/*.sql` view and index definitions — another reviewer's slice. Read only to
  confirm the contracts this code depends on (below).
- `AutoSync`, the `/api/agent/monitor` route, the monitor email and every dashboard
  component — presentation layer, another reviewer's slice.
- `src/lib/sync/shipstation.ts` and the Zenventory sync — not in the named file list; reached
  only as the upstream writer of `order_items`, noted as an assumption below.
- The already-recorded residual (`persist-charges.ts:126` `.eq('status','ok')` means a
  `'partial'` run does not throttle the next one, and storage persistence has no `canStart()`
  of its own). Traced it: the storage path is select-then-write with a per-client-month
  boundary, so a concurrent second run produces a caught 23505 and a spurious alert, not a
  wrong number. **Not worse than described**, so per instruction it is not re-raised.
- `cost_rates` seed content — the unreachable `('pack', null)`, `('storage', null)` and both
  `material` rows are already flagged in `ledger_06_seed_cost_rates.sql` by the authors.
  Seed data, not this slice.
- Whether one blended cost-per-pick is the right costing model, and whether overheads should
  be allocated — spec §11 accepts both as known limitations, explicitly.
- Performance of the `IN_CHUNK = 200` / `UPSERT_CHUNK = 500` / `DELETE_CHUNK = 200` values —
  reviewed for correctness (chunking is present everywhere a `.in()` could exceed URL length,
  and the per-order boundary survives chunking); the specific numbers are a tuning question
  with no correctness consequence I can see.
- `pick-date.ts`'s choice of `America/New_York` as the warehouse zone — a business fact I
  cannot verify from the code. The *mechanism* (live `Intl` lookup, never a stored offset,
  both DST seasons tested at `pick-date.test.ts:57-70`) is correct whatever the zone is.
- Whether the 06:00 UTC cron's before-06:00-local watermark rule is the right business
  answer. It is coherent and tested; whether "the overnight run is evidence about yesterday"
  matches how the warehouse actually works is a question for a person.

**Contracts this code's correctness depends on** (named per instruction, not judged):

1. **`findCostRate` (`cost-rate.ts:44-47`) string-compares dates.** It assumes PostgREST
   returns `cost_rates.effective_from` / `effective_to` as bare `'YYYY-MM-DD'`. If either
   ever arrives as a timestamp (`'2026-01-01T00:00:00+00:00'`), `'2026-01-01' >= that string`
   is false and the rate is missed on its own first day — a cost silently becoming unknown.
2. **`shipments_shipstation_id_key` must stay unique.** Two shipment rows on one order with
   the same `shipstation_shipment_id` would produce two identical `charge_key`s in one
   upsert batch → Postgres 21000 → that order loses all its charges for the run.
3. **`order_charges_order_key` must stay non-partial `(order_id, charge_key)`.** The
   `onConflict: 'order_id,charge_key'` at `persist-charges.ts:267` raises 42P10 against a
   partial index.
4. **`shipments.order_number_key` must remain `generated always as (upper(btrim(order_number)))
   stored`.** The `.in()` at `load-charge-inputs.ts:245` and the in-memory join key are
   computed independently; if the column's definition changes, the query and the join
   disagree and shipping revenue vanishes with no error.
5. **`order_charges.amount` must remain nullable**, and the check constraint must remain
   `cost is null or cost_basis is not null`. Both are load-bearing for the null-not-zero
   doctrine, and the I1 fix above needs the first.
6. **`order_items.quantity_picked` may arrive as a string** (Zenventory does this on some
   endpoints, handled at `order-line.ts`), and `is_component` may be null for pre-Task-12
   rows (handled by the SKU re-classification at `load-charge-inputs.ts`). Both assumptions
   are tested; both depend on the upstream sync not changing shape.

---

### Recommendations

1. **Fix I1 before merge.** It is the only finding in the slice where a real, known cost is
   excluded from margin — the flattering direction, which nobody files a bug about. The fix
   is a dozen lines and the schema already permits the row.
2. **Fix I3 before merge.** One line, and it disarms a trap that already forced a defensive
   `charge_type` test into the SQL views.
3. **Fix I4 before merge.** Treating a null `sync_runs.id` as `gate-unreadable` reuses a
   decision the file has already made correctly one screen earlier, and it closes the case
   where the lock is silently absent.
4. **Add I6, the `recalculateCharges` double-run test.** The spec calls it the most important
   test in the file and it is the one the storage path has and the charge path does not.
   Advance the fake clock past the throttle, run twice, assert row count and amount sum
   unchanged and zero new `insert` statements.
5. **I2 and I5 can follow the merge**, tracked. I2 needs a judgement call on the guard
   condition; I5 wants an advisory lock or a partial unique index, which is a schema change
   and belongs with the SQL reviewer's slice.
6. **Sweep the Minor list for M1/M2/M4 together** — they are the same shape (a data error
   rendered as a confident number or a silent skip) and share a fix pattern: emit the row
   with a null amount and name it through `onWarn`.
7. **Keep writing tests like these.** The comment-above-assertion style — stating what the
   test would catch and why the obvious simpler form does not catch it — is the reason this
   audit found no non-failing tests. It should be the house standard.

---

### Assessment — Ready to merge? **With fixes**

The null-versus-zero doctrine is enforced structurally rather than by convention, the
absence/corruption ladder is right and in the right order, and the test suite is the
strongest I have reviewed on this codebase — it asserts on statements, not just outcomes,
and the `toBeCloseTo`/null trap has been systematically closed. The four fixes named above
(I1, I3, I4, I6) are small and mechanical; I1 in particular should not ship, because it
excludes a real cost from margin in the flattering direction and only a separate leaks view
would ever surface it.
