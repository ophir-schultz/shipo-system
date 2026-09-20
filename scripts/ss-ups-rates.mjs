// Pulls LIVE UPS 2-3 day rates from ShipStation for weights 1-50 lb, zones 2-8.
// SAFETY: credentials are read from env only and are NEVER logged or written to output.
// Output: scripts/out/ups-rates-raw.json  (cost only, no markup applied here)
import fs from 'fs';
import path from 'path';
import os from 'os';

const HOME = os.homedir();
const OUT_DIR = path.join(HOME, 'shipo-system', 'scripts', 'out');
fs.mkdirSync(OUT_DIR, { recursive: true });

// ---- credentials -----------------------------------------------------------
const envPath = path.join(HOME, 'shipo-system', '.env.local');
const raw = fs.readFileSync(envPath, 'utf8');
const env = {};
for (const line of raw.split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const KEY = env.SHIPSTATION_API_KEY;
const SEC = env.SHIPSTATION_API_SECRET;
if (!KEY || !SEC) {
  console.log('MISSING creds in .env.local');
  process.exit(1);
}
const auth = 'Basic ' + Buffer.from(`${KEY}:${SEC}`).toString('base64');

// ---- config ----------------------------------------------------------------
const FROM_ZIP = '19801'; // Shipo, 310 Cornell Dr, Wilmington DE

// One representative metro per UPS zone out of 19801.
//
// EVERY zone number below is READ OFF THE OFFICIAL UPS ZONE CHART for origin
// prefix 198 — see scripts/ups-zone-chart-198.txt, pulled 2026-09-03 from
// https://www.ups.com/media/us/currentrates/zone-csv/198.xls
// ("For shipments originating in ZIP Codes 198-01 to 198-99").
// Nothing here is inferred from price, and nothing here is a guess.
//
// The first version of this list assigned zones by assumption and got FIVE of
// SEVEN wrong — New York is Zone 2 not 3, Raleigh 3 not 4, Atlanta 6 not 5,
// Chicago 5 not 6, Dallas 6 not 7 — and it never quoted Zones 4 or 7 at all.
// The tell in the data: Atlanta and Dallas returned byte-identical rates at all
// 50 weights, because they are both Zone 6. UPS prices strictly by zone, so
// identical rates mean identical zone. Do not edit this list without checking
// the chart file; a wrong header ships a wrong price to a customer.
const DESTS = [
  // zone   city            state  zip     dest prefix -> chart entry
  { zone: 2, city: 'Philadelphia', state: 'PA', zip: '19102' }, // 191 -> 171-212=2
  { zone: 3, city: 'Raleigh',      state: 'NC', zip: '27601' }, // 276 -> 275-279=3
  { zone: 4, city: 'Charlotte',    state: 'NC', zip: '28202' }, // 282 -> 280-283=4
  { zone: 5, city: 'Chicago',      state: 'IL', zip: '60601' }, // 606 -> 600-620=5
  { zone: 6, city: 'Dallas',       state: 'TX', zip: '75201' }, // 752 -> 743-768=6
  { zone: 7, city: 'Denver',       state: 'CO', zip: '80202' }, // 802 -> 793-816=7
  { zone: 8, city: 'Los Angeles',  state: 'CA', zip: '90001' }, // 900 -> 900-908=8
];

const WEIGHTS = Array.from({ length: 50 }, (_, i) => i + 1); // 1..50 lb
// Residential confirmed by Ophir 2026-09-03. DTC is the default use case, and
// residential is the HIGHER rate — so a commercial/B2B delivery just comes in
// under the card rather than over it. ShipStation's own Rate Browser defaults to
// commercial, so these numbers will read slightly higher than the UI shows.
const RESIDENTIAL = true;

// --- auto-detect the connected UPS account ---------------------------------
// Avoids having to look the carrier code up by hand. Prefers the DAP/"walleted"
// account when both are connected, since that is the discounted card.
// Ophir has FOUR UPS accounts connected (confirmed 2026-09-03 in the ShipStation
// Rate Browser): "Shipo UPS DOnt use", "UPS Account B8B393", "UPS Account V94A60",
// and "UPS Shipo 1k". He asked to quote all of them EXCEPT the "don't use" one and
// compare. So: quote every UPS carrier code, tag each row with its carrier, and
// let the comparison decide. Baseline for the published card is "UPS Shipo 1k".
// Stamped into the output JSON and printed on every Cost sheet, so a finished
// price list always says WHICH UPS account it was built from. Four accounts share
// the code 'ups', so the code alone is not enough to identify it.
let PRIMARY_LABEL = '(unknown)';
let CARRIERS = (process.env.SS_CARRIER || '').split(',').map((s) => s.trim()).filter(Boolean);
if (CARRIERS.length === 0) {
  const cr = await fetch('https://ssapi.shipstation.com/carriers', {
    headers: { Authorization: auth },
  });
  if (cr.status !== 200) {
    console.log(`Could not list carriers (HTTP ${cr.status}). Set SS_CARRIER= manually.`);
    process.exit(1);
  }
  const carriers = await cr.json();
  const upsAll = carriers.filter(
    (c) =>
      (/ups/i.test(c.code) || /ups/i.test(c.name || '')) &&
      // never quote an account explicitly labelled "DOnt use"
      !/do\s*n.?t\s*use/i.test(c.name || '') &&
      !/do\s*n.?t\s*use/i.test(c.nickname || '')
  );

  // CONFIRMED 2026-09-03 against the live account: Ophir's FOUR own UPS accounts
  // all come back with code 'ups' and name 'UPS'. Only nickname/accountNumber
  // differ. ShipStation v1 /shipments/getrates accepts ONLY a carrierCode — there
  // is no way to select among same-code accounts. Quoting 'ups' four times would
  // burn ~20 extra minutes of rate limit and return four identical tables.
  // So: de-duplicate by code. 'ups' resolves to whichever account is PRIMARY.
  console.log('UPS carrier entries returned by the API:');
  for (const c of upsAll) {
    console.log(`  code=${c.code} primary=${c.primary} nickname="${c.nickname || '(none)'}"` +
      ` acct=...${String(c.accountNumber || '').slice(-4)}`);
  }
  const seen = new Set();
  const uniq = upsAll.filter((c) => !seen.has(c.code) && seen.add(c.code));
  const dropped = upsAll.length - uniq.length;
  if (dropped > 0) {
    console.log(`\nNOTE: ${dropped} duplicate-code UPS account(s) skipped — the v1 API cannot`);
    console.log('address them separately. Rates for code "ups" are the PRIMARY account:');
    const prim = upsAll.find((c) => c.code === 'ups' && c.primary) ||
                 upsAll.find((c) => c.code === 'ups');
    console.log(`  -> nickname="${prim && prim.nickname || '(none)'}"` +
      ` acct=...${String(prim && prim.accountNumber || '').slice(-4)}`);
    console.log('To price off a DIFFERENT UPS account, make it primary in ShipStation');
    console.log('(Settings > Shipping > Carriers) and re-run. That is Ophir\'s click, not the script\'s.\n');
  }
  if (uniq.length === 0) {
    console.log('No usable UPS carrier connected. Connected carriers:',
      carriers.map((c) => c.code).join(', '));
    process.exit(1);
  }

  // ---- SAFETY GATE ---------------------------------------------------------
  // Verified 2026-09-03 on the live account: the PRIMARY 'ups' entry had no
  // nickname and account ...4A60 — the SAME account number as the entry Ophir
  // nicknamed "Shipo UPS DOnt use". Pricing off it would have produced a
  // perfectly normal-looking card built on the wrong rates. Silent wrong numbers
  // are worse than no numbers, so refuse to run unless the primary really is the
  // intended account.
  const WANT = (process.env.SS_UPS_NICKNAME || 'UPS Shipo 1k').toLowerCase();
  const primaryUps = upsAll.find((c) => c.code === 'ups' && c.primary);
  const nick = (primaryUps && primaryUps.nickname) || '';
  if (process.env.SS_SKIP_ACCOUNT_CHECK !== '1' &&
      primaryUps && !nick.toLowerCase().includes(WANT)) {
    console.log('\n=== STOPPED — WRONG UPS ACCOUNT ===');
    console.log(`The PRIMARY UPS account is nickname="${nick || '(none)'}"` +
      ` acct=...${String(primaryUps.accountNumber || '').slice(-4)}`);
    console.log(`You asked to price off "${process.env.SS_UPS_NICKNAME || 'UPS Shipo 1k'}".`);
    console.log('\nShipStation v1 only quotes the PRIMARY account, so this run would');
    console.log('have built the whole price list on the wrong rates.\n');
    console.log('FIX: in ShipStation go to Settings > Shipping > Carriers, and make');
    console.log('the account you want the PRIMARY UPS account. Then re-run this.');
    console.log('\nTo price off a different account instead:');
    console.log('   SS_UPS_NICKNAME="UPS Account B8B393" node scripts/ss-ups-rates.mjs');
    console.log('To override this check and quote the primary anyway:');
    console.log('   SS_SKIP_ACCOUNT_CHECK=1 node scripts/ss-ups-rates.mjs');
    process.exit(1);
  }
  PRIMARY_LABEL = `nickname="${nick || '(none)'}" acct=...` +
    String((primaryUps && primaryUps.accountNumber) || '').slice(-4);
  console.log(`Primary UPS account for pricing: ${PRIMARY_LABEL}`);

  CARRIERS = uniq.map((c) => c.code);
}
console.log(`Quoting carriers: ${CARRIERS.join(', ')}  (override with SS_CARRIER=a,b,c)`);

// Capture EVERY service ShipStation returns. Ground out of Wilmington already
// lands in 2-3 days across the near zones, so "2-3 day" may mean Ground OR the
// 2nd Day Air / 3 Day Select air products. Pull all of it once, decide later.
const WANTED = /./;

// ShipStation v1 limits to 40 requests/minute -> ~1.6s spacing.
const SLEEP_MS = 1700;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getRates(dest, lb, CARRIER) {
  const body = {
    carrierCode: CARRIER,
    serviceCode: null,
    packageCode: 'package',
    fromPostalCode: FROM_ZIP,
    toState: dest.state,
    toCountry: 'US',
    toPostalCode: dest.zip,
    toCity: dest.city,
    weight: { value: lb * 16, units: 'ounces' },
    confirmation: 'none',
    residential: RESIDENTIAL,
  };
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch('https://ssapi.shipstation.com/shipments/getrates', {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (r.status === 200) return await r.json();
    if (r.status === 429) {
      await sleep(20000);
      continue;
    }
    const txt = (await r.text()).slice(0, 200);
    return { __error: `HTTP ${r.status} ${txt}` };
  }
  return { __error: 'rate-limited after retries' };
}

const rows = [];
const errors = [];
let n = 0;
const total = CARRIERS.length * DESTS.length * WEIGHTS.length;

const snapshot = () => ({
  carriers: CARRIERS,
  carrier: CARRIERS[0],
  primaryAccount: PRIMARY_LABEL,
  fromZip: FROM_ZIP,
  residential: RESIDENTIAL,
  pulledAt: new Date().toISOString(),
  rows,
  errors,
});

for (const CARRIER of CARRIERS) {
  for (const dest of DESTS) {
    for (const lb of WEIGHTS) {
      n++;
      const res = await getRates(dest, lb, CARRIER);
      if (res && res.__error) {
        errors.push({ carrier: CARRIER, zone: dest.zone, lb, error: res.__error });
      } else if (Array.isArray(res)) {
        for (const s of res) {
          if (!WANTED.test(s.serviceName || '')) continue;
          rows.push({
            carrier: CARRIER,
            zone: dest.zone,
            destCity: dest.city,
            destState: dest.state,
            destZip: dest.zip,
            lb,
            serviceName: s.serviceName,
            serviceCode: s.serviceCode,
            shipmentCost: s.shipmentCost,
            otherCost: s.otherCost,
            totalCost: +((s.shipmentCost || 0) + (s.otherCost || 0)).toFixed(2),
          });
        }
      }
      if (n % 10 === 0) {
        console.log(`progress ${n}/${total} (${CARRIER}) rows=${rows.length} errors=${errors.length}`);
        fs.writeFileSync(
          path.join(OUT_DIR, 'ups-rates-raw.json'),
          JSON.stringify(snapshot(), null, 2)
        );
      }
      await sleep(SLEEP_MS);
    }
  }
}

fs.writeFileSync(path.join(OUT_DIR, 'ups-rates-raw.json'), JSON.stringify(snapshot(), null, 2));
console.log(`DONE rows=${rows.length} errors=${errors.length}`);
const svc = [...new Set(rows.map((r) => r.serviceName))];
console.log('services captured:', svc.join(' | '));
for (const c of CARRIERS) {
  const sub = rows.filter((r) => r.carrier === c);
  console.log(`  ${c}: ${sub.length} quotes`);
}
