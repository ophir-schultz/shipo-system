-- Cross-scan serial claim. Apply AFTER supabase/serialization_scans.sql.
--
-- NOT APPLIED by the app. Preview uses the production database, so
-- this file is additive. It does not drop, replace, or regrant
-- public.record_scan. It does not drop or replace public.duplicate_serials.
-- It does not update or delete scan_events, scanned_serials,
-- warehouse_daily_log, or zenventory_push_queue.
--
-- Production code on main calls record_scan with the original ten
-- arguments (src/app/api/scan/route.ts). That function is left as it
-- is, so it still does not refuse a serial that was stored on an
-- earlier scan. The refusal exists only in record_scan_claimed.
-- This branch calls that function after scan_claim_ready reports
-- version client-sku-v1. Until production code is switched to it,
-- production scans do not get this check.
--
-- Zenventory stores scanned serials on one order line: one client and
-- one SKU. This claim uses that same domain. Another client, or another
-- SKU, is not a conflict. A retry of the same scan returns the original
-- event and does not bill it again.
--
-- Rows already stored are left in place, including any pair that was
-- scanned twice before this file existed. The function reads those rows
-- before it inserts, so a new scan of one of them is still refused. The
-- unique index is on an empty table, so creating it does not fail on
-- those older pairs and does not remove them.
--
-- ONE-TIME OUTBOUND. A serial stored for this client and SKU means that
-- unit already went out. This file does not define a return, a
-- reshipment, or a later rescan, and it does not delete a claim or
-- open a release. Those need their own approved rules. A same-scan
-- retry is not that case: it is the original submission again, and it
-- must not create a second bill or a second pick.

create table if not exists scan_serial_claims (
  id              uuid primary key default uuid_generate_v4(),
  client_id       uuid not null references clients(id),
  sku_key         text not null,
  serial_key      text not null,
  scan_event_id   uuid not null references scan_events(id) on delete cascade,
  created_at      timestamptz default now(),
  unique (client_id, sku_key, serial_key)
);

alter table scan_serial_claims enable row level security;

