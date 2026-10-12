-- ============================================================
-- SERIALIZATION SCANS — billable serial capture, and the queue
-- that pushes those serials back into Zenventory.
--
-- A warehouse operator scans ONE box label and gets back the
-- individual device serials inside it. Two things then have to
-- happen, and they are deliberately decoupled:
--
--   1. BILLING. The work is charged immediately and locally, via
--      an ordinary warehouse_daily_log row. That path has no
--      external dependency, so a scan is never lost because a
--      third party is slow or down.
--
--   2. PUSH. The serials are sent to Zenventory, matched to the
--      outbound order, and CONSUMED — they leave inventory. This
--      is queued, not called inline, for three reasons: a scan
--      must not fail when Zenventory does; a failed push must be
--      retryable without re-scanning the carton; and a write that
--      mutates a client's stock needs an auditable record of
--      exactly what was sent and what came back.
--
-- PRICING. Two service types, distinguished by INPUT METHOD, not
-- by count:
--   serialization_box    $1.50  flat      serials came from a box label
--   serialization_loose  $0.32  per_unit  serials entered individually
--
-- Rates are NOT seeded here. They are per client and live in
-- client_warehouse_rates — see the commented block at the bottom.
-- The API refuses a scan when the rate row is missing rather than
-- defaulting to zero, because a silent $0 charge looks healthy.
--
-- This file is idempotent — apply it in the Supabase SQL editor.
-- ============================================================

-- One row per scan ACTION: a single box label, or one batch of
-- individually-entered serials.
create table if not exists scan_events (
  id                uuid primary key default uuid_generate_v4(),
  client_id         uuid not null references clients(id),

  -- Drives which rate applies. 'box' = came off a box label,
  -- 'loose' = keyed or scanned one at a time.
  scan_type         text not null check (scan_type in ('box', 'loose')),

  -- The Zenventory order these serials ship against. Needed to
  -- match on push; nullable so a scan is never blocked by a
  -- missing reference, but the push queue requires it.
  order_ref         text,

  -- Which LINE of that order. Zenventory holds scanned serials per
  -- line item, not per order: the barcode button on an order line
  -- opens a "Scanned Serial Numbers" list scoped to that one SKU.
  -- Real orders are multi-line (a reader, a resistor, an antenna),
  -- so without this the drainer would have to guess which line a
  -- carton belongs to — a guess that decrements the wrong product.
  -- Nullable for the same reason as order_ref: never block a scan.
  sku               text,

  -- Carton identifier off the label, when the label carries one.
  box_ref           text,

  serial_count      integer not null check (serial_count > 0),

  -- What the carton was SUPPOSED to hold. When serial_count is
  -- lower, this is a short box: still billed as one box, but
  -- visible for review rather than silently repriced.
  expected_count    integer,

  -- The billing row this scan produced. Nullable only so the
  -- insert order is flexible; the API always sets it.
  warehouse_log_id  uuid references warehouse_daily_log(id),

  scanned_at        timestamptz default now(),
  scanned_by        uuid,
  notes             text
);

create index if not exists scan_events_client_idx   on scan_events (client_id, scanned_at desc);
create index if not exists scan_events_order_idx    on scan_events (order_ref);

-- The serials themselves. Stored deliberately: they are the audit
-- trail of which physical units left the building, and they are
-- what gets pushed to Zenventory.
create table if not exists scanned_serials (
  id                uuid primary key default uuid_generate_v4(),
  scan_event_id     uuid not null references scan_events(id) on delete cascade,
  serial            text not null,

  -- Order within the scan, so a carton can be reconstructed exactly
  -- as it was read.
  position          integer
);

-- A serial cannot appear twice within one scan. That is always an
-- error: either a double-read or a bad delimiter split.
create unique index if not exists scanned_serials_unique_in_event
  on scanned_serials (scan_event_id, serial);

-- NOT globally unique on purpose. A unit can legitimately be
-- returned and reshipped, so a hard constraint would block real
-- work. This index makes the ACROSS-scan duplicate check cheap
-- instead, and the view below surfaces them for a human.
create index if not exists scanned_serials_serial_idx on scanned_serials (serial);

-- The same physical unit appearing on two different scans. Usually
-- means it was shipped twice.
create or replace view duplicate_serials as
select
  s.serial,
  count(*)                     as times_scanned,
  array_agg(distinct e.client_id) as client_ids,
  array_agg(distinct e.order_ref) as order_refs,
  min(e.scanned_at)            as first_scanned_at,
  max(e.scanned_at)            as last_scanned_at
