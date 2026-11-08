-- PROPOSAL READ. Do not run a write from this file.
--
-- Name: propose_nayax_oct6_zone_shipping_2026_11_08
-- Snapshot: supabase/proposals/oct6_23.json
-- SHA-256 of that file: f2bc2370bcdae926ccc3cbd9969271074e08666f45ba42f772b0ccbe10c9ba0e
-- 23 Nayax orders, one shipment each, ship day 2026-10-07,
-- client_rate sum 539.58, zero charges. No insert is in this file.
-- The shipping insert, if it is ever approved, is the separate file
-- supabase/propose_nayax_oct6_zone_shipping_insert_2026_11_08.sql.

with snap(order_id, order_number, shipment_id, shipstation_shipment_id, client_rate) as (
  values
  ('2872f5dd-b398-4e96-9ef2-46792d3c8143', 'SO601060842', '8246ff0d-dc3a-4543-add8-f1b76e042608', 342390276, 41.00),
  ('a5f73bc5-443f-462a-9542-d3fb320d74e5', 'SO601060976', '7c6c95ca-3fd6-47ea-b59c-96ee33bfd681', 342382251, 25.12),
  ('cb40fc02-1743-4b1e-b507-f040d561d3f0', 'SO601060977', 'b1b7a98b-1cea-4818-959b-a0978897c4b6', 342384223, 25.12),
  ('0ca89c4e-39d5-46b7-bec8-2c3c79194a33', 'SO601061006', '7209d16f-f04c-4657-b4d8-19dd1743f7b5', 342386819, 46.97),
  ('4f2abd9d-fbfa-4b0e-a7ea-4337ef1863f9', 'SO601061010', 'b35f7739-eb53-469c-b984-d0e3375b0c53', 342377194, 13.63),
  ('e3b34aed-361c-4c26-aad9-37e013f196e7', 'SO601061035', '0777c4e7-6d45-41b2-9fc7-b6e1d08aed22', 342385380, 25.08),
  ('85636cb1-2417-47d2-bfd4-da0c4b070649', 'SO601061037', '011148f0-6a8e-434b-bbb8-32bfe0c10152', 342379567, 22.07),
  ('fea67e31-4e89-4566-b0bd-d38e7338d988', 'SO601061039', '55bf0cdd-9d07-481d-8ed4-da5504f57e7b', 342385976, 35.76),
  ('c4820d1b-8d02-4a97-bbeb-89076721182c', 'SO601061040', '6a2428be-ddd7-4efd-beb2-292e61aeea48', 342381285, 33.69),
  ('1b37808f-b4b8-41ea-8383-78ad263819e7', 'SO601061041', 'e67fe550-0ac2-42d8-9fb3-95370c888780', 342373440, 14.35),
  ('f93176ab-aa0d-4f25-a0fa-7c6b24ff8a79', 'SO601061042', 'af00ab5f-5348-4413-b0d8-5cf10d987e80', 342372136, 16.54),
  ('e656b6fd-974b-472a-92a6-e6974c9d7ff5', 'SO601061043', '58c1de1e-fd03-4031-9df0-36a8f37d5ac6', 342380976, 21.45),
  ('ac7269b9-7f64-4b80-9dfd-a7f63e5b17df', 'SO601061044', '66f6d02f-d30a-42f1-b2ca-b982eb438219', 342372883, 14.35),
  ('6d702d69-ee25-4ce2-bf74-e2d2df9a4cd2', 'SO601061045', '57cd0454-e7fc-4c27-8c7b-fa1eb3fadf08', 342380718, 14.71),
  ('a79e0420-3e3b-4e56-87f0-b0441f6cbcf7', 'SO601061046', '876a1e33-9015-483f-853d-473510c77cc0', 342370166, 20.13),
  ('bbdee262-e03f-4c3f-bb01-9def8cfa6edd', 'SO601061047', 'a324b048-a372-43e0-85cc-eb6c5bd29fa3', 342374206, 16.50),
  ('dfd12fa8-d095-4324-9165-b73f68dd228a', 'SO601061048', '7e057b75-92fa-4b98-9522-37b5440a0ed4', 342377772, 14.35),
  ('59840474-7fda-47e2-88d8-e511e87667eb', 'SO601061049', 'aade7795-a82d-4dc4-a477-48cc573be182', 342378498, 15.27),
  ('9d03a5a5-061c-43a7-916f-239de70b203a', 'SO601061050', '745e5a0e-1bcf-43c8-bfca-1c150499b936', 342380479, 19.71),
  ('70adba8f-8bab-40c9-a02d-f065784c1018', 'SO601061051', '6839bab9-3a7a-4384-bf81-d9a6aa60cdb3', 342388380, 58.21),
  ('00cfecfc-b98e-4a05-a4c4-0017f3e6d32d', 'SO601061052', '555252cb-1243-473b-864d-49c8a68009a8', 342389670, 15.31),
  ('048a718d-5a45-4f44-8679-3c668caaae9e', 'SO601061053', '411dc400-5f20-488f-9db2-0d4febf21e03', 342388923, 14.95),
  ('687c25db-6423-4844-acdc-f139e7371214', 'SO601061054', '1bfc4cb4-3127-499d-8a36-79dd1e338c80', 342379076, 15.31)
),
nayax as (
  select id from public.clients where name = 'Nayax'
),
checked as (
  select snap.order_number,
         snap.client_rate,
         o.order_date,
         o.cancelled,
         s.id as live_shipment_id,
         (s.raw_data->>'shipDate') as carrier_day,
         s.client_rate as live_rate,
         (select count(*) from public.shipments s2
           where s2.client_id = o.client_id and s2.order_number = o.order_number) as n_ship,
         (select count(*) from public.order_charges oc where oc.order_id = o.id) as n_charges,
         (s.raw_data->>'voided' = 'true' or s.raw_data->'voidDate' is not null
           or s.raw_data->'voideDate' is not null) as voided
  from snap
  join public.orders o on o.id = snap.order_id::uuid
  join nayax on nayax.id = o.client_id
  join public.shipments s on s.id = snap.shipment_id::uuid
   and s.shipstation_shipment_id = snap.shipstation_shipment_id
   and s.client_id = o.client_id
   and s.order_number = o.order_number
)
select * from checked
order by order_number;
