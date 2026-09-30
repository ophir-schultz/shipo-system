import { chargeKey } from '@/lib/ledger/charge-key'
import { findCostRate, costOf, type CostRateRow } from '@/lib/ledger/cost-rate'

// Builds order_charges rows. Pure: no database, no clock, no randomness.
// Everything the calculation needs is passed in, which is what makes the
// idempotency of charge_key testable at all.

export interface ChargeInput {
  order:     { id: string; clientId: string | null; cancelled: boolean }
  items:     Array<{ id: string; sku: string | null; quantityPicked: number | null
                     isComponent: boolean; pickDate: string | null }>
  shipments: Array<{ id: string; shipmentId: number; shipDate: string
                     actualCost: number | null; voided: boolean }>
  rateCard:  Array<{ id: string; chargeType: string; variant: string | null
                     rate: number | null; rateType: string }>
  costRates: CostRateRow[]
  peakSurchargePct: number
}

export interface BuiltCharge {
  order_id: string; client_id: string | null; charge_key: string
  charge_type: string; label: string; quantity: number | null
  unit_rate: number | null; amount: number; cost: number | null
  cost_basis: string | null; rate_id: string | null; cost_rate_id: string | null
  charge_date: string; charge_date_source: string; source: string
  is_estimate: boolean
}

const cents = (n: number) => Math.round(n * 100) / 100

export function buildCharges(input: ChargeInput): BuiltCharge[] {
  // A cancelled order earns nothing and costs nothing. Returning early is
  // simpler than filtering each branch and leaves no path that could miss it.
  if (input.order.cancelled) return []

  const out: BuiltCharge[] = []
  const clientId = input.order.clientId

  const rateFor = (chargeType: string, variant: string | null) =>
    input.rateCard.find((r) =>
      r.chargeType === chargeType && (r.variant ?? null) === variant)

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
    if (!item.pickDate) continue

    const variant = item.isComponent ? 'component' : 'device'
    const rate = rateFor('pick', variant)
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
    const packRate = rateFor('pack', variant)
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
    const rate = rateFor('shipping', null)
    if (!rate) continue

    // shipstation_shipment_id is nullable in the database, and String(null) is
    // the string 'null'. Every unidentified label on one order would therefore
    // key to 'shipment:null', and because (order_id, charge_key) is unique they
    // would collapse into a single row — shipping revenue disappearing quietly
    // rather than loudly. Unidentified labels are reported by
    // leaks_monthly.unattributed_label_spend (Task 15) instead.
    if (!Number.isFinite(s.shipmentId)) continue
    // charge_date is `not null`. An undated shipment included here would fail
    // the batch upsert and take every other charge on the order with it.
    if (!s.shipDate) continue

    // A voided label was refunded, so it contributes nothing to measured cost.
    // It is counted in the voided-label leak line instead; leaving it in here
    // would overstate spend by the amount that came back.
    const cost = s.voided ? 0 : s.actualCost
    // at_cost means the client pays exactly what we paid. An unknown cost
    // cannot be billed, so the amount is 0 and the cost stays null — the two
    // are different claims and both are true.
    const amount = s.voided ? 0
                 : rate.rateType === 'at_cost' ? (s.actualCost ?? 0)
                 : (rate.rate ?? 0)

    out.push({
      order_id: input.order.id,
      client_id: clientId,
      charge_key: chargeKey({ chargeType: 'shipping', shipmentId: String(s.shipmentId) }),
      charge_type: 'shipping',
      label: s.voided ? 'Shipping (voided)' : 'Shipping',
      quantity: 1,
      unit_rate: rate.rate,
      amount: cents(amount),
      cost: cost === null ? null : cents(cost),
      cost_basis: cost === null ? null : 'measured',
      rate_id: rate.id,
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
  const pct = input.peakSurchargePct
  if (Number.isFinite(pct) && pct > 0) {
    const eligible = out.filter((c) => c.charge_type === 'pick' || c.charge_type === 'pack')
    const basis = eligible.reduce((sum, c) => sum + c.amount, 0)
    if (basis > 0) {
      const first = eligible[0]
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
        rate_id: null,
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
