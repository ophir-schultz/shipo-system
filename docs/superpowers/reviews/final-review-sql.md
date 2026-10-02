# Final review — SQL and data layer

> **Provenance banner, added in `6779251`+1 at commit time — not part of the original review.**
> Written **13:17 on 2026-10-01 against HEAD `fad4881`**. Where the text below says
> "current state", "at HEAD" or "today", it means `fad4881`, **not** the tree you are
> reading now — 20+ commits have landed since, and several findings here are closed or
> were restated after being checked. This file is committed for **provenance**: it is the
> traceable source behind the `FROM-REVIEW` item IDs in `handover-2026-10-02.md`. Read
> that file first for current status, then come here for the detail. **Re-verify against
> the code before acting on anything below.**

Branch `ledger/complete-the-ledger`. Reviewer slice: `supabase/ledger_0*.sql`, `supabase/verify/*.sql`, against `supabase/schema.sql`.

Static review only. I did not connect to a database; nothing below is claimed as executed. Where a finding can only be settled by running something, I say so and give the query.

---

## Strengths (specific, with file:line)

1. **The NULL-blind-assertion rule is genuinely observed.** I audited every `if` in all five verify files. There are exactly two `<>` comparisons — `verify/ledger_01_verify.sql:96` and `verify/ledger_03_verify.sql:94` — and both are on `select count(*) into n`, which is provably non-NULL (an ungrouped `count(*)` always returns one row). Every assertion whose actual value *can* be NULL uses `is distinct from` or an explicit `is null` guard: `verify/ledger_04_verify.sql:87, 162, 202, 207, 303, 308, 313`, `verify/ledger_03_verify.sql:220`, `ledger_05_seed_nayax.sql:177, 200, 208`. This is the single most important property in the slice and it holds.

2. **`verify/ledger_03_verify.sql:54-62` and `:135-143` get the "index does not exist" case right.** `select pg_get_expr(...), true into pred, found_idx` leaves both targets NULL when no row matches, and the test is `if found_idx is not true` — not `if not found_idx`, which would fall through on NULL. Same at `verify/ledger_01_verify.sql:61-69`. This is the exact trap the brief names, correctly avoided.

3. **`verify/ledger_04_verify.sql:31, 44` — a dedicated throwaway client with `select id into strict cid`.** `into strict` fails loudly on 0 or 2 rows rather than silently binding to the wrong client. Combined with month-ownership (Sept for VERIFY-LEAK, Oct for VERIFY-LEAK2, Nov for VERIFY-PNLC, 2099-01 for VERIFY-PNLM), the zero-assertions at `:122` and `:281` are actually meaningful rather than vacuous. The comment at `:216-226` documents a previous version of this block that could not fail — the fix is real.

4. **`verify/ledger_04_verify.sql:277-280` explicitly guards against the vacuous pass.** `if gm is null then raise exception '... this check would have passed without testing anything'` before asserting `np is not null`. That is the correct shape for a negative assertion and it is rare to see written down.

5. **`ledger_04_views.sql:253-303` — `cost_known` / `cost_unknown_charges` / `revenue_unknown_charges` as a triple.** `sum(c.cost)` is left null-propagating and *named* `cost_known`, with the count of unknowns beside it. `gross_margin`'s coalesce is documented as a deliberate, directional compromise at `:283-298`. This is the cardinal-sin rule implemented, not just asserted.

6. **`ledger_04_views.sql:374-392` — `net_profit` propagates NULL rather than coalescing a missing allocation category to 0**, with `overhead_rows` / `direct_labor_rows` / `direct_storage_rows` added so the NULL is legible. The NULL-vs-0 distinction in those counts (`:342-349`) is subtle and correct: NULL = no book for the month, 0 = book exists and this category is absent.

7. **Month bucketing is correct everywhere I checked.** `ledger_04_views.sql:334` and `:528` both `date_trunc('month', period_month)::date` on `operating_costs.period_month`, which `ledger_02_cost.sql:81-84` leaves unconstrained. `verify/ledger_04_verify.sql:291-293` dates *both* phase-2 fixtures mid-month specifically so a lost `date_trunc` is detected — and the comment at `:253-261` explains why dating only one would produce a false partial pass. That is a well-designed regression detector.

8. **`ledger_04_views.sql:129, 200, 231, 246` rotate `timestamptz` to `America/New_York` before truncating, and deliberately do NOT do so for the plain `date` columns at `:159` and `:220`.** The asymmetry is correct and the reason is written down (`:113-128`). `at time zone` on a `date` would coerce to local midnight and shift it.

9. **No row fan-out in any of the five views.** `pnl_client_monthly`'s `left join clients` (`:302`) is on a primary key; `labour_variance_inputs`'s `left join client_warehouse_rates w on w.id = c.rate_id` (`:449`) likewise; the `left join lateral ... limit 1` at `:476-485` is bounded by construction. `pick_days` (`:89-91`) joins `preferred` on `(order_id, source)` where `preferred` is `distinct on (order_id)` — at most one row. No money is double-counted by a join.

10. **`ledger_03_charges.sql:134-154` and `ledger_07_storage.sql:52-64` make drop-then-recreate atomic** by putting both statements in a PL/pgSQL block *with* an exception handler, so a failed `create`/`add` rolls the `drop` back with it. Given "half-applied state is normal", this is the right pattern and the reasoning at `:123-133` is exact.

11. **`ledger_02_cost.sql:50-75` adds the `basis` CHECK and, on failure, names the offending values.** `select string_agg(quote_literal(basis) ...)` inside the `check_violation` handler, plus a `hint` containing the diagnostic query. This is what a loud failure should look like.

12. **`ledger_07_storage.sql:36-43` picks `extract(day from period_month) = 1` over `period_month = date_trunc(...)` for a documented immutability reason.** Correct: `date_trunc(text, date)` resolves to the `timestamptz` overload, which is STABLE, and a STABLE expression in a CHECK means the constraint says different things to different sessions.

