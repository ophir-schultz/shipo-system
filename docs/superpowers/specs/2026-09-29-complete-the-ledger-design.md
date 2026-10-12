# Complete the ledger — every dollar, both sides

**Piece 1 of five.** See `2026-09-29-profit-and-loss-program.md` for the
programme outline and why this comes first.

**Supersedes** `2026-09-29-nayax-margin-tracking-design.md`, whose measured
findings are carried forward here.

---

## 1. What this is for

> A system that knows all our profit and loss, and checks where the leaks of
> money are. From the top till the tiny bits, so we can see we are not losing a
> dime.

That needs two things the system does not have. Every dollar of cost has to be
visible, and every dollar of revenue has to have a cost figure beside it. Today
neither is true: 80% of label spend never reaches the database, and every cost
column in the schema describes the carrier label — nothing records the cost of
labour, materials or space.

This piece closes both gaps. It does not reconcile against the actual bills,
does not track fuel surcharges, does not build the agents, and does not build
the dashboard — those are pieces 2 to 5, and each of them measures a number that
is wrong until this lands.

**Success looks like:** for any month, a single figure for revenue, direct cost,
gross margin and net; the ability to drill from that figure to one client, one
day, one order, one SKU; and a named, quantified answer to "where is the money
leaking."

---

## 2. What is wrong today

### 2.1 Four out of five label dollars are invisible

`src/lib/sync/shipstation.ts:19` passes `carrierCode: 'stamps_com'` to the
ShipStation API. Measured over 30 days:

| Carrier | Shipments | Spend | Share |
| --- | --- | --- | --- |
| `ups_walleted` | 776 | $12,484.09 | **80.1%** |
| `stamps_com` | 319 | $3,106.94 | 19.9% |
| **Total** | **1,095** | **$15,591.03** | |

**About $12,500 a month of label cost — the largest variable cost in the
business — never enters the database.** This is one line of code. It is the
highest-value change in the repository and everything else in this spec is
downstream of it.

It also invalidates an earlier conclusion recorded elsewhere in the repo. The
note in `scripts/diag-zone-rate-delta.mjs` that "100% of shipments are
STAMPS_COM (USPS), but `zone_chart` is a UPS chart" was an artifact of this
filter. UPS is 80% of real traffic, so **the UPS chart is correct**, and
**Section B of `scripts/proposed-zone-chart-198.sql` must never run** — it would
convert a correct chart into a wrong one. Section A's 14 territory rows remain
safe and additive.

`ups_walleted` is ShipStation's own UPS account rather than a direct UPS
account. That matters for piece 2: there are two statements to reconcile, one
from ShipStation and one from Stamps.com, not a single carrier invoice.

### 2.2 The database records what we charge, never what we pay

`client_warehouse_rates.rate`, `manual_charges.amount`,
`warehouse_daily_log.rate`, `bills`, `bill_line_items` — every one is a revenue
figure.

There are cost columns, but **every cost column in the schema describes the
carrier label and nothing else**: `shipments.actual_cost`, and
`rate_adjustments.original_cost` / `adjusted_cost` / `adjustment_amount`, which
record a carrier's re-rate of that same label.

So the system can answer "are we losing money on shipping?" It cannot answer
"are we losing money on Suteka?", because after freight the largest cost is
labour and labour appears nowhere. This is the structural gap between the
billing system that exists and the P&L system being asked for.

### 2.3 Nothing records what was picked

`order_items` does not exist. Pick and pack revenue is therefore either
unbillable or estimated from ordered quantity, which overstates it — measured
pick rates run 19% to 79% of ordered depending on the client (§3.3).

Worse, the pick is the one event that definitely happened in the warehouse and
definitely cost labour. Without it there is no denominator for a cost-per-pick,
so §5.4 has nothing to derive from.

### 2.4 Client assignment depends on credentials that are broken

Zenventory API 2.0 returns HTTP 401 for **Nayax** and **Creative Pea**. Client
assignment currently runs through Zenventory, so those clients cannot be mapped
reliably and their shipments land unattributed.

Nayax's *legacy* SecureKey works where its 2.0 key does not, which proves the
account is reachable, but the legacy endpoint ignores every parameter tried
(`page`, `perPage`, `limit`, `completed`, `status`, and three date forms all
returned byte-identical 28,796-byte responses) and serves only open orders. It
is a live view, not a sync path. §5.2 replaces the dependency with a stored
store-to-client map so a credential outage stops being an attribution outage.

### 2.5 The warehouse billing path has never run

`client_warehouse_rates` exists and is queried nowhere in the billing flow.
Pick, pack, storage, receiving and materials revenue has never been calculated
by this system for any client.

---

## 3. Evidence

All figures below are from paginated, read-only probes committed alongside this
spec. Where an earlier draft was wrong, the correction is stated rather than
quietly swapped.

### 3.1 Label spend and voided labels

`scripts/probe-label-leaks.mjs`, 30 days:

- 1,095 shipments, $15,591.03, split 80/20 UPS to Stamps.com (table in §2.1).
- **`shipmentCost` is populated on all 1,095 rows.** No shipment silently bills
  at 100% margin.
- **`insuranceCost` is zero on every row.** Not a leak source; not modelled.
- **12 voided labels, $165.03, 1.1% of spend.** ShipStation records the void.
  Only the carrier statement proves the refund landed. Roughly $2,000 a year of
  exposure if refunds are not arriving — quantified here, resolved in piece 2.
- **No return labels at all** in the window (`isReturnLabel` false throughout),
  despite the Nayax quote carrying three returns lines. Either returns are not
  flowing through ShipStation or they are not happening. Worth knowing before
  building returns billing.

A correction: the first run of this probe reported all 1,095 shipments as
voided. ShipStation's `voids=true` parameter *includes* voided shipments rather
than isolating them; the authoritative signal is the per-shipment `voided`
boolean. The probe now carries a comment saying so.

### 3.2 Order-number collisions, newly exposed by the fix

`scripts/probe-shipment-key-collisions.mjs`. `src/lib/sync/shipstation.ts:28`
matches incoming shipments with `.eq('order_number', ...).single()`.

| | |
| --- | --- |
| Distinct order numbers | 1,077 |
| Order numbers carrying more than one label | **6** |
| Collisions visible today, with the filter on | **0** |
| Collisions after the filter comes off | **6** |

**Every collision is created by the fix in §2.1.** The order number is not a
key, and today's filter is the only thing hiding that.

