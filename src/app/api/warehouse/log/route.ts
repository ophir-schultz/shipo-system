import { supabaseAdmin } from '@/lib/supabase'
import { NextResponse } from 'next/server'
import { requireStaff } from '@/lib/require-staff'
import { readAllPages } from '@/lib/db/page'
import { cardLines, priceLogLine, type RateCardRow } from '@/lib/billing/warehouse-card-lines'
import type { WarehouseRateRow } from '@/lib/billing/warehouse-log-rate'
import {
  FREIGHT_SERVICE, canonicalShipmentId, freightColumnMissing, freightFullTotal,
  prepareFreightLines, type FreightDraft,
} from '@/lib/billing/manual-freight'

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
  amount: number | null
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
  if (body.rows != null && !Array.isArray(body.rows)) {
    return NextResponse.json(
      { error: 'rows must be an array' }, { status: 400 })
  }
  const freightRaw = (body as { freight?: unknown }).freight
  if (freightRaw != null && !Array.isArray(freightRaw)) {
    return NextResponse.json({ error: 'freight must be an array' }, { status: 400 })
  }

  // Validated before anything is written, and the whole request is refused
  // rather than the bad row skipped. `parseFloat` used to run unguarded, and
  // a non-numeric quantity gave NaN -> `rate * NaN` -> NaN, which
  // JSON.stringify sends as null: a log row with no quantity and no total,
  // indistinguishable from a rate gap. The page already filters to
  // `parseFloat(q) > 0` before posting, so a bad quantity here means the
  // caller is not that page, and the honest answer is to say which row.
  const rows: LogRow[] = []
  for (const [i, raw] of ((body.rows ?? []) as unknown[]).entries()) {
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
    const amountRaw = (row as { amount?: unknown }).amount
    let amount: number | null = null
    if (amountRaw !== undefined && amountRaw !== null && amountRaw !== '') {
      amount = Number(amountRaw)
      if (!Number.isFinite(amount)) {
        return NextResponse.json({
          error: `rows[${i}] (${row.service_type}): amount `
            + `${JSON.stringify(amountRaw)} is not a number`,
        }, { status: 400 })
      }
    }
    rows.push({ ...(row as LogRow), quantity: qty, amount })
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
  const freightDrafts: FreightDraft[] = []
  for (const [i, raw] of ((freightRaw ?? []) as unknown[]).entries()) {
    const row = raw as Partial<FreightDraft>
    if (!row || typeof row.clientId !== 'string' || typeof row.date !== 'string' || typeof row.shipmentRef !== 'string') {
      return NextResponse.json({ error: `Freight line ${i + 1} is incomplete.` }, { status: 400 })
    }
    freightDrafts.push({
      clientId: row.clientId,
      date: row.date,
      shipmentRef: row.shipmentRef,
      carrierCost: row.carrierCost,
      markup: row.markup,
    })
  }
  if (rows.length === 0 && freightDrafts.length === 0) {
    return NextResponse.json({ error: 'Add a service quantity or a freight line.' }, { status: 400 })
  }

  let freightToSave: { clientId: string; date: string; shipmentRef: string; carrierCost: number; markup: number; fullTotal: number }[] = []
  let freightSetup: 'ready' | 'absent' | null = freightDrafts.length ? 'ready' : null
  if (freightDrafts.length > 0) {
    const refs: string[] = []
    for (const [i, draft] of freightDrafts.entries()) {
      const id = canonicalShipmentId(draft.shipmentRef)
      if (!id) {
        return NextResponse.json({
          error: `Freight line ${i + 1} needs the shipment id. An order number or a tracking number is not a shipment.`,
        }, { status: 400 })
      }
      draft.shipmentRef = id
      refs.push(id)
    }
    const found = refs.length === 0 ? { data: [], error: null } : await supabaseAdmin
      .from('shipments')
      .select('shipstation_shipment_id, client_id, client_rate')
      .in('shipstation_shipment_id', refs)
    if (found.error) {
      return NextResponse.json({
        error: `Could not check the shipments, so nothing was logged: ${found.error.message}`,
      }, { status: 503 })
    }
    const probe = await supabaseAdmin.from('warehouse_daily_log').select('shipment_ref').limit(1)
    if (freightColumnMissing(probe.error)) {
      freightSetup = 'absent'
    } else if (probe.error) {
      return NextResponse.json({
        error: `Could not read freight lines, so nothing was logged: ${probe.error.message}`,
      }, { status: 503 })
    } else {
      const existing = await supabaseAdmin
        .from('warehouse_daily_log')
        .select('shipment_ref')
        .in('shipment_ref', refs)
      if (freightColumnMissing(existing.error)) {
        freightSetup = 'absent'
      } else if (existing.error) {
        return NextResponse.json({
          error: `Could not read freight lines, so nothing was logged: ${existing.error.message}`,
        }, { status: 503 })
      } else {
        const prepared = prepareFreightLines(
          freightDrafts,
          (found.data ?? []).map((row) => {
            const record = row as { shipstation_shipment_id: number | string; client_id: string | null; client_rate: unknown }
            return {
              shipmentRef: String(record.shipstation_shipment_id),
              clientId: record.client_id ?? '',
              zonePriced: record.client_rate != null && record.client_rate !== '',
            }
          }),
          (existing.data ?? []).map((row) => String((row as { shipment_ref?: string }).shipment_ref ?? '')),
        )
        if (!prepared.ok) return NextResponse.json({ error: prepared.error }, { status: 400 })
        freightToSave = prepared.lines
      }
    }
  }

  for (const line of freightToSave) {
    if (
      line.carrierCost < 0
      || line.markup < 0
      || line.fullTotal !== freightFullTotal(line.carrierCost, line.markup)
    ) {
      return NextResponse.json({
        error: 'Freight total did not match cost plus markup. Nothing was logged.',
      }, { status: 400 })
    }
  }

  const clientIds = [...new Set(rows.map((r) => r.client_id))]
  const rateRead = clientIds.length === 0
    ? { data: [], error: null }
    : await supabaseAdmin
      .from('client_warehouse_rates')
      .select('*')
      .in('client_id', clientIds)
  const { data: rateData, error: rateError } = rateRead

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

  for (const [i, row] of rows.entries()) {
    const quantity = row.quantity as number
    const lines = cardLines((byClient.get(row.client_id) ?? []) as RateCardRow[], date)
    const line = lines.find((item) => item.key === row.service_type)
    const priced = priceLogLine({
      line,
      quantity,
      amount: row.amount,
      notes: row.notes ?? null,
    })
    if (priced.error) {
      return NextResponse.json({
        error: `rows[${i}] (${row.service_type}): ${priced.error}`,
      }, { status: 400 })
    }
    if (priced.unpricedReason) {
      unpriced.push({
        client_id: row.client_id,
        service_type: row.service_type,
        reason: priced.unpricedReason,
      })
    }

    entries.push({
      client_id: row.client_id,
      log_date: date,
      service_type: row.service_type,
      quantity,
      // null, not 0. An automatic line and an unpriced line both store null.
      // The note is what tells them apart: the automatic note is skipped by
      // the revenue screens, and an unpriced line is still flagged.
      rate: priced.rate,
      total: priced.total,
      notes: priced.notes,
    })
  }

  if (entries.length > 0) {
    const { error } = await supabaseAdmin.from('warehouse_daily_log').insert(entries)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  }
  if (freightToSave.length > 0) {
    const { error } = await supabaseAdmin.from('warehouse_daily_log').insert(freightToSave.map((line) => ({
      client_id: line.clientId,
      log_date: line.date,
      service_type: FREIGHT_SERVICE,
      quantity: 1,
      rate: null,
      total: line.fullTotal,
      freight_cost: line.carrierCost,
      freight_markup: line.markup,
      shipment_ref: line.shipmentRef,
      notes: null,
    })))
    if (error) {
      return NextResponse.json({
        error: entries.length > 0
          ? `Service lines were saved. Freight was not: ${error.message}`
          : error.message,
        freightSaved: 0,
      }, { status: 500 })
    }
  }

  // `unpriced` is returned, not just logged, because the person who typed
  // these numbers is standing in front of the screen right now and is the
  // only one who can act on it. A server-side warning would be read by
  // nobody; the page shows this list instead of a bare green tick.
  return NextResponse.json({
    success: true,
    count: entries.length,
    unpriced,
    freightSaved: freightToSave.length,
    freightSetup,
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

  const { data, error } = await readAllPages((from, to) => supabaseAdmin
    .from('warehouse_daily_log')
    .select('*, clients(name)')
    .eq('log_date', date)
    .order('created_at', { ascending: false })
    .order('id')
    .range(from, to))

  // The error was discarded, so a failed read rendered as "no entries today"
  // -- and the page hides the whole table when the list is empty, so a day's
  // work could look unlogged and get entered twice. Same distinction as the
  // ledger page: failed is not empty.
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 503 })
  }

  return NextResponse.json({ entries: data ?? [] })
}
