import { chargeKey } from '@/lib/ledger/charge-key'
import { findCostRate, costOf, type CostRateRow } from '@/lib/ledger/cost-rate'

// Builds order_charges rows. Pure: no database, no clock, no randomness.
// Everything the calculation needs is passed in, which is what makes the
// idempotency of charge_key testable at all.

export interface RateCardLine {
  id: string
  chargeType: string
  variant: string | null
  rate: number | null
  rateType: string
  // Effective dates, inclusive/exclusive, exactly as cost_rates uses them.
  // null effective_from means "has always been in effect": the columns were
  // added by ALTER TABLE after the rows existed, so every rate card in the
  // database today carries nulls, and treating null as "no match" would unbill
  // every client the moment this shipped.
  effectiveFrom: string | null
  effectiveTo: string | null
}

export interface ChargeInput {
  order:     { id: string; clientId: string | null; cancelled: boolean }
  items:     Array<{ id: string; sku: string | null; quantityPicked: number | null
                     isComponent: boolean; pickDate: string | null }>
  shipments: Array<{ id: string; shipmentId: number; shipDate: string
                     actualCost: number | null; voided: boolean }>
  rateCard:  RateCardLine[]
  costRates: CostRateRow[]
  peakSurchargePct: number
}

/**
 * Reports a finding that is not a failure — currently only an ambiguous rate
 * card. Optional, so `buildCharges(input)` keeps working and the module stays
 * pure for callers that do not pass one.
 */
export type ChargeWarn = (context: string, detail: string) => void

export interface BuiltCharge {
  order_id: string; client_id: string | null; charge_key: string
  charge_type: string; label: string; quantity: number | null
  // `amount` is nullable for exactly the reason `cost` is, and it carries
  // exactly the same distinction: null is "we do not know yet", 0 is "we billed
  // nothing". The only path producing a null today is an at-cost freight line
  // whose carrier cost has not been reported — the client WILL be invoiced that
  // figure once it arrives, so 0 understates revenue and reads in every
  // downstream view as a label we gave away free.
  unit_rate: number | null; amount: number | null; cost: number | null
  cost_basis: string | null; rate_id: string | null; cost_rate_id: string | null
  charge_date: string; charge_date_source: string; source: string
  is_estimate: boolean
}

// toPrecision(12) collapses the float representation error before rounding, so
// an exact half-cent rounds up rather than down: 1.005 * 100 is
// 100.49999999999999, which Math.round would take to 100 (i.e. 1.00) and
// underbill. `+ 0` normalises -0, which Postgres accepts but which renders as
// "-0.00" and reads as a mistake.
// Exported so storage-charges.ts (and any future module) can import the
// canonical rounding rule rather than redefine it incorrectly.
export const cents = (n: number) => Math.round(Number((n * 100).toPrecision(12))) / 100 + 0

