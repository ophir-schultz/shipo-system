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

rollback;
