// Read-only. Emits, per client, exactly which client_zone_rates cells are
// missing to cover their real traffic. Inserts nothing.
import { createClient } from '@supabase/supabase-js'
import { readFileSync, writeFileSync } from 'node:fs'
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const usps = JSON.parse(readFileSync('/tmp/usps198.json','utf8'))
const chart = new Map()
for (const col of ['Column0','Column1','Column2','Column3'])
  for (const e of usps[col] ?? []) {
    const z = Number(String(e.Zone).replace(/[^0-9]/g,''))
    const m = e.ZipCodes.match(/^(\d{3})\d*(?:-+(\d{3})\d*)?$/); if (!m) continue
    for (let i=Number(m[1]); i<=(m[2]?Number(m[2]):Number(m[1])); i++) chart.set(String(i).padStart(3,'0'), z)
  }
// The weight->matrix-row rule, pinned to `weightToLb` in
// src/lib/billing/zones.ts (commit 8ed5bf6). Imported rather than restated.
// Of the four copies this one mattered most: the worklist this script WRITES
// tells an operator which cells to create, and flooring an unweighed shipment
// to row 1 put "weight_lb 1" on that list. Creating that cell would not have
// priced the shipment -- resolveZoneRate refuses an unusable weight before it
// looks anything up -- so the instruction was both useless and pointed at the
// cheapest row on the card.
import { weightToLb } from './zone-weight.mjs'
// Which shipments count as unpriced, pinned to the monitor's scan. Of the seven
// scripts that still asked for `.eq('client_rate', 0)` after recalculate.ts
// started writing NULL, this is the one that mattered most: the worklist it
// WRITES is what an operator acts on, so every shipment left unpriced since the
// NULL change was absent from the list of cells somebody is asked to create.
import { UNPRICED_OR, splitUnpriced, rateKind, NO_RATE } from './unpriced-filter.mjs'

/**
 * Stops the run without writing, naming the read that failed.
 *
 * A failed read is UNKNOWN, and the one thing this script must not do with an
 * UNKNOWN is write it out as a 0. docs/rate-card-worklist.md is an operator
 * document: `splitUnpriced(null)` answers an empty population quite happily, so
 * a read that failed outright would have produced "Generated from the 0
 * shipments", a worklist with no clients in it and no indication that anything
 * had gone wrong -- read as "there is no rate-card work to do". Same reasoning
 * as src/lib/billing/recalculate.ts, which refuses rather than writing a price
 * it cannot stand behind.
 *
 * Exits BEFORE writeFileSync, so the previous worklist is left intact rather
 * than overwritten with an empty one. That matters more than it looks: the
 * stale file is at least a true record of a run that worked.
 */
function refuse(what, error) {
  console.error(
    `\n!! REFUSING to write docs/rate-card-worklist.md: ${what} failed `
    + `-- ${error?.message ?? 'no rows returned and no error given'}.\n`
    + `   Nothing was written; any existing worklist is untouched and is now `
    + `stale rather than wrong. Fix the read and re-run.`
  )
  process.exit(1)
}

const { data: clients, error: clientsErr } = await db.from('clients').select('id, name')
// Without this the next line threw "Cannot read properties of null (reading
// 'map')" -- which does at least refuse, but names neither the query nor the
// document that did not get written.
if (clientsErr || !clients) refuse('the clients read', clientsErr)
const nameOf = Object.fromEntries(clients.map(c=>[c.id,c.name]))

const { data: unpricedRows, count: unpricedTotal, error: unpricedErr } = await db.from('shipments')
  // client_rate is selected because the split reads it.
  .select('client_id, carrier, service, weight, zone, recipient_zip, client_rate', { count: 'exact' })
  .not('client_id','is',null).or(UNPRICED_OR)

// `!unpricedRows` is refused alongside the error. A genuinely empty result
// arrives as [], not null, so null here means the read did not happen -- and
// "no shipments are unpriced" is far too good a piece of news to infer from a
// query that never answered.
if (unpricedErr || !unpricedRows) refuse('the unpriced-shipments read', unpricedErr)

const split = splitUnpriced(unpricedRows)
const unpriced = split.all

// PostgREST caps a `.select()` with no `.range()`. The exact count is requested
// so the two can be compared, because this script WRITES the worklist an
// operator acts on: a capped read here does not merely undercount a console
// figure, it drops whole clients off the list of people whose card needs cells,
// and nothing in the document would say so. Same fault as the predicate this
// file just had fixed -- describing a population while quietly meaning a subset.
//
// `fetchAllPages` in src/lib/ledger/load-charge-inputs.ts is the real pager and
// is not reimplemented here: it handles PGRST103 at the end of the table and
// requires an explicit `.order()` for stable paging, and it lives in a module
// that imports `@/lib/supabase` -- an alias Node's type stripping cannot
// resolve (scripts/zone-weight.mjs explains that wall at length). So this says
// the list is partial rather than guessing at a second copy of the pager.
const capped = unpricedTotal != null && unpricedTotal !== unpriced.length

