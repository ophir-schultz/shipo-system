-- First cost rates. Every one of these is ESTIMATED and marked as such.
-- Spec: docs/superpowers/specs/2026-09-29-complete-the-ledger-design.md §5.4
--
-- Requires: supabase/ledger_02_cost.sql applied first. It creates cost_rates,
--   the unique index on (cost_type, coalesce(variant,''), effective_from), the
--   btree_gist extension and the cost_rates_no_overlap exclusion constraint —
--   all three of which this file's `on conflict do nothing` relies on.
--   Independent of ledger_03 and of ledger_05; apply in any order relative to
--   them.
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
--
-- Safe to run more than once.
-- The unique index on (cost_type, coalesce(variant,''), effective_from) and the
-- exclusion constraint both key on coalesce(variant,''), so the two null-variant
-- rows are deduplicated correctly. on conflict do nothing covers both constraints
-- without an explicit target — an explicit conflict target cannot arbitrate an
-- exclusion constraint.
--
-- But note what `do nothing` means: a row that ALREADY EXISTS WINS, including
-- one whose rate was edited by hand. Re-running this file does not reassert the
-- values below, so git and the database can diverge permanently and silently —
-- and not only in the safe direction, since a hand-edited rate that is too low
-- survives and flatters margin. Compare the trailing select against the values
-- above rather than assuming a re-run restored them.
--
-- `unit` is descriptive only. Nothing reads cost_rates.unit: the loader selects
-- it and the CostRateRow type carries it, but costOf(lookup, quantity) is
-- lookup.rate * quantity unconditionally (cost-rate.ts:71). See the pack row
-- for the trap this lays.

insert into cost_rates (cost_type, variant, unit, rate, effective_from, basis, note)
values
  ('pick', 'device',    'per_unit', 0.2300, '2026-01-01', 'estimated',
   'Placeholder pending direct_labor payroll. Re-baseline over a FULL month '
   || 'of picks: a partial month divides real payroll by incomplete volume and '
   || 'produces a standard that is permanently too high.'),
  ('pick', 'component', 'per_unit', 0.2000, '2026-01-01', 'estimated',
   'Placeholder pending direct_labor payroll. One blended rate across all '
   || 'clients: per-client rates need time-study data that does not exist.'),
  -- variant NULL: unreachable today and deliberately so. findCostRate matches
  -- variant exactly (cost-rate.ts:42) and calculate-charges.ts:156-157 looks
  -- pack cost up as 'device' or 'component', so this row never matches and a
  -- pack charge would carry cost = null — unknown, not zero, which is the right
  -- failure. Nayax raises no pack charge at all (spec §5.7). WHEN A CLIENT WITH
  -- A PER-UNIT PACK LINE IS SEEDED, this row must be split into ('pack','device')
  -- and ('pack','component') or every pack charge is permanently un-costed —
  -- and whoever adds that rate-card line has no reason to look in this file.
  -- When that split happens, fix 'per_order' too: costOf multiplies rate by
  -- quantity regardless of unit, and calculate-charges.ts:159 passes
  -- quantityPicked, so a 10-unit order would book 10 × $0.15 of pack cost.
  ('pack', null,        'per_order', 0.1500, '2026-01-01', 'estimated',
   'Placeholder pending direct_labor payroll.'),
  -- material: no findCostRate caller exists at all (the only two callers are
  -- calculate-charges.ts:123 and :156), so neither of these rows is reachable.
  -- 'box_small' / 'box_medium' are a guessed variant vocabulary that nothing
  -- consumes; whoever wires materials up chooses the real one and is not bound
  -- by these strings.
  ('material', 'box_small',  'per_order', 0.4500, '2026-01-01', 'estimated',
   'Placeholder pending packaging purchase records. These become the only '
   || 'cost rates that are measured rather than derived.'),
  ('material', 'box_medium', 'per_order', 0.7500, '2026-01-01', 'estimated',
   'Placeholder pending packaging purchase records.'),
  -- storage: also unreachable today — nothing calls findCostRate with
  -- costType 'storage'. FOR TASK 18: this row's variant is NULL, while the
  -- storage RATE CARD rows in ledger_05 use variants 'pallet' and 'shelf'.
  -- Task 18 must look storage cost up with variant: null or it silently finds
  -- nothing and every storage charge lands un-costed. And the quantity it
  -- passes is multiplied by 12.0000 regardless of 'per_pallet_month', so that
  -- quantity has to be pallet-months, not pallets.
  ('storage', null, 'per_pallet_month', 12.0000, '2026-01-01', 'estimated',
   'Placeholder pending rent and utilities allocated direct_storage.')
on conflict do nothing;

-- Must return NO ROWS. The cost_rates_basis_valid CHECK constraint in
-- ledger_02_cost.sql now rejects a misspelt basis at write time, so 'Estimated'
-- or 'estimted' can no longer reach the table at all. This select still earns
-- its place: the constraint permits 'measured' and 'derived' too, and either of
-- those on a row below — placeholders every one — would set is_estimate = false
-- (calculate-charges.ts:144) and present a placeholder as a measured cost. That
-- is exactly what this file's header forbids.
select cost_type, variant, basis from cost_rates
where effective_from = '2026-01-01' and basis is distinct from 'estimated';

-- Eyeball the six against the values above: `on conflict do nothing` means an
-- existing row won, so anything that differs here was NOT written by this file.
select cost_type, variant, rate, basis from cost_rates order by cost_type, variant;
