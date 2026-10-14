// The daily warehouse log's form shape: which rows exist, what they are
// called, which section they appear in, and which ones submit will write.
//
// This lives in lib/ rather than inside app/warehouse/page.tsx because the
// vitest config excludes `.test.tsx` -- logic inside a component cannot be
// tested here at all, and this is logic that decides what an operator is
// billed for. Every function below is pure and has a test in
// warehouse-log-form.test.ts; the page is left with rendering.
//
// The registry (WAREHOUSE_SERVICE_TYPES) is the source of LABELS AND GROUPING
// only. It is not the source of truth for which services exist, because a
// read-only probe against production found the fixed list prices almost
// nothing: across 9 active clients and the 5 most recently added actions, ZERO
// combinations were billable. The work IS priced -- the cards carry
// `inbound_pallet_handling`, `loose_case`, `special_tasks_(...)` -- but under
// the price list's names, and the cards do not agree with each other either
// (`package_received` is on one client's card and no other;
// `inbound_pallet_handling` is 7/pallet on two cards and 20/pallet on a
// third). So no single fixed list can be right: it matches some clients and
// silently misses the rest, and a missed service_type is work that gets
// logged and never invoiced.

import {
  WAREHOUSE_SERVICE_TYPES,
  WAREHOUSE_SERVICE_GROUPS,
} from './warehouse-rate-card'
import type { CardState, PricedService } from './warehouse-priced-services'

export type { CardState }

/** Where services priced on a card but absent from the registry are rendered.
 *  Without a home they would be dropped by a group filter that never matches
 *  -- which is the original "logged but never invoiced" bug wearing a
 *  different hat, and worse, because the rate was known. */
export const CARD_GROUP = 'Priced on this client’s card'

export type ServiceRow = {
  service_type: string
  label: string
  quantity: string
  notes: string
  /** Ticked prep steps. Recorded in `notes`; never priced. */
  steps: string[]
  /** The agreed rate, as priceServiceLine resolved it. Shown beside the box. */
  rate: number
  /** May be null: a card can price a service without saying per what. Shown
   *  as nothing rather than guessed. */
  unit: string | null
}

export type ClientEntry = {
  client_id: string
  name: string
  rows: ServiceRow[]
  state: CardState
  /** Charge lines on the card this screen cannot price from. See structuredNote. */
  structuredCount: number
}

/**
 * What to tell an operator whose client has boxes on screen AND charge lines
 * that are not among them.
 *
 * Returns null unless there is something to say, which is the common case: on
 * a card with no structured partition this adds nothing to the screen.
 *
 * Deliberately NOT a fifth CardState and NOT routed through cardStateNotice.
 * Those four are refusals -- they replace the form, because entering work
 * against them produces an unbillable line. This one sits above a form that
 * works. Nayax is the case that forced it: 19 rows, 18 structured, exactly one
 * loggable action, and `state` is therefore 'priced'. The operator got a
 * single Storage box and no hint that eighteen other priced lines exist, bill
 * elsewhere, and are not their job tonight. Telling them nothing is how those
 * eighteen get re-typed into the one box that was visible, or skipped.
 *
 * It names the charge calculator because "handled elsewhere" with no address
 * is an instruction to go looking.
 */
export function structuredNote(
  state: CardState, structuredCount: number,
): string | null {
  // Only on a usable form. The other three states already show a banner that
  // says more than this one would, and stacking a grey note under an amber
  // refusal reads as though the refusal had an exception.
  if (state !== 'priced') return null
  // `<= 0`, not `=== 0`. The count comes from a payload, and a negative one
  // would otherwise render as "-1 further charge lines".
  if (structuredCount <= 0) return null
  // The verb agrees too. "1 further charge line are billed" is the kind of
  // detail that makes an operator distrust the rest of the screen.
  const subject = structuredCount === 1
    ? '1 further charge line on this client’s card is'
    : `${structuredCount} further charge lines on this client’s card are`
  return `${subject} billed through the charge calculator, not from this `
    + `screen. The boxes below are the complete list of what can be logged here.`
}

/** The registry entry for a service_type, when the registry happens to know
 *  it. Compared as a string because the registry's `value` is a union type
 *  while a card's service_type is whatever the card says. */
export function knownService(serviceType: string) {
  return WAREHOUSE_SERVICE_TYPES.find(s => String(s.value) === serviceType)
}

/**
 * `inbound_pallet_handling` -> `inbound pallet handling`.
 *
 * The underscore swap is applied ONLY to names the registry cannot label. The
 * card's own spelling is otherwise preserved, so an operator can match the row
 * against the price list they were sent -- renaming
 * `special_tasks_(kitting,_bundling,_counting,_repackaging,_labelling)` to
 * something tidier would break exactly that.
 */
export function labelFor(serviceType: string): string {
  return knownService(serviceType)?.label ?? serviceType.replace(/_/g, ' ')
}

/**
 * One form row per service the client is actually billable for, at the price
 * the save will use.
 *
 * An empty card yields NO rows. That is the point: the banner, not a form full
 * of boxes, is what the operator then sees. Twenty boxes for a client with no
 * rate card is how a day's work gets typed in and saved unpriced.
 */
export function rowsFromCard(services: PricedService[]): ServiceRow[] {
  return services.map(s => ({
    service_type: s.service_type,
    label: labelFor(s.service_type),
    quantity: '',
    notes: '',
    steps: [],
    rate: s.rate,
    unit: s.unit,
  }))
}

