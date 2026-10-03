// A test double for the supabase-js query builder, backed by plain arrays.
//
// It exists because the two modules worth the most scrutiny in this task —
// persist-charges.ts and load-charge-inputs.ts — are almost entirely database
// choreography, and the things that can go wrong with them (a stale-delete
// losing its order-id filter, a page loop dropping rows, a chunk failure
// taking every other order's charges with it) are invisible to a pure unit
// test and catastrophic in production. Pointing a test at a real database is
// not an option: this project has no test database, and the live one holds the
// numbers the business invoices from.
//
// It is deliberately small. It implements the operators these two modules
// actually issue and nothing else, so that an unimplemented operator fails
// loudly instead of quietly returning everything.

export type FakeRow = Record<string, unknown>

export interface FakeError { message: string; code?: string }

/**
 * What awaiting a builder yields. `count` mirrors supabase-js: it is null
 * unless `.select(cols, { count: 'exact' })` asked for it, and when asked for
 * it is the number of rows matching the FILTERS — before range or limit. That
 * ordering is the entire value of the field: it is how a caller distinguishes
 * a table that is short from one that was truncated.
 */
export type FakeResult = { data: unknown; error: FakeError | null; count: number | null }

type Verb = 'select' | 'insert' | 'update' | 'upsert' | 'delete'

interface Filter {
  op: 'eq' | 'in' | 'lt' | 'lte' | 'gt' | 'gte' | 'like' | 'is-null' | 'not-is-null' | 'or'
  column: string
  value: unknown
}

/**
 * SQL LIKE, as a regex. `%` is any run of characters and `_` any one; every
 * other character is literal, including the regex metacharacters that appear in
 * the patterns this codebase actually issues — a storage charge key prefix is
 * `storage:2026-09-01:%`, whose dashes and colons must not be read as a range
 * or a class. Anchored at both ends, because SQL LIKE matches the WHOLE value.
 */