// Date and counts are derived. This line read "Generated 2026-09-29 from the 33
// shipments with `client_rate = 0`": a fixed date and a fixed total, written
// into a document whose entire purpose is to be regenerated, naming a predicate
// that had by then stopped meaning unpriced.
const today = new Date().toISOString().slice(0, 10)
let out = `# Rate-card worklist — what is missing, per client\n\n`
// The banner goes in the DOCUMENT, not only the console. This file is what gets
// read, often long after the run, and an operator who never saw the terminal
// has no other way to learn the list is partial.
if (capped) {
  out += `> ## ⚠ THIS LIST IS INCOMPLETE\n>\n`
  out += `> ${unpricedTotal} shipments match, but the query returned only ${unpriced.length}:\n`
  out += `> PostgREST capped the result. Every total below, every per-client section and\n`
  out += `> every cell count describes that subset only, and **whole clients may be missing\n`
  out += `> from this document entirely** — so an absent client here is not evidence that\n`
  out += `> their card is complete. Page the shipments query with \`.range()\` and\n`
  out += `> regenerate before working from this list.\n\n`
}
out += `Generated ${today} from the `
out += capped ? `${unpriced.length} of ${unpricedTotal}` : `${unpriced.length}`
out += ` shipments that have a client assigned and\n`
out += `no usable rate: **${split.noRate.length} with \`client_rate\` NULL** (the rate card does not cover\n`
out += `them) and **${split.zero.length} rated exactly \`0\`**.\n\n`
out += `Those two are counted apart because they arrive by different routes. NULL is what\n`
out += `\`lib/billing/recalculate.ts\` writes today for a shipment it cannot price. A stored\n`
out += `\`0\` is either a row last priced before unknown became NULL, or a rate card that\n`
out += `genuinely says the shipping is free — and nothing in the column tells those two\n`
out += `apart. **A free-card zero needs no cell created**, so check a \`0\` row against the\n`
out += `client's agreement before acting on it. Each client's rows below are marked.\n\n`
out += `Read-only analysis. Nothing has been written to the database.\n\n`
out += `\`resolveZoneRate\` looks for a \`client_zone_rates\` row matching\n`
out += `\`{client_id, carrier, service, weight_lb, zone}\` exactly — first with the\n`
out += `shipment's own carrier/service, then with the blanket pair \`carrier=''\`,\n`
out += `\`service=''\`. Any other combination is never tried.\n\n`

const byClient = new Map()
for (const s of unpriced) {
  if (!byClient.has(s.client_id)) byClient.set(s.client_id, [])
  byClient.get(s.client_id).push(s)
}

/** Clients whose rate card could not be read, collected for the stderr tail. */
const cardReadFailures = []

