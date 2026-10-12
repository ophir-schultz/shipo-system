# Profit and loss, end to end — programme outline

**Status:** agreed 2026-09-29. This is the map, not the design. Each piece gets
its own spec, its own plan, and its own implementation cycle.

---

## The goal, in Ophir's words

> A system that knows all our profit and loss, and checks where the leaks of
> money are. From the top till the tiny bits, so we can see we are not losing a
> dime.

With three data sources, each owning a different stage:

- **Zenventory** — the order master. Every order lands here, gets picked, and
  carries the inventory detail: SKUs, quantities, what was actually picked.
- **ShipStation** — the label layer. Picks up after the pick and is where labels
  are bought.
- **Stamps.com** — where USPS labels are paid for, and a suspected leak point.

And it must maintain itself: agents that check the data is live, that rates and
fuel surcharges stay current, and a daily email summary.

---

## Why this is five projects

Written as one spec it would be unreviewable, and four of the five pieces would
be measuring a number that is currently wrong. The ordering below is a
dependency chain, not a preference.

### 1. Complete the ledger

Make every dollar visible, on both the revenue and the cost side, for every
client. Fix the sync that currently drops 80% of label spend, pull Zenventory
orders and picks, and add a cost model so that every revenue figure has a cost
figure beside it.

**Why first:** `src/lib/sync/shipstation.ts:19` hardcodes
`carrierCode: 'stamps_com'`, so about $12,500 a month of label cost — 80% of the
largest variable cost in the business — never reaches the database. And every
cost column in the schema describes the carrier label; nothing records the cost
of labour, materials or space. Until both are fixed, every downstream number is
confidently wrong.

**Spec:** `2026-09-29-complete-the-ledger-design.md`

### 2. Reconcile against the actual bills

Match what we recorded against what was actually charged: ShipStation invoices
for the UPS side, Stamps.com statements for the USPS side, and the bank or card
charges as the outer check. Confirm that voided labels were actually refunded.

**Why it cannot come first:** the bills are full of UPS shipments the database
does not yet contain. Reconciling now would report a vast fictitious discrepancy.

**Why it matters most in the end:** everything before this proves only that our
records agree with themselves. This is the only piece that can honestly say no
money leaked. All three sources confirmed obtainable.

### 3. Keep the cost model current

Fuel surcharges, carrier general rate increases, client rate-card expiry. A rate
card that silently goes stale is a slow leak that looks like healthy margin.

**Depends on:** piece 1, which is where rates gain effective dates.

### 4. Self-watching — agents and the daily email

Three jobs Ophir asked for by name:

1. Check the data is live and complete
2. Check it keeps up with changing rates and fuel surcharges
3. Email a daily summary

**Partly built already.** `src/lib/email.ts` sends via Resend or SendGrid,
`/api/agent/monitor` already composes and emails a run summary, and it is
already on a thrice-daily Vercel cron. What is missing is P&L content, staleness
detection, and a recipient list. Daily email goes to Ophir alone until the
numbers are trusted.

### 5. Top-down P&L view

The dashboard: business total, down through client and month and charge type, to
a single SKU on a single order. Built last because it is a window onto pieces
1–4 and is worth little before they are correct.

---

## Decisions already taken

**Cost model: standard rates plus overhead allocation.** Chosen over
actuals-only (cannot tell whether a *client* is profitable, only whether their
shipping is) and over a full double-entry ledger (accounting-grade, but it means
running the books in this system). Standard costing's weakness — the rates are
estimates — becomes the leak detector once allocated; see the variance loop in
the piece 1 spec.

**Cost inputs available:** warehouse payroll, packaging material costs, rent and
utilities, software subscriptions.

**Reconciliation sources available:** ShipStation invoices, Stamps.com
statements, bank and card statements.

---

## Superseded

`2026-09-29-nayax-margin-tracking-design.md` was written before the scope
widened from one client's rate card to the whole business. Its findings were
measured and remain valid — pick-date derivation, the device/accessory split,
order-versus-shipment anchoring, the Nayax rate card itself — and are carried
forward into the piece 1 spec. It is kept for its evidence trail and should not
be implemented from directly.
