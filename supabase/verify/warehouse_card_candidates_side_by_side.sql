-- Which card should Crisp Power, Kivema, Orcam and Suteka be given a COPY of?
--
-- Run this BEFORE section 2 of warehouse_rate_card_copy_2026_10.sql. The
-- choice of source is the pricing decision -- the three candidate cards
-- disagree with each other (additional_item is 0.20 / 0.30 / 0.50 and
-- inbound_pallet_handling is 7.00 on two cards and 20.00 on a third), so
-- there is no "standard" and picking the source IS picking the rates.
--
-- One row per service_type, one column per candidate. A NULL in a column means
-- that card does not price that service at all -- which matters as much as the
-- numbers: SitnStand prices three services the other two lack, so choosing it
-- gives the four clients boxes for work the other cards cannot bill.
--
-- Read-only.

select
  s.service_type,
  max(case when c.name = 'Creative Pea'          then r.rate end) as creative_pea,
  max(case when c.name = 'Creative Pea'          then r.unit end) as cp_unit,
  max(case when c.name = 'Time Systems (UK) Ltd' then r.rate end) as time_systems,
  max(case when c.name = 'Time Systems (UK) Ltd' then r.unit end) as ts_unit,
  max(case when c.name = 'SitnStand'             then r.rate end) as sitnstand,
  max(case when c.name = 'SitnStand'             then r.unit end) as ss_unit,
  -- How many of the three price it at all. A 1 here is a service only one
  -- candidate knows about; copying that card hands it to four more clients.
  count(r.rate) as cards_pricing_it,
  -- Do the cards that DO price it agree? 'differs' is where the choice costs
  -- or earns money.
  case when count(distinct r.rate) > 1 then 'DIFFERS' else 'same' end as agreement
from (
  -- The union of service names across the three candidates, so a service
  -- missing from one card still gets a row with a NULL in that column.
  select distinct nullif(btrim(coalesce(r.service_type, '')), '') as service_type
  from client_warehouse_rates r
  join clients c on c.id = r.client_id
  where c.name in ('Creative Pea', 'Time Systems (UK) Ltd', 'SitnStand')
    and coalesce(r.effective_from, date '-infinity') <= current_date
    and coalesce(r.effective_to,   date 'infinity')  >  current_date
    and r.rate is not null
) s
left join clients c
  on c.name in ('Creative Pea', 'Time Systems (UK) Ltd', 'SitnStand')
left join client_warehouse_rates r
  on r.client_id = c.id
 and nullif(btrim(coalesce(r.service_type, '')), '') = s.service_type
 and coalesce(r.effective_from, date '-infinity') <= current_date
 and coalesce(r.effective_to,   date 'infinity')  >  current_date
 and r.rate is not null
where s.service_type is not null
group by s.service_type
order by
  -- Disagreements first: those are the lines where the choice of source
  -- changes what these four clients get billed.
  (case when count(distinct r.rate) > 1 then 0 else 1 end),
  s.service_type;