**A correction to an earlier draft, and it matters.** That draft said `.single()`
*throws* on multiple matches, so the sync would start failing loudly on the very
shipments the fix reveals. That is not what happens. In `supabase-js`, `.single()`
resolves to `{ data: null, error: PGRST116 }`; it does not throw. Line 28
destructures `data` alone and discards `error`:

```ts
const { data: existingShipment } = await supabaseAdmin   // error dropped
  .from('shipments').select('id, actual_cost, client_id')
  .eq('order_number', String(s.orderNumber)).single()
```

`existingShipment` is therefore `null`, the `if (existingShipment)` test at
line 76 is false, and control reaches `.insert(shipmentData)` at line 114.
**The sync inserts a duplicate shipment row, silently, on every run.** With
three cron runs a day, one colliding order accumulates duplicate cost rows
indefinitely. A loud failure would have been the better outcome; this is a quiet
overstatement of cost that nothing currently detects.

The remedy is §5.5's re-keying on `shipment_id`, and it must land *before* the
filter comes off — not alongside it.

One of the six collisions is not a multi-package order at all: **14 labels
costing $281.30 have a blank order number**, spanning both carriers. That is
label spend attributable to no order and therefore to no client — a leak
category in its own right, about $3,400 a year. It also means the "0 collisions
today" row above is optimistic: those 14 rows all collapse onto the same empty
order number, and the probe reports them as spanning **both** carriers — so
several are `stamps_com` and pass today's filter. **The duplicate-insert path is
already firing, before any change is made.** The other five collisions are
genuine multi-package orders.

### 3.3 Picked versus ordered

`scripts/probe-picked-vs-ordered.mjs`, fully paginated, 30 days. **Picked
quantity, not ordered quantity, is the billing quantity.**

| Client | Orders | Ordered | Picked | Ratio | Cancelled |
| --- | --- | --- | --- | --- | --- |
| Suteka | 235 | 2,078 | 1,486 | 72% | 1 |
| Orcam | 69 | 263 | 243 | 92% | 1 |
| SitnStand | 97 | 237 | 231 | 97% | 4 |
| Crisp Power | 213 | 334 | 64 | **19%** | **205** |
| Time Systems (UK) | 17 | 25 | 25 | 100% | 0 |
| Kivema | 8 | 20 | 18 | 90% | 0 |
| Creative Pea | — | — | — | — | HTTP 401 |
| Nayax | — | — | — | — | HTTP 401 |

Billing ordered quantity would overstate Crisp Power by a factor of five. The
ratio varies too widely between clients — 19% to 100% — for any single fudge
factor to substitute for the real picked figure.

The two 401 rows are the credential problem of §2.4, and they are the two
clients this work most needs: Nayax owns the rate card being modelled.

### 3.4 Orders that never become shipments

An order can be picked and never produce a label. `scripts/probe-billable-orphans.mjs`
measures the ones that actually matter — not cancelled, picked quantity above
zero, no ShipStation label:

**47 orders, 334 picked units in 30 days**, of which 37 orders / 186 units are
Suteka's. This is why the ledger anchors on the order rather than the shipment.

**A correction to an earlier draft.** That draft claimed 208 such orders for
Crisp Power alone and called it the strongest argument for order-anchoring.
It was wrong: **205 of Crisp Power's 213 orders are cancelled**, and cancelled
orders accrue no pick charges. Crisp Power's real contribution is 3 orders and
10 units. The conclusion survives on Suteka; the evidence is far thinner than
first presented. **Cancellation is a first-class filter throughout this design.**

### 3.5 When the pick happened

Ophir's requirement: *follow what was picked on the same day, so you can see the
number of items, the SKUs and all the relevant information.* That needs a date
on the pick, and neither Zenventory API reliably provides one.

Measured across a 391-order sample: **`completedDate` is empty on all 391
orders, including those flagged `completed: true`.** There are no item-level
timestamps. `pickprintdate` exists only on the legacy API, which serves one
client and cannot paginate.

So the date is derived, by a three-tier rule, with the rule that produced it
recorded on every row:

| Confidence | Source | Meaning | Availability |
| --- | --- | --- | --- |
| 3 | `pickprintdate` | The warehouse printed a pick ticket | Legacy API only — Nayax |
| 2 | Observation watermark | Our sync first saw `pickedQuantity > 0` | All clients |
| 1 | `modifiedDate` | Backfill only; the order changed that day | Historical rows |

Accuracy of the watermark equals the sync's frequency. **Nothing derived is ever
displayed with the confidence of something measured.**

---

## 4. Scope

**In:**

- Remove the carrier filter; make all label spend visible, with a safe shipment key
- Zenventory as order master: orders, items, SKUs, picked quantities, pick dates
- A cost side: `cost_rates`, `operating_costs`, and a `cost` on every charge
- The variance loop that turns allocated cost into a leak signal
- Warehouse billing calculated for the first time: pick, pack, storage,
  receiving, materials, surcharges
- Rate cards extended to carry the Nayax quote's 18 lines
- Rollup views from business total down to one SKU on one order
- A minimal read screen so the numbers are visible

**Out — later pieces:**

- Reconciliation against ShipStation, Stamps.com or bank statements (piece 2)
- Fuel surcharge and carrier rate-increase tracking (piece 3)
- Monitoring agents and the daily email (piece 4)
- The real dashboard (piece 5)
- Invoicing. This is margin tracking. Ophir was explicit: *"i dont need an
  invoice."*

---

## 5. Architecture

### 5.1 Two ledgers, not one

**Direct margin** attaches to an order. Revenue minus directly attributable
cost, per charge line: a label, a pick, a box. Drillable to one SKU.

**Operating P&L** is the business. Direct margin summed, minus the overheads
that cannot honestly be pinned to a single order — rent, software, insurance,
the portion of payroll not spent picking.

"From the top till the tiny bits" is exactly these two joined: the top is
operating P&L, the tiny bits are single charge rows, and the variance between
them (§5.3) is where leaks show up.

`recalculateShipments()` stays and keeps owning shipping margin. It gains a
cost-aware sibling rather than a rewrite.

### 5.2 Schema

#### Carried forward from the Nayax spec

**`client_store_ids`** — new. Maps ShipStation store IDs to clients, replacing
Zenventory as the client mapper so a 401 (§2.4) stops causing misattribution.

```sql
create table client_store_ids (
  id         uuid primary key default uuid_generate_v4(),
  client_id  uuid not null references clients(id),
  store_id   text not null,
  store_name text,
  created_at timestamptz default now()
);
create unique index on client_store_ids (store_id);
```

