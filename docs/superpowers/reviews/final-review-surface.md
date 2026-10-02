# Final review — presentation, API surface, sync integration, test harness

> **Provenance banner, added in `6779251`+1 at commit time — not part of the original review.**
> Written **13:17 on 2026-10-01 against HEAD `fad4881`**. Where the text below says
> "current state", "at HEAD" or "today", it means `fad4881`, **not** the tree you are
> reading now — 20+ commits have landed since, and several findings here are closed or
> were restated after being checked. This file is committed for **provenance**: it is the
> traceable source behind the `FROM-REVIEW` item IDs in `handover-2026-10-02.md`. Read
> that file first for current status, then come here for the detail. **Re-verify against
> the code before acting on anything below.**

Branch `ledger/complete-the-ledger`. Reviewed at current HEAD, read-only.
Slice: `src/app/ledger/*`, `src/app/api/ledger/summary/route.ts`, `src/lib/ledger/summary.ts`,
`src/lib/ledger/fake-supabase.ts`, `vitest.config.ts`, and the diffs `3b3a231..HEAD` of
`src/app/api/agent/monitor/route.ts`, `src/lib/sync/zenventory.ts`, `src/lib/sync/shipstation.ts`,
`src/app/clients/[id]/page.tsx`, `package.json`.

Gates run: `npx vitest run` → 16 files, 261 tests, all pass (~500ms). `npx tsc --noEmit` → exit 0.
No writes were made to the working tree, index, HEAD, or remote.

---

### Strengths (specific, with file:line)

1. **The null-versus-zero discipline is genuinely carried through to pixels, not just types.**
   Every money cell that can hold a null has a dedicated renderer that says the word rather than
   drawing a symbol: `LeakAmount` → "not quantified" (`src/app/ledger/page.tsx:105-117`),
   `NetProfitUnknown` → "unknown — {reason}" (`:125-132`), `AllocationCell` → "unknown" with a
   tooltip that distinguishes *no operating-cost rows at all* from *rows but none in this category*
   (`:140-154`), `VarianceCell` → the reason text (`:163-180`), payroll → "not entered" (`:684-694`),
   units → "unreadable" (`:698-710`). This is the hardest thing in the assignment and it is done.

2. **The variance colour scale is a separate helper with a comment explaining why it must be.**
   `varianceClass` (`src/app/ledger/page.tsx:66-71`) inverts `marginClass` (`:45-48`) deliberately:
   positive variance is an overspend and renders red. The comment at `:60-65` names the exact failure
   it prevents. The header at `:674` reads "Variance (+ = overspend)", so the convention is stated on
   screen, not only in source. Verified: no shared helper, no accidental reuse.

3. **`varianceIsEstimated` reads the right field.** `src/app/ledger/page.tsx:249` keys off
   `r.standard_rate_basis === 'estimated'` — the view's column — with a comment (`:245-248`) stating
   exactly why `VarianceResult.basis` is the wrong source (it never returns `'estimated'`). This was
   the specific trap flagged for this review and the code is on the right side of it.

4. **Truncation is disclosed rather than silently absorbed.** `RowCount`
   (`src/app/ledger/page.tsx:83-102`) renders "showing N of M rows" in orange with a tooltip warning
   that eyeball totals will be short, and distinguishes an explicit cap from a server-side cut.
   `summary.ts` requests `{ count: 'exact' }` on all six reads so `M` is real. This is the correct
   answer to Supabase's silent 1000-row cap.

5. **The `Host`-header SSRF has not crept back.** `src/app/ledger/page.tsx:242-243` calls
   `getLedgerSummary()` directly; nothing in `src/app/ledger/` fetches `/api/ledger/summary`. The
   header comment at `src/lib/ledger/summary.ts:1-19` records why. Confirmed by grep across the slice.

6. **The NULL-filter trap is handled where it was known to bite.** `summary.ts:460-525` issues a
   *separate* read for `leaks_monthly` with `.is('period_month', null)` alongside the
   `.gte('period_month', from)` read, and the page renders it as its own block. I checked every other
   filter in the slice for the same shape — `pick_days` uses `.gte('pick_date', from)` on a column
   that is NOT NULL by construction in the view (rows only exist once a pick date is set), so there
   is no second instance of the defect in this slice.

7. **The Zenventory `onConflict` / partial-index hazard is resolved in the SQL and documented.**
   `supabase/ledger_01_orders.sql:34-51` deliberately keeps `orders_client_order_key` NON-partial and
   explains that PostgREST emits a bare column list, so a partial index would raise 42P10 on every
   row. The `.upsert(..., { onConflict: 'client_id,order_key' })` in `zenventory.ts` is therefore
   safe. Cross-slice contract, verified rather than assumed.