-- Separate from record_scan. p_claim_sku is the line the operator
-- named. p_sku stays the line that may join the push queue.
-- claim version client-sku-v1
create or replace function record_scan_claimed(
  p_client_id      uuid,
  p_scan_type      text,
  p_serials        text[],
  p_order_ref      text default null,
  p_sku            text default null,
  p_box_ref        text default null,
  p_expected_count integer default null,
  p_notes          text default null,
  p_scanned_by     uuid default null,
  p_log_date       date default null,
  p_claim_sku      text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_service_type   text;
  v_rate           numeric(10,2);
  v_unit           text;
  v_count          integer := array_length(p_serials, 1);
  v_quantity       numeric(10,2);
  v_total          numeric(10,2);
  v_log_id         uuid;
  v_event_id       uuid;
  v_order          text := nullif(trim(coalesce(p_order_ref, '')), '');
  v_sku            text := nullif(trim(coalesce(p_sku, '')), '');
  v_claim_sku      text := lower(coalesce(nullif(trim(coalesce(p_claim_sku, '')), ''), nullif(trim(coalesce(p_sku, '')), ''), ''));
  v_job_id         uuid;
  v_keys           text[];
  v_key            text;
  v_existing       uuid;
  v_conflict       text;
begin
  -- claim version client-sku-v1
  if p_scan_type not in ('box', 'loose') then
    raise exception 'scan_type must be box or loose, got %', p_scan_type;
  end if;

  if v_count is null or v_count = 0 then
    raise exception 'a scan must contain at least one serial';
  end if;

  if v_count <> (select count(distinct t.serial) from unnest(p_serials) as t(serial)) then
    raise exception 'the same serial appears twice in one scan';
  end if;

  select array_agg(k order by k)
    into v_keys
  from (
    select distinct lower(trim(t.serial)) as k
    from unnest(p_serials) as t(serial)
    where trim(t.serial) <> ''
  ) folded;

  if coalesce(array_length(v_keys, 1), 0) <> v_count then
    raise exception 'the same serial appears twice in one scan';
  end if;

  -- Sorted locks so two cartons cannot deadlock, and so the check
  -- below sees a scan that committed while this one waited.
  foreach v_key in array v_keys loop
    perform pg_advisory_xact_lock(hashtextextended(p_client_id::text || '|' || v_claim_sku || '|' || v_key, 0));
  end loop;

  select e.id
    into v_existing
  from scan_events e
  where e.client_id = p_client_id
    and e.scan_type = p_scan_type
    and coalesce(nullif(trim(coalesce(e.order_ref, '')), ''), '') = coalesce(v_order, '')
    and (
      lower(coalesce(e.sku, '')) = v_claim_sku
      or exists (
        select 1 from scan_serial_claims c
        where c.scan_event_id = e.id
          and c.client_id = p_client_id
          and c.sku_key = v_claim_sku
      )
    )
    and (select count(*) from scanned_serials s where s.scan_event_id = e.id) = v_count
    and (
      select count(*) from scanned_serials s
      where s.scan_event_id = e.id
        and lower(trim(s.serial)) = any(v_keys)
    ) = v_count
  order by e.scanned_at
  limit 1;

  if v_existing is not null then
    select e.warehouse_log_id, e.serial_count, e.push_job_id, w.quantity, w.rate, w.total
      into v_event_id, v_count, v_job_id, v_quantity, v_rate, v_total
    from scan_events e
    left join warehouse_daily_log w on w.id = e.warehouse_log_id
    where e.id = v_existing
      and e.client_id = p_client_id;
    v_event_id := v_existing;
    return jsonb_build_object(
      'scan_event_id', v_existing,
      'warehouse_log_id', (select warehouse_log_id from scan_events where id = v_existing and client_id = p_client_id),
      'service_type', case p_scan_type when 'box' then 'serialization_box' else 'serialization_loose' end,
      'serial_count', v_count,
      'quantity', v_quantity,
      'rate', v_rate,
      'total', v_total,
      'push_job_id', (select push_job_id from scan_events where id = v_existing and client_id = p_client_id),
      'queued', (select push_job_id is not null from scan_events where id = v_existing and client_id = p_client_id),
      'idempotent', true
    );
  end if;

  select string_agg(distinct incoming.serial, ', ' order by incoming.serial)
    into v_conflict
  from unnest(p_serials) as incoming(serial)
  where exists (
    select 1
    from scanned_serials s
    join scan_events e on e.id = s.scan_event_id
    where e.client_id = p_client_id
      and lower(trim(s.serial)) = lower(trim(incoming.serial))
      and (
        lower(coalesce(e.sku, '')) = v_claim_sku
        or exists (
          select 1 from scan_serial_claims c
          where c.scan_event_id = e.id
            and c.client_id = p_client_id
            and c.sku_key = v_claim_sku
            and c.serial_key = lower(trim(incoming.serial))
        )
      )
  );

  if v_conflict is not null then
    raise exception
      'Serial % was already scanned for this client and SKU. Nothing else was recorded.',
      v_conflict;
  end if;

  begin
    v_service_type := case p_scan_type
                        when 'box' then 'serialization_box'
                        else 'serialization_loose'
                      end;

    select r.rate, r.unit into v_rate, v_unit
    from client_warehouse_rates r
    where r.client_id = p_client_id
      and r.service_type = v_service_type
    limit 1;

    if v_rate is null then
      raise exception
        'no % rate configured for this client — set it in client_warehouse_rates before scanning',
        v_service_type;
    end if;

    v_quantity := case when v_unit = 'flat' then 1 else v_count end;
    v_total := v_rate * v_quantity;

    insert into warehouse_daily_log
      (client_id, log_date, service_type, quantity, rate, total, notes, logged_by)
    values
      (p_client_id, coalesce(p_log_date, current_date), v_service_type,
       v_quantity, v_rate, v_total, p_notes, p_scanned_by)
    returning id into v_log_id;

    insert into scan_events
      (client_id, scan_type, order_ref, sku, box_ref, serial_count,
       expected_count, warehouse_log_id, scanned_by, notes)
    values
      (p_client_id, p_scan_type, v_order, v_sku, p_box_ref, v_count,
       p_expected_count, v_log_id, p_scanned_by, p_notes)
    returning id into v_event_id;

    insert into scanned_serials (scan_event_id, serial, position)
    select v_event_id, s.serial, s.ord
    from unnest(p_serials) with ordinality as s(serial, ord);

    insert into scan_serial_claims (client_id, sku_key, serial_key, scan_event_id)
    select p_client_id, v_claim_sku, lower(trim(s.serial)), v_event_id
    from unnest(p_serials) as s(serial);

    if v_order is not null and v_sku is not null then
      insert into zenventory_push_queue
        (client_id, order_ref, sku, idempotency_key)
      values
        (p_client_id, v_order, v_sku,
         'line-' || p_client_id::text || '-' || v_order || '-' || v_sku)
      on conflict (client_id, order_ref, sku)
        do update set order_ref = excluded.order_ref
      returning id into v_job_id;

      if (select status from zenventory_push_queue where id = v_job_id) = 'done' then
        raise exception
          'order % line % has already been pushed to Zenventory — this carton cannot be added to it',
          v_order, v_sku;
      end if;

      update scan_events set push_job_id = v_job_id where id = v_event_id and client_id = p_client_id;
    end if;

    return jsonb_build_object(
      'scan_event_id', v_event_id,
      'warehouse_log_id', v_log_id,
      'service_type', v_service_type,
      'serial_count', v_count,
      'quantity', v_quantity,
      'rate', v_rate,
      'total', v_total,
      'push_job_id', v_job_id,
      'queued', (v_job_id is not null),
      'idempotent', false
    );
  exception
    when unique_violation then
      select e.id
        into v_existing
      from scan_events e
      where e.client_id = p_client_id
        and e.scan_type = p_scan_type
        and coalesce(nullif(trim(coalesce(e.order_ref, '')), ''), '') = coalesce(v_order, '')
        and (
          lower(coalesce(e.sku, '')) = v_claim_sku
          or exists (
            select 1 from scan_serial_claims c
            where c.scan_event_id = e.id
              and c.client_id = p_client_id
              and c.sku_key = v_claim_sku
          )
        )
        and (select count(*) from scanned_serials s where s.scan_event_id = e.id) = v_count
        and (
          select count(*) from scanned_serials s
          where s.scan_event_id = e.id
            and lower(trim(s.serial)) = any(v_keys)
        ) = v_count
      order by e.scanned_at
      limit 1;

      if v_existing is not null then
        return jsonb_build_object(
          'scan_event_id', v_existing,
          'warehouse_log_id', (select warehouse_log_id from scan_events where id = v_existing and client_id = p_client_id),
          'service_type', case p_scan_type when 'box' then 'serialization_box' else 'serialization_loose' end,
          'serial_count', v_count,
          'quantity', null,
          'rate', null,
          'total', null,
          'push_job_id', (select push_job_id from scan_events where id = v_existing and client_id = p_client_id),
          'queued', (select push_job_id is not null from scan_events where id = v_existing and client_id = p_client_id),
          'idempotent', true
        );
      end if;

      raise exception
        'Serial % was already scanned for this client and SKU. Nothing else was recorded.',
        coalesce(v_conflict, array_to_string(v_keys, ', '));
  end;
end;
$$;

-- Reads the installed function bodies. A constant true is not a pass.
-- ready is true only for record_scan_claimed version client-sku-v1,
-- with the old ten-argument record_scan still free of this table.
-- It does not insert.
create or replace function scan_claim_ready()
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  v_new text := '';
  v_old text := '';
  v_config text := '';
  v_new_args integer := 0;
  v_old_args integer := 0;
  v_old_count integer := 0;
  v_definer boolean := true;
  v_advisory boolean := false;
  v_idempotent boolean := false;
  v_version boolean := false;
  v_invoker boolean := false;
  v_unique boolean := false;
  v_shape boolean := false;
  v_old_clean boolean := false;
begin
  select count(*), coalesce(max(p.pronargs), 0)
    into v_old_count, v_old_args
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'record_scan';

  select pg_get_functiondef(p.oid), p.pronargs, p.prosecdef,
         coalesce(array_to_string(p.proconfig, ','), '')
    into v_new, v_new_args, v_definer, v_config
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'record_scan_claimed';

  select coalesce(pg_get_functiondef(p.oid), '')
    into v_old
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'record_scan'
  order by p.oid
  limit 1;

  v_advisory := position('pg_advisory_xact_lock' in v_new) > 0;
  v_idempotent := position('idempotent' in v_new) > 0
    and position('already scanned for this client and SKU' in v_new) > 0;
  v_version := position('client-sku-v1' in v_new) > 0 and v_new_args = 11;
  v_invoker := v_definer = false and position('search_path=public' in v_config) > 0;
  v_unique := exists (
    select 1
    from pg_constraint c
    join pg_class rel on rel.oid = c.conrelid
    join pg_namespace n on n.oid = rel.relnamespace
    where n.nspname = 'public'
      and rel.relname = 'scan_serial_claims'
      and c.contype = 'u'
  );
  v_shape := exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'duplicate_serials'
      and column_name = 'client_ids'
  );
  v_old_clean := v_old_count = 1
    and v_old_args = 10
    and position('scan_serial_claims' in v_old) = 0;

  return jsonb_build_object(
    'ready', v_advisory and v_idempotent and v_version and v_invoker and v_unique and v_shape and v_old_clean,
    'rpc', 'record_scan_claimed',
    'version', 'client-sku-v1',
    'old_record_scan', case
      when v_old_count = 0 then 'missing'
      when v_old_count <> 1 or v_old_args <> 10 then 'replaced'
      when position('scan_serial_claims' in v_old) > 0 then 'replaced'
      else 'unchanged'
    end,
    'old_has_claim_safety', position('scan_serial_claims' in v_old) > 0,
    'checks', jsonb_build_object(
      'advisory_lock', v_advisory,
      'unique_claim', v_unique,
      'idempotent_retry', v_idempotent,
      'invoker', v_invoker,
      'old_signature', case when v_old_count = 1 and v_old_args = 10 then '10-arg' else 'other' end,
      'duplicate_serials_shape', case when v_shape then 'client_ids' else 'changed' end
    )
  );
end;
$$;

-- Grants below name only the new objects. record_scan is not revoked
-- and not granted here. Roles missing on a local server are skipped.
do $$
declare
  fn record;
  role_name text;
begin
  execute 'revoke all on table public.scan_serial_claims from public';
  for fn in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('record_scan_claimed', 'scan_claim_ready')
  loop
    execute format('revoke all on function %s from public', fn.sig);
  end loop;
  foreach role_name in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = role_name) then
      execute format('revoke all on table public.scan_serial_claims from %I', role_name);
      for fn in
        select p.oid::regprocedure as sig
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname in ('record_scan_claimed', 'scan_claim_ready')
      loop
        execute format('revoke all on function %s from %I', fn.sig, role_name);
      end loop;
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant select, insert, update, delete on table public.scan_serial_claims to service_role';
    for fn in
      select p.oid::regprocedure as sig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname in ('record_scan_claimed', 'scan_claim_ready')
    loop
      execute format('grant execute on function %s to service_role', fn.sig);
    end loop;
  end if;
end $$;