`store_id` is unique across the table, not per client: one ShipStation store
belongs to exactly one client, and the whole point is that a store cannot map
two ways. The value is read from `advancedOptions.storeId` on the ShipStation
shipment payload, which is already retained in `shipments.raw_data`, so the
table can be populated from existing rows without a new API call. Stores with no
mapping are reported rather than guessed (§7).

**`orders`** — new, and the anchor. An order exists whether or not it ever
becomes a shipment.

```sql
create table orders (
  id             uuid primary key default uuid_generate_v4(),
  client_id      uuid references clients(id),
  order_key      text not null,        -- normalised order number
  order_number   text not null,        -- as received
  source         text not null,        -- zenventory | shipstation
  order_date     date,
  cancelled      boolean default false,
  cancelled_date date,
  created_at     timestamptz default now()
);
create unique index on orders (client_id, order_key) where client_id is not null;
create unique index on orders (source, order_key)    where client_id is null;
```

Two partial unique indexes rather than one, because `unique (client_id,
order_key)` does not constrain rows where `client_id` is null — NULLs are
distinct in SQL — and unattributed orders would duplicate silently.

**`order_items`** — new. One row per line.

```sql
create table order_items (
  id                    uuid primary key default uuid_generate_v4(),
  order_id              uuid references orders(id) on delete cascade,
  source                text not null,
  line_ordinal          int  not null,   -- position in the order
  sku                   text,
  description           text,
  quantity_ordered      numeric(10,2),
  quantity_picked       numeric(10,2),
  is_component          boolean,
  classification_source text,            -- sku_prefix | category | manual
  pick_date             date,
  pick_date_source      text,            -- pickprintdate | watermark | modified_date
  is_estimate           boolean default false,
  unique (order_id, source, line_ordinal)
);
```

`line_ordinal` exists because the sync deletes and reinserts lines, which would
destroy the UUID a watermark is stored against; and SKU alone is not a key,
because kits repeat the same SKU on several lines.

**`pick_date` is set once and never moved.** A later sync that sees a larger
picked quantity updates the quantity and leaves the date alone — a partial pick
completed on Tuesday still belongs to Monday, when the labour was spent.
Downward corrections behave the same. The only event that clears a `pick_date`
is `quantity_picked` returning to zero, meaning the pick was undone.

`pick_date` is a `date`, not a `timestamptz`, and **"today" means the current
date in the warehouse's timezone (US Eastern), not UTC.** Because the crons fire
at 02:00, 10:00 and 16:00 ET during daylight time (§10), a pick finished at
17:00 Monday is first seen by the 02:00 Tuesday run. So: **a watermark set
before 06:00 local stamps the previous warehouse day.**

Three things about that rule need to be stated rather than assumed.

**The cron times drift by an hour twice a year.** `vercel.json` schedules in UTC,
which is fixed; US Eastern is not. 06:00 UTC is 02:00 EDT but 01:00 EST. The
06:00-local cutoff must therefore be computed against the warehouse's local
clock — `America/New_York`, not a stored offset — so that the rule survives the
November and March transitions without anyone noticing. The 02:00/10:00/16:00
figures quoted throughout this spec are EDT; subtract an hour in winter.

**"Nothing is picked between midnight and 6am" is an assumption, not a
measurement.** It is Ophir's account of how the warehouse runs and it is almost
certainly right, but nothing in the data confirms it, because the only pick
timestamps available are our own observation times. If a night shift is ever
added, this rule silently misdates an entire shift — with no error, no gap, and
no way to tell from the output. The rule is therefore recorded as a named
assumption here and in the code comment, so that the day the warehouse changes
hours someone can find it.

**The cutoff is coupled to the cron schedule.** If the cron times in
`vercel.json` change, this rule must change with them. A comment in both files
must say so and name the other file.

**`sync_runs`** — new and small. Records each run's source, window, row counts
and outcome, so a missed day is detectable rather than silently becoming a gap
in the pick history.

```sql
create table sync_runs (
  id               uuid primary key default uuid_generate_v4(),
  source           text not null,      -- shipstation | zenventory
  client_id        uuid references clients(id),   -- null = all clients
  mode             text not null,      -- backfill | live
  window_start     date,
  window_end       date,
  started_at       timestamptz not null default now(),
  finished_at      timestamptz,
  status           text not null,      -- running | ok | partial | failed
  rows_seen        int default 0,
  rows_written     int default 0,
  unpriced_before  int,
  unpriced_after   int,
  errors           jsonb default '[]'::jsonb,
  created_at       timestamptz default now()
);
create index on sync_runs (source, started_at desc);
```

`client_id` is per-row because Zenventory syncs per client and a 401 on one
client must be recordable without marking the whole run failed — the defect at
`zenventory.ts:86` (§5.5). `status = 'partial'` is the value that defect
currently cannot express. `unpriced_before` / `unpriced_after` carry the §5.5
blast-radius measurement. `errors` is JSON rather than text so the monitoring in
piece 4 can count error kinds without parsing prose.

**`order_charges`** — new. The margin record, and the one table that carries
both sides.

`cost_rates` is defined below but **must be created first**, because
`order_charges.cost_rate_id` references it. The migration order is `orders` →
`order_items` → `cost_rates` → `operating_costs` → `order_charges` → views.

```sql
create table order_charges (
  id                 uuid primary key default uuid_generate_v4(),
  order_id           uuid references orders(id) on delete cascade,
  client_id          uuid references clients(id),
  rate_id            uuid references client_warehouse_rates(id),
  cost_rate_id       uuid references cost_rates(id),
  charge_key         text not null,   -- deterministic identity, see below
  charge_type        text not null,   -- shipping | pick | pack | material | storage
                                      -- | receiving | surcharge | return
  label              text not null,   -- as shown to a human
  quantity           numeric(10,2),
  unit_rate          numeric(10,4),
  amount             numeric(10,2) not null,  -- charged to the client
  cost               numeric(10,2),           -- what it cost us
  cost_basis         text,            -- measured | derived | estimated
  charge_date        date not null,
  charge_date_source text,
  source             text not null,
  is_estimate        boolean default false,
  calculated_at      timestamptz default now()
);
create unique index on order_charges (order_id, charge_key)
  where order_id is not null;
create unique index on order_charges (client_id, charge_key)
  where order_id is null;
create index on order_charges (order_id);
create index on order_charges (client_id, charge_date);
create index on order_charges (charge_type, charge_date);
```

**Two partial indexes, for the same reason `orders` needs two (above).** Not
every charge belongs to an order: storage is monthly and billed in advance
against a client, not an order, and unattributed label spend belongs to neither.
A single `unique (order_id, charge_key)` would not constrain those rows at all —
NULLs are distinct in SQL — so the one category of charge that *cannot* be
re-derived from an order document would be the one silently duplicated three
times a day.