13. **`ledger_05_seed_nayax.sql:42-53` refuses to guess which client "nayax" means** — counts first, raises on 0 or >1 — instead of `limit 1` with no `order by`. And `:176-179` asserts the *measured* row count from `get diagnostics`, not a hard-coded 18.

14. **`ledger_05_seed_nayax.sql:253-260` — `rate_type is distinct from 'at_cost'`**, with a comment naming the exact trap (`rate_type` itself NULL). The `WHERE`-clause half of the standing rule, correctly handled.

15. **`ledger_04_views.sql:176-199` — `c.charge_type = 'shipping'` in leak 3 is load-bearing and documented.** `chargeKey()` returns the same `shipment:<id>` for both `'shipping'` and `'return'` (confirmed: `src/lib/ledger/charge-key.ts:50-53`), so without the type test a return-only shipment would read as billed. Verified against the TypeScript; the comment is accurate.

---

## Issues — Critical

### C1. `operating_costs.allocation` has no CHECK constraint, so a mistyped value silently deletes a real cost from net profit
`ledger_02_cost.sql:85`; consumed at `ledger_04_views.sql:335-337, 350-352, 531`.

`allocation text not null default 'overhead'` accepts any string. `pnl_monthly` sums it three ways with `filter (where allocation = '<literal>')` and `labour_variance_inputs.payroll` filters `allocation = 'direct_labor'`. There is **no writer for this table anywhere in `src/`** — I grepped; the only references are reads in `summary.ts` and display in `page.tsx`. So rows are typed by hand into the Supabase table editor.

A row entered as `'direct labor'`, `'Direct_Labor'`, `'labour'` or `'payroll'`:
- contributes to none of the three `sum(...) filter (...)` expressions, so its amount **vanishes from `net_profit` entirely**;
- contributes to none of the three `*_rows` counts, so the "which category is missing?" machinery at `ledger_04_views.sql:340-352` — the whole apparatus built to make the NULL legible — reports the category as *present and complete* if any correctly-spelled row also exists for that month;
- vanishes from `labour_variance_inputs.direct_labor`, which makes `implied_actual_rate` read low and the labour variance read **favourable**.

Both effects are in the flattering direction. There is no over-billing branch in `leaks_monthly` and no reconciliation column anywhere, so nothing detects it, ever. `$3,000` of payroll typed as `'direct labour'` makes the month look $3,000 more profitable and the pick rate look cheaper than it is — and a human reprices off that.

The asymmetry with `cost_rates` is striking: `ledger_02_cost.sql:40-75` adds a CHECK on `basis` with a 35-line justification about one mistyped character, then declares `allocation` four lines later with nothing. The same argument applies with more force, because `basis` at least has a TypeScript type guarding the write path and `allocation` has no write path at all.

**Fix.** Add, in the same guarded shape as `cost_rates_basis_valid`:
```sql
alter table operating_costs add constraint operating_costs_allocation_valid
  check (allocation in ('overhead','direct_labor','direct_storage'));
```
with a `check_violation` handler that names the offending values. Additionally — because the constraint cannot be added retroactively to a database that already holds bad rows — add a reconciliation column to the `overhead` CTE:
```sql
sum(amount) - coalesce(sum(amount) filter (where allocation in
  ('overhead','direct_labor','direct_storage')), 0) as unallocated,
count(*) filter (where allocation not in
  ('overhead','direct_labor','direct_storage')) as unallocated_rows
```
and surface it. `unallocated > 0` must be as loud as a leak.

### C2. `not o.cancelled` treats an unknown cancellation as cancelled, and the TypeScript deliberately treats it as not-cancelled
`ledger_04_views.sql:92` (`pick_days`) and `:168` (`leaks_monthly` leak 2).

`orders.cancelled` is declared `boolean default false` at `ledger_01_orders.sql:29` — nullable. The default only applies when the column is omitted from an INSERT; an upsert that passes `cancelled: null` writes NULL. That this happens is not speculative: `src/lib/ledger/load-charge-inputs.test.ts:336` is a test named *"reads a null cancelled flag as not cancelled"*, and `calculate-charges.ts:68` (`if (input.order.cancelled) return []`) treats falsy — including null — as not cancelled.

So the loader **bills** a null-cancelled order while `pick_days` and leak 2 **exclude** it, because `not NULL` is NULL and an `if`/`WHERE` on NULL drops the row.

Consequences:
- `pick_days` undercounts `units_picked` and `orders` for those orders. That feeds the dashboard and (indirectly, via the same class of error) the sense of how much work was done.
- **leak 2 `picked_never_billed` is blind to them.** An order that was picked, was never charged, and has `cancelled = NULL` produces no leak row. Per the brief's own asymmetry, a missed leak is silent forever. This is the dangerous direction.

**Fix.** Change both predicates to `where o.cancelled is not true` (or `not coalesce(o.cancelled, false)`). Separately, backfill and constrain: `update orders set cancelled = false where cancelled is null;` then `alter table orders alter column cancelled set not null;` — the column has a default, so nothing breaks, and the SQL/TypeScript disagreement becomes structurally impossible. I have **not** run the count of null-`cancelled` rows; to size it: `select count(*) from orders where cancelled is null;`

### C3. The security verification in `ledger_04_views.sql` warns instead of failing, and `ledger_04_verify.sql` does not check security at all
`ledger_04_views.sql:678` and `:732`; absence in `verify/ledger_04_verify.sql`.

The file's own header (`:35-42`) establishes the stake precisely: a view created but not revoked is readable by `anon`, whose key is a `NEXT_PUBLIC_` string in the browser bundle. The three guards that check this all end in `raise notice`:

- `:640-646` — `security_invoker` failure → notice.
- `:677-690` — reloptions read-back finds the setting missing → notice.
- `:731-737` — **`has_table_privilege('anon', ...)` finds anon can still SELECT → notice.**

