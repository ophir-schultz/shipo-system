# Partner statements from the ledger — design

> Status: DESIGN, approved in chat 2026-10-11 on the disclosure question only.
> Not yet implemented. No code written against this document.

## Purpose

Two asks, one data source:

- **Shipo side (`/pnl`)** — see what we owe each partner, and see every transaction
  behind it: every order, every prep charge, for every client that partner referred.
- **Partner side (`/partner`)** — the partner sees their client's monthly P&L and the
  transactions behind it.

The point is that both sides read the **same** source, so the partner statement and the
P&L can never disagree. Today they can: the partner statement reads `fba_invoices`,
which is hand-typed through a form on `/referrals`, while `/pnl` reads the ledger.
Nothing reconciles them.

## What already exists (do not rebuild)

- `clients.referral_partner_id` — set by `/api/referrals/link`.
- `order_charges.client_id` — present **directly** on the charge row, not only via
  `order_id`. Partner → clients → charges is a two-hop join.
- `pnl_client_monthly` — already groups by `charge_type` per client per month and
  already returns `revenue`, `cost_known`, `cost_unknown_charges`,
  `revenue_unknown_charges`, `has_estimates`.
- `referrals.ts` — `REFERRAL_TERMS`, `computeOwed()`, `buildStatement()`,
  `qualifiesInMonth()`. The economics are implemented and tested. **Nothing in this
  design changes the deal.**
- `src/components/partner/Statement.tsx` — the live partner statement.
- `/pnl` already has a "Referral Payouts" section reading `referral_payouts`.

## Decisions

### 1. Disclosure scope (approved by Ophir, 2026-10-11)

A partner sees, per client per month: orders shipped, total billed, the four cost
buckets, net profit, their 5% — **and a transaction list carrying only date, order
number, and amount billed.**

No per-order cost. No per-unit rate. No charge-type split on a transaction.

**Why:** `amount / quantity` on a line item *is* the rate card. A partner who is also
an agency could reverse-engineer our pricing. Month-level buckets stay because the
agreement defines net profit in exactly those terms and the partner must be able to
verify the 5%.

This **supersedes** the comment in `Statement.tsx` that says "never line items... see
§4.6 of the partner agreement". That citation is dead — see Blockers. Update the
comment to cite this document instead of a section that does not exist.

### 2. Bucket mapping

The agreement deducts four things. The ledger knows three.

| Agreement bucket | `charge_type` |
|---|---|
| Freight & carrier | `shipping`, `surcharge`, `return` |
| Packaging & prep materials | `material` |
| Storage | `storage` |
| Payment processing | **not in the ledger** — read `fba_invoices.cost_processing` |

**Never deducted:** `pick`, `pack`, `receiving`. These are warehouse labour and the
agreement does not deduct them.

Consequence to surface on `/pnl`: **partner net profit is structurally higher than our
real gross margin**, by exactly the pick/pack/receiving cost. That is correct per the
deal and must not be "fixed". But `/pnl` must render both numbers adjacently or we will
misread our own margin.

`surcharge`/`return` → freight is a judgment call, not a documented term. Small money.
Revisit if it ever isn't.

### 3. Null handling — the money rule

`pnl_client_monthly.gross_margin` uses `coalesce(sum(cost), 0)`, which **treats every
unpriced charge as free**. The view's own comment says it must never be rendered without
`cost_unknown_charges` beside it.

For an internal P&L that is a bad read. For a payout it is **cash out the door**: we
would pay 5% of margin we never earned, and where no cost in the month is known, net
profit equals revenue outright. The mirror risk is real too — a null `amount` is unknown
revenue, not zero, so we would *under*pay.

**Rule: a month with any unknown in a deducted bucket is PROVISIONAL and NOT PAYABLE.**

Stricter than `/pnl` on purpose. It fails in the direction that does not lose money.

Two precision points that are easy to get wrong:

- `cost_unknown_charges` must count **only charges in deducted buckets**. An unknown
  `pick` cost cannot move partner net profit, because `pick` is never deducted. Counting
  it would block payable months for no reason.