**`charge_key` is the idempotency key, and without it this table is a bug.** The
crons run three times a day and recalculation is not a one-off; an insert-only
calculator would triple every charge daily and the P&L would climb on its own.
The key is derived from the record the charge is *about*, so the same input
always produces the same key:

| Charge type | `charge_key` |
| --- | --- |
| shipping | `shipment:<shipmentId>` |
| pick, pack | `item:<order_item_id>:<charge_type>` |
| material | `item:<order_item_id>:material:<variant>` |
| storage | `storage:<period_month>` |
| surcharge | `shipment:<shipmentId>:<surcharge_code>` |

Recalculation is **upsert on `(order_id, charge_key)`**, updating `amount`,
`cost`, `unit_rate` and `calculated_at`. Charges whose source record has since
vanished — an order line deleted, a shipment voided — are removed by deleting
rows for that order whose `calculated_at` predates the current run. Upsert plus
stale-delete, never truncate-and-rebuild: truncating would destroy history for
orders the current window no longer covers.

`charge_date` is what lets the ledger answer "what did we earn on Tuesday." For
pick and pack it comes from `pick_date`; for shipping, from `ship_date`.

**`pick_days`** — a view, not a table, so it cannot drift from the lines it
summarises. This is the direct answer to *"follow what was picked the same day,
so you can see the number of items, the SKUs and all the relevant information."*

```sql
create view pick_days as
with usable as (               -- only lines that carry real pick evidence
  select oi.*
  from order_items oi
  where oi.pick_date is not null
    and oi.quantity_picked > 0
),
preferred as (                 -- one source per order: Zenventory wins
  select distinct on (u.order_id) u.order_id, u.source
  from usable u
  order by u.order_id, case u.source when 'zenventory' then 0 else 1 end
)
select o.client_id, u.pick_date, u.sku,
  max(u.description)            as description,
  bool_or(u.is_component)       as is_component,
  count(distinct o.id)          as orders,
  sum(u.quantity_picked)        as units_picked,
  bool_or(u.is_estimate)        as has_estimates,
  min(case u.pick_date_source               -- 1 = least confident
        when 'pickprintdate' then 3
        when 'watermark'     then 2
        when 'modified_date' then 1
        else 0                              -- null/unknown: trust nothing
      end)                      as confidence
from usable    u
join orders    o on o.id = u.order_id
join preferred p on p.order_id = u.order_id and p.source = u.source
where not o.cancelled
group by o.client_id, u.pick_date, u.sku;
```

The `preferred` CTE exists because Zenventory and ShipStation rows coexist for
the same order; summing both double-counts every unit.

**The `usable` CTE must come before `preferred`, and an earlier draft had it
after.** In that draft `preferred` chose Zenventory whenever *any* Zenventory
row existed, and the `pick_date is not null` filter was applied afterwards in
the outer query. An order whose Zenventory rows had arrived without a pick date
— which is the normal state until the first watermark lands — would be assigned
to Zenventory, then have all its rows filtered out, and **disappear from
`pick_days` entirely**, taking its perfectly good ShipStation pick evidence with
it. Filtering first means "preferred" ranks only among sources that actually
have something to say. A test in §8 asserts exactly this case.

The confidence column maps `pick_date_source` to an **integer** before taking
`min()`. `min()` on the raw text returns `'pickprintdate'` alphabetically, which
would rank the most-inferred rows as the most trustworthy — exactly backwards.
Lowest wins, so a day is only as good as its weakest line.

**`client_warehouse_rates`** — extended with `category`, `label`, `rate_type`,
`description`, effective dates, and `alter column rate drop not null` so
`at_cost` lines can exist (§6).

**`zone_chart`** — gains a `carrier` column. It holds a UPS chart and, now that
UPS traffic is visible, will need a USPS chart beside it rather than instead of
it.

#### New: the cost side

```sql
create table cost_rates (
  id             uuid primary key default uuid_generate_v4(),
  cost_type      text not null,        -- pick | pack | material | storage | receiving
  variant        text,                 -- box size; device vs accessory
  unit           text not null,        -- per_unit | per_order | per_pallet_month
  rate           numeric(10,4) not null,   -- what it costs US
  effective_from date not null,
  effective_to   date,                 -- null = current
  basis          text not null,        -- measured | derived | estimated
  note           text,
  created_at     timestamptz default now()
);
create unique index on cost_rates (cost_type, coalesce(variant, ''), effective_from);

-- Two rates for the same thing must never cover the same day.
alter table cost_rates add constraint cost_rates_no_overlap
  exclude using gist (
    cost_type            with =,
    coalesce(variant,'') with =,
    daterange(effective_from, effective_to, '[)') with &&
  );

create table operating_costs (
  id           uuid primary key default uuid_generate_v4(),
  period_month date not null,          -- first of month
  category     text not null,          -- payroll | rent | utilities | software | insurance
  vendor       text,
  amount       numeric(12,2) not null,
  allocation   text not null default 'overhead',
                                       -- overhead | direct_labor | direct_storage
  note         text,
  created_at   timestamptz default now()
);
create unique index on operating_costs (period_month, category, coalesce(vendor, ''));
```

Two fields do the real work.

**`basis`** carries the honesty, exactly as `pick_date_source` does. `measured`
is an invoice line. `derived` is computed from payroll. `estimated` is a
considered guess. No display may present a derived cost as measured.

**`allocation`** decides whether a cost is pushed down to individual orders or
only subtracted at the top. Payroll marked `direct_labor` feeds the
cost-per-pick derivation; rent marked `direct_storage` feeds cost-per-pallet;
everything else stays overhead.

**Effective dating is not optional.** A cost rate that changes must not rewrite
last month's margin. Every lookup is by `charge_date`, not by `now()`.

**And effective dating must be enforced, not merely intended.** The unique index
above constrains `effective_from` alone, which does not prevent a row whose
`effective_to` overruns the next row's start. Two rates would then match the same
`charge_date`, a charge would take whichever the planner happened to return
first, and the same order could cost two different amounts on two different
runs — non-determinism that would look like drift rather than a bug. The
exclusion constraint makes that state unrepresentable. It needs `btree_gist`,
which Supabase ships; the migration enables the extension first.

### 5.3 Finding the leaks

An earlier draft of this section proposed a "variance loop" as the primary leak
detector: derive cost-per-pick as payroll ÷ units picked, then report
`payroll − (picks × cost-per-pick)` as labour nobody was billed for. **That is
identically zero by construction** — substituting the definition gives
`X − (X/units × units) = 0`. It would have reported a reassuring $0.00 leak
every month forever, and the §8 test written against it would have passed
trivially. It is removed. What follows replaces it.

