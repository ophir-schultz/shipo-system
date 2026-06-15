alter table shipments add column if not exists length numeric(8,2);
alter table shipments add column if not exists width numeric(8,2);
alter table shipments add column if not exists height numeric(8,2);
alter table shipments add column if not exists weight_unit text default 'ounces';
alter table shipments add column if not exists dim_unit text default 'inches';
alter table shipments add column if not exists dim_weight numeric(8,2);
alter table shipments add column if not exists billed_weight numeric(8,2);
