-- Verifies ledger_02_cost.sql. Run AFTER applying it. Rolls itself back.
--
-- EVERY fixture below uses a synthetic cost_type ('overlap_probe' or
-- 'basis_probe') that no real rate card and no seed file uses. That is not
-- tidiness; the file could not run otherwise.
--
-- The original fixtures keyed on the REAL ('pick','device') and
-- ('storage',null) tuples, mirroring the shape of a production rate. Then
-- ledger_06_seed_cost_rates.sql seeded both of those tuples open-ended from
-- 2026-01-01, and every fixture here starts inside that window. The first
-- insert is a bare statement with no exception handler, so from the moment
-- ledger_06 applied, this entire file aborted on its FIRST LINE with an
-- exclusion_violation and asserted nothing at all — while still looking like a
-- complete, carefully-reasoned verification script.
--
-- Note which direction that fails in. It is loud, so it was survivable. The
-- dangerous variant is the mirror image: a fixture that collides inside a
-- block whose handler catches exclusion_violation would report PASS without
-- its own insert ever having been exercised. The null-variant block below is
-- exactly that shape. A verify script must therefore never share a key with
-- seeded data, because its fixtures and the data it verifies live in one table.
begin;

-- Adjacent ranges must be allowed: '[)' means effective_to is exclusive, so a
-- rate ending 2026-02-01 and one starting 2026-02-01 do not overlap.
insert into cost_rates (cost_type, variant, unit, rate, effective_from, effective_to, basis)
  values ('overlap_probe', 'device', 'per_unit', 0.2300, '2026-01-01', '2026-02-01', 'estimated');
insert into cost_rates (cost_type, variant, unit, rate, effective_from, effective_to, basis)
  values ('overlap_probe', 'device', 'per_unit', 0.2500, '2026-02-01', null, 'estimated');
do $$ begin raise notice 'PASS: adjacent effective ranges are accepted'; end $$;

-- Overlapping ranges must not be. effective_from here (2026-01-15) differs
-- from both rows above, so the unique index on
-- (cost_type, coalesce(variant,''), effective_from) cannot fire and the
-- exclusion constraint is genuinely what rejects this row. Were the dates
-- equal, a unique_violation would escape the handler below and the overlap
-- constraint would go untested.
do $$
begin
  begin
    insert into cost_rates (cost_type, variant, unit, rate, effective_from, effective_to, basis)
      values ('overlap_probe', 'device', 'per_unit', 0.2900, '2026-01-15', '2026-03-01', 'estimated');
    raise exception 'FAIL: overlapping cost rates were accepted';
  exception when exclusion_violation then
    raise notice 'PASS: overlapping cost rates are rejected';
  end;
end $$;

-- A different variant is a different thing and may overlap freely.
insert into cost_rates (cost_type, variant, unit, rate, effective_from, effective_to, basis)
  values ('overlap_probe', 'component', 'per_unit', 0.2000, '2026-01-15', '2026-03-01', 'estimated');
do $$ begin raise notice 'PASS: a different variant may overlap'; end $$;

-- A null variant must behave as one value, not as "matches nothing".
-- ('overlap_probe', null) is its own exclusion group under
-- coalesce(variant,''), distinct from the 'device' and 'component' rows above,
-- so the rejection below can only come from these two rows and not from them.
insert into cost_rates (cost_type, variant, unit, rate, effective_from, basis)
  values ('overlap_probe', null, 'per_pallet_month', 12.0000, '2026-01-01', 'estimated');
do $$
begin
  begin
    insert into cost_rates (cost_type, variant, unit, rate, effective_from, basis)
      values ('overlap_probe', null, 'per_pallet_month', 14.0000, '2026-02-01', 'estimated');
    raise exception 'FAIL: two open-ended null-variant rates overlap and were accepted';
  exception when exclusion_violation then
    raise notice 'PASS: null variant is treated as a single value';
  end;
end $$;

-- cost_rates_basis_valid. A distinct cost_type throughout, so these rows cannot
-- collide with the overlap fixtures above and report an exclusion_violation as
-- though it were a basis failure.
--
-- All three permitted values must be accepted. A constraint written against only
-- 'estimated' would pass the rejection test below while blocking every real rate
-- the day a measured figure finally arrives.
insert into cost_rates (cost_type, variant, unit, rate, effective_from, basis)
  values ('basis_probe', 'measured_v',  'per_unit', 1.0000, '2026-01-01', 'measured'),
         ('basis_probe', 'derived_v',   'per_unit', 1.0000, '2026-01-01', 'derived'),
         ('basis_probe', 'estimated_v', 'per_unit', 1.0000, '2026-01-01', 'estimated');
