// Reading a whole table, rather than reading the first thousand rows of it and
// not finding out.
//
// PostgREST caps every select at its own `db-max-rows` (1000 by default) and
// reports the cap NOWHERE: the response is a 200 with `error: null` and a
// thousand rows in it. So an unpaginated read against a bigger table is not a
// failed read that a refusal gate can catch -- `read()` passes it, the error
// gate added to the report export passes it, and the resulting spreadsheet is
// internally consistent, correctly formatted, and short by an unknown amount.
//
// That is strictly worse than a failed read. A failed read now refuses; a
// truncated read is a confident wrong total, and the invoice built from it
// undercharges a client by whatever fell past row 1000. It is also silent on
// the way in: the defect does not exist at all until the table crosses the cap,
// and then it appears without anything changing in the code.
//
// This is the same loop load-charge-inputs.ts has run on the money path since
// the ledger shipped; `fetchAllPages` there is now a wrapper over this, so
// there is one implementation of the paging rule and not two that drift. The
// ledger's existing tests for it are what prove that extraction was faithful.

/**
 * Rows requested per page. Asking for more than the server's `db-max-rows`
 * is harmless -- a short page is handled below -- so this does not have to
 * match the server's setting and must not assume it does.
 */
export const PAGE_SIZE = 1000

export interface PageError {
  message: string
  code?: string
}

export interface PageResult<T> {
  data: T[] | null
  error: PageError | null
}

/**
 * Every row the query matches, or the error that stopped the read.
 *
 * The return type is deliberately the SAME shape as a single PostgREST result,
 * so this drops into `read()`/`readOne()` and `isMigrationMissing()` unchanged
 * and the error object arrives with its `code` intact. A pager that threw
 * instead would force every page in this app to grow a try/catch and would
 * bypass the refusal plumbing that already exists.
 *
 * `page` must build a FRESH query each call and apply `.range(from, to)` to it.
 *
 * ORDERING IS PART OF THE CONTRACT. Postgres does not promise a stable row
 * order across two OFFSET queries that sort on a non-unique column, so paging
 * a read ordered only by `ship_date` can return one row twice and skip
 * another -- which on an export is a duplicated billable line and a missing
 * one, with the row count still looking right. Every `page` passed here must
 * end its sort keys with a unique column (`id` on every table in schema.sql).
 */
export async function readAllPages<T>(
  page: (from: number, to: number) => PromiseLike<PageResult<T>>,
): Promise<PageResult<T>> {
  const rows: T[] = []
  let from = 0
  for (;;) {
    const { data, error } = await page(from, from + PAGE_SIZE - 1)
    // A table whose row count is an exact multiple of the page size gets one
    // request past the end, because an empty page is the only reliable stop
    // condition (see below). PostgREST answers that with PGRST103, "requested
    // range not satisfiable", rather than 200 []. That is end of table, not a
    // failure, and reporting it as one would refuse to export a report over a
    // row count nobody controls.
    if (error?.code === 'PGRST103') return { data: rows, error: null }
    // Rows read before the failure are discarded rather than returned. They are
    // a prefix of the answer, and a prefix presented as the answer is the exact
    // defect this file exists to remove.
    if (error) return { data: null, error }
    const batch = data ?? []
    rows.push(...batch)
    // Advance by what came back, not by what was asked for. The server caps a
    // response at its own `db-max-rows`, so one configured below PAGE_SIZE
    // returns a short page on the FIRST request -- and a `length < PAGE_SIZE`
    // stop condition would read that as end-of-table and silently drop every
    // remaining row, reintroducing the truncation in the code meant to fix it.
    // An empty page is the only reliable end marker.
    if (batch.length === 0) return { data: rows, error: null }
    from += batch.length
  }
}
