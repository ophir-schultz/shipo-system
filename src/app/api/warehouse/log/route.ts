import { supabaseAdmin } from '@/lib/supabase'
import { NextResponse } from 'next/server'
import { requireStaff } from '@/lib/require-staff'
import { cents } from '@/lib/ledger/calculate-charges'
import { priceServiceLine, type WarehouseRateRow } from '@/lib/billing/warehouse-log-rate'

// What this route writes ends up on five reachable surfaces:
// dashboard/page.tsx sums `total` for the week, the month and per client, and
// pnl/page.tsx, billing/page.tsx, reports/page.tsx and api/reports/download
// all read it. So a `total` of 0 here is work that was performed and will
// never be invoiced, propagated everywhere, with nothing on any of those
// screens to distinguish it from a service the client genuinely gets free.
//
// (An earlier version of this comment said six and named
// lib/billing/calculator.ts. That file contains such a read but neither of its
// exports is called from anywhere, so it is not reachable today. The count is
// corrected rather than quietly dropped.)
//
// It used to produce one on four separate paths, because the rate lookup was
// `const rate = rateRow?.rate ?? 0` with the error discarded. Each path is
// now kept apart, because they send whoever reads the alert somewhere
// different, and none of them bills zero.

type LogRow = {
  client_id: string
  service_type: string
  quantity: string | number
  notes?: string | null
}

type CardRow = WarehouseRateRow & { client_id: string }

type Unpriced = { client_id: string; service_type: string; reason: string }

export async function POST(req: Request) {
  const denied = await requireStaff()
  if (denied) return denied

  let body: { date?: unknown; rows?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Body is not valid JSON' }, { status: 400 })
  }

  const date = body.date
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json(
      { error: 'date must be a YYYY-MM-DD string' }, { status: 400 })
  }
  if (!Array.isArray(body.rows) || body.rows.length === 0) {
    return NextResponse.json(
      { error: 'rows must be a non-empty array' }, { status: 400 })
  }

  // Validated before anything is written, and the whole request is refused
  // rather than the bad row skipped. `parseFloat` used to run unguarded, and
  // a non-numeric quantity gave NaN -> `rate * NaN` -> NaN, which
  // JSON.stringify sends as null: a log row with no quantity and no total,
  // indistinguishable from a rate gap. The page already filters to
  // `parseFloat(q) > 0` before posting, so a bad quantity here means the
  // caller is not that page, and the honest answer is to say which row.
  const rows: LogRow[] = []
  for (const [i, raw] of (body.rows as unknown[]).entries()) {
    const row = raw as Partial<LogRow>
    if (typeof row?.client_id !== 'string' || !row.client_id) {
      return NextResponse.json(
        { error: `rows[${i}]: client_id is required` }, { status: 400 })
    }
    if (typeof row.service_type !== 'string' || !row.service_type) {
      return NextResponse.json(
        { error: `rows[${i}]: service_type is required` }, { status: 400 })
    }
    const qty = Number(row.quantity)
    if (!Number.isFinite(qty) || qty <= 0) {
      return NextResponse.json({
        error: `rows[${i}] (${row.service_type}): quantity `
          + `${JSON.stringify(row.quantity)} is not a positive number`,
      }, { status: 400 })
    }
    rows.push({ ...(row as LogRow), quantity: qty })
  }

  // One query for every rate card involved, instead of one `.single()` per
  // row. Three reasons, in order of importance: there is a single error to
  // check rather than N silently-discarded ones; `.single()` returns null
  // data for BOTH no rows and several, and those two are different problems;
  // and a day's log across every client was previously N round trips.
  //
  // `select('*')` and not a column list: effective_from and effective_to are
  // added by `alter table` in ledger_03_charges.sql, so naming them would make
  // this select fail with 42703 on a database that has not had that file
  // applied -- turning every line on this screen unpriced on an older schema,
  // which is a worse answer than pricing it. A rate card is a handful of rows
  // per client, so the wildcard costs nothing.
  const clientIds = [...new Set(rows.map((r) => r.client_id))]
  const { data: rateData, error: rateError } = await supabaseAdmin
    .from('client_warehouse_rates')
    .select('*')
    .in('client_id', clientIds)

  // THE WHOLE REQUEST IS REFUSED, and nothing is written. "We could not ask
  // the database what the rate is" is not the same finding as "the rate is
  // not on the card", and collapsing the first into the second is how a
  // transient failure becomes a permanent unpriced row that looks like a data
  // gap -- one nobody will ever go back and reprice, because it is
  // indistinguishable from the real ones. The operator can press the button
  // again; a row written on a failed read cannot be found afterwards.
  if (rateError) {
    return NextResponse.json({
      error: `Could not read the rate cards, so nothing was logged: `
        + `${rateError.message}. No rows were written -- the day's entries are `
        + `unsaved, and submitting again is safe.`,
    }, { status: 503 })
  }

  const byClient = new Map<string, CardRow[]>()
  for (const r of (rateData ?? []) as CardRow[]) {
    const list = byClient.get(r.client_id)
    if (list) list.push(r)
    else byClient.set(r.client_id, [r])
  }

  const entries = []
  const unpriced: Unpriced[] = []

  for (const row of rows) {
    const quantity = row.quantity as number
    // The whole card is handed over, not a service_type-filtered slice:
    // priceServiceLine needs to see the other rows to tell "no price was ever
    // agreed" from "a price was agreed in the structured shape this screen
    // does not read", and a pre-filtered array is empty in both cases.
    const { rate, reason } = priceServiceLine(
      byClient.get(row.client_id) ?? [], row.service_type, date)

    if (reason !== null) {
      unpriced.push({ client_id: row.client_id, service_type: row.service_type, reason })
    }

    entries.push({
      client_id: row.client_id,
      log_date: date,
      service_type: row.service_type,
      quantity,
      // null, not 0. Both columns are nullable in schema.sql, the row is
      // still written so the hours are not lost, and what is withheld is only
      // the claim that the work was worth nothing. The page renders the line
      // as 'unpriced' in amber and excludes it from the subtotal with a note,
      // rather than adding a silent zero. `cents` is imported rather than
      // reimplemented so this rounds the way every other money figure in the
      // ledger does -- see its comment on the exact half-cent.
      rate,
      total: rate === null ? null : cents(rate * quantity),
      notes: row.notes || null,
    })
  }

  const { error } = await supabaseAdmin.from('warehouse_daily_log').insert(entries)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // `unpriced` is returned, not just logged, because the person who typed
  // these numbers is standing in front of the screen right now and is the
  // only one who can act on it. A server-side warning would be read by
  // nobody; the page shows this list instead of a bare green tick.
  return NextResponse.json({
    success: true,
    count: entries.length,
    unpriced,
  })
}

export async function GET(req: Request) {
  const denied = await requireStaff()
  if (denied) return denied

  const { searchParams } = new URL(req.url)
  const date = searchParams.get('date')
  if (!date) {
    return NextResponse.json({ error: 'date is required' }, { status: 400 })
  }

  const { data, error } = await supabaseAdmin
    .from('warehouse_daily_log')
    .select('*, clients(name)')
    .eq('log_date', date)
    .order('created_at', { ascending: false })

  // The error was discarded, so a failed read rendered as "no entries today"
  // -- and the page hides the whole table when the list is empty, so a day's
  // work could look unlogged and get entered twice. Same distinction as the
  // ledger page: failed is not empty.
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 503 })
  }

  return NextResponse.json({ entries: data ?? [] })
}
