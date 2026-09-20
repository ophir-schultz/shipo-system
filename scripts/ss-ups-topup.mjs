// Top-up puller: quotes ONLY the destinations missing from ups-rates-raw.json,
// then merges them back in. Use this instead of re-running the full 20-minute
// pull when the destination list gains a city.
//
// Why it exists: the original pull labelled its seven cities by assumption and
// never covered Zone 4 or Zone 7 at all (Atlanta and Dallas were both Zone 6 —
// the same zone twice — and New York duplicated Philadelphia's Zone 2). Rather
// than throw away 4,900 good quotes to fix two columns, this fills the holes.
//
// SAFETY: credentials are read from .env.local only and are NEVER logged.
// It refuses to overwrite the raw file with fewer rows than it started with.
import fs from 'fs';
import path from 'path';
import os from 'os';

const HOME = os.homedir();
const OUT_DIR = path.join(HOME, 'shipo-system', 'scripts', 'out');
const RAW = path.join(OUT_DIR, 'ups-rates-raw.json');

// ---- credentials -----------------------------------------------------------
const envPath = path.join(HOME, 'shipo-system', '.env.local');
const env = {};
for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
if (!env.SHIPSTATION_API_KEY || !env.SHIPSTATION_API_SECRET) {
  console.log('MISSING creds in .env.local');
  process.exit(1);
}
const auth = 'Basic ' + Buffer.from(
  `${env.SHIPSTATION_API_KEY}:${env.SHIPSTATION_API_SECRET}`).toString('base64');

// ---- what's missing --------------------------------------------------------
const FROM_ZIP = '19801';
const RESIDENTIAL = true;
const WEIGHTS = Array.from({ length: 50 }, (_, i) => i + 1);

// Zones verified against the official UPS chart for origin prefix 198 —
// see scripts/ups-zone-chart-198.txt. Zone 4 -> prefix 282 (280-283=4),
// Zone 7 -> prefix 802 (793-816=7).
//
// Override with a JSON array to measure any other destinations, e.g. the
// suburban counterparts used to isolate the urban delivery-area surcharge:
//   SS_TOPUP_DESTS='[{"zone":5,"city":"Naperville","state":"IL","zip":"60540"}]' \
//     node scripts/ss-ups-topup.mjs
// SS_TOPUP_CARRIERS=ups restricts the pull to one account (halves the time).
const DEFAULT_DESTS = [
  { zone: 4, city: 'Charlotte', state: 'NC', zip: '28202' },
  { zone: 7, city: 'Denver',    state: 'CO', zip: '80202' },
];
let NEW_DESTS = DEFAULT_DESTS;
if (process.env.SS_TOPUP_DESTS) {
  try {
    NEW_DESTS = JSON.parse(process.env.SS_TOPUP_DESTS);
  } catch (e) {
    console.log('SS_TOPUP_DESTS is not valid JSON:', e.message);
    process.exit(1);
  }
  if (!Array.isArray(NEW_DESTS) || NEW_DESTS.some((d) => !d.zip || !d.state || !d.city)) {
    console.log('SS_TOPUP_DESTS must be [{zone,city,state,zip}, ...]');
    process.exit(1);
  }
}

if (!fs.existsSync(RAW)) {
  console.log(`No ${RAW} — run scripts/ss-ups-rates.mjs first.`);
  process.exit(1);
}
const data = JSON.parse(fs.readFileSync(RAW, 'utf8'));
const beforeCount = data.rows.length;
const envCarriers = (process.env.SS_TOPUP_CARRIERS || '').split(',').map((s) => s.trim()).filter(Boolean);
const CARRIERS = envCarriers.length
  ? envCarriers
  : (data.carriers && data.carriers.length ? data.carriers : [data.carrier]);
console.log(`existing rows: ${beforeCount}, carriers: ${CARRIERS.join(', ')}`);
console.log(`UPS account on file: ${data.primaryAccount || '(unknown)'}`);

const already = new Set(data.rows.map((r) => `${r.carrier}|${r.destZip}|${r.lb}|${r.serviceName}`));

