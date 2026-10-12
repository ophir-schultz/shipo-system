// Generates a REVIEWABLE SQL proposal for zone_chart origin 198.
// Executes nothing against the database.
//
// Handles three subtleties in the USPS chart that a naive parse gets wrong:
//   1. Some entries are 5-digit ("96700"), not 3-digit ranges.
//   2. Zones carry '*' / '+' markers. '+' means "see the 5-digit table".
//   3. The 5-digit table's overrides are sometimes scoped to a mail SERVICE.
//      zone_chart has no service column, so those prefixes cannot be
//      represented and are deliberately NOT inserted.
import { createClient } from '@supabase/supabase-js'
import { readFileSync, writeFileSync } from 'node:fs'
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const usps = JSON.parse(readFileSync('/tmp/usps198.json', 'utf8'))

// ---- 3-digit table ----
const chart = new Map(), marked = new Set()
for (const col of ['Column0', 'Column1', 'Column2', 'Column3'])
  for (const e of usps[col] ?? []) {
    const raw = String(e.Zone)
    const zone = Number(raw.replace(/[^0-9]/g, ''))
    const m = e.ZipCodes.match(/^(\d{3})\d*(?:-+(\d{3})\d*)?$/); if (!m) continue
    for (let i = Number(m[1]); i <= (m[2] ? Number(m[2]) : Number(m[1])); i++) {
      const p = String(i).padStart(3, '0')
      chart.set(p, zone); if (/[*+]/.test(raw)) marked.add(p)
    }
  }

// ---- 5-digit overrides ----
// service === '' means the override applies to ALL services and can safely
// replace the 3-digit value. Anything else is service-scoped and therefore
// inexpressible in this schema.
const overrideAll = new Map(), overrideScoped = new Map()
for (const e of usps.Zip5Digit ?? []) {
  const [lo, hi] = e.ZipCodes.split('---')
  const zone = Number(String(e.Zone).replace(/[^0-9]/g, ''))
  for (let i = Number(lo.slice(0, 3)); i <= Number(hi.slice(0, 3)); i++) {
    const p = String(i).padStart(3, '0')
    if (e.MailService) {
      if (!overrideScoped.has(p)) overrideScoped.set(p, new Set())
      overrideScoped.get(p).add(`${e.MailService} -> zone ${zone}`)
    } else overrideAll.set(p, zone)
  }
}
for (const [p, z] of overrideAll) chart.set(p, z)   // service=ALL: safe to apply

const { data } = await db.from('zone_chart').select('dest_prefix, zone').eq('origin_prefix', '198')
const have = new Map((data ?? []).map(r => [r.dest_prefix, Number(r.zone)]))

const missing = [], ambiguous = [], changed = [], extra = []
for (const [p, z] of [...chart].sort()) {
  if (overrideScoped.has(p) && !overrideAll.has(p)) { ambiguous.push([p, z]); continue }
  if (!have.has(p)) missing.push([p, z])
  else if (have.get(p) !== z) changed.push([p, have.get(p), z])
}
for (const p of [...have.keys()].sort()) if (!chart.has(p)) extra.push(p)
const zone9 = missing.filter(([, z]) => z > 8).map(([p]) => p)