from scanned_serials s
join scan_events e on e.id = s.scan_event_id
group by s.serial
having count(*) > 1;

-- 'create table if not exists' above does nothing when the table is
-- already there, so a column added to this file later would never
-- reach a database that ran an earlier version. Stated explicitly
-- rather than relying on the table definition.
alter table scan_events add column if not exists sku text;

-- ------------------------------------------------------------
-- PUSH QUEUE — one job per ORDER LINE, not per scan.
--
-- NOTE ON RE-APPLYING. This table was previously keyed per
-- scan_event (one push per box) with a NOT NULL scan_event_id. That
-- shape is incompatible with the one below, and 'create table if not
-- exists' will quietly leave the old one in place — after which
-- record_scan fails on every scan. If an earlier version of this
-- file was ever applied, drop the old table first:
--
--   drop view if exists push_job_serials;
--   alter table scan_events drop column if exists push_job_id;
--   drop table if exists zenventory_push_queue;
--
-- Safe only while nothing has been pushed; check for yourself:
--   select count(*) from zenventory_push_queue where status = 'done';
--
-- This was originally one row per scan_event, i.e. one push per
-- box. That was wrong, and the way it was wrong is worth keeping
-- written down.
--
-- A 120-unit line is six 20-unit cartons. Per-box pushing would
-- fire six PUT /customerorders/{id}/items/pick calls at the SAME
-- line. Zenventory's serial list is per line item — the barcode
-- button on an order line opens one "Scanned Serial Numbers" list
-- for that SKU — and whether that endpoint APPENDS to the list or
-- REPLACES it has never been observed. If it replaces, five of the
-- six cartons are silently erased while the quantity is drawn down
-- six times. An unverified assumption is tolerable when the cost
-- of being wrong is a retry; here the cost is a client's real
-- stock, so the design must not depend on the answer.
--
-- So a job accumulates every carton for one (order, SKU) and is
-- pushed ONCE, when the line is complete. That is also what the
-- workflow actually is: serials go into the pick when all is
-- picked, not carton by carton.
--
-- Guards, in the schema rather than in application code:
--   * unique (client_id, order_ref, sku) — one job per line, so a
--     second carton joins the existing job instead of opening a
--     second push;
--   * idempotency_key is unique and sent with the request, so a
--     retry after an ambiguous timeout is recognisable.
--
-- READINESS is deliberately NOT stored here. The drainer decides
-- it by reading the line's orderquantity from Zenventory at push
-- time and comparing it to the serials accumulated. A locally
-- cached expectation could drift from the order; the order itself
-- cannot.
--
-- A worker must claim a row by setting status='in_flight' and only
-- treat it as complete when pushed_at is set.
-- ------------------------------------------------------------
create table if not exists zenventory_push_queue (
  id                uuid primary key default uuid_generate_v4(),

  client_id         uuid not null references clients(id),
  order_ref         text not null,
  sku               text not null,

  status            text not null default 'pending'
                      check (status in ('pending', 'in_flight', 'done', 'failed')),

  attempts          integer not null default 0,

  -- Stable across retries, and derived from the LINE rather than
  -- from any one carton, so adding a carton to an unpushed job does
  -- not change the key.
  idempotency_key   text not null unique,

  -- Exactly what we sent and exactly what came back. When a push
  -- moves stock, "what did we actually send" cannot be a guess.
  request_payload   jsonb,
  response_status   integer,
  response_body     text,
  last_error        text,

  created_at        timestamptz default now(),
  pushed_at         timestamptz,

  -- One job per order line.
  unique (client_id, order_ref, sku)
);

create index if not exists zenventory_push_queue_pending_idx
  on zenventory_push_queue (status, created_at)
  where status in ('pending', 'failed');

-- Which cartons feed which push job. Set by record_scan; the
-- drainer reads serials through this.
alter table scan_events
  add column if not exists push_job_id uuid references zenventory_push_queue(id);

create index if not exists scan_events_push_job_idx on scan_events (push_job_id);

-- Everything accumulated so far for one push job, in carton order
-- then position within the carton, so the pushed list matches the
-- physical reading order rather than arriving shuffled.
create or replace view push_job_serials as
select
  e.push_job_id,
  e.id          as scan_event_id,
  e.box_ref,
  e.scanned_at,
  s.serial,
  s.position