export function buildCharges(input: ChargeInput, onWarn?: ChargeWarn): BuiltCharge[] {
  // A cancelled order earns nothing and costs nothing. Returning early is
  // simpler than filtering each branch and leaves no path that could miss it.
  if (input.order.cancelled) return []

  const out: BuiltCharge[] = []
  const clientId = input.order.clientId

  // The billing rate is dated exactly as findCostRate dates the cost rate:
  // effective_from inclusive, effective_to exclusive, matched against the
  // CHARGE's own date and never against now(). A rate change must not rewrite
  // last month's invoice any more than it rewrites last month's margin, and a
  // bare .find() lets a superseded rate beat its replacement by array order.
  const inEffect = (r: RateCardLine, onDate: string) =>
    (r.effectiveFrom === null || r.effectiveFrom <= onDate)
    && (r.effectiveTo === null || onDate < r.effectiveTo)

  const rateFor = (chargeType: string, variant: string | null, onDate: string) => {
    const candidates = input.rateCard.filter((r) =>
      r.chargeType === chargeType && (r.variant ?? null) === variant && inEffect(r, onDate))
    if (candidates.length === 0) return undefined

    // More than one rate in effect on the same day for the same service is a
    // data error — the rate card should never overlap itself. Picking one
    // arbitrarily and silently is the failure mode this whole task exists to
    // stop, so it is named. The sort makes the choice deterministic (latest
    // start wins, ties broken by id) so at least the number does not flap
    // between runs while someone fixes the card.
    if (candidates.length > 1) {
      candidates.sort((a, b) =>
        (b.effectiveFrom ?? '').localeCompare(a.effectiveFrom ?? '')
        || a.id.localeCompare(b.id))
      onWarn?.('ambiguous rate', `client ${clientId ?? 'unattributed'}: `
        + `${candidates.length} rates for ${chargeType}/${variant ?? 'none'} are in `
        + `effect on ${onDate}; using ${candidates[0].id}`)
    }
    return candidates[0]
  }

  // ---- picks -------------------------------------------------------------
  for (const item of input.items) {
    const qty = item.quantityPicked

    // Null and zero mean NOT PICKED — a normal, common state, and no charge.
    // Anything else that is not a sane quantity is corrupt data rather than an
    // absence, and is deliberately NOT swallowed here: costOf() below throws a
    // RangeError on it, which the per-order boundary in persist-charges.ts
    // records as a failure naming the order. Treating a corrupt quantity as an
    // unknown cost instead would send someone to enter a cost rate that was
    // never the problem.
    if (qty === null || qty === undefined || qty === 0) continue
    // A charge with no date cannot be reported on, and charge_date is not null.
    //
    // This skip used to be silent, and that was tolerable only while a picked
    // line ALWAYS had a date: the sync stamped a watermark on anything it found
    // picked. It no longer does — during a sync discontinuity it leaves
    // pick_date null and pick_date_source 'unknown', deliberately, because a
    // fabricated date is worse (see watermarkIsEvidence in pick-date.ts). That
    // trade is only acceptable if the resulting gap is VISIBLE, so the quantity
    // and the order are named here rather than dropped. Unbilled pick revenue
    // that nobody is told about is the same failure as never having pulled it.
    if (!item.pickDate) {
      onWarn?.('undated pick', `client ${clientId ?? 'unattributed'}: order `
        + `${input.order.id} line ${item.id} (sku ${item.sku ?? 'none'}) has `
        + `${qty} picked but no pick date, so no pick or pack charge was built. `
        + `Supply a pick date for this line to bill it.`)
      continue
    }

    const variant = item.isComponent ? 'component' : 'device'
    const rate = rateFor('pick', variant, item.pickDate)
    // No rate card line means we have not agreed a price. Inventing one would
    // be worse than the gap; the gap shows up as "picked but never billed".
    if (!rate || rate.rate === null) continue

    const lookup = findCostRate(input.costRates, {
      costType: 'pick', variant, chargeDate: item.pickDate,
    })
    const cost = costOf(lookup, qty)

    out.push({
      order_id: input.order.id,
      client_id: clientId,
      charge_key: chargeKey({ chargeType: 'pick', orderItemId: item.id }),
      charge_type: 'pick',
      label: `Pick — ${variant}`,
      quantity: qty,
      unit_rate: rate.rate,
      amount: cents(rate.rate * qty),
      cost: cost === null ? null : cents(cost),
      cost_basis: lookup.known ? lookup.basis : null,
      rate_id: rate.id,
      cost_rate_id: lookup.known ? lookup.rateId : null,
      charge_date: item.pickDate,
      charge_date_source: 'pick_date',
      source: 'calculator',
      is_estimate: !lookup.known || lookup.basis === 'estimated',
    })

    // ---- pack ------------------------------------------------------------
    // Nayax includes packing in the pick rate and therefore has no ('pack',
    // 'device') line, so this branch correctly produces nothing for them
    // (spec §5.7). It exists so that when Orcam, Suteka or Crisp Power arrive
    // with a separately-priced pack, their charges appear without anyone
    // editing this file. A branch that is dormant for one client and load-
    // bearing for the next three is cheaper than the rework of adding it later.
    const packRate = rateFor('pack', variant, item.pickDate)
    if (packRate && packRate.rate !== null) {
      const packLookup = findCostRate(input.costRates, {
        costType: 'pack', variant, chargeDate: item.pickDate,
      })
      const packCost = costOf(packLookup, qty)

      out.push({
        order_id: input.order.id,
        client_id: clientId,
        charge_key: chargeKey({ chargeType: 'pack', orderItemId: item.id }),
        charge_type: 'pack',
        label: `Pack — ${variant}`,
        quantity: qty,
        unit_rate: packRate.rate,
        amount: cents(packRate.rate * qty),
        cost: packCost === null ? null : cents(packCost),
        cost_basis: packLookup.known ? packLookup.basis : null,
        rate_id: packRate.id,
        cost_rate_id: packLookup.known ? packLookup.rateId : null,
        charge_date: item.pickDate,
        charge_date_source: 'pick_date',
        source: 'calculator',
        is_estimate: !packLookup.known || packLookup.basis === 'estimated',
      })
    }
  }

  // ---- shipping ----------------------------------------------------------
  for (const s of input.shipments) {
    // charge_date is `not null`. An undated shipment included here would fail
    // the batch upsert and take every other charge on the order with it. The
    // check moved above the rate lookup because the lookup is now dated and has
    // nothing to match an empty string against.
    if (!s.shipDate) continue

    // NO `continue` HERE. `if (!rate) continue` dropped the whole row, and with
    // it `s.actualCost` — money that genuinely left the bank. The charge never
    // reached order_charges, so the P&L was flattered by exactly that freight,
    // and nothing downstream could notice: all six branches of leaks_monthly
    // detect under-billing or negative margin, none detects a cost that is
    // simply absent from the table. A flattering error with no detector is
    // silent forever, which is the one kind this ledger cannot tolerate.
    //
    // Spec §7, Pricing: "No rate card line for a charge — charge recorded with
    // amount = null and flagged, never silently zero. Zero revenue and unknown
    // revenue are different facts." So the row is raised with the cost intact
    // and the REVENUE null, which is the truth: we paid this, and nobody has
    // yet told us what to bill for it. It is treated the same way the at-cost
    // branch below already treats an unreported carrier cost.
    //
    // This also fires for a card whose shipping line has EXPIRED, which is the
    // likelier production trigger — `rateFor` is dated, so an effective_to that
    // has passed silently unpriced every label from that day on.
    const rate = rateFor('shipping', null, s.shipDate)

    // shipstation_shipment_id is nullable in the database, and String(null) is
    // the string 'null'. Every unidentified label on one order would therefore
    // key to 'shipment:null', and because (order_id, charge_key) is unique they
    // would collapse into a single row — shipping revenue disappearing quietly
    // rather than loudly.
    //
    // The label skipped here is reported by `leaks_monthly.unpriced_shipments`,
    // NOT by `unattributed_label_spend` as this comment used to claim. Leak 1's
    // predicate is about a blank order number or a null client_id, and a
    // shipment with a good order number, a good client and a null shipment id
    // satisfies neither disjunct — it never appears there. It lands in leak 3
    // because `'shipment:' || null::text` is NULL and `charge_key = NULL` is
    // never true, so leak 3's `not exists` is always satisfied for it.
    //
    // That only holds while `actual_cost is not null`, which is leak 3's own
    // precondition: a shipment with both a null shipment id and a null
    // actual_cost is invisible to all six leaks. Arguably that is right — we
    // have no evidence we paid anything — but it is a blind spot, not coverage.
    if (!Number.isFinite(s.shipmentId)) continue

    // Named here rather than beside the lookup so that one warning corresponds
    // to one row actually written: a shipment with no stable id has already
    // `continue`d above for a different and more serious reason, and reporting
    // it as unpriced as well would send someone to fix the rate card when the
    // problem is the shipment id. `onWarn` is the same channel the ambiguous
    // rate card uses, and persist-charges.ts funnels it into sync_runs.errors.
    if (!rate) {
      onWarn?.('unpriced shipment', `client ${clientId ?? 'unattributed'}: `
        + `no shipping rate is in effect on ${s.shipDate} for shipment `
        + `${s.shipmentId}; the carrier cost `
        + `${s.actualCost === null ? '(unreported)' : s.actualCost.toFixed(2)} is `
        + `recorded and the amount left null (unknown, not zero)`)
    }

    // A voided label was refunded, so it contributes nothing to measured cost.
    // It is counted in the voided-label leak line instead; leaving it in here
    // would overstate spend by the amount that came back.
    const cost = s.voided ? 0 : s.actualCost
    // at_cost means the client pays exactly what we paid, so an unreported
    // carrier cost makes the REVENUE unknown too — not zero. `?? 0` here wrote
    // a real charge of nothing: it says we billed this label at $0, when the
    // truth is that the figure has not arrived and the client will be invoiced
    // it. That is the identical null-versus-zero confusion the cost column
    // already refuses to make, and it understates revenue on every screen that
    // sums this table. A flat rate is unaffected: its amount is known whatever
    // the carrier eventually reports.
    //
    // `!rate` sits BELOW the voided test on purpose. A voided label is a known
    // zero on both sides — the carrier refunded it, so we paid nothing and we
    // bill nothing — and that is true whether or not the card prices shipping.
    // Nulling it because the card is silent would manufacture an unknown out of
    // a fact we have. Above the voided test, null is the only honest answer:
    // nobody has agreed a price, so the revenue is not zero, it is unknown.
    const amount = s.voided ? 0
                 : !rate ? null
                 : rate.rateType === 'at_cost' ? s.actualCost
                 : (rate.rate ?? 0)

    out.push({
      order_id: input.order.id,
      client_id: clientId,
      charge_key: chargeKey({ chargeType: 'shipping', shipmentId: String(s.shipmentId) }),
      charge_type: 'shipping',
      label: s.voided ? 'Shipping (voided)' : 'Shipping',
      quantity: 1,
      // `?? null` on both, not a fabricated stand-in. rate_id is a nullable FK
      // to client_warehouse_rates (ledger_03_charges.sql:59), so "no rate card
      // line" is representable — and it is exactly what makes this row
      // recognisable later as one to go and price, rather than one that was
      // priced at nothing.
      unit_rate: rate?.rate ?? null,
      amount: amount === null ? null : cents(amount),
      cost: cost === null ? null : cents(cost),
      cost_basis: cost === null ? null : 'measured',
      rate_id: rate?.id ?? null,
      cost_rate_id: null,
      charge_date: s.shipDate,
      charge_date_source: 'ship_date',
      source: 'calculator',
      is_estimate: false,
    })
  }

  // ---- peak surcharge ----------------------------------------------------
  // 8% of pick and pack only. Explicitly not on at-cost carrier freight —
  // charging a surcharge on a pass-through cost is overbilling — and not on
  // itself, which would compound.
  //
  // The percentage is checked for finiteness, not just for `> 0`: it arrives
  // from a numeric column via Number(), and an Infinity would pass `> 0` and
  // produce an amount that numeric(10,2) rejects, failing the whole order.
  // Pick and pack amounts are never null — only at-cost freight can be unknown,
  // and freight is excluded from the basis anyway — but the `?? 0` keeps a
  // future nullable amount from silently turning the whole basis into NaN.
  const eligible = out.filter((c) => c.charge_type === 'pick' || c.charge_type === 'pack')
  const basis = eligible.reduce((sum, c) => sum + (c.amount ?? 0), 0)
  if (basis > 0) {
    const first = eligible[0]

    // The percentage is dated like every other rate. input.peakSurchargePct is
    // the loader's undated reading of the same line and is used ONLY when the
    // card carries no ('surcharge', 'peak') line at all. If the card does carry
    // one, the dated lookup is authoritative in both directions — including
    // "none in effect on this date", which must mean no surcharge rather than
    // falling back to a figure that ignores the dates.
    const hasPeakLine = input.rateCard.some(
      (r) => r.chargeType === 'surcharge' && (r.variant ?? null) === 'peak')
    const dated = rateFor('surcharge', 'peak', first.charge_date)
    const pct = hasPeakLine ? (dated?.rate ?? 0) : input.peakSurchargePct

    if (Number.isFinite(pct) && pct > 0) {
      out.push({
        order_id: input.order.id,
        client_id: clientId,
        // Not a chargeKey() call, and deliberately so. chargeKey's surcharge
        // shape keys on a SHIPMENT, but a peak surcharge is levied once on the
        // order's whole pick-and-pack total, not on a label. charge_key only
        // has to be unique WITHIN an order — the unique index is
        // (order_id, charge_key) — so a constant is both deterministic and
        // sufficient. Passing the order id in as `shipmentId` would produce
        // 'shipment:<orderId>:peak', which would be a lie in the data.
        charge_key: 'surcharge:peak',
        charge_type: 'surcharge',
        label: `Peak surcharge (${pct}%)`,
        quantity: null,
        unit_rate: pct,
        amount: cents(basis * pct / 100),
        // A surcharge is pure revenue. It has no cost of its own, and 0 would
        // be a claim that it was free to provide.
        cost: null,
        cost_basis: null,
        // The dated line, when the card has one, so the surcharge is traceable
        // to the rate that produced it rather than being an unattributed number.
        rate_id: dated?.id ?? null,
        cost_rate_id: null,
        charge_date: first.charge_date,
        charge_date_source: first.charge_date_source,
        source: 'calculator',
        is_estimate: false,
      })
    }
  }

  return out
}
