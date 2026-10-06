-- Defence in depth for clients.name: a client cannot be named nothing.
-- Depends on nothing. Safe to run more than once.
-- Verify with supabase/verify/clients_name_not_blank_verify.sql.

-- ---------------------------------------------------------------------------
-- Why this file exists.
--
-- `name text not null` does not say what it looks like it says. NOT NULL
-- permits the empty string, and PATCH /api/clients/[id] used to pass the
-- parsed request body straight into .update() with no allowlist and no
-- per-field check -- so `PATCH {"name": ""}` wrote '' (measured in production
-- on 2026-10-05). The companion POST route guarded with `if (!name)`, and ' '
-- is truthy, so a single space became a client as well; the form's HTML
-- `required` accepts a space too.
--
-- An empty name used to take out the whole /clients render: it is a server
-- component and `client.name[0].toUpperCase()` throws TypeError on '', so the
-- operator got an error boundary instead of their client list, with nothing on
-- screen naming the row at fault. Commit 00dd53e made that derivation total
-- (src/lib/display/initial.ts), so the page survives a bad row now, and
-- src/lib/clients/editable-fields.ts stops the API writing one.
--
-- This constraint is the third layer, and it is the only one that covers a
-- writer that does not go through the API at all: a SQL statement typed into
-- this very editor, a future route that forgets the allowlist, or a Supabase
-- table-editor cell edit. The application rule and this one are deliberately
-- redundant.
--
-- WHY `name ~ '[^[:space:]]'` AND NOT `length(btrim(name)) > 0`.
--
-- btrim's second argument defaults to a SPACE, not to whitespace -- per the
-- Postgres documentation for btrim; there is no psql on the machine this was
-- written on, so that is doc-derived and not first-hand. A tab-only or
-- newline-only name therefore SURVIVES `length(btrim(name)) > 0`, while
-- JavaScript's .trim() strips both, so the obvious predicate would have been
-- quietly weaker than the TypeScript rule it is meant to back up. The regex
-- reads as what is actually wanted: at least one character that is not
-- whitespace. Step 2 of the verify script is the positive control for exactly
-- this -- it attempts a tab-only name and requires the insert to fail.

-- 1. Report what is already in the table, BEFORE changing anything.
--
-- A plain ADD CONSTRAINT would fail with 23514 on a pre-existing blank row and
-- the whole file would abort, which tells the operator that something is wrong
-- without telling them which row. This reports the rows first and then adds
-- the constraint NOT VALID, so the file always completes and the follow-up is
-- a decision rather than an error message.
do $$
declare
  bad int;
  ids text;
begin
  select count(*), string_agg(id::text, ', ')
    into bad, ids
  from   clients
  where  name !~ '[^[:space:]]';

  if bad > 0 then
    raise notice 'NOTE: % client row(s) already have a blank name: %. The constraint '
                 'below is added NOT VALID so this file still completes; give those '
                 'rows real names and then re-run step 3.', bad, ids;
  else
    raise notice 'PASS: no existing client row has a blank name';
  end if;
end $$;

-- 2. Add the constraint if it is not already there.
do $$
begin
  if exists (
    select 1 from pg_constraint
    where  conname = 'clients_name_not_blank'
    and    conrelid = 'clients'::regclass
  ) then
    raise notice 'NOTE: clients_name_not_blank already exists; left alone';
  else
    alter table clients
      add constraint clients_name_not_blank check (name ~ '[^[:space:]]') not valid;
    raise notice 'PASS: clients_name_not_blank added. It bites on every INSERT and '
                 'UPDATE from now on; NOT VALID only means the existing rows have '
                 'not been checked yet, which step 3 does.';
  end if;
end $$;

-- 3. Validate it against the existing rows.
--
-- Separate from step 2 so that a table with a blank row already in it still
-- gets the constraint. VALIDATE is what promotes it from "applies to new
-- writes" to "every row in this table satisfies it", and it is the half that
-- can legitimately fail today.
do $$
begin
  begin
    alter table clients validate constraint clients_name_not_blank;
    raise notice 'PASS: clients_name_not_blank is VALID -- every existing client row '
                 'has a non-blank name';
  exception when check_violation then
    raise notice 'PENDING: clients_name_not_blank could not be validated, because at '
                 'least one existing row has a blank name (step 1 listed them). New '
                 'writes are already refused. Fix those rows and re-run this file.';
  end;
end $$;