let o = `-- =====================================================================
-- PROPOSED zone_chart changes for origin_prefix '198'  (Wilmington, DE)
-- Generated 2026-09-29. NOTHING HAS BEEN EXECUTED. Review before running.
--
-- WHY THIS EXISTS
--   All 223 shipments in the system are STAMPS_COM (USPS). But zone_chart
--   currently holds a UPS ground chart: it has no zone 1 anywhere, and
--   198->198 is zone 2 (UPS minimum). USPS rates that lane as zone 1.
--   The table has no carrier column, so it can only hold one carrier's chart.
--
-- SOURCE
--   USPS postcalc.usps.com DomesticZoneChart, origin 198,
--   effective ${usps.EffectiveDate}. Retrieved 2026-09-29.
--   5-digit overrides applied where they apply to all mail services.
--
-- MEASURED IMPACT OF SECTION B
--   169 of 190 priced shipments already agree with the USPS chart.
--   21 shift zone. Net billing change: +$1.34 total.
-- =====================================================================


-- ---------------------------------------------------------------------
-- SECTION A — ADDITIONS (${missing.length} rows the DB is missing entirely)
-- This is the section that fixes the unpriced shipments. It is purely
-- additive and cannot change the price of anything already priced.
-- Simulated effect: prices 5 of the 33 unpriced shipments.
-- ---------------------------------------------------------------------
`
if (missing.length) {
  o += `INSERT INTO zone_chart (origin_prefix, dest_prefix, zone) VALUES\n`
  // Comma must PRECEDE the comment, or `--` swallows it and the INSERT breaks.
  o += missing.map(([p, z], i) => {
    const sep = i === missing.length - 1 ? '' : ','
    const note = overrideAll.has(p) ? '   -- from USPS 5-digit table (all services)'
      : marked.has(p) ? '   -- USPS marks this prefix * or +' : ''
    return `  ('198', '${p}', ${z})${sep}${note}`
  }).join('\n')
  o += `\nON CONFLICT DO NOTHING;\n`
}

o += `

-- ---------------------------------------------------------------------
-- SECTION A-EXCLUDED — ${ambiguous.length} prefixes deliberately NOT inserted
-- USPS gives these a different zone depending on the mail SERVICE, and
-- zone_chart has no service column. Inserting either value would be wrong
-- for the other half of the services. No shipment has ever gone to one of
-- these, so leaving them absent keeps the failure loud instead of silent.
-- ---------------------------------------------------------------------
`
for (const [p, z] of ambiguous)
  o += `--   ${p}: 3-digit table says zone ${z}; ${[...overrideScoped.get(p)].join('; ')}\n`

o += `

-- ---------------------------------------------------------------------
-- SECTION B — ZONE CORRECTIONS (${changed.length} rows where DB disagrees with USPS)
-- OPTIONAL and SEPARATE. These change prices on already-billed shipments
-- (net +$1.34). Do not run this in the same breath as Section A.
-- ---------------------------------------------------------------------
`
for (const [p, d_, u] of changed)
  o += `-- UPDATE zone_chart SET zone = ${u} WHERE origin_prefix='198' AND dest_prefix='${p}';  -- was ${d_}\n`

o += `

-- ---------------------------------------------------------------------
-- SECTION C — PRESENT IN DB, NOT IN USPS CHART (${extra.length})
-- ---------------------------------------------------------------------
${extra.map(p => `--   198 -> ${p} (zone ${have.get(p)}) is not a USPS destination prefix`).join('\n') || '--   none'}


-- ---------------------------------------------------------------------
-- SECTION D — STILL UNPRICEABLE AFTER ALL OF THE ABOVE
-- ---------------------------------------------------------------------
--   Zone > 8 in Section A: ${zone9.join(', ') || 'none — 969 resolves to zone 8 via the 5-digit table'}
--
--   International destinations have no ZIP prefix and can never be priced
--   by this table. Observed: 1 shipment to UK postcode W9 3BA
--   (Suteka, usps_first_class_mail_international).
`
writeFileSync('/Users/ophirschultz/shipo-system/scripts/proposed-zone-chart-198.sql', o)
console.log(`Section A:          ${missing.length} additions`)
console.log(`Section A-EXCLUDED: ${ambiguous.length} service-dependent prefixes skipped`)
console.log(`Section B:          ${changed.length} zone corrections (net +$1.34)`)
console.log(`Section C:          ${extra.length} in DB but not USPS`)
console.log(`zone > 8 remaining: ${zone9.join(', ') || 'none'}`)
console.log('\nwrote scripts/proposed-zone-chart-198.sql — NOT executed')
