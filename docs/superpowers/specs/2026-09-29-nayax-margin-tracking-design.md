# Per-order margin tracking, and the Nayax rate card

**Date:** 2026-09-29
**Status: SUPERSEDED — do not implement from this document.**

Replaced by `2026-09-29-complete-the-ledger-design.md`, after the scope widened
from one client's rate card to a business-wide profit-and-loss system. See
`2026-09-29-profit-and-loss-program.md` for the programme outline.

Its findings were measured and remain valid — pick-date derivation, the
device/accessory split, order-versus-shipment anchoring, the Nayax rate card,
and the corrections recorded in §3.1 and §3.2 — and are all carried forward.
This copy is kept for its evidence trail.

Two things the successor establishes that this document could not, because it
was written before the `carrierCode: 'stamps_com'` filter was understood: UPS is
**80% of label spend**, not a rounding error, and re-keying shipments on
`shipmentId` must precede removing that filter.

---

## 1. What this is for

> "add the prices to the sys so we will be able to follow where we are loosing
> how much money and all of the prices details such as order# with his shipping
> pick np apckc and all the prices"

The goal is **margin visibility per order**, not invoicing. For any order you
should be able to see what we charged, what it cost us, and the difference —
broken out by shipping, pick & pack, and the other billable services on the
client's rate card.

Nayax is the first client to load, because its quote arrived and because it is
the largest account by volume. The model has to hold every client's rate card,
not just Nayax's.

**Success looks like:** an order row showing order number, shipping charged vs
shipping cost, pick & pack charged, and net margin — with the numbers traceable
to a specific rate-card line.

---

## 2. Why this is bigger than loading a rate card

The rate card is the small part. Investigation found the system cannot
currently see most of its own business.

### 2.1 The sync drops 71% of traffic

`src/lib/sync/shipstation.ts` hardcodes `carrierCode: 'stamps_com'`. Measured
against ShipStation with no carrier filter, over 30 days:

| Store | USPS | UPS | Units | In Supabase (all time) |
| --- | --- | --- | --- | --- |
| Nayax | 0 | **309** | 8,069 | **1** |
| Suteka | 4 | 190 | 1,792 | 13 |
| SitnStand | 0 | 90 | 106 | **0** |
| Kivema | 305 | 79 | 15 | 151 |
| Orcam | 5 | 66 | 258 | 14 |
| Time System | 0 | 16 | 20 | 1 |
| Crisp Power | 0 | 5 | 54 | 1 |

**776 of 1,095 shipments (71%) never enter the database.** Nayax ships 100% UPS,
which is why it has one shipment on record while running 309 a month.

(The table lists the seven clients with meaningful volume, 1,069 shipments. The
remaining 26 are Creative Pea's 9 plus 17 across two stores with no matching
client row — itself an instance of the unmapped store case in §7.)

This invalidated three conclusions in `docs/unpriced-shipments-findings.md`,
which have been corrected in place. The dangerous one: Orcam's 800 UPS rate rows
and Crisp Power's 216 were described as "dead weight — they can never match
anything." They are correctly keyed for traffic that is never fetched. Deleting
them would have destroyed good data.

### 2.2 Nothing records what was picked

`shipmentItems` is `null` on all 223 stored shipments, because `getShipments`
never passes `includeShipmentItems`. There are zero unit counts in the system,
so pick & pack cannot be computed for anyone.

### 2.3 Client assignment depends on credentials that are broken

`client_id` is never set by the ShipStation sync. It is assigned afterwards by
`syncClientAssignments`, which pulls each client's orders using that client's
own Zenventory key and matches on order number. Each Zenventory API key is
scoped to exactly one client — verified, no key sees any other client's orders.

Nayax and Creative Pea both return **HTTP 401**. So for Nayax there is no
carrier data *and* no client mapping. Nayax's legacy `SecureKey` does work, but
it reaches an endpoint that cannot paginate or filter by date and returns only
open orders, so it does not close this gap (§3.4).

This is also why §5.2 moves client mapping onto ShipStation's `storeId`: it is
present on every shipment and needs no Zenventory credential at all.

### 2.4 The warehouse billing path has never run

`warehouse_daily_log`, `manual_charges`, `bills` and `bill_line_items` are all
empty. `client_warehouse_rates` holds exactly one row — Nayax storage at
$25.00, entered by hand. That is the "Pallet position" line of the quote; the
other seventeen lines have never been entered.

---

## 3. Data sources

**Zenventory is where orders run and where pick & pack happens. ShipStation
prints shipping labels.** That division decides the whole data model: the
billing anchor is the **order**, not the shipment.

| Fact | Source | Field |
| --- | --- | --- |
| Order exists at all | **Zenventory** | `customer-orders` |
| Client identity | Zenventory `client.id`, ShipStation `storeId` | both |
| SKU and description | Zenventory | `items[].sku`, `.description` |
| **Units actually picked** | **Zenventory** | **`items[].pickedQuantity`** |
| Component vs device | Zenventory | `items[].partOfKit`, `.componentOf` |
| Carrier, service, tracking | ShipStation | `carrierCode`, `serviceCode` |
| **What we paid the carrier** | **ShipStation** | **`shipmentCost`** |
| Weight, dimensions | ShipStation | `weight`, `dimensions` |

Zenventory has `shipVia` and `buyerPaidShipping` but no carrier cost, so
ShipStation remains necessary. Neither system alone is sufficient.

### 3.1 Why the anchor must be the order, not the shipment

Measured over 30 days, per client, fully paginated. A **billable orphan** is an
order that is not cancelled, had units picked, and has no ShipStation label —
i.e. real work a shipment-driven ledger cannot bill:

| Client | ZEN orders | Cancelled | Live | Picked units | SS shipments | Billable orphans | Orphan units |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Suteka | 235 | 1 | 234 | 1,486 | 194 | **37** | **186** |
| SitnStand | 97 | 4 | 93 | 231 | 90 | 4 | 129 |
| Crisp Power | 213 | **205** | 8 | 64 | 5 | 3 | 10 |
| Kivema | 8 | 0 | 8 | 18 | **384** | 2 | 4 |
| Time Systems | 17 | 0 | 17 | 25 | 16 | 1 | 5 |
| Orcam | 69 | 1 | 68 | 243 | 71 | 0 | 0 |
| Creative Pea | HTTP 401 | — | — | — | 9 | — | — |
| Nayax | HTTP 401 | — | — | — | 309 | — | — |