#### 5.3.1 Measured leaks — no estimation involved

These are the answer to "where are we losing money." Each is a direct
observation, not a derivation, and each is already quantified:

| Leak | Measure | Status |
| --- | --- | --- |
| **Unattributed label spend** | Labels with no order or client. **$281.30 / 30 days** | Measured, §3.2 |
| **Picked but never billed** | Orders picked, not cancelled, no charge raised. **47 orders / 334 units** | Measured, §3.4 |
| **Unpriced shipments** | Shipments with no matching rate card line | Existing count, will move sharply at §5.5 |
| **Negative-margin lines** | `order_charges` where `amount < cost` | New, computable once cost exists |
| **Carrier re-bills** | `rate_adjustments` where the carrier raised the cost after the label was bought | Table exists; see the defect below |
| **Voided labels** | Purchased then voided. **$165.03 / 30 days** of refund exposure | Measured; resolved in piece 2 |

Each becomes a row in a `leaks_monthly` view with a dollar figure and a
drill-through to the underlying records. **This, not the variance arithmetic, is
what satisfies the requirement.** None of it depends on a cost rate being right.

**A defect in the existing re-bill detection, found during this review.**
`src/lib/sync/shipstation.ts` records an adjustment only when
`diff > 0.01` — that is, only when cost goes *up*. A void refund is a cost
decrease and therefore can never be recorded, which is precisely the $165.03
category above. `rate_adjustments` is also keyed on `order_number`, so it
inherits the collision problem of §3.2. Both are fixed as part of §5.5.

#### 5.3.2 Labour variance — a real one this time

Standard costing can still produce a useful variance, but only if the rate and
the allocation base are not the same number. The fix is to **hold the standard
rather than recompute it**:

```
  Standard cost-per-pick             $r   held from a baseline period
  September picks                     n   measured
  September payroll (direct_labor)   $X   measured, from the books
  ────────────────────────────────────────
  Labour variance                $X − n·r
```

Because `r` is not derived from September's own figures, this is non-zero and
informative. A positive variance means labour cost more per pick than the
baseline: either productivity fell, wages rose, or time went into work no order
absorbed. The view reports the components — payroll, picks, implied actual rate,
standard rate — so the cause is visible rather than inferred from one number.

**Re-baselining is a deliberate, recorded act, not an automatic monthly reset.**
Recomputing `r` every month would restore the circularity and erase the signal.
When variance stays large, that is the prompt to re-baseline, and the old rate
stays in history via `effective_to`.

The same shape applies to storage — rent against a held cost-per-pallet-month —
and to materials, where the standard is simply the purchase price and the
variance is boxes bought minus boxes charged.

**This is a secondary signal, and it is labelled as one.** Until piece 2
reconciles against actual bills, the labour variance rests on a standard rate
whose own accuracy is unproven. §5.3.1 does not.

### 5.4 Setting the cost rates

- **cost-per-pick** — baselined once from `direct_labor` payroll ÷ units picked
  over the baseline period, then **held**. `basis = 'derived'`. Re-baselining
  closes the prior row with `effective_to` and opens a new one; history is never
  rewritten.
- **cost-per-pallet-month** — rent and utilities allocated `direct_storage` ÷
  pallet positions, same treatment.
- **material costs** — straight from purchase records, `basis = 'measured'`.
  These are the only cost rates that are not estimates.

Before the first payroll figure lands, rates are seeded `basis = 'estimated'`
and every charge derived from them carries `is_estimate`.

**The baseline period must contain a full month of picks.** Baselining off a
partial month divides real payroll by incomplete volume and produces a standard
that is too high, which then shows as a permanent favourable variance.

**One blended pick rate, not one per client.** A Suteka pick and an Orcam pick
cost the same in this model. Per-client rates need time-study data that does not
exist, and assuming a difference without measuring it would be inventing
precision. Accepted limitation (§11).

### 5.5 Sync changes

**`src/lib/sync/shipstation.ts` — the cost layer.**

**The order of these steps is load-bearing and matches §9.** Deleting the carrier
filter first would push 3.4× the traffic through a duplicate-insert defect that
is already live (§3.2). It is step 5, not step 1.

1. **Re-key shipments on ShipStation's `shipmentId`, not `order_number`.** §3.2
   shows the current `.single()` match silently inserts duplicates, and that 6
   collisions appear the moment the filter comes off. `shipmentId` is
   ShipStation's own primary key and unique by construction. `order_number`
   becomes a foreign key to `orders`, not an identity. Add a unique index on
   `shipments (shipment_id)` and upsert against it, so the failure mode is a
   constraint violation rather than a duplicate row.
2. **Stop discarding the `error` from every Supabase call in this file.** The
   `catch {}` at line 117 swallows the exception body too. Both feed
   `sync_runs.errors` (§7). This is the reason the duplicate inserts have never
   been noticed.
3. **Stop hardcoding `source: 'stamps'` (line 72).** With the filter gone this
   would stamp all 776 monthly UPS shipments as Stamps.com — corrupting the
   exact column piece 2 reconciles on, and doing so invisibly because the value
   would still look valid. Derive it from `carrierCode`:
   `stamps_com → 'stamps'`, `ups_walleted → 'shipstation_ups'`, anything else
   stored verbatim and reported as an unknown carrier rather than coerced.
4. **Record void refunds.** Line 82 guards rate-adjustment capture with
   `diff > 0.01`, so only *increases* are ever recorded. A refund is a negative
   diff and is therefore structurally unrecordable today. Change to
   `Math.abs(diff) > 0.01`. Without this the 12 voided labels of §3.1 can never
   be proven refunded, which is the piece-2 question.
5. **Delete `carrierCode: 'stamps_com'`.** The change of record — safe only once
   1–4 have landed and been verified on the existing 319 shipments.
6. **Handle blank order numbers explicitly.** 14 labels, $281.30, attributable
   to no order. They are ingested, attributed to a client by store ID where
   possible, and surfaced as *unattributed label spend* — a named leak line, not
   a silent drop and not a crash.
7. **Include shipment items**, so a shipment can classify its own contents when
   Zenventory is unavailable.
8. **Link to `orders` by `order_key`**, creating an order where none exists.
9. **Populate `order_charges`** with `charge_type = 'shipping'`, `amount` from
   the client rate card, `cost` from `shipmentCost`, `cost_basis = 'measured'`.
   Voided shipments contribute $0 cost and $0 revenue, and are counted in the
   voided-label leak line instead (§5.3.1); leaving them in measured cost would
   overstate spend by the $165.03 that was refunded.

