// Validation for the legacy warehouse rate card, as a pure function.
//
// Extracted from POST /api/clients/[id]/warehouse-rates so the rules can be
// tested without a database. The route previously handed the request body
// straight to `insert()`, so this module's whole job is the one that was
// missing: deciding what a caller is allowed to write to a table two
// different writers share.

export interface LegacyRate {
  client_id: string
  service_type: string
  rate: number
  unit: string
}

export const LEGACY_UNITS = [
  'per_unit', 'per_order', 'per_pallet', 'per_hour', 'flat', 'per_lb',
] as const

/**
 * The services the warehouse screens know about, and the single source of
 * truth for both of them.
 *
 * It lives here because the two lists had drifted, and the drift cost money.
 * app/warehouse/page.tsx offered nine services to log; the rate-card uploader
 * at components/billing/WarehouseRatesUpload.tsx offered eight to price. The
 * missing one was `labor_hours` -- so labour could be logged against a service
 * for which no rate could ever be entered through the UI, and under the old
 * `rateRow?.rate ?? 0` every hour of it billed at exactly nothing.
 *
 * Both components now import this, which makes the two lists the same list
 * rather than two lists that have to be kept the same. Adding a service in one
 * place adds it to both.
 *
 * `group` is presentation only -- app/warehouse/page.tsx renders one section
 * per group so a 14-row form stays scannable. It is deliberately NOT a billing
 * concept: nothing prices, sums or partitions on it, because a second
 * money-bearing classifier alongside service_type is a second thing that can
 * disagree with the rate card.
 *
 * NOTE ON WHAT IS ABSENT. `pick_pack` is in the original schema comment and is
 * the headline line on the published DTC card, and it is deliberately NOT here.
 * Pick and pack is raised automatically per order by the ledger
 * (lib/ledger/calculate-charges.ts, counted in lib/billing/statement.ts), so a
 * hand-logged pick_pack line would bill the same work a second time. Adding it
 * to this list is the one edit here that silently overcharges a client.
 */
export const WAREHOUSE_SERVICE_TYPES = [
  { value: 'storage', label: 'Storage', group: 'Storage' },
  { value: 'receiving', label: 'Receiving (unspecified)', group: 'Inbound' },
  // The four receiving variants carry the shapes the structured card already
  // prices per client (see supabase/ledger_05_seed_nayax.sql: pallet $20.00,
  // carton $0.85, devanning $450/$650). They are separate service types rather
  // than one 'receiving' line because they are priced on different units, and
  // one rate cannot express per-pallet and per-container at once.
  //
  // Generic 'receiving' is KEPT above, not replaced. Existing
  // client_warehouse_rates rows and existing warehouse_daily_log history both
  // name it; dropping it would strand those rates and make logged history
  // unreadable. It is relabelled '(unspecified)' so the variants read as the
  // better answer without the old value becoming a lie.
  { value: 'receiving_pallet', label: 'Pallet receiving', group: 'Inbound' },
  { value: 'receiving_carton', label: 'Carton receiving', group: 'Inbound' },
  { value: 'devan_20ft', label: 'Container devanning — 20ft', group: 'Inbound' },
  { value: 'devan_40ft', label: 'Container devanning — 40ft', group: 'Inbound' },
  { value: 'pallet_in', label: 'Pallet In', group: 'Inbound' },
  // The ONE billable FBA line, matching the published card's single blended
  // figure ($1.25 per unit covering FNSKU labelling, poly bagging, bundling,
  // kitting and inspection). Which steps were performed is recorded in `notes`
  // via composeServiceNotes and does NOT multiply the charge: the server
  // computes total = rate x quantity from this one rate, so per-step detail is
  // structurally incapable of billing. That is the property that makes the
  // detail safe to collect at all.
  { value: 'fba_prep', label: 'Amazon FBA prep', group: 'Prep & outbound' },
  { value: 'returns', label: 'Returns Processing', group: 'Prep & outbound' },
  { value: 'labeling', label: 'Labeling / Repackaging', group: 'Prep & outbound' },
  { value: 'kitting', label: 'Kitting / Assembly', group: 'Prep & outbound' },
  { value: 'pallet_out', label: 'Pallet Out', group: 'Prep & outbound' },
  { value: 'labor_hours', label: 'Labor Hours', group: 'Labour & other' },
  { value: 'special_task', label: 'Special Task', group: 'Labour & other' },
] as const

/** Section order for the log form. Any group not listed here renders last. */
export const WAREHOUSE_SERVICE_GROUPS = [
  'Inbound', 'Storage', 'Prep & outbound', 'Labour & other',
] as const

