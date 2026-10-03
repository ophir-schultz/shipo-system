// Read-only SIMULATION. If Section A (the additive zone_chart rows) were
// applied and nothing else changed, which of the unpriced shipments would
// price? Replays resolveZone + resolveZoneRate exactly. Writes nothing.
//
// Both the row count and the shipment count are counted at run time and
// printed. They used to be stated here as "the 29 additive zone_chart rows"
// and "the 33 unpriced shipments" -- figures from the day this was written,
// described in the present tense, in the header of the script whose whole
// output is those two numbers.
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
// The weight->matrix-row rule, pinned to `weightToLb` in
// src/lib/billing/zones.ts (commit 8ed5bf6). Imported rather than restated:
// this file used to floor an unweighed shipment to row 1, so the simulation
// counted it as one Section A WOULD price. It would not -- resolveZoneRate
// refuses that weight before it reaches the table -- and the count this script
// prints is what decides whether applying Section A is worth doing.
import { weightToLb } from './zone-weight.mjs'
// Which shipments count as unpriced, pinned to the monitor's scan. The
// `.eq('client_rate', 0)` this used to ask for stopped meaning "unpriced" when
// recalculate.ts began writing NULL, so the simulation was deciding whether
// Section A is worth applying from only the pre-change legacy zeros.
import { UNPRICED_OR, splitUnpriced, unpricedSummary, rateKind, NO_RATE } from './unpriced-filter.mjs'
// What to do when a read fails. This script's whole output is a decision
// support figure -- "would price: N of M" decides whether Section A gets
// applied -- and every read it rests on was destructured bare. The zone_chart
// read is the worst of them: `(dbChart ?? [])` means a failed read leaves the
// merge base empty, so every USPS row counts as one Section A adds, and the
// script reports a far larger `+N zone_chart rows` than Section A really is.
import { mustRead, readFailure, unknownLog, UNKNOWN } from './read-or-refuse.mjs'
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const usps = JSON.parse(readFileSync('/tmp/usps198.json','utf8'))
const uspsChart = new Map()
for (const col of ['Column0','Column1','Column2','Column3'])
  for (const e of usps[col] ?? []) {
    const z = Number(String(e.Zone).replace(/[^0-9]/g,''))
    const m = e.ZipCodes.match(/^(\d{3})\d*(?:-+(\d{3})\d*)?$/); if (!m) continue
    for (let i=Number(m[1]); i<=(m[2]?Number(m[2]):Number(m[1])); i++) uspsChart.set(String(i).padStart(3,'0'), z)
  }

// Refused, because this read IS the simulation's baseline: Section A is defined
// as "the USPS rows the table does not already have", so an unread table makes
// Section A look like the entire USPS chart and every zone it supplies look new.
const { data: dbChart } = mustRead('the zone_chart read', await db.from('zone_chart')
  .select('dest_prefix, zone').eq('origin_prefix','198'), {
  instead: 'No simulation is printed. Section A is the difference between the USPS '
    + 'chart and this table, and an unread table would have reported the whole '
    + 'USPS chart as rows Section A adds.',
})
const merged = new Map(dbChart.map(r => [r.dest_prefix, Number(r.zone)]))
let added = 0
for (const [p, z] of uspsChart) if (!merged.has(p)) { merged.set(p, z); added++ }   // Section A only

const { data: clients } = mustRead('the clients read',
  await db.from('clients').select('id, name'))
const nameOf = Object.fromEntries(clients.map(c=>[c.id,c.name]))
// `{ count: 'exact' }` alongside the rows, the way scripts/diag-unrated.mjs and
// scripts/gen-rate-card-worklist.mjs already do it. PostgREST caps a `.select()`
// with no `.range()`, so `data.length` is how many rows CAME BACK and says
// nothing about how many match. Asking for both is what lets them be compared,
// and it matters more here than anywhere: `M` in "would price: N of M" IS this
// number, and a capped M understates the case for Section A invisibly.
const unpricedRes = mustRead('the unpriced-shipments read', await db.from('shipments')
  // client_rate is selected because the split reads it.
  .select('id, client_id, carrier, service, weight, zone, recipient_zip, client_rate',
    { count: 'exact' })
  .not('client_id','is',null).or(UNPRICED_OR), {
  instead: 'No simulation is printed. An unread population would have reported '
    + '"would price: 0 of 0", which reads as Section A being worth nothing.',
})