do $$ begin raise notice 'PASS: measured, derived and estimated are all accepted'; end $$;

-- The case the constraint exists for: a misspelt basis. calculate-charges.ts:144
-- compares by exact string equality, so 'Estimated' would read as NOT estimated
-- and set is_estimate = false on every charge derived from the rate.
do $$
begin
  begin
    insert into cost_rates (cost_type, variant, unit, rate, effective_from, basis)
      values ('basis_probe', 'typo_v', 'per_unit', 1.0000, '2026-01-01', 'Estimated');
    raise exception 'FAIL: basis ''Estimated'' was accepted';
  exception when check_violation then
    raise notice 'PASS: a misspelt basis is rejected';
  end;
end $$;

-- operating_costs_allocation_valid (ledger_02_cost.sql:120-121). A synthetic
-- category namespace and a 2099 period_month, for the reason this file's header
-- gives. operating_costs holds real monthly bills and they are PERMANENT -- the
-- September rows in operating_costs_2026_09_opex.sql and _labor.sql are not
-- rolled back by anything -- so a fixture keyed on a plausible
-- (period_month, category) would eventually collide with one, and the unique
-- index on (period_month, category, coalesce(vendor,'')) would then raise
-- unique_violation where a reader expects a verdict about `allocation`.
--
-- All three permitted values must be accepted, not merely the typo rejected. A
-- constraint narrowed to 'overhead' alone would still pass the rejection tests
-- below while making every direct_labor and direct_storage row unenterable --
-- and those are the two allocations pnl_monthly pushes down rather than
-- subtracting at the top (ledger_04_views.sql:349-351).
insert into operating_costs (period_month, category, amount, allocation)
  values ('2099-01-01', 'alloc_probe_overhead',       100.00, 'overhead'),
         ('2099-01-01', 'alloc_probe_direct_labor',   100.00, 'direct_labor'),
         ('2099-01-01', 'alloc_probe_direct_storage', 100.00, 'direct_storage');
do $$ begin raise notice 'PASS: overhead, direct_labor and direct_storage are all accepted'; end $$;

-- The column default must itself satisfy the CHECK. `allocation text not null
-- default 'overhead'` (ledger_02_cost.sql:94) and the constraint are two
-- separate declarations that can be edited apart. If they ever disagree, every
-- insert that OMITS allocation fails on a value the operator never typed, and
-- omitting it is the normal way to enter an overhead bill.
insert into operating_costs (period_month, category, amount)
  values ('2099-01-01', 'alloc_probe_default', 100.00);
do $$ begin raise notice 'PASS: the allocation default is a permitted value'; end $$;

-- The case the constraint exists for. ledger_04_views.sql:349-351 reads
-- allocation by exact string equality inside a FILTER, so a misspelt value
-- matches no filter at all: the cost is not mis-bucketed, it disappears from
-- net_profit and the month reads MORE profitable than it was. Both typo shapes
-- named at ledger_02_cost.sql:110 are checked -- wrong case, then wrong
-- separator, which is the likelier slip on 'direct_labor'.
--
-- Each uses its own category, so only the CHECK can reject the row. Sharing a
-- key with a fixture above would raise unique_violation, which these handlers
-- deliberately do not catch -- it would abort the file rather than print a PASS
-- that was never earned.
do $$
begin
  begin
    insert into operating_costs (period_month, category, amount, allocation)
      values ('2099-01-01', 'alloc_probe_typo_case', 100.00, 'Overhead');
    raise exception 'FAIL: allocation ''Overhead'' was accepted';
  exception when check_violation then
    raise notice 'PASS: a miscapitalised allocation is rejected';
  end;
end $$;

do $$
begin
  begin
    insert into operating_costs (period_month, category, amount, allocation)
      values ('2099-01-01', 'alloc_probe_typo_sep', 100.00, 'direct-labor');
    raise exception 'FAIL: allocation ''direct-labor'' was accepted';
  exception when check_violation then
    raise notice 'PASS: a hyphenated allocation is rejected';
  end;
end $$;

rollback;