**47 orders and 334 picked units in 30 days are billable but invisible to a
shipment-anchored ledger.** That is the argument for anchoring on the order, and
it is a real but modest number — worth stating plainly, because an earlier draft
of this spec claimed 208 for Crisp Power alone and that was wrong: **205 of
Crisp Power's 213 orders are cancelled.** Cancelled orders accrue no pick
charges, so they were never lost revenue. The corrected figure is 3 orders and
10 units for that client.

Two things follow from the correction. First, cancellation is not an edge case
to be handled defensively at the end — Crisp Power cancels 96% of its orders, so
`cancelled` has to be a first-class filter everywhere or every total for that
client is nonsense. Second, the case for order-anchoring rests mainly on
**Suteka**, whose 37 orphans carry 186 picked units, not on the dramatic number
originally quoted.

Kivema runs the opposite way: 384 labels against 8 Zenventory orders. Its
current volume evidently does not route through Zenventory.

So **neither system is universally the master**, and the model must tolerate
orphans in both directions rather than assume a clean one-to-one:

- *Order with no shipment* — picked and billable; shipping cost unknown, not zero
- *Shipment with no order* — shipping cost known; pick & pack unknown, not zero

Both cases are recorded and reported. Neither is silently dropped, and neither
is quietly treated as $0, because a missing charge and a zero charge mean very
different things to a margin figure.

### 3.2 `pickedQuantity`, not `quantity`

**`pickedQuantity` is the billing quantity.** Ordered against picked, 30 days,
fully paginated:

| Client | Ordered | Picked | Picked / ordered |
| --- | --- | --- | --- |
| Suteka | 2,078 | 1,486 | 72% |
| Crisp Power | 334 | 64 | **19%** |
| SitnStand | 237 | 231 | 97% |
| Orcam | 263 | 243 | 92% |
| Kivema | 20 | 18 | 90% |
| Time Systems | 25 | 25 | 100% |

Billing ordered quantity would overbill Suteka by 592 units a month. Crisp
Power's 19% is the cancellation effect from §3.1, not a picking failure.

(An earlier draft cited 935 ordered / 624 picked for Suteka. That came from a
probe that read only page 1 of a paginated endpoint — a 100-order sample
reported as a total. The figures above paginate properly.)

### 3.3 Order number formats differ

Zenventory order numbers carry a client suffix that ShipStation's do not —
Zenventory `#1085 - 333` against ShipStation `#1085`. The join normalises by
taking the portion before ` - `. This is a real integration seam and gets its
own test; a silent mismatch here would present as orphans on both sides and
look exactly like the genuine orphans above.

### 3.4 Fallback when Zenventory is unavailable

Nayax and Creative Pea both return HTTP 401 on the 2.0 API, and each 2.0 key is
scoped to exactly one client — verified against every working key, none can see
another client's orders.

**Nayax does, however, have a working legacy `SecureKey.`** The legacy REST API
(`/services/rest`, `SecureKey` header) returns real Nayax data where the 2.0 key
is refused. This is worth stating plainly because it is the only Zenventory
route to the client this whole design is for. What it gives:

| Endpoint | Result |
| --- | --- |
| `/customerorders` | 29 orders, with `pickprintdate`, `pickedcount`, `orderedcount`, `pickclaimer` |
| `/customerorders/{id}/items` | line items: `sku`, `description`, `orderquantity`, `quantity`, `partofkit` |
| `/items` | 50 SKUs with `category` |
| `/inventory` | stock by SKU |

**But the legacy API cannot be a bulk sync source.** It ignores every parameter
tried — `page`, `perPage`, `limit`, `completed`, `status`, `startdate`,
`ordereddatefrom` all returned byte-for-byte identical responses (28,796 bytes,
the same 29 orders). There is no pagination and no date filter. Every order it
returns is `completed: false`, so it is a fixed window onto **currently open
orders only**; completed history is unreachable. `/items` caps at 50 the same
way.

So the legacy API is a live view, not a ledger. It cannot backfill history and
cannot be trusted to return everything. Its real value is (a) confirming Nayax
data exists and the account is reachable, and (b) `pickprintdate`, discussed
next. Nayax's billable history still has to be synthesised from ShipStation
shipments, using `shipmentItems[].quantity`: ordered quantity, no picked figure.
Every Nayax order with no label remains invisible, the same way the 47 billable
orphans in §3.1 are invisible to a shipment-anchored ledger.

### 3.5 When the pick happened

Pick & pack is billed on the day the pick happened, so every pick charge needs a
date. **Neither API reliably provides one.** Measured across a 391-order sample
— the first page for each of the six reachable clients, which is enough to test
whether a field is ever populated, though not a full census:

| Field | API | Populated | Verdict |
| --- | --- | --- | --- |
| `completedDate` | 2.0 | **0 / 391** | Empty string even when `completed: true`. Unusable. |
| `orderedDate` | 2.0 | 391 / 391 | When the order arrived, not when it was picked |
| `createdDate` | 2.0 | 391 / 391 | Record creation |
| `modifiedDate` | 2.0 | 391 / 391 | Last change of any kind |
| item-level timestamps | 2.0 | **none exist** | No date field on `items[]` at all |
| `pickprintdate` | legacy | 9 / 29 | **Conceptually correct**, but legacy-only |

`completedDate` being empty on all 391 orders — including orders flagged
`completed: true` — is the important negative result. The obvious field is a
dead end.

`pickprintdate` (`"2026-09-28 10:17:44"`, when the pick ticket was printed) is
the only field that genuinely marks picking activity. It is unavailable for
seven of eight clients, and unpaginated for the eighth.

**So the pick date is derived, in this priority order:**

1. **`pickprintdate`** where a legacy `SecureKey` exists and the order appears
   in the open-orders window. Today that is Nayax only. Strictly this is when
   the pick ticket was *printed*, which is the start of picking rather than its
   completion — so it can sit a day earlier than the work on an order picked
   overnight. It is still the best available signal, being warehouse-generated
   rather than inferred, but it is not exact and the spec does not treat it as
   a ground truth worth contradicting other evidence over.