/**
 * The service whose per-step detail is collected, and the steps themselves.
 *
 * Steps are labels and not codes because their only destination is the `notes`
 * column, which a human reads. Keeping them out of `service_type` is the whole
 * design: five separately-priced prep services would mean a unit that gets
 * three steps bills three times, against a published card that promises one
 * blended $1.25.
 */
export const FBA_PREP_SERVICE = 'fba_prep'

export const FBA_PREP_STEPS = [
  'FNSKU label', 'Poly bag', 'Bundle', 'Kitting', 'Inspection',
] as const

/**
 * `notes` for a line, combining the ticked steps with anything typed.
 *
 * Free text is never dropped, which is the only real requirement: the operator
 * typed it, and a composer that silently preferred the checkboxes would lose
 * the one part of the row nothing else records.
 */
export function composeServiceNotes(
  steps: readonly string[], freeText: string,
): string {
  const picked = steps.map((s) => s.trim()).filter((s) => s !== '')
  const typed = freeText.trim()
  if (picked.length === 0) return typed
  if (typed === '') return picked.join(', ')
  return `${picked.join(', ')} — ${typed}`
}

/**
 * Lines that look like they bill the same work twice, for a warning shown
 * BEFORE submit.
 *
 * Only one pair qualifies today: the published card folds kitting into the
 * blended FBA prep rate, while `kitting` is also its own billable service. A
 * client priced for both, with both logged against the same units, pays twice.
 *
 * This returns a warning and not an error. The combination is legitimate --
 * kitting performed on non-FBA stock on the same day is exactly it -- so the
 * operator is told, not blocked. Blocking a valid day's entry is worse than a
 * sentence asking someone to check.
 */
export function overlapWarning(
  services: readonly string[],
): string | null {
  const has = new Set(services)
  if (has.has(FBA_PREP_SERVICE) && has.has('kitting')) {
    return 'Both Amazon FBA prep and Kitting / Assembly are filled in. The '
      + 'published card folds kitting into the blended FBA prep rate, so if '
      + 'these cover the same units the client is billed for it twice. Log '
      + 'Kitting separately only for work outside the FBA prep.'
  }
  return null
}

// ============================================================
// Editing an existing legacy card.
//
// POST /api/clients/[id]/warehouse-rates REPLACES the legacy card with
// exactly the rows it is sent -- it does not merge. The edit form therefore
// has one hard requirement: what is on screen must equal what the client's
// card becomes. It used to open on a single blank row regardless of what the
// client already had, so entering one new service and saving deleted every
// other rate that client had. The button said "Add Manually" and the endpoint
// replaced; nothing in between reconciled the two.
//
// These helpers are here rather than in the .tsx because vitest.config.ts
// includes only `src/**/*.test.ts` -- logic inside a component cannot be given
// a test, and this is the logic that decides which rates survive a save.
// ============================================================

/** A rate as the edit form holds it: strings, because they come from inputs. */
export interface EditableRate {
  service_type: string
  rate: string
  unit: string
}

/**
 * The parts of a stored rate row these helpers read.
 *
 * `rate` admits string because `numeric(10,2)` arrives over PostgREST as
 * either, and `charge_type` is how a structured seed row is told from a legacy
 * one -- see ALLOWED below for why the two writers must not touch each other.
 */
export interface StoredRate {
  service_type?: string | null
  rate?: number | string | null
  unit?: string | null
  charge_type?: string | null
}

/**
 * The stored card as editable form rows.
 *
 * Structured rows are dropped: this endpoint cannot author charge_type, so
 * round-tripping one through the form would either be rejected outright by
 * validateLegacyRates or re-inserted as a legacy duplicate of a seed line.
 *
 * A row whose rate is NULL preloads BLANK rather than as '0'. Null is
 * UNKNOWN and 0 is a price, and seeding the input with a zero would turn
 * "nobody priced this" into "this service is free" the moment someone pressed
 * save without reading the row.
 */
export function toEditableRates(rows: readonly StoredRate[]): EditableRate[] {
  return rows
    .filter((r) => r.charge_type == null)
    .filter((r): r is StoredRate & { service_type: string } =>
      typeof r.service_type === 'string' && r.service_type.trim() !== '')
    .map((r) => ({
      service_type: r.service_type.trim(),
      rate: r.rate === null || r.rate === undefined ? '' : String(r.rate),
      unit: typeof r.unit === 'string' && r.unit ? r.unit : 'per_unit',
    }))
    .sort((a, b) => a.service_type.localeCompare(b.service_type))
}