**Blast radius, to be measured rather than assumed.** Removing the filter pushes
776 shipments a month into `recalculateShipments()` for the first time. Some
clients hold UPS rate rows that have never matched anything and will now start
matching; others have no UPS rates and will produce newly unpriced shipments.
**The change lands with a before-and-after unpriced count recorded in
`sync_runs`**, not blind. See `docs/unpriced-shipments-findings.md` and
`docs/rate-card-worklist.md` for the starting position.

**`src/lib/sync/zenventory.ts` — now the primary sync.**

1. **Keep the order, instead of throwing it away.** Lines 54–57 already paginate
   correctly and already receive every order, but retain only
   `order.orderNumber` — the line items, SKUs, ordered and picked quantities and
   cancellation flag are fetched and discarded. Nothing new is requested from
   Zenventory; the fix is to persist what already arrives. Upsert `orders` and
   `order_items`, reading `pickedQuantity`.

   *An earlier draft said this code "reads page 1 of a paginated endpoint." That
   was false. The page-1 limitation belonged to a throwaway probe script, and
   misattributing it to production is how that draft reported a 100-order sample
   as a client total. The production loop at lines 37–61 is correct.*
2. Fix `src/lib/sync/zenventory.ts:86` — `if (clientErrors.length ===
   clients.length)` only reports failure when *every* client fails, so the two
   401 clients of §2.4 currently look like success. Any client error is recorded
   per-client in `sync_runs` and surfaced.
3. **Stamp `pick_date` on first observed pick**, per §3.5 and the before-06:00
   rule in §5.2.
4. Overlay `pickprintdate` where the legacy API provides it, overriding a
   watermark and raising confidence to 3.
5. Record the run in `sync_runs`.

**Backfill mode versus live mode.** The first execution runs in backfill mode
and stamps `modified_date`, not today. Without this, every already-picked order
is watermarked with the deploy date and the first day shows one enormous pick
that never happened. **Backfill must complete before any live run.**

**Source switching.** When Zenventory rows first supersede a ShipStation-created
order, the existing watermark is carried across rather than discarded, so
switching source does not reset the pick date.

Both syncs are wired into the existing `/api/agent/monitor` route, which is
already on a thrice-daily Vercel cron. No new scheduler is needed (§10).

### 5.6 The device / component split

The Nayax card prices a device pick at $0.32 and a component pick at $0.20, so
the split is worth about $0.12 a unit.

**The rule is SKU prefix: `R*` and `D*` are devices.** This was approved and it
stands, because the obvious alternative fails on measurement. Zenventory carries
a native `category` field, but it is **blank on exactly `R144GUSB01S10` and
`R144GUSY01S10`**, the two highest-volume readers. Trusting `category` would
silently demote both to component rate.

**How firm each number here is, stated plainly.** The blank-`category` finding is
directly observed and certain: those two SKUs appeared in the sample and their
category field was empty. The volume attached to it is not. "About 2,935 of
roughly 2,990 monthly device units" and the resulting "$352 a month" are an
**extrapolation from a 50-item sample** — 50 is what the legacy endpoint returns
and it will not paginate (§2.4). The two SKUs plainly carry most of the volume;
the precise share, and therefore the dollar figure, is indicative only. It is
quoted to show the decision is not about rounding errors, not as a measured
result. The exact figure arrives with the Nayax 2.0 credential.

The decision does not depend on the estimate: prefix classification is right
even if the true exposure is $100 rather than $352, because a rule with two
known blind spots on the highest-volume SKUs is the wrong rule at any size.

Precedence: SKU prefix first; native `category` only for SKUs the prefix rule
does not recognise; `classification_source` records which fired. Implementation
lives in `src/lib/billing/classify-sku.ts`.

### 5.7 Peak surcharge

8% of `charge_type in ('pick', 'pack')` only. It explicitly excludes at-cost
carrier freight — charging a surcharge on a pass-through cost would be
overbilling — and excludes `surcharge` itself, which would compound.

`pack` produces no charges for Nayax, because packing is included in their pick
rate. It stays in the base definition because `charge_type` is shared across all
clients and others do pay separately.

### 5.8 The rollup

Four views, each a window on the same rows:

- **`pnl_monthly`** — per month: revenue and direct cost by charge type, gross
  margin, the variance lines from §5.3.2, overheads from `operating_costs`, net.
- **`pnl_client_monthly`** — the same per client, to gross margin.
- **`leaks_monthly`** — the six measured leaks of §5.3.1, one row each, with a
  dollar figure and a drill-through to the underlying records. This is the view
  that answers *"check where the leaks of money are"* directly, and it is the
  one that depends on no cost rate being right.
- **`pick_days`** — what was picked, per client per day per SKU.

Every figure drills to `order_charges` rows and from there to a single line on a
single order — except storage, which stops at client-and-month (§11).

`leaks_monthly` is deliberately **not** netted into `pnl_monthly`. Some leaks are
already reflected in the P&L as cost (voided labels, unattributed spend) and
subtracting them again would double-count; others are absences rather than
amounts (picked but never billed is revenue that does not exist). The two views
answer different questions and are kept apart so neither corrupts the other.

**Overheads are subtracted at the top, not spread across clients**, so
`pnl_client_monthly` shows gross margin and not net. Allocating rent and
software across clients needs an allocation key — revenue share? order share?
square footage? — and every choice is arguable. Showing gross honestly beats
showing net arbitrarily. Accepted limitation (§11).

---

## 6. Rate cards

`client_warehouse_rates` is extended to carry the Nayax quote's eighteen lines,
labelled exactly as the quote labels them.

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

**How `rate` is read, per `rate_type`** — not obvious from the number alone, and
getting it wrong is an order-of-magnitude error:

| `rate_type` | `rate` means | Charge |
| --- | --- | --- |
| `per_unit`, `per_carton`, `per_pallet`, `per_shelf`, `per_hour`, `per_box` | dollars per unit | `rate × quantity` |
| `flat` | dollars, once | `rate` |
| `percentage` | **percent, not fraction** — 8.00 is 8% | `base × rate / 100` |
| `cost_plus` | **percent markup on our cost** — 15.00 is cost + 15% | `cost × (1 + rate / 100)` |
| `at_cost` | `rate` is **null** | `cost` |

`rate` must therefore be nullable. A null rate on any other type is a data error
and is reported, not treated as zero.

Storage is monthly and billed in advance; it does not attach to an order.