8. **`shipstation_shipment_id` is backfilled by migration before the re-key goes live.**
   `supabase/ledger_03_charges.sql:11-26` adds the column, backfills from
   `raw_data->>'shipmentId'` with a numeric guard, and creates a partial unique index. Without this
   the re-key at `shipstation.ts` would have inserted a duplicate for every historical shipment. (One
   residual risk — see Important #4.)

9. **`maybeSingle()` in the fake is held to the unkind real behaviour.**
   `fake-supabase.ts:337-357` returns `{ data: null, error: PGRST116 }` on multi-match instead of
   `affected[0]`, with a comment naming the duplicate-insert defect that has been fixed three times.
   `fake-supabase.test.ts` pins it. This is exactly the right instinct about test doubles.

10. **`count: 'exact'` is measured before `range`/`limit` in the fake**
    (`fake-supabase.ts:288` sets `this.matched` prior to the slice at `:298-300`), matching PostgREST.
    `PGRST103` for an unsatisfiable range is modelled (`:293-296`). Unimplemented operators throw
    rather than no-op (`:221-233`) — the single most valuable property a fake can have.

11. **`mapVarianceRows` refuses to coalesce.** It guards against `labourVariance()` throwing
    (which in a Server Component would blank the whole page) and never substitutes 0 for a null
    payroll (`src/lib/ledger/summary.ts`, `mapVarianceRows`).

12. **`monitor/route.ts` section 4 was rewritten to distinguish unreadable from zero.**
    `scanFailed()`, `stat(err, n)` and `money(err, n)` render "unknown" rather than 0, and stage 3c is
    gated on `chargeResult && !chargeResult.skipped` (`:155`) with a comment (`:146-153`) explaining
    the 23505 race that ungated storage caused across concurrent `AutoSync` tabs. The refusal to print
    a green tick beside `0 written` (`:167-169`) is the right standard.

13. **`src/app/clients/[id]/page.tsx:263-268` is a real null-versus-zero fix in a pre-existing screen.**
    `$${Number(r.rate).toFixed(2)}` on a null `rate` printed "$0.00" in green — stating that the
    client's freight ships free. It now renders "At cost" in neutral grey. The comment block at
    `:233-259` enumerates the five other `service_type` consumers already guarded and identifies this
    as the lone outlier. That is the kind of note that makes the next reader faster.

14. **`package.json` is minimal.** Two scripts, two devDependencies (`vitest ^3.2.7`,
    `vite-tsconfig-paths ^5.1.4`). Nothing added that is not used; no large tree for a small use.

15. **`summary.test.ts` passes the NULL-assertion audit.** Every `toBeCloseTo` target is non-zero
    (230, 30, −230, 260), so a `null` actual coercing to 0 would fail the assertion rather than pass
    it. Zero-valued expectations use strict `toBe(0)`. I found no instance of the
    `expect(null).toBeCloseTo(0)` defect in this file.

---

### Issues

#### Critical

**C1. `/api/ledger/summary` is unauthenticated and serves the complete business P&L and every
client's margins, on a branch wired to a production Vercel deploy.**

- `src/app/api/ledger/summary/route.ts:1-20`.
- The handler is `export async function GET() { return NextResponse.json(await getLedgerSummary()) }`.
  It calls no guard. `src/proxy.ts:~100` excludes `api/` from the matcher
  (`'/((?!_next/static|_next/image|favicon.ico|shipo-logo.jpg|chat.js|api/|partner$|partner/|rate-sheets/).*)'`),
  so the proxy does not protect it either. The `/ledger` *page* IS protected by that matcher; the API
  route serving the same data is not. Anyone who can reach the deployment can `curl` it.
- `getLedgerSummary()` runs on `supabaseAdmin` (service role), so the RLS gap and the view `revoke`s
  in `ledger_04_views.sql:702-710` are both bypassed. The careful `revoke all ... from anon,
  authenticated` in the SQL slice is defeated by this one route.
- **The comment justifying the omission is factually wrong.** It asserts: *"This is consistent with
  every other route under `src/app/api/` — none of them check a session."* I enumerated all 36 API
  routes: **27 call `requireStaff()` or `requireStaffOrCron()`**. Of the 9 that do not, 8 are
  deliberately public by function (auth/login, chat, 4× partner, referrals/intake,
  referrals/portal-access). This route is the only new staff-data endpoint without a guard. The
  comment also instructs the next reader *"Do not add auth here without auditing and updating the
  other ~20 routes at the same time"* — which converts a one-line fix into an apparent 20-route
  project and will keep the hole open.
- **Fix:** add `const guard = await requireStaff(); if (guard) return guard` as the first line of the
  handler, matching the 27 routes that already do it, and delete the comment. `src/lib/require-staff.ts`
  already fails closed when no secret is configured. This is a two-line change and it should not
  ship without it.

**C2. Zenventory's first live run stamps today's date on every already-picked order, inventing one
enormous pick day that never happened.**

- `src/lib/sync/zenventory.ts:127-130` — `if (line.picked && !pickDate) { pickDate =
  watermarkPickDate(new Date()); pickSource = 'watermark' }`. Unconditional on run mode.
- `src/lib/sync/zenventory.ts:51` hardcodes `mode: 'live'`. `src/lib/sync/shipstation.ts:14` likewise.
  `src/lib/ledger/sync-run.ts:78` declares `mode: 'backfill' | 'live'` and `:98` threads it through —
  **the backfill arm exists in the type and is never constructed.** Nothing in `src/` passes
  `'backfill'`.
- Spec §5.5 (zenventory, backfill mode) is explicit: *"The first execution runs in backfill mode and
  stamps `modified_date`, not today. Without this, every already-picked order is watermarked with the
  deploy date and the first day shows one enormous pick that never happened. Backfill must complete
  before any live run."* Spec §11 adds that backfilled pick dates carry confidence 1 and must be
  labelled as the weakest data in the system.
- Why it matters on screen, which is what this review grades: the Pick Activity table
  (`page.tsx:561-615`) will show a single date with the entire historical pick volume against it, at
  `medium` confidence (watermark), not `low`. The labour-variance section then absorbs that entire
  volume into one month — `absorbed = units × standard_rate` — and reports a large favourable
  variance for the deploy month and an unexplained overspend for every month before it. Every number
  downstream of pick volume is wrong for the first period, and the confidence label actively says the
  data is better than it is.
- Because `pick_date` is "set ONCE and never moved" (`:109-110`), this is **not self-healing.** A
  re-run does not correct it. Undoing it requires a manual SQL pass over `order_items`.
- **Fix:** implement the backfill arm before first deploy — accept a `mode` parameter, and when
  `'backfill'`, take the pick date from the Zenventory record's `modified_date` with
  `pick_date_source = 'modified_date'` (the view already ranks this source lowest,
  `ledger_04_views.sql:86`). Run it to completion once, then switch to `'live'`. If that is out of
  scope for this branch, the minimum is to make the live path refuse to stamp a watermark when the
  order's own timestamps predate the deploy, and to document the required manual backfill in the
  deploy runbook. Shipping the `'live'`-only path as-is silently corrupts the first period.

#### Important

**I1. Pick Activity is a per-client table rendered without the client column, under a caption that
does not mention clients.**

- `src/app/ledger/page.tsx:565` — caption: *"Units picked per SKU per day."*
- Columns (`:575-580`): Date, SKU, Description, Orders, Units, Confidence. No Client.
- The view is per-client: `supabase/ledger_04_views.sql:51` — *"pick_days: what was picked, per
  client per day per SKU"* — and `:77` selects `o.client_id, u.pick_date, u.sku, ...`.
  `PickRow` in `summary.ts` carries no client field either, so the data is dropped in the mapping.
- Effect on the reader: the same (date, SKU) pair appears once per client, as visually identical rows
  with different unit counts and no way to tell them apart. A reasonable person concludes the table is
  double-counting or broken, or — worse — reads one row as the day's total for that SKU when it is one
  client's share. The caption is false of every row the table can produce, which is precisely the
  "caption false on one row teaches the reader to skim every caption" failure.
- It also makes the `PICK_ROW_LIMIT = 200` cap bind far sooner than the caption implies: 200 rows of
  (client × day × SKU) is a much smaller window than 200 rows of (day × SKU).
- **Fix:** add `client_id`/client name to `PickRow`, select it in `summary.ts`, render it as the
  second column, and change the caption to "Units picked per client per SKU per day." If the client
  genuinely should not be shown, the view must aggregate it away in SQL — but do not drop a grouping
  key in the mapping layer and keep the ungrouped caption.

**I2. `monitor/route.ts` prints a green tick over unsurfaced sync failures in stages 1 and 2.**

- `src/app/api/agent/monitor/route.ts:61` —
  `log.push(\`✓ ShipStation sync: ${syncResult.created} new · ${syncResult.updated} updated · ${syncResult.adjustments} adjustments\`)`.
  Nothing is pushed to `errors[]`.
- But the rewritten `shipstation.ts` now *collects* what it used to discard:
  `results.errors` (incremented at `:52, :65, :178, :192, :200, :205, :211`), `results.refunds`
  (`:194`), `results.unknownCarrier` (`:91`), `results.blankOrderNumber` (`:70`). None of the four is
  read by the monitor.
- Stage 2 (`:72`) prints only `clientResult.updated`. `zenventory.ts:224-231` returns
  `clients_failed` and `errors` — also unread. `syncClientAssignments` only throws when **every**
  client fails, so 9 of 10 clients failing renders as `✓ Client mapping: N shipments assigned`.
- `errors.length` drives the subject line (`:310`, `:315`): `✅ All clear` vs `🚨 Issues Detected`.
  So a run in which half the shipments errored sends "All clear".
- This is the exact defect the route's own header is a post-mortem on, and the exact reason
  `shipstation.ts` stopped discarding errors in this branch. Stages 3, 3b and 3c were hardened; 1 and
  2 were left behind. The hardening is half-applied.
- **Fix:** mirror the stage-3b pattern. Push to `errors[]` when `syncResult.errors > 0` or
  `clientResult.clients_failed > 0`; put `refunds`, `unknownCarrier` and `blankOrderNumber` in `log`
  as ⚠ lines. Do not print `✓` for a stage that reported failures.

**I3. Neither sync has a test file, and the spec names one of the missing tests as mandatory.**

- No `src/lib/sync/shipstation.test.ts`, no `src/lib/sync/zenventory.test.ts`. `vitest.config.ts`
  includes `src/**/*.test.ts`, so they would be picked up if they existed.
- Spec §8 "Sync and identity" lists ~8 required tests, including verbatim: *"**Running the sync twice
  over the same window changes no row count.** The single most important test in this file."*
- These two files received 338 changed lines between them, including a **change of primary key** for
  shipments (`order_number` → `shipstation_shipment_id`) and a rewrite of the upsert path. That is the
  highest-risk change in the slice and it has zero automated coverage. The harness
  (`fake-supabase.ts`) was built specifically to make this testable and is not used for it.
- Both Zenventory credentials currently return HTTP 401, so this code has also never run against a
  live source. There is no evidence of correctness from either direction.
- **Fix:** write both files against `createFakeSupabase`. At minimum: idempotence over a repeated
  window; a pre-existing row with `shipstation_shipment_id` null (the un-backfilled case, see I4);
  `maybeSingle()` returning PGRST116 on a duplicate; cost preserved as null rather than 0 when the
  carrier has not reported; `Math.abs(diff) > 0.01` not firing on float noise; `pick_date` unchanged
  on re-sync.

**I4. Cross-slice contract: the shipment re-key depends on a backfill that is explicitly not
asserted, and the un-backfilled case inserts a duplicate.**

- `shipstation.ts` now matches on `.eq('shipstation_shipment_id', shipmentId).maybeSingle()` and
  falls through to `.insert(shipmentData)` when there is no match.
- `supabase/ledger_03_charges.sql:14-18` backfills only where `raw_data ? 'shipmentId'` and the value
  is `~ '^[0-9]+$'`. Rows whose stored payload lacks the field keep `shipstation_shipment_id = null`.
- `supabase/verify/ledger_03_verify.sql:279-283` counts `missing_shipment_id` and its own comment says
  *"Not an assertion —"*. So the migration explicitly tolerates a partial backfill, and nothing
  downstream handles the remainder.
- **Named assumption for the SQL reviewer:** *this slice's correctness requires that
  `shipments.shipstation_shipment_id` be non-null for every shipment that ShipStation will return in
  the sync window.* Where it is null, the first run after deploy inserts a second row for that
  shipment. The partial unique index does not stop it (it excludes nulls by design). The result is
  carrier cost counted twice in `pnl_monthly` — a wrong money number on the main screen, with no
  visible symptom.
- **Fix:** before deploy, run the `missing_shipment_id` count from the verify script over the sync
  window specifically. If it is not zero, either widen the backfill or add a fallback lookup on
  `(order_number, ship_date, carrier)` for the null case. At the very least, count these in the
  monitor output so a duplicate insert is visible on the day it happens.

**I5. `run.close()` is not in a `finally` in either sync.**

- `src/lib/sync/zenventory.ts` and `src/lib/sync/shipstation.ts` both `await run.close()` on the
  success path only. Any throw between `openSyncRun` and `close` leaves the `sync_runs` row open.
- Consequences: the run appears perpetually in-flight; `monitor/route.ts:122` points the reader at
  *"the latest `sync_runs` row"* for failure detail and will find a row with no terminal state; and if
  anything keys a stale-lock timeout off run rows, an abandoned row extends the window in which
  charges are not recalculated.
- The `zenventory.ts` per-client loop makes this likelier, not less: each client opens its own run.
- **Fix:** `try { ... } finally { await run.close() }` in both, with `close()` recording the failure
  state when the run is being closed from an exception path.

**I6. Spec §9 requires two deploys; this branch is one.**

- Spec §9 separates step 2 (sync correctness with the carrier filter still on) from step 3 (drop the
  filter), and gives the reason: *"Doing both at once means a bad outcome has two candidate causes and
  a rollback abandons the fix along with the exposure."*
- This branch contains both: the `shipstation.ts` diff removes the `carrierCode: 'stamps_com'` filter
  **and** re-keys identity **and** changes error handling, together. Spec §5.5 puts the filter removal
  at step 5, after the identity change is proven.
- Combined with I3 (no tests) and the 401 credentials, the first production run will exercise a
  key change, a filter change and an error-handling change simultaneously, against live money data,
  with no way to attribute a bad result.
- **Fix:** ship the identity/upsert/error changes first with the filter retained, confirm a clean run,
  then remove the filter in a follow-up. If that is not acceptable, at minimum land I3's tests so the
  identity change has evidence behind it before the blast radius widens.

**I7. Six API results are cast to typed arrays without validating shape.**

- `src/lib/ledger/summary.ts:~529` — `leaks: (leaks.data ?? []) as LeakRow[]`, and the same pattern
  for the other five.
- `as` here asserts something unverified: if a view is redeployed with a renamed or dropped column,
  the cast succeeds and the field arrives as `undefined`. `fmt(undefined)` returns `'—'`
  (`page.tsx:30`) and `marginClass` is only called on `number | null`, so `undefined` takes the
  `n < 0 ? red : green` branch — **a missing column renders as a green zero-ish cell, not an error.**
  That is the cardinal sin arriving through a type hole rather than a logic hole.
- The fake cannot catch this (see Blind spot B4 — no column projection), so there is no test that
  would notice.
- **Fix:** validate at the boundary. A hand-written `toLeakRow(raw)` per view that reads named fields
  and returns `null` for anything absent is enough; it need not be a schema library. At minimum,
  narrow `marginClass`/`fmt` to reject `undefined` distinctly from `null` so a missing column shows as
  unknown rather than as a number.

**I8. `monitor/route.ts` is invoked ~288×/day/tab and does real write work on every call.**

- `AutoSync` polls every 5 minutes from every open browser tab. `maxDuration = 300` was raised for
  this route, so a single invocation may hold a serverless function for five minutes.
- Stages 1–3 are **not** throttled: `syncShipments(7)`, `syncClientAssignments(7)` and
  `recalculateShipments()` run on every poll, including concurrent polls from different tabs. Only
  stage 3b carries a lock and `CHARGE_THROTTLE_MINUTES`, and 3c piggybacks on it (`:155`, documented
  at `:146-153`).
- So with three tabs open, three ShipStation syncs run concurrently every five minutes, each doing
  `maybeSingle()`-then-`insert` against the same shipments. That read-then-write is not atomic: two
  concurrent runs can both find no row and both insert. The partial unique index on
  `shipstation_shipment_id` will reject the second with 23505 — which is the good outcome, and the
  reason the index matters — but the error lands in `results.errors`, which I2 shows is never
  surfaced. So the symptom is invisible.
- Cost: the ShipStation and Zenventory API calls are per-poll, per-tab. This is a real spend and a
  real rate-limit exposure.
- **Fix:** extend the stage-3b lock-and-throttle pattern to stages 1–3, or separate the cron path
  (which should do the work) from the browser-poll path (which should only read status). The
  infrastructure already exists in `recalculateCharges`.

#### Minor

**M1. Per-section empty states assert absence in the same words whether the view was empty or failed.**
`page.tsx:294` "No dated leaks in the last three months.", `:386`, `:483`, `:569` similarly. The global
banner at `:263-275` does say *"Empty tables on this page may mean a view error, not an absence of
data"*, which is an honest mitigation and is why this is Minor rather than Critical. But a reader who
scrolls to Pick Activity is reading a positive claim with the disclaimer off-screen. **Fix:** pass the
per-view error into each section and render "could not load" in red in place of the empty-state
sentence. The variance section already shows the right instinct (`:659-663`: *"This is an absence of
inputs, not a variance of zero"*) — apply it to the other four.

**M2. `fmt()` returns an em-dash for null, which in a money column is the accounting symbol for
nil.** `page.tsx:29-32`, and `int` (`:35-38`) and `fmtRate` (`:55-58`) do the same. In practice the
cells that can actually be null are all routed through the dedicated "unknown" components, so this is
latent rather than live — **but it is latent only because of a contract owned by the SQL reviewer:**
the Revenue, Direct Cost and Gross Margin cells (`:408, :420, :423`) use bare `fmt`, and are safe only
if `pnl_monthly` never emits null for them. The view comment at `page.tsx:743-747` says
`gross_margin = revenue - coalesce(cost, 0)`, which makes gross_margin null iff revenue is null.
**Named assumption: `pnl_monthly.revenue` and `.direct_cost` are non-null for every row the view
produces.** If that ever changes, three money cells silently start rendering "—". **Fix:** make
`fmt(null)` return the string `"unknown"` and leave em-dash to `int`-style non-money columns; or add
the same explicit guard the other cells have.

**M3. `getWarehouseRates` discards the query error.**
`src/app/clients/[id]/page.tsx:26-31` — `const { data } = await supabaseAdmin...; return data ?? []`.
A failed read renders the "no rates configured" empty state at `:219`. Pre-existing, but the diff
touches this table and the fix is one line. Same defect class as M1.

**M4. `.order('service_type')` sorts on the column the diff just established is null on seeded rows.**
`src/app/clients/[id]/page.tsx:30`. The display now prefers `r.label` (`:264`), so the visible order no
longer corresponds to the sort key and seeded rows cluster at the end. Cosmetic. **Fix:** order by
`label` with `service_type` as tiebreak.

**M5. `r: any` in the rates map.** `src/app/clients/[id]/page.tsx:263`. The new null-guards
(`r.label ?? r.service_type?.… ?? '—'`, `r.rate === null`) are exactly the checks a real row type would
have made the compiler enforce. With `any`, `r.rate === undefined` (if the column were not selected)
falls to `Number(undefined).toFixed(2)` → **"$NaN"**. Safe today only because the query is
`.select('*')` (`:28`). **Fix:** declare a row interface.

**M6. `syncResult: any` / `clientResult: any` in the monitor.**
`src/app/api/agent/monitor/route.ts:58, :69`. Both syncs return well-shaped objects; typing them
would have made I2 a compile-time observation (unread `errors` / `clients_failed` fields) rather than
something a reviewer had to notice.

**M7. Dead code in the fake's `select()`.**
`fake-supabase.ts:~186` — `if (this.call.verb === 'select') this.call.verb = 'select'` is a tautology.
Harmless, but it reads as though it were meant to guard something. **Fix:** delete it, or restore the
intended guard.

**M8. `vitest.config.ts` includes only `src/**/*.test.ts`, excluding `.test.tsx`.** This means
`page.tsx` — 767 lines of money-rendering logic, the single most consequential file in this slice —
cannot be tested at all. `summary.ts` deliberately pushes display decisions into `.ts` so they can be
covered (`netProfitUnavailableReason`, `confidenceLabel`, `varianceUnavailableText`), which is a good
mitigation and is why this is Minor. But `AllocationCell`, `LeakAmount`, `NetProfitUnknown`,
`VarianceCell`, `varianceClass` and `RowCount` are all untested. **Fix:** add `.test.tsx` to `include`
and cover the six renderers with the testing library; they are pure and take no context.

---

### Blind spots in the test harness

`fake-supabase.ts` defines what all 261 tests are capable of seeing. For each item below: the behaviour
is absent or unfaithful, **no existing test could detect the absence**, and the tests that appear to
cover the area are therefore weaker than they look.

**B1. The 1000-row project cap is not modelled.** `select` (`:287-301`) returns every matching row.
No test can produce a silently-truncated result. *Weakened:* `RowCount`'s entire orange branch
(`page.tsx:90-101`, "the rest were cut by the server row limit") is unreachable from any test; the
truncation test in `summary.test.ts` exercises only the explicit `PICK_ROW_LIMIT`, which is the one
case the code already knew about. The silent-truncation defect the `{count:'exact'}` design exists to
catch cannot be reproduced.

**B2. `count` is never returned for write verbs.** `this.matched` is assigned only in the `select`
branch (`:288`); `insert`/`upsert`/`update`/`delete` return `count: this.matched` = `null`
(`:359`). Real PostgREST honours `{ count: 'exact' }` on writes. *Weakened:* any future test asserting
"the upsert wrote N rows" via `count` would read `null` — and per the standing rule, an assertion
against `null` is not an assertion.

**B3. `single()` is not implemented at all.** Only `maybeSingle()` exists (`:257-259`).
`zenventory.ts` uses `.select('id').single()` on the order upsert. **The most important path in the
Zenventory sync cannot be exercised by the fake.** Calling it would hit the Builder's missing method
and throw — which is at least loud, but it means the order-upsert path has no test and cannot get one
without extending the fake. Note the semantic difference that is being skipped: `single()` errors on
*zero* rows (PGRST116) where `maybeSingle()` returns null. Code that treats "no row" as recoverable
behaves differently under the two.

**B4. There is no column projection.** `select('id, pick_date, ...')` ignores its argument entirely
and returns whole stored rows (`:186-192` records nothing about columns; `:287` returns `table.filter(...)`
unprojected). *Weakened, severely:* a test cannot detect that production code reads a field it never
selected. In the real client that field is `undefined`; in the fake it is the stored value. Every test
that reads a column from a query result is passing on data the real query would not have returned.
This is the mechanism by which I7's `as LeakRow[]` cast can never be caught by a test, and it applies
to `summary.ts`'s six reads, `zenventory.ts:113`, and `shipstation.ts`'s lookups alike.

**B5. `head: true` is not modelled.** A `{ head: true }` call returns rows rather than a body-less
count. Nothing in this slice uses it, but any count-only query added later would be tested against
behaviour the real client does not have.

**B6. Unique constraints do not exist in the fake — only the declared `onConflict` keys.**
`upsert` (`:310-321`) matches on `onConflict` and otherwise pushes. There is no table-level uniqueness.
*Weakened:* (a) the 42P10 partial-index failure that `ledger_01_orders.sql:34-48` exists to prevent
cannot be reproduced — a test would pass against a conflict target the database would reject outright;
(b) Postgres 21000 ("ON CONFLICT DO UPDATE command cannot affect row a second time") for a payload
containing two rows with the same conflict key is not raised — the fake happily applies both, second
overwriting first; (c) 23505 on a concurrent duplicate insert (I8) cannot be reproduced.

**B7. `valuesEqual(undefined, undefined)` is `true` via the `a === b` fast path (`:~60`).**
Consequence: if `onConflict` names a column that is absent from **both** the stored row and the
incoming payload — a typo, a renamed column, a stale conflict target — `keys.every(...)` is satisfied
by the *first row in the table* and the upsert silently updates the wrong row instead of inserting.
*Weakened:* a test with a wrong conflict target passes. Given that conflict targets are precisely what
the `orders` index comment warns about, this is the blind spot I would fix first. **Fix:** treat an
`undefined` on either side of a conflict-key comparison as a non-match, and throw if a conflict key is
absent from the incoming payload.

**B8. Comparisons in `gte`/`lte`/`lt` are string-wise** (`:~95`, `return String(actual) >= String(f.value)`).
Fine for ISO dates, which is what this slice filters on. Wrong for numbers: `String(9) >= String(10)`
is `true`. *Weakened:* any test filtering a numeric column asserts behaviour the database does not
have. No current test does, so this is latent — but it is a trap for the next person.

**B9. `sorted()` also compares with `String()`** (`:~268`). Numeric ordering is lexical: 10 sorts
before 9. *Weakened:* `summary.test.ts`'s sort assertions check `call.sort` (the recorded chain), not
the returned row order, so they do not depend on this — which is the right choice — but any test that
did assert row order on a numeric column would be verifying the wrong thing.

**B10. `nullsFirst` is accepted and ignored** (documented at `:236-239`). Nulls always sort last.
Honest and documented, and this codebase never asks for `nullsFirst`. Recording it so the list is
complete: no test can detect a `nullsFirst: true` that the production query needed.

**B11. `update` applies only `payload[0]`** (`:325`). A multi-row update payload silently drops all but
the first. No test would notice.

**B12. `order()`, `range()` and `limit()` are recorded but not applied to `update` or `delete`.**
Faithful to PostgREST's defaults, but the fake also does not *reject* them, so a test could chain a
`.limit()` onto a delete and see the full-table delete happen without any signal.

**B13. Awaiting a builder twice re-executes it.** `then()` (`:362-368`) calls `[RESULT]()` on each
invocation, and `[RESULT]()` pushes to `db.calls` (`:274`) and mutates tables. A double-await
double-writes and double-counts. *Weakened:* `expect(h.db.calls).toHaveLength(6)` in `summary.test.ts`
is load-bearing and would silently be satisfied by three double-awaited queries.

**B14. `rpc`, `throwOnError`, `abortSignal`, `neq`, `gt`, `ilike`, `contains` are all absent.**
Absent operators throw (good — `:221-233` sets the precedent for `is`/`not`), but only `is` and `not`
have explicit guards; the others fail as "not a function", which is loud but uninformative.

**B15. `fake-supabase.test.ts` covers 5 behaviours out of ~20.** All five concern `maybeSingle()`
plus one unimplemented-operator check. **Nothing tests** upsert conflict-target matching, the
PGRST103 range branch, `like`, `or`, sort ordering, delete scoping, update scoping, or `count`
semantics. The fake is the foundation of 261 tests and is itself 26% covered. Every item B1–B14 above
is a behaviour the fake's own test file does not pin, so a future edit to the fake can change what all
261 tests mean without any of them failing.

---

### Declined to judge

- **RLS absence on `orders`, `order_items`, `order_charges`, `cost_rates`, `operating_costs`** —
  filed separately as pre-existing, per the brief. Reasoned about in C1: it is the reason the
  unauthenticated route matters more than it otherwise would, since `supabaseAdmin` bypasses the view
  `revoke`s that were the compensating control.
- **The SQL views themselves** (`ledger_04_views.sql`) — another reviewer's slice. Read only to
  establish contracts, named in I1, I4 and M2.
- **`labourVariance()`, `calculateCharges()`, `cost-rate.ts`, `pick-date.ts` internals** — the
  calculation core, another reviewer's slice. Judged only where the screen consumes them (Strength 3,
  I1).
- **`package-lock.json`** — excluded by the brief.
- **Whether `CHARGE_THROTTLE_MINUTES` and `STALE_RUN_MINUTES` are the right durations** — a
  operational judgement with no correctness answer available from source. The mechanism is sound; the
  numbers are a tuning decision for the owner.
- **The Vercel cron schedule (06:00/14:00/20:00 UTC) versus the before-06:00-local watermark rule** —
  depends on `watermarkPickDate`'s internals, which are in the calculation reviewer's slice. Flagged
  here only because C2 makes the first run's date wrong regardless of schedule.
- **Tailwind colour contrast / accessibility of the orange-on-slate "unknown" text** — real but
  outside the brief's scope, and the choice is consistent across the page.
- **`AutoSync.tsx` itself** — not in the slice. Its polling behaviour is taken as the given fact the
  brief supplied and reasoned about in I8.
- **Whether `/ledger` should exist as a page at all, versus a report export** — product question.
- **Performance of six parallel view reads under load** — the views are another slice and no
  measurement is available offline.
- **`supabase/APPLY_NOW.sql` and `partner_onboarding.sql`** — appeared in greps for `voided`/`backfill`
  but are unrelated to this branch.

---

### Recommendations

1. **Before merge, add `requireStaff()` to `src/app/api/ledger/summary/route.ts` and delete the
   comment.** Two lines. The comment is wrong about the codebase and its instruction to audit 20
   routes first will preserve the hole indefinitely. (C1)
2. **Do not deploy the Zenventory sync until the backfill arm exists and has been run.** The damage
   is not self-healing and requires manual SQL to undo. If backfill is genuinely out of scope, block
   the live path rather than letting it stamp today. (C2)
3. **Write `shipstation.test.ts` and `zenventory.test.ts`.** The harness exists for exactly this and
   is unused for the branch's highest-risk change. Start with the spec's own "running the sync twice
   changes no row count". (I3)
4. **Harden the fake before trusting the next 261 tests.** Priority order: B7 (undefined conflict-key
   match — a wrong conflict target currently passes), B4 (column projection — the mechanism by which
   unvalidated casts stay invisible), B6 (duplicate conflict keys within one payload), B2 (count on
   writes). Then extend `fake-supabase.test.ts` to pin each one.
5. **Finish the monitor hardening in stages 1 and 2.** Surface `errors`, `clients_failed`, `refunds`,
   `unknownCarrier`, `blankOrderNumber`; stop printing `✓` over a stage that failed. Type the two
   `any`s so the compiler keeps it finished. (I2, M6)
6. **Add the client column to Pick Activity, or aggregate it away in SQL.** Do not ship a per-client
   table captioned as per-SKU-per-day. (I1)
7. **Split the ShipStation deploy per spec §9** — identity change first with the carrier filter on,
   filter removal second. If that is refused, land I3's tests as the substitute evidence. (I6)
8. **Wrap both `run.close()` calls in `finally`.** (I5)
9. **Throttle or lock monitor stages 1–3** the way 3b already is, or split the cron path from the
   browser-poll path. (I8)
10. **Validate the six view payloads at the boundary** instead of `as`-casting them, and add
    `.test.tsx` to the vitest include so the six money renderers can be covered. (I7, M8)

---

### Assessment — Ready to merge? **No**

Two defects put wrong numbers in front of a reader or wrong data in the database: an unauthenticated
endpoint that publishes the complete P&L and every client's margins to anyone who can reach the
production deployment (C1), and a Zenventory sync whose first live run permanently stamps today's date
on every historical pick — the exact failure spec §5.5 was written to prevent, made unrecoverable by
the deliberate "set once, never moved" rule (C2). Both are fixable within this branch; C1 is two
lines. The display layer itself is the strongest part of the work and I would merge it on its own
merits — but the API route ships with it, and the sync change that carries the most risk has no tests,
no live verification, and a test harness with fourteen blind spots that would not have caught it.

