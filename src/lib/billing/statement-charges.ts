import { supabaseAdmin } from '@/lib/supabase'
import { readAllPages, type PageResult } from '@/lib/db/page'
import type { Money } from '@/lib/billing/unpriced'
import type { DateRange } from '@/lib/billing/statement'

// The one read behind a client's statement, used by BOTH the screen and the
// spreadsheet.
//
// Not two copies of the same query, because the spreadsheet is the artefact that
// gets attached to an invoice and the screen is what an operator checks the
// figure against before sending it. If those two selected different columns,
// filtered on a different date column, or ordered differently across pages, the
// disagreement would show up as a client disputing a number that the screen
// still displays -- and there would be no way to tell which of the two was
// right. The download route calls this function, so there is only one answer to
// be right or wrong.
//
// WHY `charge_date` AND NOT `calculated_at`.
//
// `charge_date` is the day the WORK happened -- the pick date, the ship date
// (calculate-charges.ts:212, :384) -- and `calculated_at` is the day the ledger
// got round to pricing it. A period is a claim about the client's activity, so a
// backfill run today must not move last month's picks into this month's
// statement. charge_date is `not null` (ledger_03_charges.sql:74), so no row can
// fall out of every period.
//
// WHY EVERY PAGE ENDS ITS SORT WITH `.order('id')`.
//
// Same reason as the export route. PostgREST caps a select at `db-max-rows`
// (1000) and reports it as a 200 with `error: null`, so the read has to be paged;
// and Postgres does not promise a stable row order between two OFFSET queries
// sorted on a non-unique column. `charge_date` is a DATE, so a busy client ties
// by the hundreds within one day -- without the unique tiebreaker, page two
// repeats a charge page one already returned and drops one it never did. On a
// statement that is a line billed twice and another missing, with a row count
// that still looks plausible.

/** One `order_charges` row as the statement reads it. */
export interface StatementChargeRow {
  charge_type: string
  label: string
  quantity: Money
  /**
   * The rate this line was priced at, straight off the client's rate card.
   *
   * Carried so the statement can SHOW the rate rather than leave the client to
   * divide the amount by the quantity -- which is the first thing anyone does
   * when checking an invoice, and which does not even work for a line whose
   * quantity is null. Never used to re-derive the amount: see statement.ts.
   */
  unit_rate: Money
  amount: Money
  is_estimate: boolean
  charge_date: string
  /**
   * The order this charge was raised against, or null.
   *
   * Carried so the statement can name the ORDER NUMBER beside each charge.
   * Without it the detail sheet is a list of dates and labels, and a client
   * asking "which orders is this for?" cannot be answered from the file at
   * all -- they would have to take the total on trust, which is the opposite
   * of what a statement is for. Nullable because the FK is
   * (ledger_03_charges.sql:57), and an unattributed charge must still appear
   * on the sheet rather than being dropped to make the join tidy.
   */
  order_id: string | null
  /**
   * The charge's identity within its order, and the only route from a shipping
   * charge back to the parcel it billed.
   *
   * `chargeKey` writes `shipment:<shipstation_shipment_id>` for charge_type
   * 'shipping' (charge-key.ts:74-75), and that id has a unique index on
   * `shipments` (ledger_03_charges.sql:25-26). So this column -- not a
   * same-order-number guess -- is what joins a billed freight line to its
   * carrier, service, tracking number and weight, 1:1 and unambiguously, for
   * an order that shipped in more than one box.
   */
  charge_key: string
}

/**
 * Every charge the ledger has priced for this client inside the period.
 *
 * Returns the raw PostgREST verdict rather than throwing, so the caller decides
 * whether a failed read becomes a refused screen or a refused download. Both of
 * them must refuse: this is the money.
 */
export function readStatementCharges(
  clientId: string,
  range: DateRange,
): Promise<PageResult<StatementChargeRow>> {
  return readAllPages((from, to) => supabaseAdmin
    .from('order_charges')
    .select('charge_type, label, quantity, unit_rate, amount, is_estimate, charge_date, order_id, charge_key')
    .eq('client_id', clientId)
    .gte('charge_date', range.from)
    .lte('charge_date', range.to)
    .order('charge_date')
    .order('id')
    .range(from, to))
}

/**
 * The earliest charge_date the ledger holds for this client, or null.
 *
 * The statement's history is bounded by how far back the ledger has actually
 * run, and nothing in the period figures says so. A statement for a month before
 * the ledger started is a correct sum over no rows, which renders as a confident
 * $0.00 -- and that is a sentence about the client's activity, not about our
 * coverage. The screen prints this so the two can be told apart.
 *
 * Read as a one-row list and not `.single()`, because "this client has no
 * charges at all" is a normal answer here, not the PGRST116 near-miss that
 * readOne exists to interpret.
 */
export function readEarliestChargeDate(
  clientId: string,
): PromiseLike<PageResult<{ charge_date: string }>> {
  return supabaseAdmin
    .from('order_charges')
    .select('charge_date')
    .eq('client_id', clientId)
    .order('charge_date')
    .limit(1)
}