// Resume at WEIGHT granularity, not city granularity. This run gets killed by the
// environment after a few minutes, so it has to be restartable: skipping a whole
// city because one weight of it exists would silently leave permanent holes.
const doneBox = new Set(data.rows.map((r) => `${r.carrier}|${r.destZip}|${r.lb}`));
const todo = [];
for (const c of CARRIERS) {
  for (const d of NEW_DESTS) {
    let skipped = 0;
    for (const lb of WEIGHTS) {
      if (doneBox.has(`${c}|${d.zip}|${lb}`)) { skipped++; continue; }
      todo.push({ carrier: c, dest: d, lb });
    }
    if (skipped) console.log(`  ${c} ${d.city}: ${skipped}/${WEIGHTS.length} weights already done`);
  }
}
if (todo.length === 0) {
  console.log('Nothing to top up. Raw file untouched.');
  process.exit(0);
}
console.log(`quoting ${todo.length} boxes (~${Math.ceil((todo.length * 1.7) / 60)} min)`);

// ---- pull ------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getRates(dest, lb, carrierCode) {
  const body = {
    carrierCode, serviceCode: null, packageCode: 'package',
    fromPostalCode: FROM_ZIP,
    toState: dest.state, toCountry: 'US', toPostalCode: dest.zip, toCity: dest.city,
    weight: { value: lb * 16, units: 'ounces' },
    confirmation: 'none', residential: RESIDENTIAL,
  };
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch('https://ssapi.shipstation.com/shipments/getrates', {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (r.status === 200) return await r.json();
    if (r.status === 429) { await sleep(20000); continue; }
    return { __error: `HTTP ${r.status} ${(await r.text()).slice(0, 200)}` };
  }
  return { __error: 'rate-limited after retries' };
}

const added = [];
let n = 0;
for (const job of todo) {
  n++;
  const res = await getRates(job.dest, job.lb, job.carrier);
  if (res && res.__error) {
    data.errors.push({ carrier: job.carrier, zone: job.dest.zone, lb: job.lb, error: res.__error });
  } else if (Array.isArray(res)) {
    for (const s of res) {
      const key = `${job.carrier}|${job.dest.zip}|${job.lb}|${s.serviceName}`;
      if (already.has(key)) continue;
      already.add(key);
      added.push({
        carrier: job.carrier,
        zone: job.dest.zone,
        destCity: job.dest.city, destState: job.dest.state, destZip: job.dest.zip,
        lb: job.lb,
        serviceName: s.serviceName, serviceCode: s.serviceCode,
        shipmentCost: s.shipmentCost, otherCost: s.otherCost,
        totalCost: +((s.shipmentCost || 0) + (s.otherCost || 0)).toFixed(2),
      });
    }
  }
  if (n % 10 === 0) {
    console.log(`progress ${n}/${todo.length} added=${added.length}`);
    save();   // checkpoint — this process does not reliably survive to the end
  }
  await sleep(1700);
}

// ---- merge -----------------------------------------------------------------
// Never shrink the file. If something went wrong upstream, leave the good data alone.
// Written atomically (temp file + rename) so a kill mid-write cannot corrupt the
// 4,900 good quotes already on disk.
function save() {
  const merged = data.rows.concat(added);
  if (merged.length < beforeCount) {
    console.log('REFUSING to write: merged file would have fewer rows than before.');
    return null;
  }
  const out = Object.assign({}, data, {
    rows: merged,
    toppedUpAt: new Date().toISOString(),
  });
  const tmp = RAW + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2));
  fs.renameSync(tmp, RAW);
  return merged;
}

// save() no longer mutates data.rows, so the final report has to count the
// MERGED array it returns. Counting data.rows here would silently report the
// pre-run totals and hide whether the top-up actually landed.
const finalRows = save() || data.rows;
console.log(`DONE  ${beforeCount} -> ${finalRows.length} rows (+${added.length})`);
for (const d of NEW_DESTS) {
  const c = finalRows.filter((r) => r.destZip === d.zip).length;
  console.log(`  zone ${d.zone} ${d.city} ${d.zip}: ${c} quotes`);
}
