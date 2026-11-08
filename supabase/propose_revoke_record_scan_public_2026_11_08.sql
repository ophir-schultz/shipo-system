-- PROPOSAL. Do not run.
--
-- Name: propose_revoke_record_scan_public_2026_11_08
-- Least privilege for the old 10-argument record_scan only.
-- The live scan route calls record_scan_claimed. This file does not
-- replace either function, does not grant anything, and does not
-- touch record_scan_claimed.
-- It would revoke EXECUTE from public, anon, and authenticated.
-- service_role and the owner stay able to call it.
-- This ends in ROLLBACK. The production approval does not approve it.
--
-- A later approved dry run must set, in the same session:
--   set shipo.approve_record_scan_revoke = 'propose_revoke_record_scan_public_2026_11_08';

begin;

do $gate$
begin
  if current_setting('shipo.approve_record_scan_revoke', true)
     is distinct from 'propose_revoke_record_scan_public_2026_11_08' then
    raise exception 'record_scan revoke is not approved. No grant was changed.';
  end if;
end
$gate$;

do $sig$
declare
  n integer;
  args integer;
begin
  select count(*), max(p.pronargs) into n, args
  from pg_proc p
  join pg_namespace ns on ns.oid = p.pronamespace
  where ns.nspname = 'public' and p.proname = 'record_scan';
  if n <> 1 or args is distinct from 10 then
    raise exception 'record_scan is % rows with % args, expected one 10-arg function. Nothing was changed.', n, args;
  end if;
  if not exists (
    select 1
    from pg_proc p
    join pg_namespace ns on ns.oid = p.pronamespace
    where ns.nspname = 'public' and p.proname = 'record_scan_claimed'
  ) then
    raise exception 'record_scan_claimed is missing. Refusing to touch record_scan.';
  end if;
end
$sig$;

revoke execute on function public.record_scan(
  uuid, text, text[], text, text, text, integer, text, uuid, date
) from public, anon, authenticated;

rollback;