A NOTICE is not a failure. The paste completes, the SQL editor reports success, and — on the reasonable assumption that an operator pasting 780 lines scrolls to the bottom looking for red, not for a messages pane — nobody sees it. Every client's name, monthly label spend, cost and gross margin is then public until somebody happens to look.

This is the brief's own standing rule applied to a guard rather than an assertion: **a check that cannot fail manufactures confidence.** The third guard in particular is the one closing the real exposure (the ledger tables have no RLS of their own, so `security_invoker` does not protect them — only the revoke does), and it is the one that should be loudest.

The file is pasted as a single transaction by contract (`:35-38`). That makes `raise exception` exactly right: it rolls back the creates along with the failed revoke, leaving **no view at all** rather than an exposed one. Failing closed is available for free here and is not taken.

Compounding it: `verify/ledger_04_verify.sql` — the file whose whole job is to fail loudly — contains no security assertion whatsoever. It tests `pick_days`, `leaks_monthly` leak 4, `pnl_client_monthly` and `pnl_monthly`, and says nothing about who can read them.

**Fix.**
1. `ledger_04_views.sql:732` → `raise exception` (keep the message; it is good). Same for `:678`, or at minimum promote it to `raise warning` and document why it is not fatal.
2. Add to `verify/ledger_04_verify.sql`, as a hard assertion:
```sql
do $$
declare open_to text;
begin
  select string_agg(v.name || ' -> ' || v.role, ', ')
    into open_to
  from unnest(array['public.pick_days','public.leaks_monthly',
                    'public.pnl_client_monthly','public.pnl_monthly',
                    'public.labour_variance_inputs']) as v(name)
  cross join unnest(array['anon','authenticated']) as v2(role)
  -- note: rewrite as a single unnest pair; shape shown for intent
  where has_table_privilege(v2.role, v.name, 'SELECT');
  if open_to is not null then
    raise exception 'FAIL: these views are readable by a public role: %', open_to;
  end if;
  raise notice 'PASS: neither anon nor authenticated can select the five views';
end $$;
```
Note this must check `authenticated` as well as `anon` — see I11.

### C4. Activating the peak surcharge per the file's own instructions arms a duplicate-row bug, and `client_warehouse_rates` has no overlap protection at all
`ledger_05_seed_nayax.sql:56-57` (the delete), `:127-133` (the activation instructions), `:148-149` (the peak tuple); `ledger_03_charges.sql:213-214` (the non-unique lookup index).

The seed's idempotency rests on `delete from client_warehouse_rates where client_id = cid and effective_from = '2026-01-01'`. The peak row is inserted with `effective_from = '2026-01-01'` (the empty `[2026-01-01, 2026-01-01)` off-switch), so today the delete covers all eighteen rows.

The file instructs the operator (`:127-133`) to activate the line by editing *this file's* date literals to the real peak window and re-running. Trace it:

- **Run 1** (today): 18 rows, peak at `('2026-01-01','2026-01-01')`.
- **Edit + Run 2**: delete matches all 18 (the stored peak still has `effective_from='2026-01-01'`), insert 18, peak now at e.g. `('2026-11-01','2026-12-26')`. Correct.
- **Run 3** (re-paste for any reason — a later rate edit, a rebuild, a second operator): the delete now matches only **17** rows; the peak row's `effective_from` is `2026-11-01` and escapes it. The insert adds 18. **There are now two identical peak rows.**
- **Run 4**: three. It compounds.

`get diagnostics n = row_count` at `:176` still reads 18 and passes. The two scoped assertions at `:196-210` check only `pick/device` and `pick/component`, so the peak duplication is invisible at apply time.

The file's own header calls this outcome out — *"two rows for the same (charge_type, variant), which is the self-overlapping card the dated lookup exists to prevent (calculate-charges.ts:91-98 calls it a data error and resolves it by sort order)"* — but attributes it only to hand-edits in the database, not to the activation procedure the same file prescribes.

**The deeper problem underneath it:** `client_warehouse_rates` has *no* uniqueness and *no* exclusion constraint. `ledger_03_charges.sql:213-214` creates `client_warehouse_rates_lookup_idx` on `(client_id, charge_type, variant, effective_from)` and it is **not unique**. Compare the cost side, which has both a unique index *and* a GiST exclusion constraint (`ledger_02_cost.sql:23-38`) on exactly the same grounds — *"Two rates for the same thing must never cover the same day. Without this, charge calculation is non-deterministic."* That argument applies identically to the revenue side, and the revenue side is the one the client is invoiced from. Nothing in this branch prevents two overlapping rate-card rows for the same `(client, charge_type, variant)`.

**Fix.**
1. Make the delete cover the seeded set regardless of the peak dates, e.g. scope it by the lines this file owns rather than by a date literal — `delete from client_warehouse_rates where client_id = cid and charge_type is not null and effective_from is not null;` (legacy rows have `effective_from = null` and are still protected), or add a `seed_source text` marker column and delete on that.
2. Add the assertion the other two have: `select count(*) ... where charge_type='surcharge' and variant='peak'` must be `is distinct from 1`.
3. Add to `client_warehouse_rates` the same protection `cost_rates` has:
```sql
alter table client_warehouse_rates add constraint client_warehouse_rates_no_overlap
  exclude using gist (
    client_id                 with =,
    coalesce(charge_type,'')  with =,
    coalesce(variant,'')      with =,
    daterange(effective_from, effective_to, '[)') with &&
  );
```
This will need a guarded `do` block and a backfill decision for the legacy rows where `effective_from is null` (a NULL `effective_from` makes `daterange` NULL, which `&&` never matches — so legacy rows are simply exempt, which is the safe behaviour).

---

## Issues — Important

### I1. `net_profit`'s value is never asserted — only its nullness
`verify/ledger_04_verify.sql:262-327`.

