-- Complete the ledger, migration 7: monthly storage occupancy.
-- Spec: docs/superpowers/specs/2026-09-29-complete-the-ledger-design.md §6
-- Requires: supabase/schema.sql (clients, uuid_generate_v4).
-- Safe to run more than once.
--
-- What each client occupied, per month. Declared, not measured: no system we
-- integrate with reports pallet positions. `note` records who said so and how,
-- and `basis` is always 'estimated' until it comes off a warehouse count sheet.
-- src/lib/ledger/storage-charges.ts reads `basis` and forces is_estimate = true
-- on every charge built from a row whose basis is not exactly 'measured', so a
-- guess never reaches an invoice wearing the confidence of a measurement.
--
-- TO STOP BILLING A CLIENT-MONTH, SET THE COUNTS TO 0 -- DO NOT DELETE THE ROW.
-- persist-storage-charges.ts sweeps away storage charges for any client-month
-- it reads and finds no longer priced, but it only sweeps the client-months it
-- reads. Deleting the declaration row removes the month from that read, so the
-- charges it already wrote survive with nothing left to contradict them, and
-- the client keeps being billed for space they no longer occupy.

create table if not exists client_storage_months (
  id               uuid primary key default uuid_generate_v4(),
  client_id        uuid not null references clients(id),
  period_month     date not null,
  pallet_positions numeric(10,2),
  shelf_positions  numeric(10,2),
  basis            text not null default 'estimated',
  note             text,
  created_at       timestamptz default now(),
  unique (client_id, period_month)
);

-- period_month must be the first of a month. A row dated the 17th would make
-- charge_key 'storage:2026-09-17:pallet' and bill the client twice for
-- September.
--
-- The test is `extract(day from period_month) = 1`, NOT
-- `period_month = date_trunc('month', period_month)::date`. There is no
-- date_trunc(text, date) overload: that call would resolve date_trunc(text,
-- timestamptz), which is STABLE rather than IMMUTABLE because it depends on the
-- session TimeZone setting. A CHECK is supposed to mean the same thing for
-- every connection; that one means whatever the writer's TimeZone says it
-- means, so the same date can pass for one session and fail for another.
-- extract(day from date) is IMMUTABLE and needs no timezone at all.
--
-- The drop and the add are one atomic step inside a PL/pgSQL block. A bare
-- `drop constraint` followed by `add constraint` would break this file's own
-- "safe to run more than once" claim: between the two statements the table is
-- unconstrained, and if the add then fails -- it fails if a bad row is already
-- stored -- that window never closes. A block WITH an exception handler runs
-- its body in a subtransaction, so a failed add rolls the drop back with it.
-- Same pattern as ledger_03_charges.sql:123-153.
do $$
begin
  alter table client_storage_months
    drop constraint if exists client_storage_months_is_month_start;
  alter table client_storage_months
    add constraint client_storage_months_is_month_start
    check (extract(day from period_month) = 1);
exception when check_violation then
  raise exception 'client_storage_months already holds a row whose period_month is not '
                  'the first of a month, so the constraint cannot be added (%). The '
                  'previous constraint has been restored, so nothing is left '
                  'unconstrained. Fix the row and re-run this file.', sqlerrm;
end $$;

-- A position count cannot be negative. Without this a typo becomes a credit.
-- Wrapped for the same reason as the block above.
do $$
begin
  alter table client_storage_months
    drop constraint if exists client_storage_months_non_negative;
  alter table client_storage_months
    add constraint client_storage_months_non_negative
    check (coalesce(pallet_positions, 0) >= 0 and coalesce(shelf_positions, 0) >= 0);
exception when check_violation then
  raise exception 'client_storage_months already holds a negative position count, so the '
                  'constraint cannot be added (%). The previous constraint has been '
                  'restored, so nothing is left unconstrained. Fix the row and re-run '
                  'this file.', sqlerrm;
end $$;

-- Only supabaseAdmin reads or writes this table. Without RLS the anon role
-- could INSERT storage declarations and fabricate billing.
alter table client_storage_months enable row level security;

-- Verify the constraints reject both mistakes. Both inserts must fail; this
-- block inserts nothing and raises nothing when the table is correct.
--
-- Both probes use period_month in year 2999, not a month anyone bills. A probe
-- dated '2026-09-01' can collide with a REAL declaration on
-- unique (client_id, period_month), and `exception when check_violation` does
-- not catch unique_violation -- so a correctly-constrained table would abort
-- this migration with a spurious duplicate-key error. Year 2999 cannot collide
-- with a row anyone would legitimately store.
do $$
declare cid uuid;
begin
  select id into cid from clients limit 1;
  if cid is null then
    raise notice 'SKIP: no client rows to test the constraints against';
    return;
  end if;

  begin
    insert into client_storage_months (client_id, period_month, pallet_positions)
      values (cid, '2999-01-17', 4);
    raise exception 'FAIL: a mid-month period_month was accepted';
  exception when check_violation then
    raise notice 'PASS: period_month must be a month start';
  end;

  begin
    insert into client_storage_months (client_id, period_month, pallet_positions)
      values (cid, '2999-01-01', -2);
    raise exception 'FAIL: a negative pallet count was accepted';
  exception when check_violation then
    raise notice 'PASS: negative positions are rejected';
  end;
end $$;
