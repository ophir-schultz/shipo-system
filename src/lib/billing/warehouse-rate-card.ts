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
 */
export const WAREHOUSE_SERVICE_TYPES = [
  { value: 'storage', label: 'Storage' },
  { value: 'receiving', label: 'Receiving' },
  { value: 'returns', label: 'Returns Processing' },
  { value: 'labeling', label: 'Labeling / Repackaging' },
  { value: 'kitting', label: 'Kitting / Assembly' },
  { value: 'pallet_in', label: 'Pallet In' },
  { value: 'pallet_out', label: 'Pallet Out' },
  { value: 'labor_hours', label: 'Labor Hours' },
  { value: 'special_task', label: 'Special Task' },
] as const

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
