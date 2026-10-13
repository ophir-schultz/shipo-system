import { describe, it, expect } from 'vitest'
import { readAllPages, PAGE_SIZE } from '@/lib/db/page'

// The loop these cover used to live in load-charge-inputs.ts and is still
// proven there against the real fake database. What is tested here is the part
// that is new: it RETURNS the failure instead of throwing it, because the
// callers on this side of the app are a page and an export route that have a
// refusal to render, and a thrown error would bypass `read()` entirely.
//
// The interesting cases are all about the difference between "that was the last
// page" and "the read stopped early", because every one of them arrives looking
// like the other. PostgREST reports a cap with a 200 and reports the end of a
// table with an error, so the two signals are inverted from what they should be.

/** A page function over a fixed array, with a server-side cap of `cap` rows. */
function server<T>(rows: T[], cap = PAGE_SIZE) {
  const seen: Array<[number, number]> = []
  const page = async (from: number, to: number) => {
    seen.push([from, to])
    return { data: rows.slice(from, Math.min(to + 1, from + cap)), error: null }
  }
  return { page, seen }
}

describe('readAllPages', () => {
  it('returns every row of a table larger than one page', async () => {
    // The defect in one line: unpaginated, this read returns `cap` rows with
    // error null and nothing anywhere says the other 1500 exist.
    const all = Array.from({ length: 2500 }, (_, i) => ({ i }))
    const { page } = server(all, 1000)

    const res = await readAllPages(page)

    expect(res.error).toBeNull()
    expect(res.data).toHaveLength(2500)
    // Not just the count: a paging bug that double-counts a page would also
    // produce 2500 and would be a duplicated billable line on an invoice.
    expect(res.data!.map(r => r.i)).toEqual(all.map(r => r.i))
  })

  it('keeps reading when the SERVER caps a page below what was asked for', async () => {
    // `db-max-rows` is the server's setting, not ours. Configured below
    // PAGE_SIZE it short-pages the very first request, and a
    // `length < PAGE_SIZE` stop condition would read that as end-of-table and
    // drop everything after row 3 -- reintroducing the truncation inside the
    // code written to remove it.
    const all = Array.from({ length: 7 }, (_, i) => ({ i }))
    const { page, seen } = server(all, 3)

    const res = await readAllPages(page)

    expect(res.data).toHaveLength(7)
    expect(seen).toHaveLength(4)              // 3 + 3 + 1 + 0
    // Advancing by PAGE_SIZE rather than by what came back would ask for row
    // 1000 second and return 3 rows out of 7.
    expect(seen.map(([from]) => from)).toEqual([0, 3, 6, 7])
  })

  it('treats PGRST103 as the end of the table, not as a failure', async () => {
    // A table whose row count is an exact multiple of the page size always gets
    // one request past the end, and PostgREST answers that with an error rather
    // than 200 []. Refusing on it would mean a report that cannot be exported
    // whenever the row count lands on a round number.
    let call = 0
    const res = await readAllPages(async () => {
      call++
      if (call === 1) return { data: [{ i: 1 }], error: null }
      return { data: null, error: { message: 'Requested range not satisfiable', code: 'PGRST103' } }
    })

    expect(res.error).toBeNull()
    expect(res.data).toEqual([{ i: 1 }])
  })

  it('returns the error, and no rows, when a page fails', async () => {
    // The rows read before the failure are a PREFIX of the answer, and a prefix
    // handed back as the answer is the defect. So data is null -- which is what
    // makes `read()` refuse rather than render a short table.
    const original = { message: 'permission denied for table shipments', code: '42501' }
    let call = 0
    const res = await readAllPages(async () => {
      call++
      if (call === 1) return { data: Array.from({ length: 1000 }, (_, i) => ({ i })), error: null }
      return { data: null, error: original }
    })

    expect(res.data).toBeNull()
    expect(res.error).toBe(original)
  })

  it('hands the error object back by identity, with its code intact', async () => {
    // Load-bearing in two places: load-charge-inputs.ts branches on `code` to
    // name a migration file, and isMigrationMissing() reads `code` to decide
    // between the yellow actionable banner and the red one. A pager that
    // re-wrapped the error into a string would silently disable both.
    const original = { message: 'relation "public.bills" does not exist', code: '42P01' }
    const res = await readAllPages(async () => ({ data: null, error: original }))

    expect(res.error).toBe(original)
    expect(res.error!.code).toBe('42P01')
  })

  it('stops after one request on an empty table', async () => {
    const { page, seen } = server([])

    const res = await readAllPages(page)

    // An empty result and a successful read of an empty table are the same
    // thing HERE, and only here: error is null, so the caller may say so.
    expect(res).toEqual({ data: [], error: null })
    expect(seen).toHaveLength(1)
  })

  it('does not loop forever on a table whose size is an exact page multiple', async () => {
    const all = Array.from({ length: 2000 }, (_, i) => ({ i }))
    const { page, seen } = server(all, 1000)

    const res = await readAllPages(page)

    expect(res.data).toHaveLength(2000)
    expect(seen).toHaveLength(3)              // 1000 + 1000 + 0
  })

  it('asks for a page of PAGE_SIZE rows, inclusive of both ends', async () => {
    // Off by one here reads 999 rows per round trip and still looks CORRECT,
    // because the loop advances by what came back -- it would only be slower.
    // So it needs an assertion; nothing else in this file would notice.
    const { page, seen } = server([{ i: 0 }])

    await readAllPages(page)

    expect(seen[0]).toEqual([0, PAGE_SIZE - 1])
  })
})