- `sum(cost) filter (where ...)` returns NULL when no row matches, not 0.
  `coalesce(bucket, 0)` is safe here **only because the unknown counter guards it** — no
  `material` charges at all genuinely means zero materials cost, whereas `material`
  charges with null cost means unknown, and that case is caught by the counter, not the
  coalesce. Do not remove the counter and keep the coalesce.

### 4. Revenue definition — a known approximation

The agreement says "amounts invoiced to the client for the month". The ledger sums
charges **dated** in the month. If invoicing lags charge dates these differ. Accepted for
now; flag it if a partner ever disputes a figure.

## The new objects

Two views. No new tables.

> **Amendment, 2026-10-11 (during implementation).** This section originally
> specified one view. A second, `partner_order_transactions`, was added. Reason:
> the transaction list in Decision 1 has to be aggregated from `order_charges`
> somewhere, and doing it in the app means pulling ~6 charge rows per order to
> render 1 line per order — 12,000 rows to show 2,000. Doing it in SQL also
> moves the disclosure rule out of the render and into the schema: the view has
> no cost column, so a future component *cannot* leak per-order cost. Both views
> live in `supabase/partner_ledger.sql` and share one revoke/grant block.

### 1. `partner_client_monthly`

```sql
create or replace view public.partner_client_monthly as
with b as (
  select date_trunc('month', oc.charge_date)::date as period_month,
         oc.client_id,
         sum(oc.amount) as revenue,
         sum(oc.cost) filter (where oc.charge_type in ('shipping','surcharge','return'))
           as cost_freight,
         sum(oc.cost) filter (where oc.charge_type = 'material')  as cost_materials,
         sum(oc.cost) filter (where oc.charge_type = 'storage')   as cost_storage,
         -- Reported, never deducted. This is the gap between partner net
         -- profit and our real gross margin.
         sum(oc.cost) filter (where oc.charge_type in ('pick','pack','receiving'))
           as cost_labour_not_deducted,
         count(*) filter (where oc.amount is null) as revenue_unknown_charges,
         -- Deducted buckets ONLY. See Decision 3.
         count(*) filter (
           where oc.cost is null
             and oc.charge_type in ('shipping','surcharge','return','material','storage')
         ) as cost_unknown_charges,
         bool_or(oc.is_estimate) as has_estimates
  from order_charges oc
  group by 1, 2
)
select b.period_month,
       b.client_id,
       cl.name                as client_name,
       cl.referral_partner_id,
       b.revenue,
       coalesce(b.cost_freight, 0)   as cost_freight,
       coalesce(b.cost_materials, 0) as cost_materials,
       coalesce(b.cost_storage, 0)   as cost_storage,
       coalesce(b.cost_labour_not_deducted, 0) as cost_labour_not_deducted,
       -- Processing is NOT here: the ledger has no such charge type. The app
       -- subtracts fba_invoices.cost_processing to reach final net profit.
       b.revenue
         - coalesce(b.cost_freight, 0)
         - coalesce(b.cost_materials, 0)
         - coalesce(b.cost_storage, 0) as net_profit_before_processing,
       b.revenue_unknown_charges,
       b.cost_unknown_charges,
       (b.revenue_unknown_charges = 0 and b.cost_unknown_charges = 0) as payable,
       b.has_estimates
from b
join clients cl on cl.id = b.client_id
where cl.referral_partner_id is not null;
```

`where referral_partner_id is not null` keeps the view to referred clients only.

### 2. `partner_order_transactions`

One row per (client, month, order). Columns: `period_month`, `client_id`,
`referral_partner_id`, `order_id`, `order_number`, `first_charge_date`,
`last_charge_date`, `amount_billed`, `amount_unknown_charges`, `charge_rows`.

Three things about it that are load-bearing:

- **No cost column, of any kind.** That is Decision 1 enforced in the schema.
- **Grouped by `charge_date`**, identically to `partner_client_monthly`, because
  the lines must add up to the month total. The post-apply reconciliation query
  in the SQL file asserts exactly that and should return no rows.
