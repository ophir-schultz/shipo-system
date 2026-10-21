// What can each client be billed for on a given day?
//
// The warehouse daily log used to render one fixed list of actions for every
// client. A probe against production found that list prices nothing: across 9
// active clients and the 5 most recently added actions, zero combinations were
// billable, because the cards use the price list's names and the constant used
// its own. See lib/billing/warehouse-priced-services.ts for the full reasoning.
//
// This endpoint answers the question per client, from each client's own card,
// using the same function that prices the save.

import { supabaseAdmin } from '@/lib/supabase'
import { NextResponse } from 'next/server'
import { requireStaff } from '@/lib/require-staff'
import { pricedServices } from '@/lib/billing/warehouse-priced-services'
import type { WarehouseRateRow } from '@/lib/billing/warehouse-log-rate'

type CardRow = WarehouseRateRow & { client_id: string }

export async function GET(req: Request) {
  const denied = await requireStaff()
  if (denied) return denied

  const date = new URL(req.url).searchParams.get('date')
  // Validated rather than defaulted to today. The menu and the save must be
  // asked about the SAME day -- if this silently fell back to the server's
  // clock while the operator was logging yesterday's work, the screen would
  // offer a rate the save would not use. A bad parameter is a caller bug and
  // says so.
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json(
      { error: `A date is required, as yyyy-mm-dd. Received ${JSON.stringify(date)}.` },
      { status: 400 },
    )
  }

  const { data: clients, error: clientsError } = await supabaseAdmin
    .from('clients')
    .select('id, name')
    .eq('active', true)
    .order('name')

  // REFUSED, not emptied. `const { data } = ...` with the error dropped is how
  // "we could not ask the database" renders as "this client has no rates" --
  // and on this screen that is a menu with nothing in it, which an operator
  // reads as "there is no work to log today".
  if (clientsError) {
    return NextResponse.json(
      { error: `Could not read the client list: ${clientsError.message}` },
      { status: 503 },
    )
  }

  // One query for every card, like POST /api/warehouse/log, and `select('*')`
  // for the reason stated there: naming effective_from/effective_to fails with
  // 42703 on a database that has not had ledger_03_charges.sql applied, which
  // would turn every action on this screen into "unpriced" on an older schema.
  const { data: rateData, error: ratesError } = await supabaseAdmin
    .from('client_warehouse_rates')
    .select('*')

  if (ratesError) {
    return NextResponse.json(
      { error: `Could not read the rate cards: ${ratesError.message}` },
      { status: 503 },
    )
  }

  const byClient = new Map<string, CardRow[]>()
  for (const r of (rateData ?? []) as CardRow[]) {
    const list = byClient.get(r.client_id)
    if (list) list.push(r)
    else byClient.set(r.client_id, [r])
  }

  return NextResponse.json({
    date,
    clients: (clients ?? []).map((c) => ({
      id: c.id,
      name: c.name,
      // A client with no rows at all gets [] -- which pricedServices reports
      // as 'no-card', the state four of the nine active clients are in.
      ...pricedServices(byClient.get(c.id) ?? [], date),
    })),
  })
}