Phase 1 asserts `np is not null → FAIL`. Phase 2 (two of three allocations present) asserts `np is not null → FAIL`. Both branches check that net profit is **NULL**. No block anywhere enters all three allocation categories and asserts a numeric result.

Consequence: if `ledger_04_views.sql:391-392` were written `r.revenue - coalesce(r.direct_cost,0) + o.overhead - o.direct_labor - o.direct_storage`, or the three terms were coalesced to 0, or `direct_cost` were added rather than subtracted, **every assertion in this file still passes.** The single number a human reads before changing a client's price has its arithmetic and its signs untested.

**Fix.** Add a phase 3 to the same block:
```sql
insert into operating_costs (period_month, category, amount, allocation)
  values ('2099-01-25', 'VERIFY-space', 500.00, 'direct_storage');
select net_profit into np from pnl_monthly where period_month = '2099-01-01';
-- revenue 10.00, direct_cost 4.00, overhead 1000, labour 2000, storage 500
if np is distinct from -3494.00 then
  raise exception 'FAIL: net_profit is %, expected -3494.00', np;
end if;
```
A negative expected value is deliberate — it pins the sign of all five terms at once.

### I2. `labour_variance_inputs` has no automated verification at all
`ledger_04_views.sql:438-567`; absent from `verify/ledger_04_verify.sql`.

It is the most intricate view in the file — a units-weighted rate across variants, an all-or-nothing NULL rule, a `union` of two month sources, a lateral effective-dated lookup, and a `jsonb_agg` — and the only check on it is the commented-out operator query at `:748-781`, which the file itself says "cannot be run from the test suite".

Specifically untested, each a plausible and consequential error:
- **the weighting.** `sum(units_v * rate_v) / sum(units_v)` at `:501` and `:555`. If it degraded to a plain `avg(rate)`, a month of 10,000 device picks and 10 component picks would report a rate materially below the true blend, absorbed cost would read low, and the variance would read **unfavourable** — sending someone to hunt an overspend that is not there. (Direction is safe; the number is still wrong.)
- **`any_rate_missing`** (`:496`, `:554`, `:557`). If it stopped nulling the month, a partially-covered month would report a weighted average over the covered subset only — the exact failure the comment at `:491-495` describes.
- **`unattributable_pick_charges`** (`:490`) — the column that surfaces pick charges with an unresolvable `rate_id`.
- **the `months` union** (`:534-543`) — a month with payroll and no picks. The comment calls it "the largest unfavourable variance there is"; nothing proves it appears.
- **`direct_labor` being NULL and not 0** when no payroll is entered — the operator note at `:753-756` says this is the thing to check first, and it is checkable in SQL.

**Fix.** Add a block to `verify/ledger_04_verify.sql` using the sentinel-month pattern already established (own a month like `2098-01`), with a client-specific rate card seeded inside the transaction, asserting: `units_picked`, that `standard_rate` equals the hand-computed weighted blend, that `standard_rate` goes NULL when one variant's cost rate is absent, that `direct_labor` is NULL before the payroll insert, and that a payroll-only month produces a row with `units_picked = 0`.

### I3. `verify/ledger_02_verify.sql` cannot run at all once `ledger_06_seed_cost_rates.sql` has been applied
`verify/ledger_02_verify.sql:6-9, 25-26, 30-31` vs `ledger_06_seed_cost_rates.sql:42-80`.

The seed inserts open-ended rates: `('pick','device', from 2026-01-01, to NULL)`, `('pick','component', same)`, `('storage', NULL, same)`. The verify script's first statement is a bare (un-handled) insert of `('pick','device', 2026-01-01 → 2026-02-01)`, which overlaps the seeded row and violates `cost_rates_no_overlap`. Being outside any `do` block, it aborts the whole script at line 7. Line 25 (`pick`/`component`) and line 30 (`storage`/NULL — which also collides with the unique index on `(cost_type, coalesce(variant,''), effective_from)`) fail the same way.

So in the documented apply order (`ledger_02` → … → `ledger_06`), the verification of the overlap constraint — the constraint that makes charge calculation deterministic — **never executes**. What the operator sees is an `exclusion_violation` from a file whose header says "Run AFTER applying it", which reads exactly like the "already applied, wave it off" failure that `ledger_04_views.sql:16-19` warns about in another context.

The file already knows the fix and applies it to the last section only: `:43-45` uses a distinct `cost_type = 'basis_probe'` *"so these rows cannot collide with the overlap fixtures above"*.

**Fix.** Rename the overlap fixtures to a probe cost_type — `('overlap_probe','device')`, `('overlap_probe','component')`, `('overlap_probe', null)` — so the script is independent of what is seeded. The constraint under test is on `(cost_type, coalesce(variant,''))`, so the probe exercises it identically.

### I4. `revenue_unknown_charges` is untested in both views
`ledger_04_views.sql:276` and `:314`; absent from `verify/ledger_04_verify.sql`.

This column exists specifically for the mirror of the cardinal sin — an at-cost freight line whose carrier bill has not arrived has **unknown revenue**, and `sum(amount)` silently skips it. The VERIFY-PNLC block (`:181-214`) tests the *cost* direction thoroughly (`cost_unknown_charges = 1`, `cost_known is null`) and the revenue direction not at all: its fixture has `amount = 7.50`.

Given `ledger_03_charges.sql:95-100` had to add a guarded `drop not null` on `amount` because an earlier draft shipped it NOT NULL, and `verify/ledger_03_verify.sql:192-208` tests that nullability at the table level, the *view* half of the same property being untested is a real gap.

**Fix.** In the VERIFY-PNLC block, add a second charge in the same group with `amount = null, cost = null`, then assert `revenue is distinct from 7.50 → FAIL` (unchanged — sum skips the null) **and** `revenue_unknown_charges is distinct from 1 → FAIL`. Do the same for `pnl_monthly` in the VERIFY-PNLM block.

