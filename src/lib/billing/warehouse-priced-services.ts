// Which actions can this client actually be billed for today?
//
// The warehouse daily log rendered one fixed menu of actions for every client,
// taken from WAREHOUSE_SERVICE_TYPES. A read-only probe against production
// showed what that menu is worth: across 9 active clients and the 5 actions
// most recently added, ZERO combinations were priced. The work is not unpriced
// -- the cards carry `inbound_pallet_handling`, `loose_case`,
// `special_tasks_(kitting,_bundling,_counting,_repackaging,_labelling)` -- the
// constant simply does not use the names the rate cards use.
//
// Renaming the constant does not fix it, because the cards do not agree with
// each other either: `package_received` is on one client's card and no other,
// `inbound_pallet_handling` is 7/pallet on two cards and 20/pallet on a third,
// and the shrink-wrap line is spelled `..._(palletizing)` on one card and
// `..._(palletizing)_with_the_pallet` on two more. Any single constant is
// correct for some clients and silently unmatched for the rest, and an
// unmatched service_type is work that gets logged and never invoiced.
//
// So the menu is derived from the client's own card instead of guessed.

import { priceServiceLine, inEffect, type WarehouseRateRow } from './warehouse-log-rate'

export interface PricedService {
  service_type: string
  /** Already parsed, and already the number the save will bill. Never null. */
  rate: number
  /** null when the card does not say. Not defaulted -- see below. */
  unit: string | null
}

/**
 * Four states, not a boolean, because they send someone to four different
 * places and the old screen collapsed all of them into "here is a form":
 *
 *   no-card         nothing at all. Every warehouse service is unbillable for
 *                   this client, not merely the one being logged. Four of the
 *                   nine active clients are here.
 *   structured-only the card holds charge_type/variant lines. A price WAS
 *                   agreed, in a shape this screen cannot price from -- bill
 *                   through the charge calculator, or add service_type lines.
 *   none-priced     service_type lines exist but none is usable today:
 *                   expired, duplicated, or carrying no rate. Telling this
 *                   operator "no rate card" would be false.
 *   priced          at least one action is billable.
 */
export type CardState = 'no-card' | 'structured-only' | 'none-priced' | 'priced'

export interface ClientCard {
  state: CardState
  /** Empty for every state except `priced`. */
  services: PricedService[]
}

/**
 * @param card EVERY row for the client, both partitions -- the same array that
 *             POST /api/warehouse/log hands to priceServiceLine. A caller that
 *             pre-filtered to the legacy partition would make `no-card` and
 *             `structured-only` indistinguishable, which is most of the point.
 * @param date ISO yyyy-mm-dd. Passed in rather than read from the clock so the
 *             menu and the save can be asked about the SAME day; a log entered
 *             just before midnight must not be offered one rate and billed
 *             another.
 */
export function pricedServices(card: WarehouseRateRow[], date: string): ClientCard {
  if (card.length === 0) return { state: 'no-card', services: [] }

  // Blank and whitespace-only names are dropped here rather than in the
  // component: they would render as an unlabelled row and submit as a
  // service_type of ''. Every caller gets the same answer.
  const names = [...new Set(
    card
      .map((r) => r.service_type)
      .filter((s): s is string => typeof s === 'string' && s.trim() !== ''),
  )].sort()

  const services: PricedService[] = []
  for (const service_type of names) {
    // DELEGATED, not re-decided. priceServiceLine is what the save uses, so
    // asking it is the only way this menu cannot offer an action the save
    // would refuse -- or hide one it would have accepted. A second copy of
    // the effective-window and rate-parsing rules here would be two things to
    // keep in step, and the symptom of their drifting apart is an operator
    // looking at a menu that lies about what is billable.
    const { rate } = priceServiceLine(card, service_type, date)

    // `rate === null` is the refusal, and it covers every failure mode at
    // once: not in effect, ambiguous, unparseable. `!rate` would be wrong
    // here -- it also drops 0, and a rate card that says 0 is a card that
    // says this service is free, which someone decided on purpose.
    if (rate === null) continue

    // The row the rate came from, found with the SAME exported predicate
    // priceServiceLine used -- not "the first row with a rate", which would
    // happily read the unit off an expired line while billing a live one.
    // priceServiceLine returned a non-null rate, so exactly one row is live
    // here by construction: it refuses both 0 live rows and >1.
    const live = card.filter(
      (r) => r.service_type === service_type && inEffect(r, date))
    services.push({
      service_type,
      rate,
      // Not defaulted to 'per_unit'. The unit is shown to the operator beside
      // the rate, and inventing one puts a figure on screen that nobody
      // agreed to.
      unit: live[0]?.unit ?? null,
    })
  }

  if (services.length > 0) return { state: 'priced', services }
  // Only reached when nothing priced. The structured check comes second
  // because a card can hold both partitions, and if any service_type line is
  // billable the screen is usable -- the structured lines are then beside the
  // point rather than the finding.
  if (card.some((r) => r.charge_type)) return { state: 'structured-only', services: [] }
  return { state: 'none-priced', services: [] }
}