2. **Observation watermark** — the date our own sync *first sees*
   `pickedQuantity` rise above zero for an order. With a daily sync this is
   accurate to the day, and it works for every client without depending on a
   field Zenventory does not expose. This is the primary mechanism going
   forward.
3. **`modifiedDate`**, for backfilling orders picked before this system
   existed. Approximate — it moves on any change — and flagged as such.

Each charge records which rule produced its date (`pick_date_source`), so a
figure derived from a watermark is never presented with the same confidence as
one stamped by the warehouse. The watermark only becomes accurate once the sync
runs daily; that is a prerequisite, recorded in §10, not an assumption.

Every order and charge row records its origin (`source: 'zenventory' |
'shipstation'`), and ShipStation-derived pick charges are flagged
`is_estimate`. They will run high relative to a picked figure, and must never be
presented as though they were measured.

**Restoring the Nayax and Creative Pea keys is the highest-value action
available here**, and it requires no deploy. Until then Nayax margin is an
estimate built from the label layer of a business that runs on the other system.

---

## 4. Scope

**In scope**

- An `orders` table as the billing anchor, fed primarily from Zenventory
- Sync repair: all carriers, line items captured, `client_id` assigned directly
- Rate card model capable of holding the Nayax quote without losing meaning
- Nayax's 18 rate lines loaded, labelled exactly as the quote labels them
- Per-order margin: shipping, pick & pack, peak surcharge
- **A pick date on every picked line, and a per-day view** — by client and day:
  which SKUs were picked, how many units, across how many orders, and what that
  is worth
- Account-level charges that do not attach to an order (storage)

**Out of scope, deliberately**

- *Presentation and styling.* Belongs to
  `2026-09-29-website-design-alignment-design.md`, which is unreviewed. This
  spec produces data and the minimum UI to read it.
- *Invoicing.* The ask is explicitly margin visibility, not billing documents.
  `bills` / `bill_line_items` already exist for that and stay untouched.
- *Receiving, returns, special labour capture.* No data feed exists —
  `warehouse_daily_log` is empty. These stay manual entry. Better to ship
  accurate shipping and pick margin than to fabricate the rest.
- *TOPUP balance automation.* The quote's $5,000 advance and $2,000 alert are
  real, but an account-balance ledger is its own project.

---

## 5. Architecture

### 5.1 Where charges live

Charges are **materialized** as rows, one per charge per order, each carrying
both the rate-card line it came from and the rate value used at calculation
time.

The alternative — deriving charges on read — was rejected because it destroys
history. If a rate changes, every past order silently reprices and "where did we
lose money last month" becomes unanswerable. Materializing with a captured rate
value keeps history while still allowing recalculation.

This also follows a pattern the codebase already has: `recalculateShipments()`
already computes and writes `client_rate` and `profit_loss` onto `shipments`.

**That existing path stays, and keeps ownership of shipping margin.**
`order_charges` rows of `charge_type = 'shipping'` are written from the same
computation rather than by a second, parallel one, so the two cannot disagree.
The existing shipments view continues to work untouched. Retiring
`shipments.client_rate` / `profit_loss` in favour of `order_charges` is a
follow-up, deliberately not bundled here — this spec adds pick, pack and
surcharge margin, which do not exist at all today, and leaves the one margin
calculation that already works alone.

### 5.2 Schema

**`client_store_ids`** — new. Replaces Zenventory as the client mapper.

```sql
create table client_store_ids (
  id uuid primary key default uuid_generate_v4(),
  client_id uuid references clients(id) on delete cascade,
  source text not null,          -- 'shipstation' | 'zenventory'
  external_id text not null,     -- ShipStation storeId, or Zenventory client.id
  label text,                    -- store name as it appears in the source
  created_at timestamptz default now(),
  unique (source, external_id)
);
```

`storeId` is present on every ShipStation shipment and maps cleanly to existing
client rows (Nayax→350349, Kivema→326718 and 342774, Suteka→337203 and 347395,
Orcam→343386, SitnStand→342775, Crisp Power→344458 and 345004, Creative
Pea→348161 and 348165). Several clients have multiple stores, hence a separate
table rather than a column.

**`orders`** — new, and the central change. The billing anchor, because orders
are picked whether or not a label is ever printed.

```sql
create table orders (
  id uuid primary key default uuid_generate_v4(),
  client_id uuid references clients(id),
  order_number text not null,        -- as the source reports it
  order_key text not null,           -- normalised for joining: "#1085 - 333" -> "#1085"
  ordered_date timestamptz,
  completed_date timestamptz,
  cancelled boolean default false,
  source text not null,              -- 'zenventory' | 'shipstation'
  raw_data jsonb,
  created_at timestamptz default now()
);
-- client_id is nullable (unmapped stores, §7), and NULLs are distinct in a
-- normal unique index, which would let re-syncs insert duplicates. Two partial
-- indexes instead, so unmapped orders still dedupe by source identity:
create unique index on orders (client_id, order_key) where client_id is not null;
create unique index on orders (source, order_key)    where client_id is null;
create index on orders (client_id, ordered_date);
```

`shipments` gains `order_id uuid references orders(id)`, matched on
`(client_id, order_key)`. A shipment with no matching order still syncs with
`order_id` null rather than being dropped, and an order is created for it from
the ShipStation side so that every billable thing has an anchor.

`cancelled` matters more than it looks: Crisp Power cancels 205 of 213 orders in
a 30-day window (§3.1). Cancelled orders accrue no pick charges and are excluded
from the daily view, so this column carries most of that client's accuracy.

**`sync_runs`** — new, small, and required by the watermark.

```sql
create table sync_runs (
  id uuid primary key default uuid_generate_v4(),
  source text not null,              -- 'zenventory' | 'shipstation'
  client_id uuid references clients(id),   -- null = account-wide run
  run_date date not null,            -- warehouse-local date
  started_at timestamptz default now(),
  finished_at timestamptz,
  ok boolean,
  orders_seen int,
  error text
);
create index on sync_runs (source, client_id, run_date);
```

