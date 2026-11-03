-- ============================================================
-- Serial delivery status. Additive. Apply in the SQL editor
-- after supabase/serialization_scans.sql.
--
-- scanned_serials already keeps the serial, and scan_events keeps
-- the order, the client, the SKU, the scan time and who scanned.
-- These columns record whether that serial reached Zenventory,
-- when, and what the order read-back said.
--
-- Nayax is not stored here. Nayax receives serials from Zenventory
-- through the API connection that already exists. This system does
-- not send serials to Nayax.
--
-- The columns are the latest answer, so the screen can filter.
-- serial_delivery_log is the history. The app only inserts into
-- the log. Nothing in this file deletes or rewrites a scan.
-- ============================================================

alter table scanned_serials add column if not exists zenventory_status text;
alter table scanned_serials add column if not exists zenventory_sent_at timestamptz;
alter table scanned_serials add column if not exists zenventory_response text;

create table if not exists serial_delivery_log (
  id                  uuid primary key default uuid_generate_v4(),
  scanned_serial_id   uuid references scanned_serials(id),
  client_id           uuid references clients(id),
  order_ref           text,
  sku                 text,
  serial              text not null,
  channel             text not null check (channel in ('zenventory')),
  status              text not null check (status in ('sent', 'failed', 'skipped')),
  response_status     integer,
  response_body       text,
  recorded_at         timestamptz not null default now()
);

create index if not exists serial_delivery_log_serial_idx
  on serial_delivery_log (serial, recorded_at desc);

create index if not exists serial_delivery_log_order_idx
  on serial_delivery_log (order_ref, recorded_at desc);

alter table serial_delivery_log enable row level security;

-- No policy is granted to anon or authenticated. Staff screens read
-- and the push route writes through the service role, which bypasses
-- RLS. A missing policy here means the Data API cannot update or
-- delete the log.
