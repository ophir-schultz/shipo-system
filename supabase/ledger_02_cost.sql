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

-- calculate-charges.ts:144 and :177 test `lookup.basis === 'estimated'` by exact
-- string equality to decide is_estimate. Without this constraint one mistyped
-- character in a hand-pasted seed file — 'Estimated', 'estimted' — sets
-- is_estimate = false on every charge derived from that rate, and a placeholder
-- is presented on screen as a measured cost. The three values below are the same
-- set the loader's CostRateRow type declares (cost-rate.ts:27), so a value that
-- passes here is a value the calculator can actually interpret.
--
-- ledger_06_seed_cost_rates.sql has a trailing select that catches this, but it
-- only catches it if the operator reads it. This catches it at write time.
do $$
declare
  offending text;
begin
  alter table cost_rates add constraint cost_rates_basis_valid
    check (basis in ('measured','derived','estimated'));
  raise notice 'cost_rates_basis_valid added';
exception
  when duplicate_object then
    raise notice 'cost_rates_basis_valid already present';
  when check_violation then
    -- The failed ALTER is rolled back to this block's savepoint, so the table is
    -- readable here. Name the bad values: "some row" alone does not tell the
    -- operator which paste to go and fix.
    select string_agg(quoted, ', ')
      into offending
      from (select distinct quote_literal(basis) as quoted
              from cost_rates
             where basis not in ('measured','derived','estimated')) bad;
    raise exception
      'cost_rates_basis_valid NOT added: cost_rates already holds invalid basis value(s): %', offending
      using hint = 'Every charge derived from those rows has the wrong is_estimate. '
        || 'Correct them, then re-run this file. Locate them with: '
        || 'select id, cost_type, variant, effective_from, basis from cost_rates '
        || 'where basis not in (''measured'',''derived'',''estimated'');';
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