The watermark dates a pick to the day it was *observed*, so a missed day
silently rolls that day's picks into the next one. Without a record of which
days actually ran, the daily view has no way to tell a quiet Tuesday from a
Tuesday the sync never happened — and both look like plausible numbers. Any
`pick_date` whose preceding day has no successful run for that client and source
is flagged in the read view as possibly absorbing earlier work.

**`order_items`** — new. One row per line, keyed to the order rather than the
shipment, since a picked line exists before any label does.

```sql
create table order_items (
  id uuid primary key default uuid_generate_v4(),
  order_id uuid references orders(id) on delete cascade,
  line_ordinal int not null,       -- position within the order, from the source
  sku text,
  description text,
  quantity_ordered numeric(10,2),
  quantity_picked numeric(10,2),   -- Zenventory pickedQuantity; null if unknown
  is_component boolean,            -- from partOfKit/componentOf, category, or SKU rule
  classification_source text,      -- kit_flag | category | sku_prefix | unknown
  pick_date date,                  -- the DAY this line was picked (see 3.5)
  pick_date_source text,           -- pickprintdate | watermark | modified_date
  is_estimate boolean default false, -- true when derived from ShipStation
  source text not null,            -- 'zenventory' | 'shipstation'
  created_at timestamptz default now(),
  unique (order_id, source, line_ordinal)
);
create index on order_items (order_id);
create index on order_items (pick_date, sku);
```

Zenventory supersedes ShipStation for the same order. The two sources share no
line identifier, so rather than reconcile row by row a sync deletes all rows for
`(order_id, source)` and reinserts. That keeps both syncs idempotent and lets
either run first without duplicating lines.

**Both sources' rows can therefore coexist for one order**, which matters for
every consumer: anything reading `order_items` for billing must select a single
source per order — Zenventory where any Zenventory row exists, else ShipStation
— or it will double-count. This is applied in the `pick_days` view below and in
charge calculation.

**`pick_date` is set once and never moved.** Per §3.5 it comes from
`pickprintdate` where available, otherwise from the watermark — the first sync
that observes `quantity_picked > 0`. The delete-and-reinsert above would destroy
a watermark, so before deleting, the sync reads existing `(line_ordinal,
pick_date, pick_date_source)` for that `(order_id, source)` and restores them
onto the reinserted rows.

`line_ordinal` exists for exactly this reason. Matching on SKU is not sufficient
— a kit can list the same SKU on two lines — and matching on `id` is impossible
across a delete. The carry-forward is keyed on `(order_id, source,
line_ordinal)`.

**Carry-forward is unconditional whenever a `pick_date` already exists**, not
conditional on the picked quantity being unchanged. A line picked 3 of 10 on
Monday and 10 of 10 on Tuesday was still first picked on Monday; re-stamping it
Tuesday because the quantity moved would contradict "set once and never moved"
and would silently shift revenue between days. A *downward* correction is
treated the same way: the date stays, only the quantity changes. The only case
that clears a `pick_date` is `quantity_picked` returning to zero, which means
the pick was undone.

`pick_date` is a `date`, not a `timestamptz`. The charge lands on a warehouse
day, and a timestamp would invite timezone bugs at exactly the boundary that
decides which day gets billed. **"Today" for watermarking purposes means the
current date in the warehouse's local timezone (US Eastern), not UTC** — a sync
running at 02:00 UTC would otherwise stamp the following day.

Warehouse-local is necessary but not sufficient, because of when the scheduled
runs actually fall. Per §10 the crons fire at 02:00, 10:00 and 16:00 ET. A pick
finished at 17:00 Monday is first observed by the 02:00 **Tuesday** run, and a
naive "today in ET" would bill it to Tuesday. So the rule is: **if the observing
run's warehouse-local time is before 06:00, stamp the previous warehouse day.**
Nothing is picked between midnight and 6am; a watermark set in that window is
always evidence about the day that just ended. This is a property of the
schedule, so if the cron times in `vercel.json` change, this cutoff has to be
revisited with them — the two are coupled, and a comment in both places should
say so.

**`pick_days`** — new view, not a table. This is the "what was picked that day"
answer, derived rather than stored so it cannot drift from the lines it
summarises.

```sql
create view pick_days as
with preferred as (            -- one source per order: Zenventory wins
  select distinct on (oi.order_id)
         oi.order_id,
         oi.source
  from order_items oi
  order by oi.order_id,
           case oi.source when 'zenventory' then 0 else 1 end
)
select
  o.client_id,
  oi.pick_date,
  oi.sku,
  max(oi.description)                           as description,
  bool_or(oi.is_component)                      as is_component,
  count(distinct o.id)                          as orders,
  sum(oi.quantity_picked)                       as units_picked,
  bool_or(oi.is_estimate)                       as has_estimates,
  min(case oi.pick_date_source                  -- 1 = least confident
        when 'pickprintdate' then 3
        when 'watermark'     then 2
        when 'modified_date' then 1
        else 0                                  -- null/unknown: trust nothing
      end)                                      as confidence
from order_items oi
join orders o   on o.id = oi.order_id
join preferred p on p.order_id = oi.order_id and p.source = oi.source
where oi.pick_date is not null
  and oi.quantity_picked > 0
  and not o.cancelled
group by o.client_id, oi.pick_date, oi.sku;
```

This gives, per client per day: which SKUs were picked, how many units of each,
how many orders they spanned, and how trustworthy the date is.

Two details are deliberate. The `preferred` CTE picks **one source per order**,
because §5.2 allows Zenventory and ShipStation rows to coexist and summing both
would double every unit. And `confidence` takes the **minimum of a mapped
integer** — 3 `pickprintdate`, 2 `watermark`, 1 `modified_date`, 0 unknown, so
**1 is worst and 3 is best** — meaning a day mixing one warehouse-stamped line
with fifty inferred ones reports as inferred. `min()` on the raw text would
return `'pickprintdate'` alphabetically and present the whole day as measured,
which is precisely backwards. The `else 0` matters for the same reason: a null
or unrecognised source would otherwise be skipped by `min()` and let the day
inherit a better rating than it earned.

Cancelled orders are excluded here rather than at charge time, so the
operational view and the billing view cannot disagree. Given Crisp Power's 205
cancellations in 30 days, this filter is doing real work, not guarding an edge
case.