**`description` must be populated for all eighteen lines.** The qualifying
conditions are part of the price and must be transcribed from the quote
verbatim, not summarised.

**Volume note, and treat it with suspicion.** The quote assumes roughly 1,464
orders a month against a 3,500 ceiling and allows re-quoting if the mix shifts
by more than 25%. Measured volume came out at about 309 shipments in 30 days —
roughly 21% of the assumption.

That figure was measured **through the `carrierCode: 'stamps_com'` filter**, and
309 sits uncomfortably close to the 319 total shipments that filter returns
(§2.1). Either Nayax is 97% of all Stamps.com traffic, or the number is the bug
measuring itself and Nayax's real volume includes UPS shipments that were never
counted. Both are plausible and the evidence cannot currently distinguish them,
because Nayax's Zenventory 2.0 credential returns 401 (§2.4) and the
order-side cross-check is unavailable.

**So this number is not usable for a re-quote conversation yet.** It is restated
after step 3 of §9, when the filter is gone, and that is the first point at
which "Nayax is at a fifth of quoted volume" becomes a claim rather than a
suspicion. If the shortfall survives the fix, it is a real margin question and
the system should surface it; if it does not, this note records why nobody
should have acted on it.

**Rate cards for Orcam, Suteka and Crisp Power are still needed** (§10).

---

## 7. Error handling

Each of these produces a visible, named finding. None is silently swallowed.

**Attribution and identity**

- *Shipment with a blank order number* — ingested, attributed by store ID where
  possible, reported as unattributed label spend. Measured: 14 labels, $281.30.
- *Order number matching several shipments* — expected, and correct once keyed
  on `shipmentId`. Multi-package orders are normal.
- *A Supabase call returning an error* — counted and recorded in
  `sync_runs.errors`. Today both the discarded `error` at line 28 and the bare
  `catch {}` at line 117 throw this information away, which is why the
  duplicate-insert defect of §3.2 has run unnoticed. **Nothing in this design
  may discard an error object.**
- *Unique-constraint violation on `shipments (shipment_id)` or
  `order_charges (order_id, charge_key)`* — a loud failure, and a wanted one. It
  means the idempotency key is wrong, which is a bug to fix rather than a row to
  skip.
- *Carrier code that is neither `stamps_com` nor `ups_walleted`* — stored
  verbatim and reported as an unknown carrier. Never coerced to a known value,
  because §5.5 step 3 exists precisely to stop that.
- *Store ID with no client* — reported. 17 shipments across two stores today.
- *Zenventory 401* — the client's orders are not synced; `client_store_ids`
  keeps attribution working anyway. Reported per client, never as a global pass
  (§5.5 step 2).

**Pricing**

- *No rate card line for a charge* — charge recorded with `amount = null` and
  flagged, never silently zero. Zero revenue and unknown revenue are different
  facts.
- *Null `rate` on a type other than `at_cost`* — data error, reported.
- *Shipment with no matching zone or weight band* — the existing unpriced path;
  count tracked before and after the filter change.

**Cost**

- *Charge with no cost rate* — `cost` null, `cost_basis` null. It appears in
  revenue and is excluded from margin, rather than counted as pure profit.
- *Variance beyond threshold* — a finding, with the month and category named.
- *Payroll not yet entered for a closed month* — that month's derived rates stay
  `estimated` and everything from them stays `is_estimate`.

**Pick dates**

- *Picked but no pick date* — possible for history synced before watermarking.
  Excluded from `pick_days` rather than dated to the sync date.
- *A missed sync day* — detected from `sync_runs`. Three runs a day means one
  failure does not lose a pick day, since the next run sees the same unchanged
  quantity; only a full day of failures does.
- *`pickprintdate` disagreeing with an existing watermark* — `pickprintdate`
  wins and the confidence rises, because it is the warehouse's own record.

---

## 8. Testing

**Sync and identity**

- Two labels on one order number persist as **two rows**, not one row and not
  three. Written against the current code it must fail by producing a duplicate
  on the second run — the §3.2 defect — and pass only after re-keying.
- **Running the sync twice over the same window changes no row count.** The
  single most important test in this file: three crons a day make
  non-idempotency compound. It covers `shipments` and `order_charges` together.
- A voided shipment contributes $0 to measured cost and appears in the voided
  leak line instead
- A cost *decrease* records a `rate_adjustments` row. Fails today: the
  `diff > 0.01` guard at `shipstation.ts:82` makes refunds unrecordable.
- A `ups_walleted` shipment stores a UPS `source`, not `'stamps'`
- A blank order number is ingested and reported, not dropped
- Removing the carrier filter yields 1,095 shipments where 319 were seen before,
  measured over the same 30-day window as §3.1. `syncShipments()` defaults to
  `daysBack = 30`, but the monitor cron calls `syncShipments(7)`
  (`src/app/api/agent/monitor/route.ts:43`), so the test must pass 30
  explicitly rather than reuse whatever window the cron happens to run
- A partial client failure is recorded as `status = 'partial'` with the failing
  client named, not swallowed by the all-must-fail check at `zenventory.ts:86`
- A Supabase error is counted in `sync_runs.errors` rather than discarded by the
  bare `catch {}`

**Pick dates**

- A first-seen pick stamps today's warehouse-local date, source `watermark`
- A watermark set at 02:00 ET stamps the **previous** day
- A partial pick completing later keeps its original date and updates quantity
- A downward correction keeps the date
- A pick returning to zero clears the date
- Backfill stamps `modified_date`, never the deploy date
- `pickprintdate` overrides a watermark and raises confidence to 3
- Source switching from ShipStation to Zenventory carries the watermark across
- `pick_days` confidence returns the **lowest** confidence present, as an integer
- `pick_days` does not double-count an order with rows from both sources
- **An order with dateless Zenventory rows and dated ShipStation rows still
  appears in `pick_days`**, sourced from ShipStation. This is the §5.2 ordering
  bug: with `preferred` computed before the filters, the order vanishes
  altogether and no total looks wrong — the units simply stop existing.
- Cancelled orders are excluded from `pick_days` and from all pick charges

**Rates and charges**

- `percentage` 8.00 charges 8%, not 800% and not 0.08%
- `cost_plus` 15.00 charges cost × 1.15
- `at_cost` with a null rate charges cost exactly
- A null rate on `per_unit` is reported as a data error
- Peak surcharge applies to pick and pack only, never to freight or to itself
- A device SKU bills $0.32 and a component $0.20
- A SKU with a blank `category` and an `R` prefix classifies as a device

**Cost and P&L**