/**
 * The rows a save will actually send.
 *
 * Shared with droppedServices below, and that sharing is the point: the
 * warning has to name exactly the rows the submit will leave behind. Two
 * filters that agree today drift apart the first time one is edited, and the
 * failure is silent -- the form promises to keep a rate it then deletes.
 *
 * NOTE the `> 0`: a rate typed as 0 is NOT submitted, so a deliberate "this
 * service is free" cannot currently be saved from this form. That is
 * pre-existing behaviour, preserved here rather than quietly changed, because
 * fixing it alters what gets written on a billing path and deserves its own
 * change. droppedServices reports such a row as dropped, so it is at least
 * visible instead of silent.
 */
export function ratesToSubmit(rows: readonly EditableRate[]): EditableRate[] {
  return rows.filter((r) => r.rate.trim() !== '' && parseFloat(r.rate) > 0)
}

/**
 * Services on the stored card that this save would REMOVE.
 *
 * The form cannot prevent a replace from dropping a rate -- replacing is what
 * the endpoint does -- so the remaining job is to make the loss visible before
 * it happens rather than after. Covers both ways a row goes missing: deleted
 * from the form, and present but blank/zero so the submit filter skips it.
 */
export function droppedServices(
  existing: readonly StoredRate[],
  edited: readonly EditableRate[],
): string[] {
  const kept = new Set(ratesToSubmit(edited).map((r) => r.service_type))
  const out: string[] = []
  for (const e of toEditableRates(existing)) {
    if (!kept.has(e.service_type) && !out.includes(e.service_type)) {
      out.push(e.service_type)
    }
  }
  return out
}

/**
 * The service a newly added form row should default to: the first loggable
 * one not already on the form.
 *
 * A consequence of preloading. The form used to open on a single row, so a
 * fixed default of 'storage' rarely collided; now that it opens on the whole
 * card, 'storage' is usually already there -- and validateLegacyRates rejects
 * a duplicate service outright, so pressing "add row" and saving would error
 * on a form the operator had not yet touched.
 *
 * Falls back to the first service when every one is already on the card. That
 * row IS a duplicate, and it is meant to be: the alternative is returning
 * something unloggable or empty, and the duplicate check gives a message that
 * names the problem.
 */
export function nextUnusedService(used: readonly string[]): string {
  const taken = new Set(used)
  const free = WAREHOUSE_SERVICE_TYPES.find((s) => !taken.has(s.value))
  return free ? free.value : WAREHOUSE_SERVICE_TYPES[0].value
}

/**
 * The only columns this endpoint may author.
 *
 * charge_type, variant, effective_from and effective_to are deliberately
 * absent. Those belong to the seed files in supabase/, whose own delete is
 * keyed on `charge_type is not null` -- so the two writers are partitioned by
 * that column and cannot reach each other's rows. An endpoint that could set
 * charge_type would break the partition, and the rows it wrote would be
 * silently overwritten the next time the seed is applied.
 */
const ALLOWED = new Set(['client_id', 'service_type', 'rate', 'unit'])

export type Validated =
  | { rates: LegacyRate[]; warnings: string[] }
  | { error: string }

/**
 * @param raw       the request body's `rates`, entirely untrusted
 * @param clientId  from the URL. This is the authority; a row that names a
 *                  different client is rejected rather than rewritten.
 */