### I5. `pick_days`' de-duplication is never exercised, and its failure direction flatters
`ledger_04_views.sql:61-76, 89-93`; `verify/ledger_04_verify.sql:41-63`.

The VERIFY-PD fixture gives the order a dateless Zenventory line and a dated ShipStation line. Only the ShipStation line survives the `usable` CTE, so `preferred` has exactly one candidate. **If the `join preferred p` at `:91` were deleted entirely, this test would still pass with the same numbers.** The central property of the view — that an order with usable lines in *both* sources is counted once, with Zenventory winning — is untested.

If that de-duplication broke, `units_picked` would double. Doubled units flow into `labour_variance_inputs.units_picked` → `absorbed` reads high → the variance reads **favourable**. Flattering direction, silent.

The test also asserts only `n > 0`, never a quantity.

**Fix.** Give VERIFY-PD a second order with a dated Zenventory line *and* a dated ShipStation line for the same SKU and pick_date, with different `quantity_picked` (say 3 and 5), and assert `units_picked is distinct from 3 → FAIL` — proving both that the row is counted once and that Zenventory won.

### I6. Five of the six leak branches have no test
`ledger_04_views.sql:110-253`; `verify/ledger_04_verify.sql:107-166`.

Only leak 4 (`negative_margin_lines`) is covered, in both directions. Leaks 1, 2, 3, 5 and 6 have none. Untested behaviours that matter:

- **leak 2** (`picked_never_billed`) — the `not exists ... charge_type = 'pick'` correlation, and the `not o.cancelled` predicate that C2 shows is wrong.
- **leak 3** (`unpriced_shipments`) — the `charge_type = 'shipping'` test whose absence would let a return-only shipment read as billed (`:178-183`); and the NULL-`period_month` bucket (`:191-199`) that `summary.ts:469-479` has a whole separate query for.
- **leaks 5/6** — the `> 0` / `< 0` split on `adjustment_amount`, which `ledger_03b` exists to make correct.
- **leak 1** — `nullif(trim(order_number), '') is null or client_id is null`.

**Fix.** At minimum add leak 2 and leak 3 with a sentinel month, since those two are the ones that catch unbilled work. Leak 3 in particular should assert that a shipment carrying only a `'return'` charge still appears.

### I7. `create table if not exists order_charges` will not repair a pre-existing table, and one of the things it will not add is the cost-has-basis CHECK
`ledger_03_charges.sql:55-87`.

The file is explicit that "half-applied state is normal" and adds a guarded `alter ... drop not null` at `:95-100` precisely because `create table if not exists` does nothing to an existing table. That reasoning is correct and incomplete. Against a database carrying an earlier draft of `order_charges`, a re-run also fails to add:

- `constraint order_charges_cost_has_basis` (`:85-86`) — **the silent one.** Without it a charge can be written with `cost` set and `cost_basis` NULL, and every screen renders it as measured. The verify script does test this (`verify/ledger_03_verify.sql:241-257`), which is the saving grace — but only if the operator runs the verify.
- columns `cost_rate_id`, `cost_basis`, `charge_date_source`, `is_estimate`. These fail loudly (PostgREST returns "column does not exist"), so they are less dangerous.

`client_storage_months` in `ledger_07` handles the same problem correctly for its constraints (`:52-80` drop-and-re-add in guarded blocks); `order_charges` does not.

**Fix.** Add the constraint idempotently, in the shape `ledger_07_storage.sql:52-64` already uses:
```sql
do $$
begin
  alter table order_charges drop constraint if exists order_charges_cost_has_basis;
  alter table order_charges add constraint order_charges_cost_has_basis
    check (cost is null or cost_basis is not null);
exception when check_violation then
  raise exception 'order_charges already holds a row with cost set and cost_basis '
                  'null — every screen renders those as measured. Fix them and '
                  're-run. Locate: select id, charge_key, cost from order_charges '
                  'where cost is not null and cost_basis is null;';
end $$;
```
And add `alter table order_charges add column if not exists ...` for the six columns, so a re-run converges.

### I8. `exception when others then raise notice '... was already nullable'` reports a false all-clear for real failures
`ledger_03_charges.sql:95-100`, `:220-225`, `:232-237`.

`ALTER TABLE ... ALTER COLUMN ... DROP NOT NULL` on a column that is *already* nullable **succeeds silently** in Postgres — it does not raise. So the handler never fires for the case its message describes. What it does catch is every genuine failure: table does not exist (42P01), column does not exist (42703), insufficient privilege (42501), lock timeout — and reports all of them as "was already nullable".

Concretely: if `ledger_03` is pasted before `ledger_01`, or into a database where `order_charges` was never created, `:97` fails with 42P01 and the operator is told the column was already nullable. The migration then continues.

`ledger_04_views.sql:623-631` gets this right for the analogous block — it prints `sqlstate` and `sqlerrm` and explicitly says "the handler reports WHAT failed, not why". The same treatment is needed here.

**Fix.** `raise notice 'could not drop not null on order_charges.amount (SQLSTATE %: %) — if this is not "already nullable", the migration is not complete', sqlstate, sqlerrm;` Better: narrow to the SQLSTATEs actually expected and let the rest propagate.

### I9. `ledger_06_seed_cost_rates.sql` has no hard assertion; `on conflict do nothing` lets a hand-lowered cost rate survive forever
`ledger_06_seed_cost_rates.sql:40-95`.

The header is admirably honest about this (`:28-33`): *"a row that ALREADY EXISTS WINS, including one whose rate was edited by hand … not only in the safe direction, since a hand-edited rate that is too low survives and flatters margin."* Having identified the exact failure and its direction, the file's response is two trailing `select`s and an instruction to eyeball them.

Compare `ledger_05_seed_nayax.sql`, which for the *revenue* side does the right thing: `get diagnostics` on the row count (`:176-179`) plus two scoped `is distinct from` assertions (`:196-210`) that abort the paste. The *cost* side — where an error flatters margin, per the project's governing asymmetry — gets weaker treatment than the revenue side.

