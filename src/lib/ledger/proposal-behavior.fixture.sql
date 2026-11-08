-- Disposable local proof of the repair guards. Not a live repair.
-- No network. The database is created empty for this file.

create table if not exists public.sync_runs (
  source text,
  status text,
  mode text,
  client_id uuid,
  finished_at timestamptz
);
create table if not exists public.order_charges (
  id uuid primary key,
  order_id uuid,
  client_id uuid,
  charge_key text,
  charge_type text,
  charge_date date,
  charge_date_source text,
  amount numeric,
  unit_rate numeric,
  cost numeric,
  cost_basis text,
  rate_id uuid,
  source text
);
create table if not exists proof (
  step text primary key,
  ok boolean not null,
  detail text
);
truncate proof;
truncate public.order_charges;
truncate public.sync_runs;

insert into public.sync_runs (source, status, mode, client_id, finished_at)
values ('charges', 'ok', 'preserve_stored', null, '2026-11-08 12:00:00+00');

insert into public.order_charges (
  id, order_id, charge_date, amount, charge_date_source, source, charge_key
) values (
  '11111111-1111-1111-1111-111111111111',
  '22222222-2222-2222-2222-222222222222',
  date '2026-10-05', 10.00, 'ship_date', 'calculator', 'shipment:1'
);

-- Wrong sequence: the date row is still on the old day.
do $wrong$
begin
  begin
    perform 1
    from (values ('11111111-1111-1111-1111-111111111111'::uuid, date '2026-10-05', date '2026-10-06', 10.00::numeric))
      as snap(id, old_charge_date, new_charge_date, amount)
    left join public.order_charges oc on oc.id = snap.id
    where oc.id is null
       or oc.charge_date is distinct from snap.new_charge_date
       or oc.amount is distinct from snap.amount
       or oc.charge_date_source is distinct from 'ship_date';
    if found then
      raise exception '1038 date repair is not the live after-state (1 rows). Refusing the 23 inserts. Nothing was inserted.';
    end if;
    insert into public.order_charges (id, order_id, charge_key, charge_date, amount, source)
    values ('33333333-3333-3333-3333-333333333333', '44444444-4444-4444-4444-444444444444', 'shipment:2', date '2026-10-07', 20.13, 'zone_client_rate');
  exception when others then
    insert into proof values ('wrong-order', sqlerrm like '%not the live after-state%', sqlerrm);
  end;
end
$wrong$;

-- The date repair lands. Then the 23 insert is allowed.
update public.order_charges
set charge_date = date '2026-10-06'
where id = '11111111-1111-1111-1111-111111111111'
  and charge_date = date '2026-10-05'
  and amount = 10.00
  and charge_date_source = 'ship_date';

do $right$
begin
  begin
    perform 1
    from (values ('11111111-1111-1111-1111-111111111111'::uuid, date '2026-10-05', date '2026-10-06', 10.00::numeric))
      as snap(id, old_charge_date, new_charge_date, amount)
    left join public.order_charges oc on oc.id = snap.id
    where oc.id is null
       or oc.charge_date is distinct from snap.new_charge_date
       or oc.amount is distinct from snap.amount
       or oc.charge_date_source is distinct from 'ship_date';
    if found then
      raise exception '1038 date repair is not the live after-state';
    end if;
    insert into public.order_charges (
      id, order_id, charge_key, charge_date, amount, unit_rate, cost, cost_basis, rate_id, source, charge_date_source
    ) values (
      '33333333-3333-3333-3333-333333333333',
      '44444444-4444-4444-4444-444444444444',
      'shipment:2', date '2026-10-07', 20.13, 20.13, 5.00, 'measured', null, 'zone_client_rate', 'ship_date'
    );
    insert into proof values ('insert-after-repair', true, 'inserted');
  exception when others then
    insert into proof values ('insert-after-repair', false, sqlerrm);
  end;
end
$right$;

-- Dry-run approval does not authorize the commit-form restore.
do $unapproved$
begin
  begin
    perform set_config('shipo.approve_charge_date_repair_restore', 'restore_charge_date_repair_2026_11_08', true);
    if current_setting('shipo.approve_charge_date_repair_restore_apply', true)
       is distinct from 'apply_restore_charge_date_repair_2026_11_08' then
      raise exception 'charge date restore apply is not approved. No row was changed.';
    end if;
    update public.order_charges set charge_date = date '2026-10-05'
    where id = '11111111-1111-1111-1111-111111111111';
  exception when others then
    insert into proof values ('restore-unapproved', sqlerrm like '%not approved%', sqlerrm);
  end;
end
$unapproved$;

-- Drift blocks the undo.
do $drift$
begin
  begin
    perform set_config('shipo.approve_charge_date_repair_restore_apply', 'apply_restore_charge_date_repair_2026_11_08', true);
    update public.order_charges set amount = 99
    where id = '11111111-1111-1111-1111-111111111111';
    perform 1
    from (values ('11111111-1111-1111-1111-111111111111'::uuid, date '2026-10-05', date '2026-10-06', 10.00::numeric))
      as snap(id, old_charge_date, new_charge_date, amount)
    left join public.order_charges oc on oc.id = snap.id
    where oc.id is null
       or oc.charge_date is distinct from snap.new_charge_date
       or oc.amount is distinct from snap.amount
       or oc.charge_date_source is distinct from 'ship_date';
    if found then
      raise exception 'restore refused: 1 rows are not the repaired image';
    end if;
  exception when others then
    insert into proof values ('restore-drift', sqlerrm like '%not the repaired image%', sqlerrm);
    update public.order_charges set amount = 10.00
    where id = '11111111-1111-1111-1111-111111111111';
  end;
end
$drift$;

-- Exact image: the undo commits inside this session.
do $undo$
begin
  perform set_config('shipo.approve_charge_date_repair_restore_apply', 'apply_restore_charge_date_repair_2026_11_08', true);
  perform set_config('shipo.approve_nayax_oct6_zone_shipping_restore_apply', 'apply_restore_nayax_oct6_zone_shipping_2026_11_08', true);
  update public.order_charges oc
  set charge_date = date '2026-10-05'
  where oc.id = '11111111-1111-1111-1111-111111111111'
    and oc.charge_date = date '2026-10-06'
    and oc.amount = 10.00
    and oc.charge_date_source = 'ship_date';
  delete from public.order_charges
  where id = '33333333-3333-3333-3333-333333333333'
    and source = 'zone_client_rate'
    and amount = 20.13
    and charge_date = date '2026-10-07'
    and rate_id is null
    and cost = 5.00
    and cost_basis = 'measured';
  insert into proof values ('restore-exact', true, 'undone');
end
$undo$;

insert into proof
select 'date-back', charge_date = date '2026-10-05', charge_date::text
from public.order_charges
where id = '11111111-1111-1111-1111-111111111111';

insert into proof
select 'shipping-gone', count(*) = 0, count(*)::text
from public.order_charges
where id = '33333333-3333-3333-3333-333333333333';