**The view reports units, not money.** Revenue per day is
`sum(order_charges.amount)` filtered on `charge_date`, which is the only figure
that accounts for rate changes, the peak surcharge, and ShipStation-estimated
picks that carry a charge but no `quantity_picked`. The two are reconciled in
testing on unit counts, not dollars — the view is the operational answer to
"what did we pick on Tuesday," `order_charges` is the financial one.

**`client_warehouse_rates`** — extended. The current shape
(`service_type / rate / unit`) cannot hold the quote.

```sql
alter table client_warehouse_rates
  add column label text,             -- exact wording from the quote
  add column category text,          -- inbound | storage | outbound | returns
  add column description text,       -- the qualifying conditions
  add column rate_type text,         -- see below
  add column sort_order int default 0,
  add column effective_from date,
  add column effective_to date;

-- 'at_cost' lines have no rate at all (see 6), so rate must be nullable.
alter table client_warehouse_rates alter column rate drop not null;
```

All columns are added, none dropped. `service_type` and `unit` stay and keep
working; `category`/`rate_type` are the richer replacements that new code reads.
The single existing row — Nayax storage, $25.00, `per_pallet` — is backfilled to
`label = 'Pallet position'`, `category = 'storage'`, `rate_type = 'per_pallet'`
rather than reinserted, so nothing references a row that disappeared. Retiring
the old columns is deliberately left for after this ships, when it can be done
knowing what actually reads them.

`rate_type` vocabulary: `per_unit`, `per_carton`, `per_pallet`, `per_shelf`,
`per_hour`, `per_box`, `flat`, `percentage`, `cost_plus`, `at_cost`.

The last three do not exist today and the quote cannot be represented without
them — peak season is `percentage`, packing materials is `cost_plus`, carrier
freight is `at_cost`.

**Storage carries a time dimension the others do not.** A pallet position is
$25.00 *per pallet per month*, not per pallet. Rather than add a period column
used by two rows, `category = 'storage'` is defined to mean "charged monthly per
unit held." Any future rate needing a different period forces a real period
column at that point; inventing one now would be speculative.

**`description` is commercially load-bearing, not documentation.** "Full carton
pick — $1.50" carries the condition *"effective only with one barcode that scans
all the SKUs in a single scan."* Without that text, a 20-unit carton bills at
$1.50 instead of $6.40. Dropping the qualifier silently changes the price.

**`order_charges`** — new. The margin record.

```sql
create table order_charges (
  id uuid primary key default uuid_generate_v4(),
  order_id uuid references orders(id) on delete cascade,
  client_id uuid references clients(id),
  rate_id uuid references client_warehouse_rates(id),
  charge_type text not null,     -- shipping | pick | pack | surcharge | material
  label text not null,           -- as shown to a human
  quantity numeric(10,2),
  unit_rate numeric(10,4),       -- rate at time of calculation
  amount numeric(10,2) not null, -- charged to client
  cost numeric(10,2),            -- our cost, where known
  charge_date date not null,     -- the day this charge belongs to
  charge_date_source text,       -- pickprintdate | watermark | modified_date | ship_date
  source text not null,          -- zenventory | shipstation | manual
  is_estimate boolean default false,
  calculated_at timestamptz default now()
);
create index on order_charges (order_id);
create index on order_charges (client_id, charge_date);
```

Charges hang off the **order**, not the shipment. Pick & pack is earned when the
order is picked; shipping cost arrives later and only if a label is printed.
Keying to the shipment would have made the 47 billable orphan orders of §3.1 —
334 picked units, mostly Suteka's — unbillable.

**`charge_date` is what makes the ledger answer "what did we earn on Tuesday."**
It is distinct from `calculated_at`: a pick that happened on the 3rd and was
first computed on the 5th belongs to the 3rd. Pick and pack charges take
`charge_date` from the line's `pick_date`; shipping takes it from the shipment's
ship date; the peak surcharge takes it from the charge it uplifts, so an order
straddling January 15 cannot uplift the wrong day's work. Nothing derives it
from `now()`, because a re-run would then silently move historical revenue.

`amount − cost` is the margin. Shipping has both sides. Pick & pack has a charge
but no directly attributable cost, so `cost` is null and margin is reported as
revenue rather than profit for those lines — labour cost allocation is a
separate problem and pretending otherwise would produce a confidently wrong
number.

**Account-level charges.** `order_charges` is keyed to an order, so storage
has nowhere to go. It does not need a new table: `warehouse_daily_log` already
exists with `client_id / log_date / service_type / quantity / rate / total` and
has never been used. Storage is recorded there as a monthly entry, referencing
the same `client_warehouse_rates` line. Account-level totals are the sum of
`warehouse_daily_log` for the period; per-order margin is the sum of
`order_charges`. Storage is deliberately **not** allocated across orders —
spreading a fixed monthly cost over a variable order count produces a per-order
margin that moves when nothing about the order changed.

**`zone_chart`** — gains a `carrier` column. It holds a UPS chart while both
carriers are now live, and has no carrier dimension.

```sql
alter table zone_chart add column carrier text;
update zone_chart set carrier = 'UPS' where carrier is null;
```

Existing rows are backfilled to `'UPS'`, which is what they are. The column is
left nullable so the backfill cannot fail on rows added between migration and
update; a null carrier is treated as "matches any" by `resolveZoneRate`, which
preserves today's behaviour rather than silently unpricing anything.

### 5.3 Sync changes

The order of these two syncs inverts. Today ShipStation creates the records and
Zenventory annotates them. It becomes the reverse.

**`src/lib/sync/zenventory.ts` — now the primary sync.**

1. For each client with working credentials, pull `customer-orders` and upsert
   into `orders` on `(client_id, order_key)`, `source: 'zenventory'`. Client
   identity comes from the key itself, so no name matching is needed.
2. Write `order_items` from `items[]` with `pickedQuantity` and the kit flags,
   `source: 'zenventory'`, replacing that source's rows for the order.
