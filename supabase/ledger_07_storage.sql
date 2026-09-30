-- What each client occupied, per month. Declared, not measured: no system we
-- integrate with reports pallet positions. `source` records who said so, and
-- `basis` is always 'estimated' until it comes off a warehouse count sheet.
-- Spec: docs/superpowers/specs/2026-09-29-complete-the-ledger-design.md §6

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
-- charge_key 'storage:2026-09-17' and bill the client twice for September.
alter table client_storage_months
  drop constraint if exists client_storage_months_is_month_start;
alter table client_storage_months
  add constraint client_storage_months_is_month_start
  check (period_month = date_trunc('month', period_month)::date);

-- A position count cannot be negative. Without this a typo becomes a credit.
alter table client_storage_months
  drop constraint if exists client_storage_months_non_negative;
alter table client_storage_months
  add constraint client_storage_months_non_negative
  check (coalesce(pallet_positions, 0) >= 0 and coalesce(shelf_positions, 0) >= 0);

-- Only supabaseAdmin reads or writes this table. Without RLS the anon role
-- could INSERT storage declarations and fabricate billing.
alter table client_storage_months enable row level security;

-- Verify the constraints reject both mistakes. This should raise twice and
-- insert nothing. NOT RUN by Task 18 — requires a live database.
--
-- do $$
-- declare cid uuid;
-- begin
--   select id into cid from clients limit 1;
--   if cid is null then
--     raise exception 'no client rows to test against';
--   end if;
--
--   begin
--     insert into client_storage_months (client_id, period_month, pallet_positions)
--       values (cid, '2026-09-17', 4);
--     raise exception 'FAIL: a mid-month period_month was accepted';
--   exception when check_violation then
--     raise notice 'PASS: period_month must be a month start';
--   end;
--
--   begin
--     insert into client_storage_months (client_id, period_month, pallet_positions)
--       values (cid, '2026-09-01', -2);
--     raise exception 'FAIL: a negative pallet count was accepted';
--   exception when check_violation then
--     raise notice 'PASS: negative positions are rejected';
--   end;
-- end $$;
