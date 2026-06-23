-- Tracks failed login attempts per email for server-side brute-force lockout.
create table if not exists login_attempts (
  email          text primary key,
  failed_count   integer not null default 0,
  locked_until   timestamptz,
  last_attempt   timestamptz not null default now(),
  last_ip        text,
  updated_at     timestamptz not null default now()
);

-- RLS on: only the service-role key (used by the server login route) may touch this table.
alter table login_attempts enable row level security;
