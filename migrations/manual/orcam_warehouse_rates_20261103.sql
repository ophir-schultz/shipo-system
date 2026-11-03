-- Orcam warehouse rates, confirmed list (price-lists/orcam.json, PR #24).
--
-- Paste this whole file into the Supabase SQL editor and run it once.
-- It does not run on deploy. It does not delete a rate row.
--
-- client_warehouse_rates has no active or archived column. A row stops
-- applying when effective_to is set: lookups are half-open
-- [effective_from, effective_to). effective_from = effective_to is the
-- off switch (an empty window), the same one ledger_03_charges.sql uses.
-- The warehouse log (src/lib/billing/warehouse-log-rate.ts) and the
-- ledger (src/lib/ledger/calculate-charges.ts, storage-charges.ts) both
-- use that window.
--
-- The $1.20 pick line and the $45 special-task line are closed with
-- every other open Orcam row, so neither stays in effect. The confirmed
-- lines below are what is in effect afterwards.
--
-- Pick & pack is NOT written as charge_type 'pick' / variant 'device'
-- or 'component'. The calculator bills those as rate × quantity picked
-- (calculate-charges.ts). Orcam's price is $0.50 per order for the first
-- 4 items, then $0.10 per extra item. Writing 0.50 on variant 'device'
-- would bill $0.50 per item. The two pick rows use variants the
-- calculator does not multiply: 'order' and 'additional_item'.
-- The warehouse log prices them by service_type.
--
-- Packing materials are cost + 15 percent. rate 15 with rate_type
-- 'cost_plus' is that percent, the same reading as the Nayax seed
-- (ledger_05_seed_nayax.sql). markup stays null: that column is a
-- dollar markup (client_warehouse_rates_markup.sql), and 15 dollars
-- would be a different price. service_type is null so the daily log
-- does not treat 15 as $15 per unit.
--
-- Storage pallet $25 uses charge_type 'storage', variant 'pallet',
-- rate_type 'per_pallet', which is what storage-charges.ts bills.
-- The rack is variant 'rack', not 'shelf'. The storage job only looks
-- up pallet and shelf, so a $60 shelf line is not written.

-- ---------------------------------------------------------------------------
-- (a) Backup. Run before the transaction. If this table already exists,
--     stop: this file has been applied, or a previous attempt got this far.
-- ---------------------------------------------------------------------------

do $$
declare
  n int;
begin
  select count(*) into n
    from clients
   where name ilike 'orcam'
      or name ilike 'orcam %'
      or name ilike 'orcam-%';
  if n is distinct from 1 then
    raise exception
      'Expected exactly one Orcam client (name Orcam, or Orcam …). Found %. Nothing was written.',
      n;
  end if;
end $$;

create table client_warehouse_rates_backup_orcam_20261103 as
select r.*
  from client_warehouse_rates r
  join clients c on c.id = r.client_id
 where c.name ilike 'orcam'
    or c.name ilike 'orcam %'
    or c.name ilike 'orcam-%';

-- ---------------------------------------------------------------------------
-- (b) One transaction. Close every Orcam row that can still apply, then
--     insert the confirmed list. A failure rolls the card back. The
--     backup table above is already committed and is not undone.
-- ---------------------------------------------------------------------------

begin;

do $$
declare
  cid uuid;
  n int;
  v_today date := (timezone('America/New_York', now()))::date;
  closed int;
  inserted int;
  stray int;
begin
  select count(*) into n
    from clients
   where name ilike 'orcam'
      or name ilike 'orcam %'
      or name ilike 'orcam-%';
  if n is distinct from 1 then
    raise exception
      'Expected exactly one Orcam client. Found %. The card was not changed.', n;
  end if;

  select id into cid
    from clients
   where name ilike 'orcam'
      or name ilike 'orcam %'
      or name ilike 'orcam-%';

  -- Still in effect today, or starting later. A past effective_to is
  -- already off and is left as history.
  update client_warehouse_rates
     set effective_to = case
           when effective_from is null or effective_from < v_today then v_today
           else effective_from
         end
   where client_id = cid
     and (effective_to is null or effective_to > v_today);
  get diagnostics closed = row_count;
  raise notice 'Closed % open Orcam rate row(s) as of %', closed, v_today;

  insert into client_warehouse_rates (
    client_id, category, label, description,
    rate, rate_type, unit, markup,
    charge_type, variant, service_type,
    effective_from, effective_to
  ) values
    -- Pick & pack: $0.50 per order covers the first 4 items.
    (cid, 'outbound', 'Pick & pack',
     'Per order. $0.50 covers the first 4 items.',
     0.50, 'per_order', 'per_order', null,
     'pick', 'order', 'pick_pack',
     v_today, null),
    -- Each item past those 4 is $0.10. Its own service_type, so the
    -- daily log does not see two live pick_pack rows and refuse both.
    (cid, 'outbound', 'Pick & pack, additional item',
     'Each item past the first 4 on the order.',
     0.10, 'per_unit', 'per_unit', null,
     'pick', 'additional_item', 'pick_pack_additional_item',
     v_today, null),

    -- Packing materials: cost + 15 percent. Not a dollar rate.
    (cid, 'materials', 'Packing materials',
     'Cost of the materials plus 15 percent. rate 15 is the percent, not dollars.',
     15.00, 'cost_plus', null, null,
     'material', 'packing', null,
     v_today, null),

    -- Storage.
    (cid, 'storage', 'Monthly storage, pallet, active (40 x 48 x 50 in)',
     'Per pallet.',
     25.00, 'per_pallet', 'per_pallet', null,
     'storage', 'pallet', 'storage_pallet',
     v_today, null),
    (cid, 'storage', 'Monthly storage, rack (shelving, five shelves)',
     'Per rack. $60 is the rack, not a per-shelf split.',
     60.00, 'per_unit', 'per_rack', null,
     'storage', 'rack', 'storage_rack',
     v_today, null),

    -- Special tasks. Replaces the $45 line, which was closed above.
    (cid, 'labour', 'Special tasks',
     'Per hour.',
     48.00, 'per_hour', 'per_hour', null,
     'labour', 'hour', 'special_task',
     v_today, null),

    -- Returns: $3.50, plus $0.50 for each extra item.
    (cid, 'returns', 'Returns',
     'Per return.',
     3.50, 'per_order', 'per_order', null,
     'return', 'order', 'returns',
     v_today, null),
    (cid, 'returns', 'Returns, additional item',
     'Each item past the first on the return.',
     0.50, 'per_unit', 'per_unit', null,
     'return', 'additional_item', 'returns_additional_item',
     v_today, null),

    -- Handling.
    (cid, 'outbound', 'Box sorting up to 30 lbs',
     'Per box.',
     0.60, 'per_box', 'per_box', null,
     'handling', 'box_sort', 'box_sorting',
     v_today, null),
    (cid, 'outbound', 'LTL, pallet shipped',
     'Per pallet shipped.',
     20.00, 'per_pallet', 'per_pallet', null,
     'handling', 'ltl_pallet', 'ltl_pallet',
     v_today, null),
    (cid, 'outbound', 'Sorting items',
     'Per item.',
     0.25, 'per_unit', 'per_unit', null,
     'handling', 'item_sort', 'sorting_items',
     v_today, null),

    -- Inbound.
    (cid, 'inbound', 'Inbound fee (one SKU)',
     'Per pallet.',
     0.50, 'per_pallet', 'per_pallet', null,
     'receiving', 'inbound_one_sku', 'inbound_one_sku',
     v_today, null),
    (cid, 'inbound', 'Full container load inbound fee',
     'Per pallet.',
     5.50, 'per_pallet', 'per_pallet', null,
     'receiving', 'inbound_container', 'inbound_container',
     v_today, null),
    (cid, 'inbound', 'Inbound fee (multiple SKU)',
     'Per carton.',
     2.25, 'per_carton', 'per_carton', null,
     'receiving', 'inbound_multi_sku', 'inbound_multi_sku',
     v_today, null),
    (cid, 'inbound', 'Container unloading, palletizing',
     'Per 20 ft container. Shrink is not a separate charge.',
     450.00, 'flat', 'flat', null,
     'receiving', 'devan_20ft', 'devan_20ft',
     v_today, null),
    (cid, 'inbound', 'Container unloading, non-palletizing',
     'Per 40 ft container.',
     650.00, 'flat', 'flat', null,
     'receiving', 'devan_40ft', 'devan_40ft',
     v_today, null),

    -- Pallet build. Shrink wrap is included in the $15.
    (cid, 'outbound', 'Pallet build',
     'Per pallet built. Shrink wrap is included.',
     15.00, 'per_pallet', 'per_pallet', null,
     'pack', 'pallet_build', 'pallet_build',
     v_today, null);

  get diagnostics inserted = row_count;
  if inserted is distinct from 17 then
    raise exception 'Expected to insert 17 Orcam rate lines, wrote %. Rolled back.', inserted;
  end if;

  -- The two lines that must not keep billing.
  select count(*) into stray
    from client_warehouse_rates
   where client_id = cid
     and (effective_from is null or effective_from <= v_today)
     and (effective_to is null or effective_to > v_today)
     and (
       (rate = 1.20 and (
          coalesce(charge_type, '') = 'pick'
          or coalesce(service_type, '') ilike '%pick%'
          or coalesce(label, '') ilike '%pick%'))
       or
       (rate = 45.00 and (
          coalesce(service_type, '') ilike '%special%'
          or coalesce(label, '') ilike '%special%'
          or coalesce(charge_type, '') in ('labour', 'labor')))
     );
  if stray <> 0 then
    raise exception
      '% Orcam row(s) still in effect at $1.20 pick or $45 special task. Rolled back.',
      stray;
  end if;

  select count(*) into n
    from client_warehouse_rates
   where client_id = cid
     and effective_from = v_today
     and effective_to is null;
  if n is distinct from 17 then
    raise exception
      'Expected 17 Orcam rows opening today, found %. Rolled back.', n;
  end if;

  raise notice 'Orcam rate card replaced with 17 confirmed lines from %', v_today;
end $$;

commit;

-- ---------------------------------------------------------------------------
-- (c) Verification. Expect 17 rows, the rates below, and no $1.20 pick
--     or $45 special-task row in effect.
-- ---------------------------------------------------------------------------

select c.name as client,
       r.label,
       r.service_type,
       r.charge_type,
       r.variant,
       r.rate,
       r.rate_type,
       r.unit,
       r.markup,
       r.effective_from,
       r.effective_to,
       r.description
  from client_warehouse_rates r
  join clients c on c.id = r.client_id
 where (c.name ilike 'orcam' or c.name ilike 'orcam %' or c.name ilike 'orcam-%')
   and (r.effective_from is null or r.effective_from <= (timezone('America/New_York', now()))::date)
   and (r.effective_to is null or r.effective_to > (timezone('America/New_York', now()))::date)
 order by r.category, r.label;