- A cost rate change does not alter last month's margin — `effective_from` is
  respected, not just the latest row taken
- Overlapping `cost_rates` ranges for one `cost_type` + `variant` are rejected.
  The unique index only constrains `effective_from`; it does not stop a row
  whose `effective_to` runs past the next row's start, which would make a charge
  match two rates and silently take whichever the planner returned first.
- A charge with no cost rate is excluded from margin, not counted as profit
- **The labour variance is non-zero when payroll and standard disagree.** Given a
  held standard of $0.21/pick, 10,000 picks and $2,400 of payroll, the variance
  is $300 unfavourable and not $0.00. This test exists because an earlier draft
  defined the standard as payroll ÷ picks, which made the variance identically
  zero and the test unfailable (§5.3).
- Re-baselining the standard rate writes a new `cost_rates` row and leaves prior
  months' variances unchanged

**The rollup identity**

- Drilling from a monthly total reaches individual `order_charges` rows that sum
  back to it
- **`pnl_monthly` revenue equals the sum of `pnl_client_monthly` revenue *plus*
  the unattributed bucket.** Not "equals the sum of per-client revenue" — §3.2
  measured $281.30 of label spend belonging to no client, so a plain equality
  either fails or, worse, passes because the unattributed rows were quietly
  excluded from both sides. The test asserts the three-way identity and asserts
  the unattributed bucket is **surfaced**, not netted away.
- The identity holds when a client has revenue and no costs, and when a client
  has costs and no revenue — the join must not be an inner join, which would
  drop both cases and make the totals agree by losing the same rows twice.

---

## 9. Sequence

1. **Schema** — `orders`, `order_items`, `client_store_ids`, `sync_runs`,
   `cost_rates`, `operating_costs`, then `order_charges` (which references
   `cost_rates`). Additive; no behaviour change.
2. **ShipStation sync correctness, filter still on.** Re-key on `shipmentId`,
   stop discarding errors, derive `source` from `carrierCode`, allow negative
   rate adjustments. Verified against the 319 shipments already visible, where
   the blast radius is known and small.
3. **Drop the carrier filter** — a separate deploy from step 2, so that if the
   1,095-shipment run misbehaves it is unambiguous which change caused it.
   Record before-and-after unpriced counts in `sync_runs`.
   - **Why these are two steps and not one.** Step 2 fixes a defect that is
     already live; step 3 multiplies the traffic through it by 3.4×. Doing both
     at once means a bad outcome has two candidate causes and a rollback
     abandons the fix along with the exposure.
4. **Zenventory sync becomes primary** — persist orders and items, the
   error-check fix, `pick_date` stamping, `sync_runs`. Wired into
   `/api/agent/monitor`.
   - 4a. **One backfill run** over a widened window, stamping `modified_date`.
     This must complete before any live run.
5. **Backfill ShipStation** over a widened window, now that orders exist to link
   to, so historical P&L becomes correct rather than 20% of correct.
6. **Rate card extension** plus Nayax's 18 lines.
7. **Cost rates and operating costs** loaded from the four inputs.
8. **`order_charges` calculation**, both `amount` and `cost`.
9. **Views** — `pick_days`, `pnl_client_monthly`, `pnl_monthly` — plus the
   minimal read screen.

Steps 1 to 5 are the prerequisite. Until they land, $12,500 a month of cost is
invisible and 47 picked orders a month do not exist.

**Step 4 starts the clock on the watermark.** Every day between that deploy and
step 9 accumulates real pick dates, so the daily view has genuine history the
day it ships. Deferring step 4 does not delay the feature by a day; it delays it
by a day and loses a day.

---

## 10. Prerequisites outside this work

- **Restore Zenventory 2.0 credentials for Nayax and Creative Pea.** Both 401.
  No deploy required, and still the highest-value unblocked action available.
- **The four cost inputs** — warehouse payroll, packaging material costs, rent
  and utilities, software subscriptions. Without them §5.4 has nothing to derive
  from and every cost stays `estimated`.
- **Rate cards for Orcam, Suteka and Crisp Power**, per
  `docs/rate-card-worklist.md`.
- **The schedule already exists.** `vercel.json` declares three crons on
  `/api/agent/monitor` at 06:00, 14:00 and 20:00 UTC — 02:00, 10:00 and 16:00 US
  Eastern *during daylight time*, an hour earlier in winter (§5.2). The same
  route is polled every five minutes by the AutoSync widget
  when a staff browser is open, which gives finer resolution in practice but is
  opportunistic; the cron is the floor. `syncClientAssignments` in
  `src/lib/sync/zenventory.ts` *does* already call `getCustomerOrders` per
  client and matches by `order_number` — but it reads those orders only to stamp
  `client_id` onto existing `shipments` rows and then discards them. The order
  header, the line items, the SKUs and the picked quantities are all fetched and
  thrown away. So the work is widening a job on an existing cron to persist what
  it already retrieves, not building a scheduler and not adding an API call.
- **Do not run Section B of `scripts/proposed-zone-chart-198.sql`.** It converts
  a UPS chart to USPS while UPS is 80% of traffic. Section A's 14 territory rows
  remain safe.

---

## 11. Accepted limitations

Stated plainly so nobody later mistakes them for bugs.

- **One blended cost-per-pick**, not per client. Per-client rates need time-study
  data that does not exist.
- **Overheads are not allocated to clients.** Per-client figures are gross
  margin. Every allocation key is arguable; gross honesty beats arbitrary net.
- **The watermark is only as accurate as the sync.** Three runs a day gives
  day-level accuracy going forward and nothing better for history.
- **Backfilled pick dates are `modified_date`**, confidence 1. They are the
  weakest data in the system and are labelled as such everywhere.
- **Cost is standard, not actual, until piece 2.** The variance line is the
  honest measure of that gap, and it is reported rather than hidden.
- **Returns are specified but unobserved.** Zero return labels in 30 days.
  Returns billing is built to the quote but cannot be validated against traffic
  that does not exist yet.
- **Storage does not drill to an order, and cannot.** "From the top till the tiny
  bits" reaches a single SKU on a single order for pick, pack, material and
  shipping. Storage is billed monthly per pallet or shelf in advance, so its
  finest honest grain is client-and-month. The drill-down stops there and says
  so rather than inventing a per-order share of a pallet.
- **`is_component` is a SKU property, recorded per line.** A SKU reclassified
  later does not retroactively change historical charges, because the
  classification is stored on the line at calculation time. That is deliberate —
  reprising last quarter because a category was corrected would make closed
  months move — but it means the same SKU can bill two ways across time, and
  `classification_source` is the only record of why.