3. **Stamp `pick_date`.** Before replacing a line's rows, read the existing
   `(line_ordinal, pick_date, pick_date_source)` for that `(order_id, source)`
   and restore them onto the reinserted rows. Set a *new* `pick_date` only when
   `pickedQuantity > 0` and no date is carried forward. Restoration is
   unconditional — it does **not** depend on the picked quantity being
   unchanged — with one exception: if `pickedQuantity` has returned to zero the
   pick was undone, and `pick_date` is cleared rather than carried. Which date
   gets written depends on the mode:
   - **Live mode** (the order was modified within this sync's window): today's
     warehouse-local date, `pick_date_source: 'watermark'`.
   - **Backfill mode** (§9 step 4, a widened window over historical orders):
     `modifiedDate`, `pick_date_source: 'modified_date'`. Without this
     distinction the backfill would stamp every historical pick with the deploy
     date and manufacture one enormous fictitious pick day. The sync takes the
     mode as an explicit parameter rather than inferring it.
4. Record the run in `sync_runs`, success or failure, before returning.
5. Fix `if (clientErrors.length === clients.length)` — it currently only reports
   when *every* client fails, which is exactly how Nayax and Creative Pea sat at
   401 unnoticed. Any client failing must surface.
6. Paginate on `meta.totalPages`. `perPage` caps at 100, and reading page 1 only
   understates Crisp Power by 113 orders and Suteka by 135.

**Cutover.** A live run finds orders already picked and stamps them all with
that day, producing one artificial spike. So the **very first execution after
deploy must be a backfill run** (§9 step 2a), before any live run. Existing
picks then date from `modifiedDate`, and only genuinely new picks watermark
afterwards.

**Source switching.** When Zenventory rows first supersede an order that
ShipStation created, the new rows are keyed to a different `source` and inherit
no carry-forward, so they would be watermarked with today's date even though the
pick is older. To prevent the date moving, a line with no carry-forward of its
own inherits `pick_date` from the same order's other source where one exists,
preferring the earlier date. Only an order with no prior `pick_date` on any
source gets a fresh watermark.

**Legacy `pickprintdate` overlay — Nayax only.** Where a client has a
`zenventory_secure_key`, pull `/services/rest/customerorders` and, for orders
matched on `ordernumber`, set `pick_date` from `pickprintdate` with
`pick_date_source: 'pickprintdate'`, overriding any watermark. This endpoint
takes no parameters and returns only currently-open orders (§3.4), so it is a
best-effort improvement on a narrow slice, not a sync path — it must never be
the sole source for a client, and an empty response is not evidence that nothing
was picked.

**`src/lib/sync/shipstation.ts` — now the cost layer.**

1. Remove `carrierCode: 'stamps_com'` — recovers 71% of shipments
2. Add `includeShipmentItems: true` to `getShipments` params and its type
3. Resolve `client_id` from `advancedOptions.storeId` via `client_store_ids`
4. Link each shipment to its order on `(client_id, order_key)`. Where no order
   exists — Kivema, Nayax — create one with `source: 'shipstation'` and write
   `order_items` from `shipmentItems` with `is_estimate = true`.
5. Record the run in `sync_runs`.

Running Zenventory first means most orders already exist when ShipStation
arrives, so the ShipStation-created orders are genuinely the orphans rather than
a race artifact. Both syncs are idempotent, so order is a matter of data
quality, not correctness.

Backfill is a re-sync over a widened date range, not a data migration.

### 5.4 The device / component split

Nayax's quote prices two different picks:

- Device pick + serial number scan — **$0.32/unit**
- Component / accessory pick — **$0.20/unit**

Across 8,069 monthly units that is a **$968/month** spread, so the rule matters.

**Decision: SKU prefix.** SKUs beginning `R` or `D` are serialized devices
(`R144GUSY01S10`, `R144GUSB01S10` readers; `D600005S10` ONYX). Everything else —
cables `C*`, antennas `510*`, cards and adapters `M*`, brackets `NX-*`/`P*` — is
a component. That splits roughly 2,990 device units against 5,079 component
units, about $1,973/month.

Zenventory also carries a native `category` on `/items`, which looked like it
should beat any prefix guess. **It does not, and the way it fails is the reason
to keep the prefix rule.** In the sample returned: 46 `Components`, 1 `Devices`,
3 blank — and the three blanks are `C150008`, `R144GUSB01S10`, `R144GUSY01S10`.
The category is empty on precisely the two highest-volume device SKUs, which
together account for 2,935 of the ~2,990 monthly device units. `imastercategory`
is blank on the same three. Trusting the field would classify almost every
device as a component and underbill by roughly $0.12 × 2,935 ≈ **$352/month**.

That sample is 50 items, which is the legacy endpoint's hard cap (§3.4) and not
necessarily the whole catalogue. It is sufficient to show the field is
unreliable — a single blank on a top device SKU does that — but it is not
sufficient to conclude the field is reliable for anything else, and the design
does not assume so.

So the precedence is: `partOfKit`/`componentOf` where set, then `category` where
non-blank, then the SKU prefix rule, which is what actually resolves the device
SKUs today. Because `category` is demonstrably wrong by omission, it never
overrides a prefix match on a known device prefix; it only classifies SKUs the
prefix rule does not recognise. Every row records which rule decided it, in
`classification_source`, so the split can be audited rather than trusted.

Items where all three are silent are **reported, not defaulted**. Component is
the cheaper rate, so a silent default would quietly bill in the client's favour
and never be noticed. The rule lives in one function —
`src/lib/billing/classify-sku.ts` — with the prefix list in that module's
exported constant, not scattered through the sync.

### 5.5 Peak surcharge

+8% of outbound charges, **October 15 to January 15**. Implemented as a
`percentage` rate line with `effective_from` / `effective_to`.

**The base is the order's `pick` and `pack` charges only.** Stating it as "8% of
outbound charges" is ambiguous, because §6 files Carrier freight under
`category = 'outbound'` while it is billed `at_cost` — uplifting it would mark
up a pass-through and overcharge on every order. The base is defined by
`charge_type in ('pick','pack')`, not by rate category. It also excludes
`surcharge` so the uplift can never compound on itself.

Nayax's quote has no separate packing line — packing is included in the pick
rate — so `pack` produces no charges for Nayax today. It stays in the base
definition because `charge_type` is shared across all clients and another rate
card may well price packing separately.

The two vocabularies are related but not interchangeable: `category` describes
where a rate sits in the quote, `charge_type` describes what a computed charge
is. The surcharge base is defined in terms of `charge_type` deliberately.

`charge_date` for the surcharge is the `charge_date` of the charges it uplifts,
so an order picked on January 14 and shipped on January 16 is uplifted on the
pick, correctly, and an order picked after the window is not uplifted at all.

Peak begins in roughly two weeks. If nothing computes it, it does not get
billed.

---

## 6. The Nayax rate card

Eighteen lines, labelled exactly as the quote labels them.

| Category | Label | Rate | Type |
| --- | --- | --- | --- |
| inbound | Pallet receiving | 20.00 | per_pallet |
| inbound | Carton receiving | 0.85 | per_carton |
| inbound | Container devanning 20ft | 450.00 | flat |
| inbound | Container devanning 40ft | 650.00 | flat |
| storage | Pallet position | 25.00 | per_pallet |
| storage | Shelf | 12.00 | per_shelf |
| outbound | Device pick + serial number scan | 0.32 | per_unit |
| outbound | Component / accessory pick | 0.20 | per_unit |
| outbound | Full carton pick | 1.50 | per_carton |
| outbound | Full pallet scan | 12.50 | per_pallet |
| outbound | Full pallet pick | 20.00 | per_pallet |
| outbound | Pallet + shrink wrap | 15.00 | per_pallet |
| outbound | Carrier freight | null | at_cost |
| outbound | Peak season surcharge | 8.00 | percentage |
| returns | Return processing | 3.00 | per_box |
| returns | Additional returned item | 0.35 | per_unit |
| returns | Special labour | 48.00 | per_hour |
| returns | Packing materials | 15.00 | cost_plus |

**How `rate` is read, per `rate_type`** — this is not obvious from the number
alone and getting it wrong is an order-of-magnitude error:

| `rate_type` | `rate` means | Charge |
| --- | --- | --- |
| `per_unit`, `per_carton`, `per_pallet`, `per_shelf`, `per_hour`, `per_box` | dollars per unit of that thing | `rate × quantity` |
| `flat` | dollars, once | `rate` |
| `percentage` | **percent, not fraction** — 8.00 means 8% | `base × rate / 100` |
| `cost_plus` | **percent markup on our cost** — 15.00 means cost + 15% | `cost × (1 + rate / 100)` |
| `at_cost` | `rate` is **null**; there is no rate | `cost` |

`rate` is therefore nullable, which it must be for `at_cost` to exist at all. A
null `rate` on any other type is a data error and is reported, not treated as
zero.

Storage is monthly and billed in advance; it does not attach to an order.

**The `description` column must be populated for all eighteen lines**, not just
the one quoted in §5.2. The qualifying conditions are part of the price, and the
implementation task is to transcribe them from the quote verbatim rather than
summarise them.

**Volume note.** The quote assumes roughly 1,464 orders/month against a 3,500
ceiling, and allows re-quoting if the mix shifts by more than 25%. Actual
measured volume is **309 shipments in 30 days** — about 21% of the assumption.
Whether that is a ramp or a misread, it is a margin question the system should
surface rather than bury.

---

## 7. Error handling

The theme: **missing is not zero.** Every gap below is recorded and reported
rather than defaulted, because a $0 charge and an unknown charge look identical
in a margin total and mean opposite things.

- **Order with no shipment** (47 in 30 days: Suteka 37, SitnStand 4, Crisp
  Power 3, Kivema 2, Time Systems 1). Pick & pack
  charges normally; shipping is reported *unknown*, never $0. Expected, not an
  error.
- **Shipment with no order** (Kivema, Nayax). An order is created from the
  ShipStation side, `source: 'shipstation'`; pick & pack is an estimate from
  ordered quantity and flagged.
- **Unmapped store.** Shipment syncs with `client_id` null and is counted, not
  dropped. A silent drop is how the current gap went unnoticed.
- **Zenventory failure for one client.** Logged per client and surfaced
  immediately. It must not require *all* clients to fail before reporting —
  that bug is why two clients sat at 401.
- **Missing items.** Charge rows are not fabricated. The order shows shipping
  margin and pick & pack marked unavailable.
- **Missing rate line.** The charge is skipped and the order flagged, matching
  how unpriced shipments surface today.
- **Cancelled order.** No pick charges accrue.
- **Picked but no pick date.** Possible for history synced before watermarking
  existed. The charge is still raised — the work happened — with `pick_date`
  from `modifiedDate` and `pick_date_source: 'modified_date'`. It appears in
  daily totals marked approximate rather than being excluded, since excluding it
  would make a day's revenue look lower than it was.
- **A missed sync day.** The watermark dates picks to the day they were
  *observed*, so a sync that skips two days attributes both days' picks to the
  third. The daily view cannot detect this on its own, so the sync records its
  own run days and the view flags any date whose preceding day had no successful
  run. Silently plausible-looking numbers are the failure mode to avoid here.
- **`pickprintdate` disagrees with an existing watermark.** `pickprintdate`
  wins, and the correction is logged. It is a warehouse-stamped fact against our
  inference.
- **Recalculation.** Rerunning replaces that order's `order_charges` rather than
  appending, so it is idempotent. `charge_date` is recomputed from `pick_date`,
  never from the run date, so a re-run cannot move revenue between days.

---

## 8. Testing

- Order-number normalisation: Zenventory `#1085 - 333` joins ShipStation `#1085`
- An order with no shipment still produces pick charges, and reports shipping
  unknown rather than zero
- A shipment with no order creates one, and its pick charges are `is_estimate`
- `pickedQuantity` preferred over `quantity` when both are present
- Cancelled orders accrue no pick charges
- Zenventory pagination follows `meta.totalPages` — a single-page read
  understates Crisp Power by 113 orders
- A single client's 401 is reported while other clients still sync
- SKU classification: `R144GUSY01S10`→device, `C130001`→component,
  `510021`→component, `NX-MA0119`→component
- A blank Zenventory `category` falls through to the prefix rule rather than
  defaulting to component — `R144GUSB01S10` has a blank category and must still
  price at $0.32
- `pick_date` is stamped only when `pickedQuantity` first exceeds zero, not when
  the order appears
- `pick_date` survives the delete-and-reinsert of `order_items`
- **`pick_date` survives a partial pick completing** — 3 of 10 on day one, 10 of
  10 on day two, date stays day one. This is the case an earlier draft got
  wrong by making carry-forward conditional on unchanged quantity.
- `pick_date` survives a downward quantity correction, and clears only when
  `quantity_picked` returns to zero
- Carry-forward matches on `line_ordinal`, so an order with the same SKU on two
  lines keeps both dates correctly
- Backfill mode stamps `modified_date`, not today — a backfill does not create
  one giant fictitious pick day
- Watermark uses warehouse-local date, not UTC: a sync at 02:00 UTC stamps the
  previous day
- `pickprintdate` overrides a watermark for the same order
- `charge_date` follows `pick_date`, not the calculation date — recalculating an
  old order does not move it into today
- **`pick_days` does not double-count an order present from both sources** —
  Zenventory wins, and total units equal the Zenventory rows alone
- `pick_days.confidence` reports the *least* confident line in the group, so one
  `pickprintdate` line among fifty watermarks does not present the day as
  measured
- `pick_days` unit totals equal the sum of `order_items.quantity_picked` for
  non-cancelled orders of the preferred source on that day
- A cancelled order disappears from `pick_days` as well as from charges
- Percentage surcharge applies only inside its date window, and only to
  `charge_type in ('pick','pack')` — **never to carrier freight**, despite that
  rate sitting in the `outbound` category
- The surcharge does not compound on itself across recalculations
- `percentage` 8.00 computes 8%, not 800% or 0.08%; `cost_plus` 15.00 computes
  cost × 1.15
- `at_cost` with a null rate charges cost; a null rate on any other type is
  reported as a data error, not treated as zero
- Recalculating an order twice produces one set of charges, not two
- A shipment whose store maps to no client still syncs, with null `client_id`,
  and a re-sync does not duplicate it
- Zone resolution for `{carrier, service:''}` cards — currently missing, and
  load-bearing once UPS traffic arrives

Against real data, 30-day window: Suteka ~235 orders, 2,078 ordered units,
1,486 picked, 37 billable orphans; Crisp Power 213 orders of which **205
cancelled**, leaving 8 live and 3 orphans; Orcam 0 orphans. Every one of the 33
unpriced shipments catalogued in `docs/unpriced-shipments-findings.md` should
either price or report a specific reason.

The Crisp Power cancellation figure is the single best regression check in this
list — if a change makes that client's picked units jump, cancellation filtering
has broken somewhere.

---

## 9. Sequence

1. `orders`, `order_items`, `client_store_ids` + mapping rows — additive, no
   behaviour change
2. Zenventory sync becomes primary: pull orders, paginate properly, fix the
   all-must-fail error check, **stamp `pick_date` on first observed pick**, and
   record runs in `sync_runs`. Wire it into `/api/agent/monitor`, which is
   already on a thrice-daily cron (§10) — no new scheduler is needed.
   **Its first execution runs in backfill mode** — see step 2a — and every run
   after that is live.
   - 2a. One backfill run over a widened window, stamping `modified_date`. This
     must happen before any live run, or every already-picked order is
     watermarked with the deploy date and the first day shows a spike that
     never occurred.
3. ShipStation sync becomes the cost layer: drop the carrier filter, include
   items, link to orders by `order_key`
4. Backfill re-sync over a widened window for the **ShipStation** side, now that
   orders exist to link to
5. Rate card schema extension + Nayax's 18 lines
6. `order_charges` + calculation, `charge_date` from `pick_date`
7. `pick_days` view + minimal read view: per client per day, SKUs, units, value

1–4 are the prerequisite. Until they land, the 47 picked-but-unlabelled orders
of §3.1 are invisible and Nayax has a single shipment on record.

**Step 2 starts the clock on the watermark.** Every day between that deploy and
step 6 still accumulates accurate pick dates, so the daily view has real history
the day it ships. Deferring step 2 does not delay the feature by a day, it
delays it by a day and loses a day.

---

## 10. Prerequisites outside this work

- **Restore Zenventory credentials for Nayax and Creative Pea.** Both 401 on the
  2.0 API. Until then Nayax pick & pack is a ShipStation estimate on ordered
  quantity, with no measured pick date. No deploy required, and it is still the
  single highest-value action available.
- **The schedule exists — but it does not yet run the job this design needs.**
  The watermark in §3.5 dates a pick to the day it is first observed, so its
  accuracy is exactly the sync's frequency. An earlier draft listed "does a
  schedule exist?" as an open question; it has since been checked, and the
  answer is better than assumed. `vercel.json` declares three crons on
  `/api/agent/monitor`, at 06:00, 14:00 and 20:00 UTC — **02:00, 10:00 and 16:00
  US Eastern**, i.e. twice within the warehouse day plus an overnight run. The
  same route is also polled every five minutes by the AutoSync widget whenever a
  staff member has the dashboard open, which in practice gives far finer
  resolution, but that is opportunistic and cannot be relied on. The cron is the
  floor.

  What the route does **not** do is pull Zenventory orders. It calls
  `syncShipments(7)` and `syncClientAssignments(7)`, and
  `syncClientAssignments` only maps stores to clients — it reads no order lines
  and no picked quantities. So the scheduling infrastructure is already in
  place and correct; the work in §9 step 2 is to add the new Zenventory order
  sync to this existing route, not to build a scheduler. That is a materially
  smaller task than this spec previously assumed.

  Two consequences follow. First, the 16:00 ET run is the last one inside the
  working day, so picks completed after 16:00 are first observed overnight —
  handled by the before-06:00 rule in §5.2. Second, three runs a day means a
  single failed run does not lose a pick day, because the next run still
  observes the same unchanged `pickedQuantity`; only a full day of failures
  does, which is what `sync_runs` exists to detect.
- **Rate cards for Orcam, Suteka, Crisp Power.** Real rates still needed, per
  `docs/rate-card-worklist.md`.
- **Do not run Section B of `scripts/proposed-zone-chart-198.sql`.** It converts
  a UPS chart to USPS while 71% of traffic is UPS. Section A (14 territory rows)
  remains safe and correct.