function likeToRegExp(pattern: string): RegExp {
  let body = ''
  for (const ch of pattern) {
    if (ch === '%') body += '[\\s\\S]*'
    else if (ch === '_') body += '[\\s\\S]'
    else body += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${body}$`)
}

/**
 * A record of one executed query. Tests assert on these rather than only on the
 * resulting rows, because some guarantees are about the STATEMENT and not about
 * its effect on a particular fixture — "the stale-delete is scoped to this
 * run's orders" is true of the statement even on a fixture where an unscoped
 * delete would happen to remove the same rows.
 */
export interface FakeCall {
  table: string
  verb: Verb
  filters: Filter[]
  payload: FakeRow[]
  onConflict?: string
  range?: [number, number]
  limit?: number
  /** The `count` option passed to .select(), if any. */
  count?: string
  /**
   * Sort keys, in the order they were added via .order(). Tests assert on this
   * to confirm ordering is present — deleting an .order() call from production
   * code would otherwise leave every test green.
   */
  sort: Array<{ column: string; ascending: boolean }>
}

export interface FakeDb {
  /** Live table contents. Mutated by writes; read directly in assertions. */
  tables: Record<string, FakeRow[]>
  /** Every statement executed, in order. */
  calls: FakeCall[]
  /** Return an error to make a statement fail; return null/undefined to let it run. */
  failOn?: (call: FakeCall) => FakeError | null | undefined
  client: FakeClient
}

export interface FakeClient {
  from(table: string): Builder
}

const RESULT = Symbol('result')

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  // Postgres compares a uuid column to a uuid string, and a numeric column to
  // a number, without the caller thinking about it. Coercing both sides to
  // strings keeps the double from failing a match that the database would make.
  if (a === null || a === undefined || b === null || b === undefined) return false
  return String(a) === String(b)
}

/** `col.op.value` clauses joined by commas, as PostgREST's `.or()` takes them. */
function matchesOr(row: FakeRow, expr: string): boolean {
  return expr.split(',').some((clause) => {
    const [column, op, ...rest] = clause.split('.')
    const value = rest.join('.')
    const actual = row[column]
    if (op === 'is') return value === 'null' ? actual === null || actual === undefined : false
    if (actual === null || actual === undefined) return false
    if (op === 'gte') return String(actual) >= value
    if (op === 'lte') return String(actual) <= value
    if (op === 'eq') return valuesEqual(actual, value)
    throw new Error(`fake-supabase: unimplemented .or() operator '${op}' in '${clause}'`)
  })
}

function matches(row: FakeRow, filters: Filter[]): boolean {
  return filters.every((f) => {
    const actual = row[f.column]
    switch (f.op) {
      case 'eq': return valuesEqual(actual, f.value)
      case 'in': return (f.value as unknown[]).some((v) => valuesEqual(actual, v))
      case 'lt':
        if (actual === null || actual === undefined) return false
        return String(actual) < String(f.value)
      case 'lte':
        // A null is not <= anything in SQL. Same hazard as gte below: the row
        // is DROPPED, silently, rather than compared.
        if (actual === null || actual === undefined) return false
        return String(actual) <= String(f.value)
      case 'gt':
        // Same null guard as its siblings: a null is not > anything in SQL, and
        // the row is DROPPED rather than compared.
        if (actual === null || actual === undefined) return false
        // NUMERIC when both sides are numbers, unlike the string comparisons
        // above. Those operators only ever receive ISO dates, which sort
        // correctly as strings; .gt()'s only caller in this codebase is the
        // monitor's undated-pick scan, which compares `quantity_picked` to 0 —
        // and as strings '9' > '10', so a 9-unit line would be judged against
        // a 10-unit threshold wrongly. Postgres compares integers as integers,
        // so this is the more faithful behaviour, not a convenience.
        if (typeof actual === 'number' && typeof f.value === 'number') return actual > f.value
        return String(actual) > String(f.value)
      case 'gte':
        if (actual === null || actual === undefined) return false
        return String(actual) >= String(f.value)
      case 'like':
        if (actual === null || actual === undefined) return false
        return likeToRegExp(String(f.value)).test(String(actual))
      case 'is-null': return actual === null || actual === undefined
      case 'not-is-null': return actual !== null && actual !== undefined
      case 'or': return matchesOr(row, f.value as string)
    }
  })
}

class Builder implements PromiseLike<FakeResult> {
  private call: FakeCall
  private returning = false
  private singleRow = false
  /** Set by single(), not by maybeSingle(): zero rows is then an error. */
  private requireOne = false
  private matched: number | null = null

  constructor(private db: FakeDb, table: string) {
    this.call = { table, verb: 'select', filters: [], payload: [], sort: [] }
  }

  private rows(): FakeRow[] {
    return (this.db.tables[this.call.table] ??= [])
  }

  select(_columns?: string, options?: { count?: 'exact' | 'planned' | 'estimated' }): this {
    // After a write, .select() means "return the affected rows"; on its own it
    // is the read verb. Column projection is not modelled: these modules never
    // depend on a column being absent from the result.
    if (this.call.verb === 'select') this.call.verb = 'select'
    this.returning = true
    // `count` is the number of rows matching the FILTERS, before range/limit.
    // That is the whole point of asking for it — it is how a caller tells a
    // short table from a truncated one — so the double must compute it before
    // slicing, not after.
    if (options?.count) this.call.count = options.count
    return this
  }

  insert(payload: FakeRow | FakeRow[]): this {
    this.call.verb = 'insert'
    this.call.payload = Array.isArray(payload) ? payload : [payload]
    this.returning = false
    return this
  }

  upsert(payload: FakeRow | FakeRow[], options?: { onConflict?: string }): this {
    this.call.verb = 'upsert'
    this.call.payload = Array.isArray(payload) ? payload : [payload]
    this.call.onConflict = options?.onConflict
    return this
  }

  update(patch: FakeRow): this {
    this.call.verb = 'update'
    this.call.payload = [patch]
    return this
  }

  delete(): this {
    this.call.verb = 'delete'
    this.returning = false
    return this
  }

  eq(column: string, value: unknown): this {
    this.call.filters.push({ op: 'eq', column, value }); return this
  }
  in(column: string, value: unknown[]): this {
    this.call.filters.push({ op: 'in', column, value }); return this
  }
  lt(column: string, value: unknown): this {
    this.call.filters.push({ op: 'lt', column, value }); return this
  }
  lte(column: string, value: unknown): this {
    this.call.filters.push({ op: 'lte', column, value }); return this
  }
  gt(column: string, value: unknown): this {
    this.call.filters.push({ op: 'gt', column, value }); return this
  }
  gte(column: string, value: unknown): this {
    this.call.filters.push({ op: 'gte', column, value }); return this
  }
  like(column: string, pattern: string): this {
    this.call.filters.push({ op: 'like', column, value: pattern }); return this
  }
  or(expression: string): this {
    this.call.filters.push({ op: 'or', column: '', value: expression }); return this
  }
  is(column: string, value: unknown): this {
    if (value !== null) {
      throw new Error(`fake-supabase: unimplemented .is('${column}', ${String(value)}) — only null is modelled`)
    }
    this.call.filters.push({ op: 'is-null', column, value: null })
    return this
  }
  not(column: string, operator: string, value: unknown): this {
    if (operator !== 'is' || value !== null) {
      throw new Error(`fake-supabase: unimplemented .not('${column}', '${operator}', …)`)
    }
    this.call.filters.push({ op: 'not-is-null', column, value: null })
    return this
  }

  /**
   * `nullsFirst` is accepted and ignored: `sorted()` below always places nulls
   * last, which is Postgres's ascending default and the only setting this
   * codebase asks for.
   */
  order(column: string, options?: { ascending?: boolean; nullsFirst?: boolean }): this {
    this.call.sort.push({ column, ascending: options?.ascending !== false })
    return this
  }
  range(from: number, to: number): this {
    this.call.range = [from, to]; return this
  }
  limit(n: number): this {
    this.call.limit = n; return this
  }
  /**
   * As supabase-js: zero rows is `{ data: null, error: null }`, one row is the
   * row, and MORE THAN ONE is `{ data: null, error: PGRST116 }` — an error
   * object, not a throw. See the note on PGRST116 in [RESULT] for why this
   * double must not be kinder than that.
   */
  maybeSingle(): this {
    this.returning = true; this.singleRow = true; return this
  }

  /**
   * As supabase-js, and NOT as maybeSingle(): zero rows is an ERROR here, not
   * a null. That difference is the reason both exist. zenventory.ts upserts an
   * order with `.select('id').single()` and then branches on
   * `if (orderErr || !orderRow)`, so a double that answered null-with-no-error
   * for the empty case would exercise the wrong half of that condition.
   */
  single(): this {
    this.returning = true; this.singleRow = true; this.requireOne = true; return this
  }

  private sorted(rows: FakeRow[]): FakeRow[] {
    if (this.call.sort.length === 0) return rows
    return [...rows].sort((a, b) => {
      for (const { column, ascending } of this.call.sort) {
        const av = a[column], bv = b[column]
        if (valuesEqual(av, bv)) continue
        // Nulls sort last ascending, as Postgres does by default.
        if (av === null || av === undefined) return 1
        if (bv === null || bv === undefined) return -1
        const cmp = String(av) < String(bv) ? -1 : 1
        return ascending ? cmp : -cmp
      }
      return 0
    })
  }

  private [RESULT](): FakeResult {
    this.db.calls.push(this.call)

    const injected = this.db.failOn?.(this.call)
    if (injected) return { data: null, error: injected, count: null }

    const table = this.rows()
    let affected: FakeRow[] = []

    switch (this.call.verb) {
      case 'select': {
        affected = this.sorted(table.filter((r) => matches(r, this.call.filters)))
        if (this.call.count) this.matched = affected.length
        const [from, to] = this.call.range ?? [0, affected.length - 1]
        // PostgREST answers a range that starts past the end with PGRST103
        // rather than an empty 200. fetchAllPages depends on treating that as
        // end-of-table, and a double that returned [] instead would leave that
        // branch untested.
        if (from > 0 && from >= affected.length) {
          return { data: null, error: { message: 'Requested range not satisfiable', code: 'PGRST103' }, count: null }
        }
        affected = affected.slice(from, to + 1)
        if (this.call.limit !== undefined) affected = affected.slice(0, this.call.limit)
        break
      }
      case 'insert': {
        affected = this.call.payload.map((r, i) => ({
          id: r.id ?? `fake-${this.call.table}-${table.length + i + 1}`, ...r,
        }))
        table.push(...affected)
        break
      }
      case 'upsert': {
        const keys = (this.call.onConflict ?? '').split(',').map((k) => k.trim()).filter(Boolean)
        for (const incoming of this.call.payload) {
          // A conflict target naming a column the payload does not have is a
          // typo, and it has to fail here or the match below silently succeeds:
          // `valuesEqual(undefined, undefined)` is true, so a misspelled key
          // matches the FIRST row in the table and the upsert updates it. Every
          // row in a batch would collapse onto row one and the test would still
          // be green. persist-charges.test.ts's idempotency test -- the one
          // spec §8 calls the most important in the file -- carried exactly this
          // blind spot: it proved charge_key was deterministic and could say
          // nothing about the onConflict target, because a mangled target
          // behaved identically.
          //
          // Real PostgREST answers 42703 for an unknown column and 42P10 when
          // no unique index matches the target, so failing is the faithful
          // behaviour as well as the useful one. A throw rather than an error
          // result because this is a broken test, not a modelled database
          // outcome -- same reason an unimplemented operator throws.
          //
          // `in`, not a truthiness or undefined check: `order_id` is null on a
          // storage charge and on unattributed label spend, and null is a
          // legitimate conflict-target value that NULL-distinctness simply
          // leaves unconstrained. Present-and-null must pass; absent must not.
          for (const k of keys) {
            if (!(k in incoming)) {
              throw new Error(
                `fake-supabase: upsert on ${this.call.table} names '${k}' in its `
                + `onConflict target, but the payload has no such key. Keys present: `
                + `${Object.keys(incoming).join(', ')}`)
            }
          }
          const existing = keys.length > 0
            ? table.find((r) => keys.every((k) => valuesEqual(r[k], incoming[k])))
            : undefined
          if (existing) { Object.assign(existing, incoming); affected.push(existing) }
          else {
            const row = { id: incoming.id ?? `fake-${this.call.table}-${table.length + 1}`, ...incoming }
            table.push(row); affected.push(row)
          }
        }
        break
      }
      case 'update': {
        affected = table.filter((r) => matches(r, this.call.filters))
        for (const r of affected) Object.assign(r, this.call.payload[0])
        break
      }
      case 'delete': {
        affected = table.filter((r) => matches(r, this.call.filters))
        this.db.tables[this.call.table] = table.filter((r) => !affected.includes(r))
        break
      }
    }

    if (!this.returning) return { data: null, error: null, count: null }

    if (this.singleRow) {
      // supabase-js does NOT throw when maybeSingle() matches more than one
      // row: it returns `{ data: null, error: { code: 'PGRST116' } }`. Code
      // that destructures only `data` therefore sees null and reads it as "no
      // row exists", which is how the same duplicate-insert defect has been
      // fixed three times on this branch (see the DEFECT 1 note in
      // sync/shipstation.ts). A double that quietly answered `affected[0]`
      // instead would make every test written against it useless as evidence
      // about exactly the code path that keeps breaking, so the double is held
      // to the real client's behaviour rather than to a more convenient one.
      //
      // single() additionally errors on ZERO rows, where maybeSingle() answers
      // null. PGRST116's own message says "multiple (or no) rows returned"
      // because PostgREST uses one code for both.
      if (affected.length > 1 || (this.requireOne && affected.length === 0)) {
        return {
          data: null,
          error: {
            message: 'JSON object requested, multiple (or no) rows returned',
            code: 'PGRST116',
          },
          count: null,
        }
      }
      return { data: affected[0] ?? null, error: null, count: this.matched }
    }

    return { data: affected, error: null, count: this.matched }
  }

  then<R1 = FakeResult, R2 = never>(
    onFulfilled?: ((v: FakeResult) => R1 | PromiseLike<R1>) | null,
    onRejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    let result: FakeResult
    try { result = this[RESULT]() } catch (err) { return Promise.reject(err).then(onFulfilled, onRejected) }
    return Promise.resolve(result).then(onFulfilled, onRejected)
  }
}

export function createFakeSupabase(tables: Record<string, FakeRow[]> = {}): FakeDb {
  const db: FakeDb = {
    tables,
    calls: [],
    client: { from: (table: string) => new Builder(db, table) },
  }
  return db
}