A pick cost rate hand-edited from 0.2300 to 0.1300 understates `order_charges.cost` on every pick charge → `gross_margin` overstated → `net_profit` overstated → no leak fires, because `leaks_monthly` has no over-billing / under-costing branch.

**Fix.** Wrap the insert in a `do` block and assert the six rows exist with the expected rates:
```sql
select count(*) into n from cost_rates
 where effective_from = '2026-01-01'
   and (cost_type, coalesce(variant,''), rate, basis) in (
     ('pick','device',0.2300,'estimated'), ('pick','component',0.2000,'estimated'),
     ('pack','',0.1500,'estimated'), ('material','box_small',0.4500,'estimated'),
     ('material','box_medium',0.7500,'estimated'), ('storage','',12.0000,'estimated'));
if n is distinct from 6 then
  raise exception 'cost_rates does not match this file: % of 6 rows agree. '
    'on conflict do nothing means an existing row won. Reconcile before trusting margin.', n;
end if;
```

### I10. `charge_type`, `cost_type` and `rate_type` are unconstrained text, and the views filter on exact literals
`ledger_03_charges.sql:62` (`order_charges.charge_type`), `ledger_02_cost.sql:13` (`cost_rates.cost_type`), `ledger_03_charges.sql:199` (`client_warehouse_rates.rate_type`), `:210-211` (`charge_type`, `variant`).

`leaks_monthly` leak 2 tests `charge_type = 'pick'`, leak 3 tests `= 'shipping'`, `labour_variance_inputs` tests `= 'pick'`. `ledger_05`'s trailing query tests `rate_type is distinct from 'at_cost'`.

The `charge_type` domain is defined in TypeScript (`src/lib/ledger/charge-key.ts:13-15`: `'shipping' | 'pick' | 'pack' | 'material' | 'storage' | 'receiving' | 'surcharge' | 'return'`) and nowhere in the database. `ledger_02_cost.sql:40-49` makes the case for pulling exactly this kind of union type into a CHECK — *"This catches it at write time"* — for `basis`, and then does not do it for the four columns that the views actually filter on.

Risk here is lower than C1 because these columns *do* have a typed write path. But a charge written by any other route (a manual fix, a future script, a `psql` correction) with `charge_type = 'Pick'` silently leaves both the leak-2 test and the labour variance.

**Fix.** Add CHECKs for `order_charges.charge_type` and `client_warehouse_rates.rate_type` at least. If a value domain is genuinely open (`cost_type`), say so in a comment so the omission reads as a decision.

### I11. The anon-privilege guard checks `anon` but not `authenticated`
`ledger_04_views.sql:729`.

`revoke all ... from anon, authenticated` (`:700-704`) covers both roles; the verification at `:729` covers only `anon`. `supabase/partner_login.sql` and `partner_portal.sql` exist, so `authenticated` is a real, populated role on this database — a signed-in partner. If a grant elsewhere (or an `alter default privileges` targeting `authenticated`) reopened these views, the guard would report "Verified: anon cannot SELECT from any of the five views" while every partner could read every *other* client's margin.

**Fix.** Iterate both roles:
```sql
from unnest(array['public.pick_days', ...]) as v(name),
     unnest(array['anon','authenticated'])   as r(role)
where has_table_privilege(r.role, v.name, 'SELECT')
```
and include the role in the message. (This applies to the C3 fix too.)

### I12. `verify/ledger_03_verify.sql:227-236` misattributes a `service_type` failure to `rate`
The block inserts into `client_warehouse_rates` omitting `service_type`, and its only handler is `when not_null_violation then raise exception 'FAIL: rate is still NOT NULL; at-cost lines cannot be stored'`.

`ledger_03_charges.sql:232-237` drops NOT NULL from `service_type` for exactly this reason, and per I8 that alter can fail while reporting success. If it did, this block fires a `not_null_violation` on `service_type` and tells the operator to go and look at `rate`. They will find `rate` already nullable and conclude the verify script is broken.

**Fix.** Include `sqlerrm` in the message, or split into two blocks — one omitting `service_type` with `rate` supplied, one supplying `service_type` with `rate` null.

### I13. `order_charges_unattributed_key` is never tested
`ledger_03_charges.sql:180-182`; absent from `verify/ledger_03_verify.sql`.

The index exists on an explicitly stated principle — *"'unreachable' is a claim about code not yet written, and the cost of being wrong is asymmetric: an absent constraint here means the thrice-daily cron inserts a fresh copy of the same charge every run, and the ledger triples while still looking plausible."* The other two indexes on the table get two blocks each (an existence/predicate check and a behavioural check). This one gets none.

**Fix.** A four-line block in the shape of `:106-121`: insert `(order_id null, client_id null, charge_key 'VERIFY-UNATTRIB')` twice, assert the second raises `unique_violation`.

---

## Issues — Minor

**M1.** `ledger_04_views.sql:29-33` — *"Nothing in supabase/ or src/ selects from these five today (verified: …)"* is now false. `src/lib/ledger/summary.ts:461-522` selects from all five via `supabaseAdmin`. The *conclusion* (no database object depends on them, so a plain `drop` without `cascade` is correct) still holds, but the stated evidence is stale and a future reader will trust it. Update the comment to say "no database object depends on them; `summary.ts` reads them over PostgREST, which is not a dependency `drop` can see."

**M2.** `verify/ledger_01_verify.sql:96` and `verify/ledger_03_verify.sql:94` use `if n <> 1`. Safe today — `n` comes from `select count(*) into n`, which cannot be NULL — but inconsistent with the `is distinct from` form used everywhere else in the branch, and the safety depends on a reader knowing why. Change both for uniformity; the rule should not have exceptions a reader has to verify.

