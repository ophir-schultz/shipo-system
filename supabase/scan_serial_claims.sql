-- Cross-scan serial claim. Apply AFTER supabase/serialization_scans.sql.
--
-- NOT APPLIED by the app. A person has to run this in the SQL editor
-- after reading it. It does not update or delete scan_events,
-- scanned_serials, warehouse_daily_log, or zenventory_push_queue.
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
-- A return of the same unit is not given a second scan by this file.
-- Releasing a claim would be a separate change.

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

-- The old view listed every client id that had ever stored that text
-- on one row. This replacement is one client and one SKU per row.
-- Dropping the view does not drop the scans it read.
drop view if exists duplicate_serials;
create view duplicate_serials
with (security_invoker = true) as
select
  e.client_id,
  e.sku,
  s.serial,
  count(*) as times_scanned,
  array_agg(distinct e.order_ref) as order_refs,
  min(e.scanned_at) as first_scanned_at,
  max(e.scanned_at) as last_scanned_at
from scanned_serials s
join scan_events e on e.id = s.scan_event_id
group by e.client_id, e.sku, s.serial
having count(*) > 1;

-- p_claim_sku is the line the operator named. p_sku stays the line
-- that may join the push queue, and it is still null when that line
-- was not verified. The claim follows the named line so an unverified
-- scan and a later verified one cannot both keep the same unit.
create or replace function record_scan(
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
