// Resolving a warehouse daily-log line to a rate, as a pure function.
//
// This is extracted from POST /api/warehouse/log rather than left inline
// because it is the point at which work performed becomes money invoiced, and
// what it used to be was `const rate = rateRow?.rate ?? 0` with the lookup's
// error discarded. Four distinct conditions collapsed into a billable zero,
// and `warehouse_daily_log.total` is read by five reachable surfaces --
// dashboard/page.tsx (week, month, and per-client), pnl/page.tsx,
// billing/page.tsx, reports/page.tsx and api/reports/download -- so a zero
// there is work that will never be invoiced, agreeing with itself everywhere
// it is shown.
//
// An earlier version of this comment counted lib/billing/calculator.ts as a
// sixth. It does contain such a read, but neither of its exports is called
// from anywhere in the repository, so it is not a surface a zero reaches
// today. Corrected rather than left standing: a blast radius is a claim, and
// this one was not checked when it was written.
//
// Pure, so the decision can be tested without a database. The project has no
// test database and the live one holds the figures the business invoices from;
// the same reasoning as the header of ledger/fake-supabase.ts.

export interface WarehouseRateRow {
  id: string
  service_type: string | null
  /**
   * Nullable since ledger_03_charges.sql dropped the NOT NULL, so that an
   * at_cost line can be expressed at all. The workaround it replaced was
   * storing 0, which reads as "free" everywhere downstream.
   *
   * Typed to admit `string` as well because `numeric(10,2)` is a column type
   * whose JSON representation is not worth betting a billing path on. It is
   * coerced and checked for finiteness rather than trusted.
   */
  rate: number | string | null
  /**
   * effective_from / effective_to are added by `alter table` in
   * ledger_03_charges.sql, so on a database that has not had that file applied
   * they are absent rather than null. Both are treated as unbounded, which is
   * the only reading under which an un-migrated card still prices correctly.
   */
  effective_from?: string | null
  effective_to?: string | null
  /**
   * Set only by the structured seed files. Its presence is how this function
   * tells "no price was ever agreed" from "a price was agreed in a shape this
   * screen does not read" -- two findings that send someone to different
   * places, and which a single "no rate found" message conflates.
   */
  charge_type?: string | null
}

export interface PricedLine {
  /** null means UNKNOWN. Never 0 -- 0 is a price, and a wrong one. */
  rate: number | null
  /** null exactly when `rate` is non-null. Says what to do, not just what failed. */
  reason: string | null
}

/**
 * Half-open [from, to), matching client_warehouse_rates_no_overlap, which is
 * declared `daterange(effective_from, effective_to, '[)')`. Using a different
 * convention here from the one the constraint enforces would let two rates the
 * database considers non-overlapping both be in effect on the same day.
 *
 * ISO yyyy-mm-dd strings compare correctly with `<`/`>=`, which is why no Date
 * is constructed: `new Date('2026-03-01')` is UTC midnight and
 * `new Date('2026-03-01T00:00:00')` is local, and a comparison that silently
 * depends on the server's timezone is not one to put in a billing path.
 */
export function inEffect(r: WarehouseRateRow, date: string): boolean {
  if (r.effective_from && r.effective_from > date) return false
  if (r.effective_to && r.effective_to <= date) return false
  return true
}

/**
 * @param card  EVERY row on the client's rate card, not a pre-filtered subset.
 *              The filtering happens here so that "the card holds structured
 *              lines only" and "the client has no card at all" can be reported
 *              as themselves; a caller that filtered by service_type first
 *              would hand over an empty array for all three cases.
 */
export function priceServiceLine(
  card: WarehouseRateRow[],
  serviceType: string,
  date: string,
): PricedLine {
  // `.eq('service_type', ...)` in PostgREST could never have matched a
  // structured row either -- those carry service_type null, and a SQL
  // equality never matches NULL. Doing it in memory changes no behaviour and
  // makes the three empty-set cases below distinguishable.
  const named = card.filter((r) => r.service_type === serviceType)
  const live = named.filter((r) => inEffect(r, date))

  if (named.length === 0) {
    if (card.length === 0) {
      return {
        rate: null,
        reason: 'this client has no warehouse rate card at all, so no price '
          + 'has been agreed for any service',
      }
    }
    if (card.some((r) => r.charge_type)) {
      return {
        rate: null,
        reason: `no rate line names service_type '${serviceType}'. This `
          + `client's card holds structured charge_type/variant lines, which `
          + `this screen does not price from -- add a service_type line for `
          + `this work, or bill it through the charge calculator instead`,
      }
    }
    return {
      rate: null,
      reason: `no rate line names service_type '${serviceType}', so no price `
        + `has been agreed for this service`,
    }
  }

  if (live.length === 0) {
    const windows = named
      .map((r) => `${r.effective_from ?? 'open'}..${r.effective_to ?? 'open'}`)
      .join(', ')
    return {
      rate: null,
      reason: `${named.length} rate line(s) exist for '${serviceType}' but `
        + `none is in effect on ${date} (windows: ${windows}). Extend an `
        + `effective_to, or add a line covering this date.`,
    }
  }

  if (live.length > 1) {
    // Reachable, not hypothetical. client_warehouse_rates_no_overlap is keyed
    // on `charge_type with =`, and a NULL never conflicts in an exclusion
    // constraint -- so the charge_type-null rows this screen reads are exactly
    // the rows that constraint does not cover. Two can be written, and
    // `.single()` reported that the same way it reports none: null data, which
    // `?? 0` then billed as free. Resolving it by sort order would be worse
    // than refusing: it would bill a real amount from an arbitrary row.
    return {
      rate: null,
      reason: `${live.length} rate lines for '${serviceType}' are all in `
        + `effect on ${date} (ids ${live.map((r) => r.id).join(', ')}), so `
        + `which one applies is ambiguous. Delete or date-bound the duplicates.`,
    }
  }

  const raw = live[0].rate
  const parsed = raw === null || raw === undefined || raw === '' ? NaN : Number(raw)
  if (!Number.isFinite(parsed)) {
    return {
      rate: null,
      reason: `the '${serviceType}' rate line in effect on ${date} `
        + `(id ${live[0].id}) carries no usable rate (${JSON.stringify(raw)}), `
        + `so this work cannot be priced here. Fill in that rate, or bill the `
        + `service at cost through the charge calculator.`,
    }
  }

  // A negative rate is a credit, and a credit entered on a daily activity log
  // is far more likely to be a typo in the rate card than a deliberate
  // discount on receiving. It is admitted rather than refused -- refusing
  // would make a legitimate correction impossible to record -- but 0 is
  // returned as 0, not converted to null: a rate card that says 0 is a card
  // that says this service is free, which is a statement someone made on
  // purpose. That is the whole distinction this function exists to preserve,
  // and it runs in both directions.
  return { rate: parsed, reason: null }
}