**M3.** `ledger_04_views.sql:209` — `c.charge_key = 'shipment:' || s.shipstation_shipment_id::text`. When `shipstation_shipment_id` is NULL the concatenation yields NULL, the equality is never true, `not exists` is always true, and **every** such shipment carrying a cost is reported as `unpriced_shipments` forever. This is correct *today* only because `calculate-charges.ts:213` (`if (!Number.isFinite(s.shipmentId)) continue`) also skips them, so they genuinely are unbilled — but the view's correctness is resting on a coincidence between a SQL string-concat NULL and a TypeScript guard. Make it explicit: add `and s.shipstation_shipment_id is not null` to the `not exists` subquery and a separate branch, or at minimum comment the coupling. **TypeScript contract I am assuming:** `src/lib/ledger/calculate-charges.ts:213` continues to skip shipments with a non-finite `shipmentId`, and `src/lib/ledger/charge-key.ts:50-53` continues to emit `shipment:<shipstation_shipment_id>` for `chargeType: 'shipping'`. Please confirm.

**M4.** `ledger_04_views.sql:236-238, 251-253` — leaks 5 and 6 ignore `rate_adjustments.status` and `billed_to_client`. A carrier re-bill that has already been passed on to the client (`billed_to_client = true`) is still reported as leaked money. Over-reporting is the safe direction, but it makes the leak non-actionable over time. Consider `and not coalesce(a.billed_to_client, false)` for leak 5, or add the billed count as a separate column.

**M5.** `ledger_04_views.sql:237, 252` — `adjustment_amount > 0` and `< 0` both exclude NULL. An adjustment row with an unknown amount appears in neither branch and in no count. Small, but it is an unknown rendered as absent. Consider a seventh branch, or a `count(*) filter (where adjustment_amount is null)` column.

**M6.** `ledger_04_views.sql:231, 246` — `rate_adjustments.adjustment_date` is nullable, so leaks 5 and 6 can also produce a `period_month is null` bucket. Only leak 3's null bucket is documented (`:191-199`) and only leak 3's is mentioned in `summary.ts:174`. `summary.ts:469-479` does query the undated bucket generically, so nothing is lost — but the comment at `:191` implies leak 3 is the only branch that can do this, which is not true.

**M7.** `ledger_07_storage.sql:26` — `basis text not null default 'estimated'` with no CHECK, while `cost_rates.basis` has one (`ledger_02_cost.sql:55`). The direction is safe here (`storage-charges.ts` forces `is_estimate = true` for anything that is not exactly `'measured'`), so a typo degrades to "estimated". Worth a CHECK anyway for symmetry, and to stop `'Measured'` from being typed and *not* taking effect while the operator believes it has.

**M8.** `verify/ledger_01_verify.sql:42, 86` and `verify/ledger_03_verify.sql:9, 27, 79, 109, 162, 195, 230, 244, 266` — `select id into cid from clients limit 1` with no guard. On an empty `clients` table `cid` is NULL and the blocks behave differently: `verify/ledger_03_verify.sql:106-121` would still print PASS, but via `order_charges_unattributed_key` rather than `order_charges_client_key` — a pass for the wrong reason. `ledger_07_storage.sql:99-102` handles the empty case explicitly (`raise notice 'SKIP'`) and `verify/ledger_04_verify.sql:31` sidesteps it with a dedicated fixture client. Adopt one of those two patterns in the other two verify files.

**M9.** `ledger_04_views.sql:671` (`left join pg_class c on c.relname = v.name`), `verify/ledger_01_verify.sql:65`, `verify/ledger_03_verify.sql:58, 139` — no `relkind` filter and, in the verify files, no namespace filter. A same-named relation in another schema would be picked up; `select into` without `strict` takes the first row silently. Low probability, trivial to close: add `and c.relkind = 'v'` / `and c.relkind = 'i'` and a namespace predicate.

**M10.** `order_charges.cost numeric(10,2)` (`ledger_03_charges.sql:72`) against `cost_rates.rate numeric(10,4)` (`ledger_02_cost.sql:16`). Per-charge cost is rounded to cents on store, losing up to $0.005 per charge. Postgres `numeric` rounds half-away-from-zero, so the error is unbiased and does not systematically flatter; at three crons a day over a year this is a few dollars business-wide. This is normal accounting practice and I would not change it — but it means the ledger's cent-level total will not reconcile exactly against `sum(quantity * rate)` computed at four decimals, and somebody will eventually chase that difference. Worth one sentence in the spec.

**M11.** `ledger_04_views.sql:567` — `order by m.period_month desc` inside a view definition. Postgres permits it, but the ordering is not guaranteed to survive a wrapping query, and `summary.ts` issues its own `order`. Harmless; noted only because it can read as a guarantee it is not.

**M12.** `ledger_04_views.sql:700-704` revokes from `anon, authenticated` but not from `PUBLIC`. Supabase's bootstrap grants to the three named roles rather than `PUBLIC`, so this is currently sufficient, and the `has_table_privilege` guard would catch a `PUBLIC` grant if one appeared (that function accounts for `PUBLIC`). Adding `revoke all on ... from public;` costs nothing and closes the case by construction.

**M13.** `ledger_03_charges.sql:243-244` — `alter table zone_chart add column if not exists carrier text; update zone_chart set carrier = 'UPS' where carrier is null;` The `update` is unconditional on re-run and will also stamp `'UPS'` onto any genuinely-unknown-carrier row a future writer inserts with `carrier` left null. Today that is correct (the chart holds only UPS). Once a USPS chart sits beside it — which is the stated reason for the column — a USPS row inserted without `carrier` gets silently labelled UPS on the next paste of this file. Consider `add column carrier text not null default 'UPS'` on the existing rows and then dropping the default, so the backfill happens once.

---

## Declined to judge