/** The section a row belongs in: its registry group, or the card bucket. */
export function groupOf(row: ServiceRow): string {
  return knownService(row.service_type)?.group ?? CARD_GROUP
}

/** The services in one form section. */
export function rowsInGroup(rows: ServiceRow[], group: string): ServiceRow[] {
  return rows.filter(r => groupOf(r) === group)
}

/**
 * Registry groups first, in their declared order, then the card bucket -- but
 * only when something is actually in it, so a client whose card happens to use
 * only registry names sees the layout unchanged rather than gaining an empty
 * heading.
 */
export function groupsToRender(rows: ServiceRow[]): string[] {
  const groups: string[] = [...WAREHOUSE_SERVICE_GROUPS]
  if (rows.some(r => groupOf(r) === CARD_GROUP)) groups.push(CARD_GROUP)
  return groups
}

/**
 * Rows the operator actually filled in.
 *
 * The submit loop and the per-client counts both call this. If they used
 * different predicates the summary above the button would promise a different
 * set of clients than the one that gets written.
 *
 * `parseFloat(r.quantity) > 0` is deliberate and it has a known cost: a
 * quantity of 0 cannot be submitted. That is a separate question from a RATE
 * of 0 -- a rate card saying 0 means "this service is free", which someone
 * decided, and pricedServices offers it. Zero QUANTITY means no work was done,
 * and a log line claiming no work is not worth writing.
 *
 * The `r.quantity !== ''` clause is REDUNDANT and is kept only as a statement
 * of intent. A mutation removing it passes all 39 tests, and that is correct
 * rather than a gap in them: `parseFloat('')` is NaN and `NaN > 0` is false,
 * so the empty string is already excluded by the comparison alone. It is
 * written out because "blank means skip this row" is the rule an operator is
 * relying on, and leaving that to an implicit NaN is how someone later
 * "simplifies" the comparison into `>= 0` and starts writing empty rows.
 * Nobody should add a test for it; there is no behaviour to pin.
 */
export function filledRows(rows: ServiceRow[]): ServiceRow[] {
  return rows.filter(r => r.quantity !== '' && parseFloat(r.quantity) > 0)
}

/**
 * Empty the boxes, keep the card.
 *
 * Used by "Submit Another Entry". The rows, rates, units and card state came
 * from each client's own rate card and have not changed because an entry was
 * saved, so rebuilding them from a fixed list -- which is what this screen's
 * old reset did -- would replace a priced form with a guessed one.
 */
export function clearedEntries(entries: ClientEntry[]): ClientEntry[] {
  return entries.map(e => ({
    ...e,
    rows: e.rows.map(r => ({ ...r, quantity: '', notes: '', steps: [] })),
  }))
}

/**
 * What to tell the operator when the form has no rows to show, or fewer than
 * they expect.
 *
 * `null` for a usable card. The other three states are NOT collapsed into one
 * "no rates" message, because they send the person standing at the screen to
 * three different places: add a card, use the charge calculator, or check the
 * effective dates on a card that already exists. The screen this replaced
 * showed all four the same twenty boxes.
 *
 * It is a function in lib/ rather than a ternary in the JSX for two reasons.
 * The `switch` below is exhaustive over CardState, so adding a fifth state
 * fails the typecheck instead of quietly falling into whichever branch was
 * written last. And the copy is then testable at all, which in this file it
 * otherwise would not be.
 */
export function cardStateNotice(
  state: CardState, clientName: string, date: string,
): { title: string; body: string } | null {
  switch (state) {
    case 'priced':
      return null
    case 'no-card':
      return {
        title: 'No rate card for this client',
        body: `Nothing is on file for ${clientName}, so no warehouse service `
          + `can be billed — not just the one you were about to log. Add the `
          + `rates on the client's page first; anything entered here would be `
          + `saved with no total and would not reach an invoice.`,
      }
    case 'structured-only':
      return {
        title: 'This client is priced, but not for daily log services',
        body: `A price was agreed for ${clientName}, but it is held as `
          + `receiving/storage charge lines, which this screen cannot price `
          + `from. Bill those through the charge calculator, or add `
          + `per-service rates to the card to log them here.`,
      }
    case 'none-priced':
      return {
        title: 'Nothing on this card can be priced today',
        body: `${clientName} has service lines on file, but none is usable `
          + `for ${date} — expired, duplicated, or carrying no rate. This is `
          + `not a missing rate card; check the effective dates on the `
          + `client's page.`,
      }
  }
  // Unreachable while CardState is the four states above -- the switch is
  // exhaustive, which is the point. Kept so a widened union is a compile
  // error here rather than a banner that renders nothing.
  const unhandled: never = state
  throw new Error(`Unhandled card state: ${String(unhandled)}`)
}

/**
 * `e.rate?.toFixed(2)` was one `?.` away from crashing the panel: optional
 * chaining guards `e.rate` being null, not `toFixed` being absent, so a
 * numeric column arriving over JSON as a string throws "toFixed is not a
 * function" and takes the whole list with it.
 *
 * An em-dash is kept distinct from $0.00. That distinction is the entire point
 * of the column being nullable: unpriced is not free.
 */
export function money(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—'
  const n = Number(v)
  return Number.isFinite(n) ? `$${n.toFixed(2)}` : '—'
}