- **`order_id` is nullable** in `order_charges` — storage and other
  account-level charges have a client and a month but no order. They collapse
  into one row per month with a null `order_number`. Label it ("Storage and
  account charges"), don't render a blank.

`referral_partner_id` is carried on the view so the server can filter by
partner in the query itself, rather than fetching wide and narrowing in JS —
which is the defect being fixed in `Statement.tsx` below.

## Shipo side — `/pnl`

Extend the existing Referral Payouts section rather than adding a page:

- Per partner → per client → per month: billed revenue, the four buckets, partner net
  profit, **our** gross margin beside it (the labour gap from Decision 2), 5% owed, and
  the unknown counters.
- A total per partner: owed, approved, paid, outstanding — from `computeOwed()`, which
  already does this.
- Drilldown to the transactions: orders and their charges, full detail. This is the
  internal view, so charge-type split and cost are both shown here.
- Any provisional month rendered as such, with the unknown count, and excluded from the
  payable total.

## Partner side — `/partner`

- Keep the existing month blocks and the four buckets.
- Repoint the numbers from `fba_invoices` to `partner_client_monthly`.
- Add the transaction list per Decision 1: date, order number, amount billed.
- Provisional months shown as provisional, not silently omitted — a partner who sees a
  month vanish will ask why, and the honest answer is "we have not priced it yet".
- Fix `Statement.tsx:53-55`: it selects **every** `fba_invoices` row and filters by
  client in JS at line 65. Not a leak today because the filter precedes render, but it
  is one refactor from being one. Use `.in('client_id', clientIds)`.

## Migration, not replacement

`fba_invoices` rows are the record of what was already **paid**. Do not delete them.

- `partner_client_monthly` becomes authoritative for new months.
- `fba_invoices` remains the payment record and the source of `cost_processing`.
- Where both exist for a (client, month), show the delta. That is what makes the two
  systems reconcile instead of silently disagreeing — and the first run of that delta is
  the real test of whether the hand-typed figures were ever right.

## Out of scope

- No change to the economics: $300, 5%, 12 months, $500/month bar.
  - _(Historical. The $500/month bar and the 60-day wait were both removed on 2026-10-12,
    the day after this spec. They were out of scope for this piece of work and still are —
    the line is left as written. For the current terms read `REFERRAL_TERMS` in
    `src/lib/referrals.ts`, which is the single source of truth.)_
- No change to `computeOwed()` or the founding-client cap.
- No automatic payment. A human still approves every payout.
- Processing fees stay a manual monthly input. Deriving them needs a payment processor
  integration that does not exist (no Stripe code anywhere in the repo).

## Blockers (independent of this work)

1. **No partner can log in.** Production has no email provider key. `src/lib/email.ts`
   returns `{sent:false, provider:'none'}` and never throws, so a login code is never
   delivered and the failure is silent. Building a better statement nobody can reach is
   not progress. Fix first — it is one Vercel env var.
2. **No Partner Agreement exists.** DocuSign has zero templates. One envelope was ever
   sent (`81bab422-09ae-8039-8396-1dea8d2c4d69`, 2026-08-08) and is still `delivered`,
   never signed. The repo draft is marked NOT FOR SIGNATURE and contains **no
   5%/12-month term at all** — only the one-time $300. The live site promises $300 + 5%
   for 12 months and cites a Partner Agreement we would provide. We are publishing terms
   we have no executed contract for, and the only draft on file contradicts them.
3. **`/api/referrals/intake` is unauthenticated** — no `REFERRAL_INTAKE_TOKEN` set. The
   form has reCAPTCHA; the API does not. Inserts `pending` rows only, so it cannot
   trigger a payout, but it is an open write on a public URL.

## Testing

- Build one fixture from the **live shape** of `order_charges`, not a hand-fed row. A
  fixture that supplies a column the real data never carries tests the model, not the
  code.
- A month with a null `cost` in a deducted bucket must come back `payable = false`.
- A month with a null `cost` on `pick` only must come back `payable = true`.
- A month with no `material` charges at all must show `cost_materials = 0` and stay
  payable — this is the case the coalesce exists for.
- A null `amount` anywhere must come back `payable = false`.
- Partner A's statement must contain zero rows belonging to Partner B. Assert on the
  query, not the render.
- The reconciliation delta against `fba_invoices` must be computed for every month where
  both exist, and a non-zero delta must be visible rather than rounded away.