- All TypeScript. Two other reviewers have it. Where the SQL depends on a TS contract I have named the file and the assumption inline (C2, M3, and the `chargeKey` format under Strength 15).
- The pre-existing absence of RLS on `orders`, `order_items`, `order_charges`, `cost_rates`, `operating_costs`. Filed separately per the brief. I did reason about it: it is precisely why the `revoke` in `ledger_04` — not `security_invoker` — is the load-bearing half, which is what makes C3 a security finding rather than a hygiene one.
- `supabase/schema.sql`'s own design (`numeric(10,2)` throughout, `profit_loss` as a stored derived column, no FKs on `bills`). Pre-existing, out of this branch's diff.
- `supabase/campaigns_pnl.sql`, `APPLY_NOW.sql`, `serialization_scans.sql`, `partner_*.sql`, `referral_*.sql`, `zone_rates.sql`. Not on this branch's file list.
- Whether the Supabase SQL editor actually surfaces `raise notice` output. I cannot verify it from here and it varies by version. My C3 argument does not depend on the answer — a NOTICE is not a failure regardless of whether it is displayed — but if notices *are* reliably shown, C3's severity drops from "silent" to "easily missed".
- Whether `shipments` currently holds duplicate rows that would make `shipments_shipstation_id_key` (`ledger_03_charges.sql:24-26`) fail to create. Requires execution: `select shipstation_shipment_id, count(*) from shipments where shipstation_shipment_id is not null group by 1 having count(*) > 1;`
- Whether `orders.cancelled` currently holds NULLs, which sizes C2. Requires execution: `select count(*) from orders where cancelled is null;`
- Whether `cost_rates` currently holds hand-edited rates diverging from `ledger_06` (sizes I9). Requires execution: the `select` at `ledger_06_seed_cost_rates.sql:95`.
- The correctness of the Nayax rate values themselves (0.32, 0.20, 8%, etc.) against the quote. The quote text is not in the repository; `ledger_05_seed_nayax.sql:33-35` says so.
- The spec's decision not to allocate overhead per client (`pnl_client_monthly` is gross margin only). A deliberate, documented product ruling (`design.md:1160`), not a defect.
- The `effective_from = effective_to` off-switch idiom. Established as deliberate in the brief; I judged only the *re-run* consequence of changing those dates, which is C4.
- Index selection and query-plan performance across the five views. No production row counts available, and none of the views is on a request-blocking path (`summary.ts` reads them with explicit limits).
- `sync_runs` (`ledger_01_orders.sql:86-104`). Declared but nothing in this slice reads it; whether it is populated correctly is a TypeScript question.

---

## Recommendations

1. **Constrain the four value domains the views filter on, in the shape `cost_rates_basis_valid` already establishes.** `operating_costs.allocation` (C1) is the one that costs money today. `order_charges.charge_type` and `client_warehouse_rates.rate_type` (I10) are cheap to add alongside it. The branch has already worked out the right idiom — a guarded `do` block that names the offending rows on failure — so this is mechanical.

2. **Promote the three security guards from `raise notice` to `raise exception` (C3), and give `ledger_04_verify.sql` a security block.** The paste-as-one-transaction contract means an exception fails *closed*: no view rather than an exposed view. Nothing else in the branch has that property available for free and unclaimed.

3. **Add a positive, numeric assertion for `net_profit` (I1).** Two NULL assertions do not pin an arithmetic expression. One phase-3 block with a hand-computed negative expected value pins all five signs simultaneously.

4. **Give `labour_variance_inputs` the same treatment the other four views got (I2).** The sentinel-month + throwaway-client pattern in `ledger_04_verify.sql` already works; this view just needs its own month and a seeded rate card.

5. **Make the NULL-handling of `orders.cancelled` structurally impossible to get wrong (C2)** — backfill, then `set not null` — rather than fixing the two predicates and leaving the next view author to rediscover it.

6. **Apply the cost side's overlap protection to the revenue side (C4).** `cost_rates` has a unique index *and* a GiST exclusion constraint on the argument that overlapping rates make calculation non-deterministic. `client_warehouse_rates` — which determines what the client is invoiced — has neither.

7. **Re-baseline the verify scripts against the real apply order.** I3 shows `ledger_02_verify.sql` is unrunnable after `ledger_06`. Every verify script should use probe values in namespaces no seed occupies, and the apply-order header in `ledger_01_orders.sql:3-4` should be extended to cover 05, 06, 07 and the verify files, stating when each is run.

8. **Add an `unallocated` / `unallocated_rows` pair to `pnl_monthly`'s overhead CTE.** Even with C1's CHECK in place, a database that already holds a bad row cannot receive the constraint, and the ledger should be able to say "there is $X in operating_costs this month that I did not put anywhere" rather than silently dropping it. This is the same reasoning that produced `cost_unknown_charges`, applied to the overhead side.

9. **Write down the "what must be added when a view is added" checklist inside `ledger_04_views.sql`.** The five registration points are currently described across three separate comment blocks (`:26-27`, `:649-661`, `:617-621`). All five views are registered correctly today. A single numbered list at the top of the file would make the next addition mechanical rather than archaeological.

---

## Assessment

**Ready to merge? — With fixes.**

The design judgment in this slice is unusually good: the null-versus-zero rule is implemented rather than merely asserted, the verify scripts observe the `is distinct from` discipline without exception, month bucketing is correct everywhere, and no view double-counts money through a join. But four things must land before a human reprices off this output — an unconstrained `allocation` column that silently deletes real costs from net profit in the flattering direction (C1), a NULL-blind `cancelled` predicate that blinds a leak detector and contradicts the loader (C2), security guards that warn instead of failing on a public-data exposure (C3), and a rate-card seed whose own documented activation procedure arms a duplicate-row bug (C4). The Important tier is dominated by coverage gaps rather than defects — but two of them, the untested arithmetic of `net_profit` (I1) and the entirely untested `labour_variance_inputs` (I2), sit under the two numbers this system exists to produce.