for (const [cid, rows] of [...byClient].sort((a,b)=>b[1].length-a[1].length)) {
  // Capped the same way, and this read is the one that changes the INSTRUCTION
  // rather than a count: the `Fix` paragraph below branches on whether `pairs`
  // contains the blanket `carrier=''` pair. If the rows carrying it sat beyond
  // the cap, the operator is told to create or re-key a card that already
  // exists. A full 20x8 blanket grid is 160 rows, so a client with several
  // carrier/service pairs can reach the limit.
  const { data: card, count: cardTotal, error: cardErr } = await db.from('client_zone_rates')
    .select('carrier, service, weight_lb, zone', { count: 'exact' }).eq('client_id', cid)
  // Not a refusal, because this one is per-client and the other sections are
  // still worth having -- but emphatically not an empty card either. `card`
  // would be null, `cardRead` 0, and the document would have said "*none at
  // all*" and then "Fix: create a card" to an operator whose client may already
  // have a complete one. So this client's card is reported UNKNOWN and the Fix
  // line is withheld rather than guessed.
  const cardKnown = !cardErr && card != null
  if (!cardKnown) cardReadFailures.push(nameOf[cid] ?? cid)
  const cardRead = card?.length ?? 0
  const cardCapped = cardKnown && cardTotal != null && cardTotal !== cardRead
  const pairs = [...new Set((card ?? []).map(r => `carrier=${JSON.stringify(r.carrier)} service=${JSON.stringify(r.service)}`))]

  const clientSplit = splitUnpriced(rows)
  out += `## ${nameOf[cid]} — ${rows.length} unpriced `
  out += `(${clientSplit.noRate.length} NULL, ${clientSplit.zero.length} stored \`0\`)\n\n`
  if (!cardKnown) {
    out += `**Card today:** *UNKNOWN — could not be read.* \`client_zone_rates\` query failed: `
    out += `${cardErr?.message ?? 'no rows returned and no error given'}\n\n`
    out += `> **⚠ A failed read is not an empty card, so no fix is suggested for this\n`
    out += `> client.** They may already have a complete card. The cells listed below are\n`
    out += `> what their traffic needs; whether any of them are missing is not known.\n`
    out += `> Re-run before concluding anything about this client.\n\n`
  }
  else out += `**Card today:** ${cardRead ? `${cardCapped ? `${cardTotal} rows, of which ${cardRead} were read` : `${cardRead} rows`}, keyed \`${pairs.join('` , `')}\`` : '*none at all*'}\n\n`
  if (cardCapped) {
    out += `> **⚠ This client's card read was capped** — ${cardTotal} rows exist, ${cardRead} came back.\n`
    out += `> The keys above are only those present in that subset, so the **Fix** below may\n`
    out += `> name work that is already done: a blanket \`carrier=''\`, \`service=''\` row could\n`
    out += `> exist beyond the cap. Page this query with \`.range()\` before acting on it.\n\n`
  }

  const need = new Map()
  let noWeight = 0
  for (const s of rows) {
    const dp = String(s.recipient_zip ?? '').replace(/\D/g,'').slice(0,3)
    const z = (s.zone >= 1 && s.zone <= 8) ? s.zone : (chart.get(dp) ?? null)
    // 'NO WEIGHT' rather than row 1, alongside the existing 'NO ZONE' marker
    // and for the same reason: a cell nobody can name is not a cell to add.
    const lb = weightToLb(s.weight)
    if (lb === null) noWeight++
    // The rate kind is part of the key so the table does not merge the two. A
    // cell wanted only by stored-0 rows may be a cell that already prices --
    // at $0, because the card says free -- and creating it would be the
    // operator doing work to change a price somebody agreed.
    const k = `${lb ?? 'NO WEIGHT'}|${z ?? 'NO ZONE'}|${rateKind(s) === NO_RATE ? 'NULL' : '0'}`
    need.set(k, (need.get(k) ?? 0) + 1)
  }
  out += `**Cells its real traffic needs** (weight_lb x zone, zone resolved via the USPS chart):\n\n`
  out += `| weight_lb | zone | stored client_rate | shipments |\n|---|---|---|---|\n`
  for (const [k, n] of [...need].sort()) { const [w,z,kind]=k.split('|'); out += `| ${w} | ${z} | ${kind} | ${n} |\n` }
  if (clientSplit.zero.length) {
    out += `\n> **${clientSplit.zero.length} of these already store \`0\`.** If this client's agreement says\n`
    out += `> the shipping is free, those rows are correct and the cells wanted only by\n`
    out += `> them are **not cells to create**. If it does not, they are pre-NULL legacy\n`
    out += `> zeros and they belong on this list. The column cannot tell you which;\n`
    out += `> the agreement can.\n`
  }
  if (noWeight) {
    out += `\n> **${noWeight} of these have no usable weight** (absent, 0, negative or\n`
    out += `> non-finite), so no \`weight_lb\` can be named for them and the rows marked\n`
    out += `> \`NO WEIGHT\` above are **not cells to create**. \`weightToLb\` answers null\n`
    out += `> for such a shipment and \`resolveZoneRate\` reports it unpriced without\n`
    out += `> reading the matrix, so no rate-card row will price them. Record the\n`
    out += `> weight on the shipment instead.\n`
  }

  const carriers = [...new Set(rows.map(s => `${s.carrier} / ${s.service}`))]
  out += `\n**Their traffic is:** ${carriers.map(c=>`\`${c}\``).join(', ')}\n\n`
  if (!cardKnown) out += `**Fix:** *withheld* — this client's card could not be read, so there is nothing to compare their traffic against. See above.\n\n`
  else if (!cardRead) out += `**Fix:** create a card. Simplest is a blanket grid \`carrier=''\`, \`service=''\`, weight_lb 1-20 x zone 1-8 = 160 cells.\n\n`
  else if (pairs.some(p => p.includes('carrier=""'))) {
    // "fail only because the zone could not be resolved" is not true of a
    // shipment with no usable weight, and this line is the one an operator
    // acts on, so it is not allowed to say "no work needed" for a shipment
    // that needs a weight recorded.
    out += `**Fix:** the blanket card already exists and covers zones 1-8 — ${noWeight ? `${rows.length - noWeight} of these` : 'these'} fail only because the zone could not be resolved. Section A of the zone_chart proposal fixes them. No rate-card work needed.`
    out += noWeight
      ? ` The other ${noWeight} fail on an unusable weight, which Section A does not touch: record the weight.\n\n`
      : `\n\n`
  }
  else out += `**Fix:** the existing ${cardRead} rows are keyed to \`${pairs.join('`, `')}\`, which this client's traffic never matches. Either re-key them to the blanket pair \`carrier=''\`, \`service=''\`, or add a second card keyed to \`carrier='STAMPS_COM'\` with the real USPS rates.\n\n`
  out += `---\n\n`
}
writeFileSync('/Users/ophirschultz/shipo-system/docs/rate-card-worklist.md', out)
console.log(out)
// On stderr as well as in the document, because this script's stdout is often
// redirected and the banner would go with it.
if (capped) {
  console.error(
    `\n!! wrote a PARTIAL worklist: ${unpricedTotal} shipments match but only `
    + `${unpriced.length} were read. Whole clients may be missing. Page the `
    + `shipments query with .range() and regenerate.`
  )
}
if (cardReadFailures.length) {
  console.error(
    `\n!! ${cardReadFailures.length} client(s) had an unreadable rate card and are `
    + `marked UNKNOWN with no fix suggested: ${cardReadFailures.join(', ')}. `
    + `Their sections say what their traffic needs but not what is missing.`
  )
}