const split = splitUnpriced(unpricedRes.data)
const unpriced = split.all

// Not `(count ?? 0)`. A failed count request answers null and a count of 0 is a
// real finding -- nothing is unpriced, i.e. there is nothing for Section A to
// fix -- so `readFailure`'s `want: 'count'` mode is what tells them apart.
const countWhy = readFailure(unpricedRes, { want: 'count' })
const unpricedTotal = countWhy ? null : unpricedRes.count
const capped = unpricedTotal != null && unpricedTotal !== unpriced.length

console.log(`simulating Section A only: +${added} zone_chart rows, no zone changes\n`)
// Which population is being simulated, stated before its result. Section A
// adds zone_chart rows, and that helps a shipment whichever value its
// client_rate holds -- but "would price: N of M" is the figure this script
// exists to produce, so what M is made of belongs next to it.
console.log(unpricedSummary(split) + '\n')

// Said at the top as well as at the headline, because this script's entire
// output is one decision: is applying Section A worth it? A shipment beyond the
// cap is never simulated, so it can only be absent from `would price` -- the
// headline moves in one direction only, DOWN, and the decision it informs is
// whether to bother. A capped read therefore argues against a change that may
// well be worth making, and nothing in the old output said so.
//
// `fetchAllPages` in src/lib/ledger/load-charge-inputs.ts is the real pager and
// is deliberately not reimplemented here: it handles PGRST103 at the end of the
// table and needs an explicit `.order()`, and it lives in a module importing
// `@/lib/supabase`, an alias Node's type stripping cannot resolve from a .mjs.
// So this says the simulation is partial rather than growing a second copy.
if (capped) {
  console.log(`!! PARTIAL: ${unpricedTotal} shipments match, but only ${unpriced.length} came back --`)
  console.log(`   PostgREST capped the read. The ${unpricedTotal - unpriced.length} not read were not simulated at all,`)
  console.log(`   so every figure below is over the subset and "would price" is a FLOOR on`)
  console.log(`   what Section A would fix, never the result. Page the query with .range()`)
  console.log(`   and re-run before deciding against applying it.\n`)
}
// A count that never arrived is not a count that agreed: with nothing to check
// `data.length` against, a cap cannot be ruled out, so the headline cannot be
// certified as covering the population either.
else if (countWhy) {
  console.log(`!! whether these are ALL the matching shipments is ${UNKNOWN}: the exact count`)
  console.log(`   was not returned (${countWhy}), so the ${unpriced.length} rows read cannot be`)
  console.log(`   compared against the number that match. PostgREST caps an unpaged .select(),`)
  console.log(`   so "would price" below may be over a subset.\n`)
}
const res = { priced: 0, pricedNull: 0, pricedZero: 0, noZone: 0, noCell: 0, noWeight: 0, unknown: 0 }
const detail = new Map()
/** Rate-cell lookups that failed, named once at the end. */
const unread = unknownLog()
for (const s of unpriced) {
  const kind = rateKind(s)
  let zone = (s.zone >= 1 && s.zone <= 8) ? s.zone : null
  if (zone == null) {
    const dp = String(s.recipient_zip ?? '').replace(/\D/g,'').slice(0,3)
    const z = dp.length === 3 ? merged.get(dp) : undefined
    if (z != null && z >= 1 && z <= 8) zone = z
  }
  let outcome
  if (zone == null) { res.noZone++; outcome = 'still NO ZONE' }
  else if (weightToLb(s.weight) === null) {
    // Section A adds zone_chart rows, and this shipment's problem is not its
    // zone. Reported as its own outcome so the headline "would price" figure
    // does not count a shipment that applying Section A cannot fix.
    res.noWeight++; outcome = `zone ${zone} OK, but NO USABLE WEIGHT`
  }
  else {
    const lb = weightToLb(s.weight)
    let rate = null
    let cellUnknown = false
    for (const a of [{c:s.carrier ?? '', sv:s.service ?? ''},{c:'',sv:''}]) {
      // `want: 'maybe'`: a null row is the ordinary miss, and the miss is what
      // `no rate cell` reports. An error is not a miss -- it used to be
      // indistinguishable from one, so a failed lookup moved a shipment out of
      // "would price" and into "rate card still missing", understating the
      // figure this script exists to produce and blaming the rate card for it.
      const hit = unread.soft(
        `${nameOf[s.client_id] ?? s.client_id} rate cell carrier=${JSON.stringify(a.c)} `
        + `service=${JSON.stringify(a.sv)} weight_lb=${lb} zone=${zone}`,
        await db.from('client_zone_rates').select('rate')
          .eq('client_id', s.client_id).eq('carrier', a.c).eq('service', a.sv)
          .eq('weight_lb', lb).eq('zone', zone).maybeSingle(),
        { want: 'maybe' },
      )
      // Breaks rather than trying the blanket pair next. A shipment whose exact
      // pair could not be read is unknown whatever the blanket row says: the
      // exact pair is tried first and wins, so a blanket hit would be reported
      // as this shipment's price when it may not be.
      if (!hit.ok) { cellUnknown = true; break }
      if (hit.value?.rate != null) { rate = Number(hit.value.rate); break }
    }
    if (cellUnknown) {
      res.unknown++
      outcome = `zone ${zone} OK, rate cell ${UNKNOWN} (lookup failed)`
    }
    else if (rate != null) {
      res.priced++
      if (kind === NO_RATE) res.pricedNull++
      else res.pricedZero++
      outcome = `PRICED $${rate.toFixed(2)} (zone ${zone})`
    }
    else { res.noCell++; outcome = `zone ${zone} OK, but no rate cell` }
  }
  // The rate kind is part of the key, so the breakdown does not merge a
  // shipment the live biller refuses to price with one that already carries a
  // stored 0.
  const k = `${nameOf[s.client_id]} [${kind}] :: ${outcome.replace(/\$[\d.]+ /, '')}`
  detail.set(k, (detail.get(k) ?? 0) + 1)
}
for (const [k, n] of [...detail].sort()) console.log(`  ${String(n).padStart(3)}  ${k}`)
// A floor for either of two independent reasons: a rate-cell lookup that failed
// (below), or shipments that were never simulated because the read was capped.
// Both can only move the figure down, so either one makes it AT LEAST.
const isFloor = res.unknown > 0 || capped
// `of M` names the population, so when the read was capped it names both: the
// number that match and the number actually simulated. Printing `unpriced.length`
// alone offered the subset as the denominator, which is the whole fault here --
// a capped M understates the case for Section A and reads as the final word.
const denom = capped ? `${unpriced.length} simulated (of ${unpricedTotal} that match)` : `${unpriced.length}`
console.log(`\n  would price: ${res.priced}${isFloor ? ' (AT LEAST)' : ''} of ${denom}`)
// Said next to the headline, not only in the stderr tail. This number is read
// as the case for applying Section A, and with failed lookups in it the number
// is a floor rather than the answer.
if (res.unknown) {
  console.log(`    ^ ${res.unknown} shipments had a rate-cell lookup fail, so they are`)
  console.log(`      counted in neither "would price" nor "rate card still missing".`)
  console.log(`      This figure is a FLOOR, not the result. Re-run.`)
}
// The same point for the other reason, next to the same number: an unsimulated
// shipment cannot land in "would price", so the case for Section A can only be
// stronger than this line says -- never weaker.
if (capped) {
  console.log(`    ^ ${unpricedTotal - unpriced.length} more shipments match but were not read, so they were never`)
  console.log(`      simulated. Section A may price some of them too. This figure is a`)
  console.log(`      FLOOR and every breakdown below is over the ${unpriced.length} simulated. Page`)
  console.log(`      the shipments query with .range() and re-run.`)
}
// Split, because only the first number is a thing Section A fixes. A shipment
// storing 0 because its card says the shipping is free already priced; it
// "would price" again at $0 here, and counting that as a Section A win
// overstates the case for applying it. Which of the stored zeros are free-card
// zeros and which are pre-NULL legacy zeros is not knowable from this column --
// that is why they are shown apart rather than resolved.
console.log(`    of which client_rate is NULL (uncovered today):   ${res.pricedNull}`)
console.log(`    of which client_rate is already 0:                ${res.pricedZero}  (a free-card zero would price at $0 regardless of Section A)`)
console.log(`  still no zone: ${res.noZone}`)
console.log(`  zone fine, rate card still missing: ${res.noCell}`)
console.log(`  zone fine, but no usable weight: ${res.noWeight}  (Section A cannot fix these; record the weight)`)
if (res.unknown) console.log(`  zone fine, but the rate cell could not be read: ${res.unknown}  (${UNKNOWN} — not a verdict either way)`)

unread.tail('rate-cell lookups')
