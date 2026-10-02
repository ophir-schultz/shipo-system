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

const { data: clients } = await db.from('clients').select('id, name')
const nameOf = Object.fromEntries(clients.map(c=>[c.id,c.name]))
const { data: unpriced } = await db.from('shipments')
  .select('client_id, carrier, service, weight, zone, recipient_zip')
  .not('client_id','is',null).eq('client_rate', 0)

let out = `# Rate-card worklist — what is missing, per client\n\n`
out += `Generated 2026-09-29 from the 33 shipments with \`client_rate = 0\`.\n`
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

for (const [cid, rows] of [...byClient].sort((a,b)=>b[1].length-a[1].length)) {
  const { data: card } = await db.from('client_zone_rates')
    .select('carrier, service, weight_lb, zone').eq('client_id', cid)
  const pairs = [...new Set((card ?? []).map(r => `carrier=${JSON.stringify(r.carrier)} service=${JSON.stringify(r.service)}`))]

  out += `## ${nameOf[cid]} — ${rows.length} unpriced\n\n`
  out += `**Card today:** ${card?.length ? `${card.length} rows, keyed \`${pairs.join('` , `')}\`` : '*none at all*'}\n\n`

  const need = new Map()
  let noWeight = 0
  for (const s of rows) {
    const dp = String(s.recipient_zip ?? '').replace(/\D/g,'').slice(0,3)
    const z = (s.zone >= 1 && s.zone <= 8) ? s.zone : (chart.get(dp) ?? null)
    // 'NO WEIGHT' rather than row 1, alongside the existing 'NO ZONE' marker
    // and for the same reason: a cell nobody can name is not a cell to add.
    const lb = weightToLb(s.weight)
    if (lb === null) noWeight++
    const k = `${lb ?? 'NO WEIGHT'}|${z ?? 'NO ZONE'}`
    need.set(k, (need.get(k) ?? 0) + 1)
  }
  out += `**Cells its real traffic needs** (weight_lb x zone, zone resolved via the USPS chart):\n\n`
  out += `| weight_lb | zone | shipments |\n|---|---|---|\n`
  for (const [k, n] of [...need].sort()) { const [w,z]=k.split('|'); out += `| ${w} | ${z} | ${n} |\n` }
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
  if (!card?.length) out += `**Fix:** create a card. Simplest is a blanket grid \`carrier=''\`, \`service=''\`, weight_lb 1-20 x zone 1-8 = 160 cells.\n\n`
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
  else out += `**Fix:** the existing ${card.length} rows are keyed to \`${pairs.join('`, `')}\`, which this client's traffic never matches. Either re-key them to the blanket pair \`carrier=''\`, \`service=''\`, or add a second card keyed to \`carrier='STAMPS_COM'\` with the real USPS rates.\n\n`
  out += `---\n\n`
}
writeFileSync('/Users/ophirschultz/shipo-system/docs/rate-card-worklist.md', out)
console.log(out)