export function validateLegacyRates(raw: unknown, clientId: string): Validated {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { error: 'No rates provided' }
  }

  const rates: LegacyRate[] = []

  for (const [i, item] of raw.entries()) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      return { error: `rates[${i}] is not an object` }
    }
    const row = item as Record<string, unknown>

    // Rejected, not stripped. A caller that sent charge_type meant something
    // by it, and silently dropping the field would store a row that does not
    // say what was asked for -- which is how a structured line becomes a
    // legacy line nobody can account for.
    const extra = Object.keys(row).filter((k) => !ALLOWED.has(k))
    if (extra.length > 0) {
      return {
        error: `rates[${i}] carries ${extra.join(', ')}, which this endpoint `
          + `does not set. It writes only the legacy service_type rate card; `
          + `structured charge_type/variant lines are owned by the seed files `
          + `in supabase/, so that the two writers cannot overwrite each `
          + `other. Edit the seed and re-apply it instead.`,
      }
    }

    if (row.client_id !== undefined && row.client_id !== clientId) {
      return {
        error: `rates[${i}] names client_id ${JSON.stringify(row.client_id)} `
          + `but the URL names ${clientId}. Refusing rather than guessing `
          + `which is meant -- one of them is a different client's rate card.`,
      }
    }

    if (typeof row.service_type !== 'string' || !row.service_type.trim()) {
      return { error: `rates[${i}]: service_type is required` }
    }

    // A rate that cannot be read is rejected rather than stored. The uploader
    // runs parseFloat over a spreadsheet cell, parseFloat('n/a') is NaN, and
    // JSON.stringify sends NaN as null -- so without this check an unreadable
    // cell became a stored NULL rate. That is a legitimate value in the
    // column (ledger_03_charges.sql drops the NOT NULL for at_cost lines), so
    // nothing downstream would reject it; it would surface weeks later on the
    // warehouse log as a line nobody can price, with no trace of the
    // spreadsheet cell that caused it.
    //
    // Checked BEFORE the empty-string case is special-cased away, because
    // Number('') is 0, not NaN: a blank rate cell would otherwise be stored
    // as free rather than refused.
    if (row.rate === null || row.rate === undefined
        || (typeof row.rate === 'string' && !row.rate.trim())) {
      return {
        error: `rates[${i}] (${row.service_type}): rate is empty. A blank rate `
          + `is not stored as 0 -- 0 means the service is free, which is a `
          + `different statement from not having priced it.`,
      }
    }
    // Only a number or a string is coerced. Number() turns `true` into 1 and
    // `[]`/`[5]` into 0 and 5 -- so without this gate a rate of `true` is
    // stored as $1.00 and `false` as free, both of them plausible prices that
    // nothing downstream can tell apart from deliberate ones. The NaN check
    // below does not catch these, because they are finite.
    if (typeof row.rate !== 'number' && typeof row.rate !== 'string') {
      return {
        error: `rates[${i}] (${row.service_type}): rate is a `
          + `${Array.isArray(row.rate) ? 'array' : typeof row.rate}, not a `
          + `number. It is refused rather than converted -- Number() would `
          + `turn it into a real-looking price nothing downstream could `
          + `question.`,
      }
    }

    const rate = Number(row.rate)
    if (!Number.isFinite(rate)) {
      return {
        error: `rates[${i}] (${row.service_type}): rate `
          + `${JSON.stringify(row.rate)} is not a number. A rate that cannot `
          + `be read is not stored -- it would become an unbillable line.`,
      }
    }

    const unit = typeof row.unit === 'string' && row.unit ? row.unit : 'per_unit'
    if (!(LEGACY_UNITS as readonly string[]).includes(unit)) {
      return {
        error: `rates[${i}] (${row.service_type}): unit `
          + `${JSON.stringify(unit)} is not one of ${LEGACY_UNITS.join(', ')}`,
      }
    }

    // client_id comes from the URL, never from the row, even though the two
    // have just been checked to agree. The check reports a caller that is
    // confused about which client it is editing; this line is what guarantees
    // the written value regardless.
    //
    // Deliberately redundant, and therefore NOT separately testable: with the
    // check above in place the two values cannot differ, so a mutation that
    // writes row.client_id instead survives the suite. Recorded rather than
    // worked around -- contriving a test for it would mean weakening the
    // check, and the redundancy is the point. What the suite does pin is the
    // check.
    rates.push({ client_id: clientId, service_type: row.service_type.trim(), rate, unit })
  }

  // A single upload naming the same service twice would write two rows that
  // are both in effect -- which is the ambiguity warehouse-log-rate.ts then
  // refuses to price. Catching it here names the duplicate while the person
  // who typed it is still looking at the form, instead of surfacing as an
  // unpriceable line on a daily log weeks later.
  const seen = new Set<string>()
  for (const r of rates) {
    if (seen.has(r.service_type)) {
      return {
        error: `service_type '${r.service_type}' appears more than once. Two `
          + `rates for one service are both in effect at once, which makes `
          + `the service unpriceable rather than picking one.`,
      }
    }
    seen.add(r.service_type)
  }

  // A warning and not a rejection, deliberately. The Excel path derives
  // service_type from arbitrary spreadsheet text
  // (WarehouseRatesUpload.tsx:45), so a sheet saying 'Palletizing' yields
  // 'palletizing' -- a rate for a service no screen can log work against, and
  // therefore one that will never be used by anything.
  //
  // Refusing the upload would be the heavier response and would block a
  // workflow this code cannot see. Storing it silently would leave dead weight
  // on a rate card nobody audits. Reporting it is the one option that neither
  // blocks nor hides: the row is saved, and the person who uploaded it is told
  // which lines can never be billed from, while they are still looking at the
  // form.
  const known = new Set<string>(WAREHOUSE_SERVICE_TYPES.map((s) => s.value))
  const warnings = rates
    .filter((r) => !known.has(r.service_type))
    .map((r) => `'${r.service_type}' is not a service the daily log can record, `
      + `so this rate is saved but nothing will ever bill from it. The `
      + `loggable services are ${WAREHOUSE_SERVICE_TYPES.map((s) => s.value).join(', ')}.`)

  return { rates, warnings }
}