from scan_events e
join scanned_serials s on s.scan_event_id = e.id
where e.push_job_id is not null;

-- ------------------------------------------------------------
-- record_scan() — the whole scan, or none of it.
--
-- A scan writes to four tables: the billing row, the scan event,
-- the serials, and the push queue. Doing that as four separate
-- statements from the API leaves two ways to fail badly:
--
--   * charge written, serials lost  -> an invoice line with no
--     evidence behind it;
--   * serials written, charge lost  -> work done for free, and
--     nothing to notice it by.
--
-- A function body is one transaction, so a raise anywhere below
-- rolls the whole thing back and the operator simply rescans.
--
-- It REFUSES when the client has no rate configured. The rest of
-- this codebase defaults a missing rate to zero, which writes a
-- $0 line that looks exactly like a healthy one. Here that would
-- mean silently doing serialization for free, so it raises.
-- ------------------------------------------------------------
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
  p_log_date       date default null
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
  v_job_id         uuid;
begin
  if p_scan_type not in ('box', 'loose') then
    raise exception 'scan_type must be box or loose, got %', p_scan_type;
  end if;

  if v_count is null or v_count = 0 then
    raise exception 'a scan must contain at least one serial';
  end if;

  -- Cheaper to reject here than to let the unique index fire after
  -- the billing row is already written.
  if v_count <> (select count(distinct t.serial) from unnest(p_serials) as t(serial)) then
    raise exception 'the same serial appears twice in one scan';
  end if;

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

  -- The rate row's own unit decides how to multiply, so a rate
  -- configured as flat is never billed per serial by accident.
  v_quantity := case when v_unit = 'flat' then 1 else v_count end;
  v_total    := v_rate * v_quantity;

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

  -- Pushing needs BOTH an order and a line within it. Missing either
  -- means there is nothing safe to push to: an order ref alone cannot
  -- say which SKU's serial list to fill, and on a multi-line order
  -- picking that wrong would consume a different product entirely.
  -- The scan is still billed and still stored — it can be attached to
  -- a job later, once the missing reference is known.
  if v_order is not null and v_sku is not null then
    -- Upsert: the second carton of a line joins the first carton's
    -- job rather than opening a competing push. 'do update' on a
    -- no-op column is what makes RETURNING yield the existing row.
    insert into zenventory_push_queue
      (client_id, order_ref, sku, idempotency_key)
    values
      (p_client_id, v_order, v_sku,
       'line-' || p_client_id::text || '-' || v_order || '-' || v_sku)
    on conflict (client_id, order_ref, sku)
      do update set order_ref = excluded.order_ref
    returning id into v_job_id;

    -- A line already pushed must not quietly absorb another carton:
    -- the serials would sit in the job looking sent when they never
    -- were. Surfacing it as an error is the point — it means either a
    -- miscount or a carton scanned after the line was closed.
    if (select status from zenventory_push_queue where id = v_job_id) = 'done' then
      raise exception
        'order % line % has already been pushed to Zenventory — this carton cannot be added to it',
        v_order, v_sku;
    end if;

    update scan_events set push_job_id = v_job_id where id = v_event_id;
  end if;

  return jsonb_build_object(
    'scan_event_id',    v_event_id,
    'warehouse_log_id', v_log_id,
    'service_type',     v_service_type,
    'serial_count',     v_count,
    'quantity',         v_quantity,
    'rate',             v_rate,
    'total',            v_total,
    'push_job_id',      v_job_id,
    'queued',           (v_job_id is not null)
  );
end;
$$;

alter table scan_events           enable row level security;
alter table scanned_serials       enable row level security;
alter table zenventory_push_queue enable row level security;

-- ------------------------------------------------------------
-- RATES — run per client, with that client's id. Not seeded
-- automatically: a rate applied to the wrong client bills the
-- wrong company.
--
-- insert into client_warehouse_rates (client_id, service_type, rate, unit)
-- values
--   ('<client-uuid>', 'serialization_box',   1.50, 'flat'),
--   ('<client-uuid>', 'serialization_loose', 0.32, 'per_unit')
-- on conflict do nothing;
--
-- Check which clients are still missing rates:
--
-- select c.id, c.name
-- from clients c
-- where c.active
--   and not exists (
--     select 1 from client_warehouse_rates r
--     where r.client_id = c.id and r.service_type = 'serialization_box'
--   );
-- ------------------------------------------------------------
