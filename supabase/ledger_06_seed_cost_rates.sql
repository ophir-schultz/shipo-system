-- First cost rates. Every one of these is ESTIMATED and marked as such.
-- Spec: docs/superpowers/specs/2026-09-29-complete-the-ledger-design.md §5.4
--
-- Requires: supabase/ledger_03_charges.sql applied first.
--   ledger_02_cost.sql creates the cost_rates table; ledger_03 does not touch
--   it, but these seeds require the same migration run as ledger_05, and
--   stating the dependency explicitly here prevents applying them out of order.
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
